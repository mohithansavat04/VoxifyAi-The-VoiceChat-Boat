const { createClient } = require('@deepgram/sdk');
const Groq = require('groq-sdk');
const fetch = require('node-fetch');
const Client = require('../models/Client');
const CallLog = require('../models/CallLog');

function setupTwilioAIEngine(ws, clientData, callLogId) {
    const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    
    const customQuestions = clientData.questions && clientData.questions.length > 0 
        ? clientData.questions.map((q, i) => `${i+1}. ${q}`).join('\n')
        : "1. Are you interested in learning about our new solutions?";

    const SYSTEM_PROMPT = `You are a conversational AI voice agent on a live phone call representing a business in the ${clientData.industry} industry.

Your ONLY task is to ask the user these questions sequentially:
${customQuestions}

CRITICAL RULES:
1. DO NOT output a script, template, or placeholders like "[Wait for user]". You are on a live call. Only generate your exact spoken words for the current turn.
2. Ask exactly ONE question per turn. Never ask two questions at once.
3. Wait for the user to answer before moving to the next question.
4. When they answer, give a short, natural acknowledgment (e.g., "Got it", "Nice") and ask the next question.
5. Keep your tone relaxed, human, and conversational. Do not sound robotic. Do not go off-script.
6. When ALL questions are answered, say a quick goodbye and MUST append the exact string "[CALL_ENDED]" at the end.`;

    let deepgramLive = null;
    let streamSid = null;
    let userTranscript = '';
    let isProcessing = false;
    let keepAlive = null;
    let startTime = Date.now();
    let messages = [{ role: 'system', content: SYSTEM_PROMPT }];
    
    let silenceTimeout = null;
    let playbackTimeout = null;
    let hardFallbackTimeout = null;

    const onSilence = async () => {
        if (isProcessing) return;
        console.log('[Twilio] Silence detected. Prompting user.');
        isProcessing = true;
        userTranscript = '';
        await handleAiResponse('[System: The user has been silent for too long. Gently say "Are you there?" and repeat your last question briefly.]');
    };

    const clearSilenceTimeout = () => {
        if (silenceTimeout) clearTimeout(silenceTimeout);
        if (playbackTimeout) clearTimeout(playbackTimeout);
        if (hardFallbackTimeout) clearTimeout(hardFallbackTimeout);
    };

    const startSilenceTimeout = () => {
        clearSilenceTimeout();
        // Fire after 4 seconds of no user speech
        silenceTimeout = setTimeout(onSilence, 4000);
    };

    const startHardFallback = (delayMs) => {
        // Hard fallback: fires 4 seconds AFTER the AI finishes speaking
        // Ensures we never get stuck waiting forever
        if (hardFallbackTimeout) clearTimeout(hardFallbackTimeout);
        hardFallbackTimeout = setTimeout(() => {
            if (!isProcessing) {
                onSilence();
            }
        }, delayMs + 4000);
    };

    const setupDeepgram = () => {
        deepgramLive = deepgram.listen.live({
            model: 'nova-2',
            language: 'en-IN',
            encoding: 'mulaw',
            sample_rate: 8000,
            smart_format: true,
            interim_results: true,
            endpointing: 800,
        });

        deepgramLive.on('open', () => {
            console.log(`[Twilio] Deepgram STT connection opened for client: ${clientData.emailOrPhone}`);
            keepAlive = setInterval(() => {
                if (deepgramLive && deepgramLive.getReadyState() === 1) {
                    deepgramLive.keepAlive();
                }
            }, 10 * 1000);
        });

        deepgramLive.on('Results', async (data) => {
            const transcript = data.channel.alternatives[0].transcript;
            
            if (transcript && transcript.trim().length > 0) {
                clearSilenceTimeout();
                if (streamSid) {
                    // Barge-in: stop any currently playing audio immediately
                    ws.send(JSON.stringify({ event: 'clear', streamSid: streamSid }));
                }
                isProcessing = false;
            }

            if (transcript && data.is_final) {
                userTranscript += ' ' + transcript;
            }

            if (data.speech_final) {
                if (userTranscript.trim().length > 0) {
                    if (isProcessing) {
                        userTranscript = '';
                        return;
                    }
                    isProcessing = true;

                    const finalUserMessage = userTranscript.trim();
                    userTranscript = ''; 
                    
                    console.log(`[Twilio] User: ${finalUserMessage}`);
                    await handleAiResponse(finalUserMessage);
                } else {
                    if (!isProcessing) {
                        startSilenceTimeout();
                    }
                }
            }
        });

        deepgramLive.on('error', (error) => {
            console.error('[Twilio] Deepgram STT error:', error);
        });
        
        deepgramLive.on('close', () => {
            console.log('[Twilio] Deepgram STT connection closed');
            if (keepAlive) clearInterval(keepAlive);
            clearSilenceTimeout();
        });
    };

    setupDeepgram();

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

            let aiResponseText = chatCompletion.choices[0].message.content;
            
            // Strip out <think> tags for models that output reasoning
            aiResponseText = aiResponseText.replace(/<think>[\s\S]*?(?:<\/think>|$)\s*/gi, '').trim();

            if (!aiResponseText) {
                isProcessing = false;
                startSilenceTimeout();
                return;
            }

            let callEnded = false;
            if (aiResponseText.includes('[CALL_ENDED]')) {
                callEnded = true;
                aiResponseText = aiResponseText.replace('[CALL_ENDED]', '').trim();
            }

            console.log(`[Twilio] AI: ${aiResponseText}`);
            messages.push({ role: 'assistant', content: aiResponseText });

            // Fetch TTS from Deepgram specifying mu-law 8000Hz for Twilio
            const ttsResponse = await global.fetch('https://api.deepgram.com/v1/speak?model=aura-luna-en&encoding=mulaw&sample_rate=8000', {
                method: 'POST',
                headers: {
                    'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ text: aiResponseText })
            });

            if (ttsResponse.ok) {
                const arrayBuffer = await ttsResponse.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                const base64Audio = buffer.toString('base64');
                
                if (streamSid) {
                    ws.send(JSON.stringify({
                        event: 'clear',
                        streamSid: streamSid
                    }));
                    ws.send(JSON.stringify({
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: base64Audio }
                    }));
                }

                // Estimate audio duration to properly time the silence timeout
                const charCount = aiResponseText.length;
                const estDurationMs = Math.min(Math.max(1000, (charCount / 15) * 1000), 10000); 

                isProcessing = false; // Allow immediate barge-in!

                playbackTimeout = setTimeout(() => {
                    startSilenceTimeout();
                }, estDurationMs);

                // Hard fallback: after AI finishes + 4 seconds, force move forward no matter what
                startHardFallback(estDurationMs);

                if (callEnded) {
                    setTimeout(() => {
                        processEndCall();
                    }, estDurationMs + 2000); // End call after speaking finishes
                }
            } else {
                console.error('[Twilio] TTS error:', await ttsResponse.text());
                isProcessing = false;
            }

        } catch (error) {
            console.error('Error generating AI response:', error.message || error);
            if (error.status === 429) {
                console.error('[RateLimit] Daily token limit reached. Stopping retries.');
                isProcessing = false;
                clearSilenceTimeout();
            } else {
                isProcessing = false;
                startSilenceTimeout();
            }
        }
    }

    let callProcessed = false;
    async function processEndCall() {
        if (callProcessed) return;
        callProcessed = true;
        console.log(`[Twilio] Processing end call logic, Stream SID: ${streamSid}`);
        clearSilenceTimeout();
        if (deepgramLive && deepgramLive.getReadyState() === 1) {
            deepgramLive.finish();
        }
        
        // Run extraction
        const durationMinutes = Math.max(1, Math.ceil((Date.now() - startTime) / 60000));
        const fullConversationTranscript = messages.map(m => `${m.role}: ${m.content}`).join('\n');
        
        const extractionPrompt = `You are a data extraction AI. Extract the answers to the following questions from this transcript. Return ONLY a valid JSON object where keys are the exact questions and values are the extracted answers (or "Not answered" if skipped).
        
Questions to extract:
${customQuestions}

Transcript:
${fullConversationTranscript}
`;
        let extractedData = {};
        try {
            const extraction = await groq.chat.completions.create({
                messages: [{ role: 'user', content: extractionPrompt }],
                model: 'llama-3.1-8b-instant',
                temperature: 0,
                response_format: { type: "json_object" }
            });
            extractedData = JSON.parse(extraction.choices[0].message.content);
        } catch (e) {
            console.error("[Twilio] Extraction error:", e);
        }

        clientData.trialMinutes = Math.max(0, clientData.trialMinutes - durationMinutes);
        await Client.findByIdAndUpdate(clientData._id, { trialMinutes: clientData.trialMinutes });

        if (callLogId) {
            await CallLog.findByIdAndUpdate(callLogId, {
                status: 'Completed',
                transcript: fullConversationTranscript,
                extractedData: extractedData,
                durationMinutes: durationMinutes
            });
        }
        
        // Close WS to drop Twilio stream
        setTimeout(() => ws.close(), 1000);
    }

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message.toString());

            if (data.event === 'start') {
                streamSid = data.start.streamSid;
                console.log(`[Twilio] Call started, Stream SID: ${streamSid}`);
                // Let the AI generate the first question
                if (!isProcessing) {
                    isProcessing = true;
                    handleAiResponse('[System: The call has just connected. Greet the user and ask the FIRST question on your list.]');
                }
            }

            if (data.event === 'media') {
                if (deepgramLive && deepgramLive.getReadyState() === 1) {
                    // Twilio sends base64 mu-law audio
                    const b64Data = data.media.payload;
                    const audioBuffer = Buffer.from(b64Data, 'base64');
                    deepgramLive.send(audioBuffer);
                }
            }

            if (data.event === 'stop') {
                await processEndCall();
            }
        } catch (e) {
            console.error('[Twilio] WS Message Error:', e);
        }
    });

    ws.on('close', () => {
        console.log('[Twilio] WebSocket closed');
        if (deepgramLive && deepgramLive.getReadyState() === 1) {
            deepgramLive.finish();
        }
        if (keepAlive) clearInterval(keepAlive);
    });
}

module.exports = { setupTwilioAIEngine };
