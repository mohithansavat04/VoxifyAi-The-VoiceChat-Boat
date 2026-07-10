const { createClient } = require('@deepgram/sdk');
const Groq = require('groq-sdk');
const fetch = require('node-fetch');
const Client = require('../models/Client');
const CallLog = require('../models/CallLog');

function setupExotelAIEngine(ws, clientData, callLogId) {
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
    let streamSid = null; // Exotel might use a different ID, but we'll store it here
    let userTranscript = '';
    let isProcessing = false;
    let keepAlive = null;
    let startTime = Date.now();
    let messages = [{ role: 'system', content: SYSTEM_PROMPT }];
    
    let silenceTimeout = null;
    let playbackTimeout = null;

    const onSilence = async () => {
        if (isProcessing) return;
        console.log('[Exotel] Silence detected. Prompting user.');
        isProcessing = true;
        await handleAiResponse('[System: The user has been silent. Gently ask if they are still there or repeat your last question.]');
    };

    const clearSilenceTimeout = () => {
        if (silenceTimeout) clearTimeout(silenceTimeout);
        if (playbackTimeout) clearTimeout(playbackTimeout);
    };

    const startSilenceTimeout = () => {
        clearSilenceTimeout();
        silenceTimeout = setTimeout(onSilence, 2500);
    };

    const setupDeepgram = () => {
        deepgramLive = deepgram.listen.live({
            model: 'nova-2',
            language: 'en-IN',
            encoding: 'linear16', // Exotel typically uses 16-bit PCM
            sample_rate: 16000,   // 16kHz sample rate
            smart_format: true,
            interim_results: true,
            endpointing: 800,
        });

        deepgramLive.on('open', () => {
            console.log(`[Exotel] Deepgram STT connection opened for client: ${clientData.emailOrPhone}`);
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
                // Barge-in: Tell Exotel to clear playback buffer
                ws.send(JSON.stringify({ event: 'clear' }));
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
                    
                    console.log(`[Exotel] User: ${finalUserMessage}`);
                    await handleAiResponse(finalUserMessage);
                } else {
                    if (!isProcessing) {
                        startSilenceTimeout();
                    }
                }
            }
        });

        deepgramLive.on('error', (error) => {
            console.error('[Exotel] Deepgram STT error:', error);
        });
        
        deepgramLive.on('close', () => {
            console.log('[Exotel] Deepgram STT connection closed');
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

            console.log(`[Exotel] AI: ${aiResponseText}`);
            messages.push({ role: 'assistant', content: aiResponseText });

            // Fetch TTS from Deepgram as linear16 / 16000Hz for Exotel
            const ttsResponse = await global.fetch('https://api.deepgram.com/v1/speak?model=aura-luna-en&encoding=linear16&sample_rate=16000', {
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
                
                // Exotel expects audio payloads (base64)
                ws.send(JSON.stringify({
                    event: 'media',
                    media: { payload: base64Audio }
                }));

                const charCount = aiResponseText.length;
                const estDurationMs = Math.min(Math.max(1000, (charCount / 15) * 1000), 10000); 

                isProcessing = false; 

                playbackTimeout = setTimeout(() => {
                    startSilenceTimeout();
                }, estDurationMs);

                if (callEnded) {
                    setTimeout(() => {
                        processEndCall();
                    }, estDurationMs + 2000); 
                }
            } else {
                console.error('[Exotel] TTS error:', await ttsResponse.text());
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
        console.log(`[Exotel] Processing end call logic`);
        clearSilenceTimeout();
        if (deepgramLive && deepgramLive.getReadyState() === 1) {
            deepgramLive.finish();
        }
        
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
            console.error("[Exotel] Extraction error:", e);
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
        
        setTimeout(() => ws.close(), 1000);
    }

    ws.on('message', async (message) => {
        try {
            if (Buffer.isBuffer(message)) {
                // If Exotel sends raw binary PCM directly
                if (deepgramLive && deepgramLive.getReadyState() === 1) {
                    deepgramLive.send(message);
                }
                return;
            }

            const data = JSON.parse(message.toString());

            // Handle start event (similar to Twilio)
            if (data.event === 'start' || data.event === 'connected') {
                console.log(`[Exotel] Call started.`);
                if (!isProcessing) {
                    isProcessing = true;
                    handleAiResponse('[System: The call has just connected. Greet the user and ask the FIRST question on your list.]');
                }
            }

            // Handle media event (base64 encoded JSON)
            if (data.event === 'media' && data.media && data.media.payload) {
                if (deepgramLive && deepgramLive.getReadyState() === 1) {
                    const audioBuffer = Buffer.from(data.media.payload, 'base64');
                    deepgramLive.send(audioBuffer);
                }
            }

            // Handle stop event
            if (data.event === 'stop' || data.event === 'closed') {
                await processEndCall();
            }
        } catch (e) {
            // Not a JSON message or parse error. If it's a string, maybe it's raw text? 
            // We ignore it safely.
            console.error('[Exotel] WS Message Error (might be non-JSON):', e.message);
        }
    });

    ws.on('close', () => {
        console.log('[Exotel] WebSocket closed by client/Exotel');
        processEndCall();
    });
}

module.exports = { setupExotelAIEngine };
