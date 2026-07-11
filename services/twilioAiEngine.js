const { createClient } = require('@deepgram/sdk');
const Groq = require('groq-sdk');
const Client = require('../models/Client');
const CallLog = require('../models/CallLog');

function setupTwilioAIEngine(ws, clientData, callLogId) {
    const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    const customQuestions = clientData.questions && clientData.questions.length > 0
        ? clientData.questions.map((q, i) => `${i + 1}. ${q}`).join('\n')
        : '1. Are you interested in learning about our new solutions?';

    const SYSTEM_PROMPT = `You are a voice AI agent on a live phone call for a ${clientData.industry || 'General'} business.

Your ONLY job: ask these questions ONE AT A TIME, in order:
${customQuestions}

STRICT RULES:
- Each response = exactly ONE short sentence or question. Maximum 20 words.
- After the user answers, give a brief acknowledgment ("Got it", "Thanks", "I see") then immediately ask the next question.
- NEVER say placeholders. You are live on a call.
- When ALL questions are answered, say a brief goodbye and append [CALL_ENDED].`;

    // ── State ──────────────────────────────────────────────────────────────────
    // 'idle' | 'ai_speaking' | 'listening' | 'processing'
    let state = 'idle';
    let deepgramLive = null;
    let keepAlive = null;
    let streamSid = null;
    let userTranscript = '';
    let silenceTimer = null;
    let startTime = Date.now();
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

    // ── Timers ─────────────────────────────────────────────────────────────────

    function clearSilenceTimer() {
        if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    }

    function startSilenceTimer(delayMs = 4000) {
        clearSilenceTimer();
        silenceTimer = setTimeout(handleSilence, delayMs);
    }

    async function handleSilence() {
        if (state !== 'listening') return;
        console.log('[Twilio] Silence timeout - prompting user.');
        state = 'processing';
        userTranscript = '';
        await handleAiResponse('[System: The user has not replied. Politely say "Are you still there?" and repeat your last question briefly.]');
    }

    // ── Deepgram STT ───────────────────────────────────────────────────────────

    function setupDeepgram() {
        deepgramLive = deepgram.listen.live({
            model: 'nova-2',
            language: 'en-IN',
            encoding: 'mulaw',
            sample_rate: 8000,
            smart_format: true,
            interim_results: true,
            endpointing: 1200,      // same as proven aiEngine.js
            utterance_end_ms: 1500, // same as proven aiEngine.js
        });

        deepgramLive.on('open', () => {
            console.log('[Twilio] Deepgram connected');
            keepAlive = setInterval(() => {
                if (deepgramLive && deepgramLive.getReadyState() === 1) {
                    deepgramLive.keepAlive();
                }
            }, 10000);
        });

        deepgramLive.on('Results', async (data) => {
            const transcript = data?.channel?.alternatives?.[0]?.transcript;

            // User started talking → barge-in: stop AI audio
            if (transcript && transcript.trim().length > 0) {
                if (state === 'ai_speaking' && streamSid) {
                    console.log('[Twilio] Barge-in detected, clearing AI audio');
                    ws.send(JSON.stringify({ event: 'clear', streamSid }));
                    state = 'listening';
                    userTranscript = '';
                }
                clearSilenceTimer();
            }

            // Accumulate final transcripts when listening
            if (transcript && data.is_final && state === 'listening') {
                console.log(`[Twilio] is_final: "${transcript}"`);
                userTranscript += ' ' + transcript;
            }

            // Process when user has finished speaking
            if (data.speech_final) {
                const trimmed = userTranscript.trim();
                console.log(`[Twilio] speech_final: state=${state}, transcript="${trimmed}"`);
                if (trimmed.length > 0 && state === 'listening') {
                    state = 'processing';
                    userTranscript = '';
                    clearSilenceTimer();
                    console.log(`[Twilio] User: "${trimmed}"`);
                    await handleAiResponse(trimmed);
                } else {
                    // No speech detected — start listening timer
                    if (state === 'listening') {
                        startSilenceTimer(4000);
                    }
                }
            }
        });

        deepgramLive.on('error', (err) => {
            console.error('[Twilio] Deepgram error:', err);
        });

        deepgramLive.on('close', () => {
            console.log('[Twilio] Deepgram closed');
            if (keepAlive) clearInterval(keepAlive);
        });
    }

    setupDeepgram();

    // ── AI Response Handler ────────────────────────────────────────────────────

    async function handleAiResponse(userMessage) {
        try {
            if (userMessage) {
                messages.push({ role: 'user', content: userMessage });
            }

            const chatCompletion = await groq.chat.completions.create({
                messages,
                model: 'meta-llama/llama-4-scout-17b-16e-instruct',
                temperature: 0.3,
                max_tokens: 120,
            });

            let aiText = chatCompletion.choices[0].message.content || '';
            aiText = aiText.replace(/<think>[\s\S]*?(?:<\/think>|$)\s*/gi, '').trim();
            aiText = aiText.replace(/\*\*.*?\*\*/g, '').trim();

            if (!aiText) {
                state = 'listening';
                startSilenceTimer(4000);
                return;
            }

            const callEnded = aiText.includes('[CALL_ENDED]');
            aiText = aiText.replace('[CALL_ENDED]', '').replace(/\[.*?\]/g, '').trim();

            console.log(`[Twilio] AI: "${aiText}"`);
            messages.push({ role: 'assistant', content: aiText });

            // TTS via Deepgram — mulaw 8000Hz for Twilio
            state = 'ai_speaking';
            const ttsRes = await global.fetch(
                'https://api.deepgram.com/v1/speak?model=aura-luna-en&encoding=mulaw&sample_rate=8000',
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ text: aiText }),
                }
            );

            if (!ttsRes.ok) {
                console.error('[Twilio] TTS failed:', await ttsRes.text());
                state = 'listening';
                startSilenceTimer(4000);
                return;
            }

            const arrayBuffer = await ttsRes.arrayBuffer();
            const base64Audio = Buffer.from(arrayBuffer).toString('base64');

            if (streamSid) {
                ws.send(JSON.stringify({ event: 'clear', streamSid }));
                ws.send(JSON.stringify({
                    event: 'media',
                    streamSid,
                    media: { payload: base64Audio },
                }));
            }

            const estDurationMs = Math.max(1500, Math.min((aiText.length / 14) * 1000, 12000));
            console.log(`[Twilio] Speaking for ~${Math.round(estDurationMs / 100) / 10}s`);

            // Allow barge-in immediately but start silence timer after speaking finishes
            state = 'listening';
            userTranscript = '';

            if (!callEnded) {
                startSilenceTimer(estDurationMs + 5000);
            }

            if (callEnded) {
                setTimeout(() => processEndCall(), estDurationMs + 2000);
            }

        } catch (err) {
            console.error('[Twilio] handleAiResponse error:', err.message);
            state = 'listening';
            startSilenceTimer(4000);
        }
    }

    // ── End Call & Data Extraction ─────────────────────────────────────────────

    let callProcessed = false;
    async function processEndCall() {
        if (callProcessed) return;
        callProcessed = true;
        console.log('[Twilio] Processing end call');
        clearSilenceTimer();
        if (deepgramLive && deepgramLive.getReadyState() === 1) deepgramLive.finish();

        const durationMinutes = Math.max(1, Math.ceil((Date.now() - startTime) / 60000));
        const fullTranscript = messages.map(m => `${m.role}: ${m.content}`).join('\n');

        const extractionPrompt = `Extract answers from this call transcript. Return ONLY valid JSON where keys are the questions and values are the answers (or "Not answered").

Questions:
${customQuestions}

Transcript:
${fullTranscript}`;

        let extractedData = {};
        try {
            const extraction = await groq.chat.completions.create({
                messages: [{ role: 'user', content: extractionPrompt }],
                model: 'llama-3.1-8b-instant',
                temperature: 0,
                response_format: { type: 'json_object' },
            });
            extractedData = JSON.parse(extraction.choices[0].message.content);
        } catch (e) {
            console.error('[Twilio] Extraction error:', e.message);
        }

        await Client.findByIdAndUpdate(clientData._id, {
            trialMinutes: Math.max(0, clientData.trialMinutes - durationMinutes),
        });

        if (callLogId) {
            await CallLog.findByIdAndUpdate(callLogId, {
                status: 'Completed',
                transcript: fullTranscript,
                extractedData,
                durationMinutes,
            });
        }

        setTimeout(() => ws.close(), 1000);
    }

    // ── WebSocket Events ───────────────────────────────────────────────────────

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message.toString());

            if (data.event === 'start') {
                streamSid = data.start.streamSid;
                console.log(`[Twilio] Stream started: ${streamSid}`);
                if (state === 'idle') {
                    state = 'processing';
                    handleAiResponse('[System: The call just connected. Greet the user warmly and ask the FIRST question.]');
                }
            }

            if (data.event === 'media') {
                if (deepgramLive && deepgramLive.getReadyState() === 1) {
                    deepgramLive.send(Buffer.from(data.media.payload, 'base64'));
                }
            }

            if (data.event === 'stop') {
                await processEndCall();
            }
        } catch (e) {
            // ignore non-JSON
        }
    });

    ws.on('close', () => {
        console.log('[Twilio] WebSocket closed');
        clearSilenceTimer();
        processEndCall();
    });
}

module.exports = { setupTwilioAIEngine };
