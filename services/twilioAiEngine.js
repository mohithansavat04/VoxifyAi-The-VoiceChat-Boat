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
- NEVER say placeholders like "[Wait for user]". You are live on a call.
- NEVER ask two questions at once.
- When ALL questions are answered, say a brief goodbye and append [CALL_ENDED].
- If you cannot hear the user clearly, say "Sorry, I missed that. Could you repeat?" and re-ask the same question.`;

    let streamSid = null;
    let deepgramLive = null;
    let keepAlive = null;
    let startTime = Date.now();
    let messages = [{ role: 'system', content: SYSTEM_PROMPT }];

    // State
    let isSpeaking = false;      // AI is currently playing audio
    let isProcessing = false;     // AI is generating a response
    let accumulatedTranscript = '';
    let utteranceTimer = null;    // fires when user stops talking
    let noSpeechTimer = null;     // fires if user never speaks (hard fallback)

    // ─── Timers ───────────────────────────────────────────────────────────────

    function clearAllTimers() {
        if (utteranceTimer) { clearTimeout(utteranceTimer); utteranceTimer = null; }
        if (noSpeechTimer) { clearTimeout(noSpeechTimer); noSpeechTimer = null; }
    }

    // Called after AI finishes speaking - starts listening window
    function startListeningWindow() {
        clearAllTimers();
        // If user says nothing for 5 seconds after AI speaks, nudge them
        noSpeechTimer = setTimeout(() => {
            if (!isProcessing && !isSpeaking) {
                console.log('[Twilio] No speech detected for 5s. Nudging user.');
                isProcessing = true;
                accumulatedTranscript = '';
                handleAiResponse('[System: The user has not responded. Say "Are you there?" and briefly repeat your last question.]');
            }
        }, 5000);
    }

    // Called when user speech is detected - starts utterance-end countdown
    function onUserSpeechDetected(transcript) {
        // Cancel the no-speech fallback since user IS talking
        if (noSpeechTimer) { clearTimeout(noSpeechTimer); noSpeechTimer = null; }

        // Barge-in: cut AI audio immediately
        if (isSpeaking && streamSid) {
            ws.send(JSON.stringify({ event: 'clear', streamSid }));
            isSpeaking = false;
        }

        // Start a 1.5s utterance-end timer (resets with each new word)
        if (utteranceTimer) clearTimeout(utteranceTimer);
        utteranceTimer = setTimeout(() => {
            if (accumulatedTranscript.trim().length > 0 && !isProcessing) {
                const userMessage = accumulatedTranscript.trim();
                accumulatedTranscript = '';
                console.log(`[Twilio] User said: "${userMessage}"`);
                isProcessing = true;
                handleAiResponse(userMessage);
            }
        }, 1500);
    }

    // ─── Deepgram Setup ───────────────────────────────────────────────────────

    function setupDeepgram() {
        deepgramLive = deepgram.listen.live({
            model: 'nova-2',
            language: 'en-IN',
            encoding: 'mulaw',
            sample_rate: 8000,
            smart_format: true,
            interim_results: true,
            endpointing: 300,       // detect end of speech after 300ms silence
            utterance_end_ms: 1000, // fire UtteranceEnd after 1s of silence
        });

        deepgramLive.on('open', () => {
            console.log('[Twilio] Deepgram connected');
            keepAlive = setInterval(() => {
                if (deepgramLive && deepgramLive.getReadyState() === 1) {
                    deepgramLive.keepAlive();
                }
            }, 8000);
        });

        deepgramLive.on('Results', (data) => {
            const transcript = data?.channel?.alternatives?.[0]?.transcript;
            if (!transcript || !transcript.trim()) return;

            // If AI is speaking and user talks, register barge-in
            if (isSpeaking) {
                onUserSpeechDetected(transcript);
            }

            // Accumulate interim results
            if (!data.is_final) return;

            accumulatedTranscript += ' ' + transcript.trim();
            console.log(`[Twilio] Interim transcript: "${transcript}"`);
            onUserSpeechDetected(transcript);
        });

        deepgramLive.on('UtteranceEnd', () => {
            console.log('[Twilio] UtteranceEnd received');
            if (accumulatedTranscript.trim().length > 0 && !isProcessing) {
                if (utteranceTimer) clearTimeout(utteranceTimer);
                const userMessage = accumulatedTranscript.trim();
                accumulatedTranscript = '';
                isProcessing = true;
                console.log(`[Twilio] Processing utterance: "${userMessage}"`);
                handleAiResponse(userMessage);
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

    // ─── AI Response Handler ──────────────────────────────────────────────────

    async function handleAiResponse(userMessage) {
        try {
            clearAllTimers();

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
            // Strip reasoning tags
            aiText = aiText.replace(/<think>[\s\S]*?(?:<\/think>|$)\s*/gi, '').trim();

            if (!aiText) {
                isProcessing = false;
                startListeningWindow();
                return;
            }

            let callEnded = false;
            if (aiText.includes('[CALL_ENDED]')) {
                callEnded = true;
                aiText = aiText.replace('[CALL_ENDED]', '').trim();
            }

            console.log(`[Twilio] AI: ${aiText}`);
            messages.push({ role: 'assistant', content: aiText });

            // TTS via Deepgram (mulaw 8000Hz for Twilio)
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

            isProcessing = false;

            if (!ttsRes.ok) {
                console.error('[Twilio] TTS failed:', await ttsRes.text());
                startListeningWindow();
                return;
            }

            const arrayBuffer = await ttsRes.arrayBuffer();
            const base64Audio = Buffer.from(arrayBuffer).toString('base64');

            if (streamSid) {
                // Clear any in-flight audio first
                ws.send(JSON.stringify({ event: 'clear', streamSid }));
                // Send new audio
                ws.send(JSON.stringify({
                    event: 'media',
                    streamSid,
                    media: { payload: base64Audio },
                }));
                isSpeaking = true;
            }

            // Estimate how long audio will play (chars / 15 words-per-sec)
            const estDurationMs = Math.min(Math.max(1500, (aiText.length / 15) * 1000), 12000);

            setTimeout(() => {
                isSpeaking = false;
                if (!callEnded) {
                    startListeningWindow();
                }
            }, estDurationMs);

            if (callEnded) {
                setTimeout(() => processEndCall(), estDurationMs + 1500);
            }

        } catch (err) {
            console.error('[Twilio] handleAiResponse error:', err.message);
            isProcessing = false;
            isSpeaking = false;
            startListeningWindow();
        }
    }

    // ─── End Call & Data Extraction ───────────────────────────────────────────

    let callProcessed = false;
    async function processEndCall() {
        if (callProcessed) return;
        callProcessed = true;
        console.log('[Twilio] Processing end call');
        clearAllTimers();
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

    // ─── WebSocket Events ─────────────────────────────────────────────────────

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message.toString());

            if (data.event === 'start') {
                streamSid = data.start.streamSid;
                console.log(`[Twilio] Stream started: ${streamSid}`);
                if (!isProcessing) {
                    isProcessing = true;
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
            // ignore non-JSON messages
        }
    });

    ws.on('close', () => {
        console.log('[Twilio] WebSocket closed');
        clearAllTimers();
        processEndCall();
    });
}

module.exports = { setupTwilioAIEngine };
