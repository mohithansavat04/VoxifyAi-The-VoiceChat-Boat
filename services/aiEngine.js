const Groq = require('groq-sdk');
const Client = require('../models/Client');
const CallLog = require('../models/CallLog');
const { createClient } = require('@deepgram/sdk');

function setupAIEngine(ws, clientData) {
    const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    const customQuestions = clientData.questions && clientData.questions.length > 0
        ? clientData.questions.map((q, i) => `${i + 1}. ${q}`).join('\n')
        : '1. Are you interested in learning about our new solutions?';

    const SYSTEM_PROMPT = `You are a voice AI agent on a live phone call for a ${clientData.industry} business.

Your ONLY job: ask these questions ONE AT A TIME, in order, and wait for the user to reply:
${customQuestions}

HOW TO RESPOND:
- Each response = exactly ONE short sentence or question. Never list multiple questions.
- After the user answers, give a short warm acknowledgment ("Got it", "Thanks", "I see") then ask the next question.
- Never say "[Wait for user]" or any placeholder text. You are live on a call right now.
- When you have received answers to ALL questions, say a brief goodbye and end with [CALL_ENDED].`;

    // State machine: 'idle' | 'ai_speaking' | 'listening' | 'processing'
    let state = 'idle';
    let deepgramLive = null;
    let keepAlive = null;
    let userTranscript = '';
    let audioBuffer = [];
    let silenceTimer = null;
    let startTime = Date.now();

    const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

    // ─── Timers ────────────────────────────────────────────────────────────────

    function clearSilenceTimer() {
        if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    }

    function startSilenceTimer(delayMs = 2500) {
        clearSilenceTimer();
        silenceTimer = setTimeout(handleSilence, delayMs);
    }

    // ─── Silence handler ───────────────────────────────────────────────────────

    async function handleSilence() {
        if (state !== 'listening') return;
        console.log('[Silence] No response detected, prompting user.');
        state = 'processing';
        ws.send(JSON.stringify({ type: 'transcript', text: '(Silence)', role: 'user' }));
        await handleAiResponse('[System: The user has not replied. Politely repeat your last question in different words.]');
    }

    // ─── Main AI response handler ─────────────────────────────────────────────

    async function handleAiResponse(userMessage) {
        try {
            if (userMessage) {
                messages.push({ role: 'user', content: userMessage });
            }

            const chatCompletion = await groq.chat.completions.create({
                messages: messages,
                model: 'meta-llama/llama-4-scout-17b-16e-instruct',
                temperature: 0.3,
                max_tokens: 200,
            });

            let aiText = chatCompletion.choices[0].message.content || '';

            // Strip any <think>...</think> blocks (including unclosed ones)
            aiText = aiText.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();

            // Remove any leftover markdown bold markers
            aiText = aiText.replace(/\*\*.*?\*\*/g, '').trim();

            if (!aiText) {
                state = 'listening';
                startSilenceTimer();
                return;
            }

            // Detect [CALL_ENDED] BEFORE stripping brackets
            const callEnded = aiText.includes('[CALL_ENDED]');
            aiText = aiText.replace('[CALL_ENDED]', '').replace(/\[.*?\]/g, '').trim();

            console.log(`AI: ${aiText}`);
            messages.push({ role: 'assistant', content: aiText });
            ws.send(JSON.stringify({ type: 'transcript', text: aiText, role: 'ai' }));

            // ── TTS ─────────────────────────────────────────────────────────
            state = 'ai_speaking';
            const ttsResponse = await global.fetch(
                'https://api.deepgram.com/v1/speak?model=aura-luna-en',
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ text: aiText }),
                }
            );

            if (ttsResponse.ok) {
                const arrayBuffer = await ttsResponse.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                ws.send(buffer);

                // Immediately open for listening (barge-in capable)
                // We use the estimated speaking duration only to delay the silence timer
                const estDurationMs = Math.max(1500, Math.min((aiText.length / 14) * 1000, 12000));
                console.log(`[TTS] Sent ${buffer.length} bytes. Est. speak time: ${Math.round(estDurationMs/100)/10}s. Waiting to open silence timer.`);

                // Allow barge-in immediately
                state = 'listening';
                userTranscript = '';

                if (!callEnded) {
                    // Start silence timer after expected speaking duration
                    // 5 seconds gives the user enough time to think and respond
                    startSilenceTimer(estDurationMs + 5000);
                }

                if (callEnded) {
                    setTimeout(() => processEndCall(), estDurationMs + 2000);
                }
            } else {
                const errText = await ttsResponse.text();
                console.error('TTS error:', errText);
                state = 'listening';
                startSilenceTimer();
            }

        } catch (error) {
            console.error('Error generating AI response:', error.message || error);
            // If rate limited, do NOT retry — stop the loop
            if (error.status === 429) {
                console.error('[RateLimit] Daily token limit reached. Pausing for 60 seconds before retrying.');
                state = 'idle';
                clearSilenceTimer();
                // Notify the UI
                ws.send(JSON.stringify({ type: 'transcript', text: '[System: AI service is temporarily unavailable. Please try again in a minute.]', role: 'ai' }));
            } else {
                state = 'listening';
                startSilenceTimer();
            }
        }
    }

    // ─── Deepgram STT ─────────────────────────────────────────────────────────

    const setupDeepgram = () => {
        deepgramLive = deepgram.listen.live({
            model: 'nova-2',
            language: 'en-IN',
            smart_format: true,
            interim_results: true,
            endpointing: 1200,
            utterance_end_ms: 1500,
        });

        deepgramLive.on('open', () => {
            console.log(`Deepgram STT connection opened for client: ${clientData.emailOrPhone}`);
            while (audioBuffer.length > 0) {
                deepgramLive.send(audioBuffer.shift());
            }
            keepAlive = setInterval(() => {
                if (deepgramLive && deepgramLive.getReadyState() === 1) {
                    deepgramLive.keepAlive();
                }
            }, 10000);
        });

        deepgramLive.on('Results', async (data) => {
            const transcript = data.channel.alternatives[0].transcript;

            // User started talking — barge-in: stop AI audio
            if (transcript && transcript.trim().length > 0) {
                if (state === 'ai_speaking') {
                    console.log(`[Barge-in] User is talking, stopping AI audio. State: ai_speaking -> listening`);
                    ws.send(JSON.stringify({ type: 'clear_audio' }));
                    state = 'listening';
                    userTranscript = '';
                }
                clearSilenceTimer();
            }

            // Accumulate final transcripts only when listening
            if (transcript && data.is_final && state === 'listening') {
                console.log(`[STT is_final] "${transcript}"`);
                userTranscript += ' ' + transcript;
            }

            // Process when Deepgram says user has finished speaking
            if (data.speech_final) {
                const trimmed = userTranscript.trim();
                console.log(`[STT speech_final] state=${state}, transcript="${trimmed}"`);
                if (trimmed.length > 0 && state === 'listening') {
                    state = 'processing';
                    userTranscript = '';
                    clearSilenceTimer();

                    console.log(`User: ${trimmed}`);
                    ws.send(JSON.stringify({ type: 'transcript', text: trimmed, role: 'user' }));
                    await handleAiResponse(trimmed);
                } else {
                    startSilenceTimer(4000);
                }
            }
        });

        deepgramLive.on('error', (err) => console.error('Deepgram STT error:', err));

        deepgramLive.on('close', () => {
            console.log('Deepgram STT connection closed');
            if (keepAlive) clearInterval(keepAlive);
            clearSilenceTimer();
        });
    };

    setupDeepgram();

    // ─── End call processing ─────────────────────────────────────────────────

    async function processEndCall() {
        clearSilenceTimer();
        state = 'idle';
        if (deepgramLive && deepgramLive.getReadyState() === 1) deepgramLive.finish();
        if (keepAlive) clearInterval(keepAlive);

        const durationMinutes = Math.max(1, Math.ceil((Date.now() - startTime) / 60000));
        clientData.trialMinutes = Math.max(0, clientData.trialMinutes - durationMinutes);
        await Client.findByIdAndUpdate(clientData._id, { trialMinutes: clientData.trialMinutes });

        const fullTranscript = messages.map(m => `${m.role}: ${m.content}`).join('\n');

        const extractionPrompt = `Extract answers from this transcript. Return a valid JSON object where keys are questions and values are answers (or "Not answered").

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
            console.error('Extraction error:', e);
        }

        const log = new CallLog({
            clientId: clientData._id,
            targetPhone: 'Browser Test Call',
            status: 'Completed',
            transcript: fullTranscript,
            extractedData,
            durationMinutes,
            recordingUrl: '/mock-recording.mp3',
        });
        await log.save();
        console.log('Call log saved successfully');

        ws.send(JSON.stringify({
            type: 'call_summary',
            extractedData,
            durationMinutes,
            recordingUrl: '/mock-recording.mp3',
            trialMinutesLeft: clientData.trialMinutes,
        }));

        setTimeout(() => ws.close(), 1000);
    }

    // ─── WebSocket messages ───────────────────────────────────────────────────

    ws.on('message', async (message, isBinary) => {
        if (isBinary) {
            if (deepgramLive && deepgramLive.getReadyState() === 1) {
                deepgramLive.send(message);
            } else {
                audioBuffer.push(message);
            }
        } else {
            try {
                const data = JSON.parse(message.toString());
                if (data.type === 'start' && state === 'idle') {
                    state = 'processing';
                    handleAiResponse('[System: The call just connected. Greet the user briefly and ask the FIRST question.]');
                }
                if (data.type === 'end_call') {
                    await processEndCall();
                }
            } catch (e) {
                console.error(e);
            }
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected from AI engine');
        if (deepgramLive && deepgramLive.getReadyState() === 1) deepgramLive.finish();
        if (keepAlive) clearInterval(keepAlive);
        clearSilenceTimer();
    });
}

module.exports = { setupAIEngine };
