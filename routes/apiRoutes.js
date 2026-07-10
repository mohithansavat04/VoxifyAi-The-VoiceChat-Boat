const express = require('express');
const Client = require('../models/Client');
const CallLog = require('../models/CallLog');
const Transaction = require('../models/Transaction');
const jwt = require('jsonwebtoken');
const Groq = require('groq-sdk');
const twilio = require('twilio');
const Razorpay = require('razorpay');
const crypto = require('crypto');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_voxify_key_2026';
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Middleware to authenticate via API Key
async function authenticateApiKey(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }
    const apiKey = authHeader.split(' ')[1];
    const client = await Client.findOne({ apiKey });
    
    if (!client) {
        return res.status(401).json({ error: 'Invalid API Key' });
    }
    if (client.status === 'Suspended') {
        return res.status(403).json({ error: 'Account suspended.' });
    }
    
    req.client = client;
    next();
}

// Dynamic CRM Endpoint: Trigger Call via configured BYOT Provider
router.post('/v1/call', authenticateApiKey, async (req, res) => {
    try {
        const { targetPhone } = req.body;
        const client = req.client;

        if (!targetPhone) {
            return res.status(400).json({ error: 'targetPhone is required' });
        }
        if (client.trialMinutes <= 0) {
            return res.status(403).json({ error: 'Trial minutes exhausted. Please upgrade your plan.' });
        }

        const provider = client.telecomProvider || 'twilio';
        const creds = client.telecomCredentials || {};
        const baseUrl = process.env.BASE_URL || process.env.NGROK_URL || 'https://voxifyai-the-voicechat-boat.onrender.com';
        
        // Create an initial call log
        const callLog = new CallLog({
            clientId: client._id,
            targetPhone: targetPhone,
            status: 'Initiated'
        });
        await callLog.save();

        if (provider === 'twilio') {
            const sid = creds.twilioAccountSid || process.env.TWILIO_ACCOUNT_SID;
            const token = creds.twilioAuthToken || process.env.TWILIO_AUTH_TOKEN;
            const fromNumber = creds.twilioPhoneNumber || process.env.TWILIO_PHONE_NUMBER;

            if (!sid || !token) return res.status(500).json({ error: 'Twilio credentials not configured' });

            const twilioClient = twilio(sid, token);
            const call = await twilioClient.calls.create({
                url: `${baseUrl}/api/v1/twiml/${client._id}/${callLog._id}`,
                to: targetPhone,
                from: fromNumber,
                record: true,
                recordingStatusCallback: `${baseUrl}/api/v1/recording/${callLog._id}`,
                recordingStatusCallbackEvent: ['completed']
            });

            res.json({
                message: 'Call initiated successfully via Twilio',
                callId: callLog._id,
                twilioCallSid: call.sid,
                targetPhone: targetPhone,
                status: 'In Progress'
            });

        } else if (provider === 'exotel') {
            const { exotelAccountSid, exotelApiKey, exotelApiToken, exotelSubdomain, exotelCallerId } = creds;
            
            if (!exotelAccountSid || !exotelApiKey || !exotelApiToken || !exotelSubdomain) {
                return res.status(500).json({ error: 'Exotel credentials incomplete in settings.' });
            }

            // Fallback for missing caller ID (ExoPhone)
            const fromNumber = exotelCallerId || targetPhone; // This might fail if Exotel requires a verified Exophone, but we'll try

            const authString = Buffer.from(`${exotelApiKey}:${exotelApiToken}`).toString('base64');
            const wssUrl = baseUrl.replace(/^https?:\/\//, 'wss://');
            const streamUrl = `${wssUrl}/exotel-stream/${client._id}/${callLog._id}`;

            const params = new URLSearchParams();
            params.append('From', fromNumber);
            params.append('To', targetPhone);
            params.append('CallerId', fromNumber); // Usually required to be ExoPhone
            params.append('streamurl', streamUrl);
            params.append('streamtype', 'bidirectional');

            const exotelRes = await fetch(`https://${exotelSubdomain}/v1/Accounts/${exotelAccountSid}/Calls/connect.json`, {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${authString}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: params
            });

            const exotelData = await exotelRes.json();
            
            if (exotelRes.ok) {
                res.json({
                    message: 'Call initiated successfully via Exotel',
                    callId: callLog._id,
                    exotelCallSid: exotelData.Call ? exotelData.Call.Sid : null,
                    targetPhone: targetPhone,
                    status: 'In Progress'
                });
            } else {
                console.error('Exotel API Error:', exotelData);
                res.status(500).json({ error: 'Exotel API Error: ' + JSON.stringify(exotelData) });
            }

        } else {
            res.status(400).json({ error: 'Unsupported provider: ' + provider });
        }
    } catch (err) {
        console.error('Telecom Error:', err);
        res.status(500).json({ error: 'Server error: ' + (err.message || 'processing call') });
    }
});

// Endpoint hit by Twilio when the user picks up the phone
router.post('/v1/twiml/:clientId/:callLogId', (req, res) => {
    const { clientId, callLogId } = req.params;
    
    // Strip http/https and use wss
    const baseUrl = process.env.BASE_URL || process.env.NGROK_URL || 'https://voxifyai-the-voicechat-boat.onrender.com';
    const wssUrl = baseUrl.replace(/^https?:\/\//, 'wss://');
    
    const twiml = new twilio.twiml.VoiceResponse();
    // Connect the call to our WebSocket stream
    const connect = twiml.connect();
    connect.stream({
        url: `${wssUrl}/twilio-stream/${clientId}/${callLogId}`,
    });

    res.type('text/xml');
    res.send(twiml.toString());
});

// Endpoint hit by Twilio when the call recording is ready
router.post('/v1/recording/:callLogId', async (req, res) => {
    try {
        const { callLogId } = req.params;
        const { RecordingUrl } = req.body;
        
        if (RecordingUrl) {
            // Append .mp3 so the client can play it in the browser without Twilio authentication
            const playableUrl = RecordingUrl + '.mp3';
            await CallLog.findByIdAndUpdate(callLogId, { recordingUrl: playableUrl });
        }
        res.sendStatus(200);
    } catch (err) {
        console.error('Recording Webhook Error:', err);
        res.sendStatus(500);
    }
});
// Dashboard Endpoint: Get Call History
router.get('/v1/calls', async (req, res) => {
    try {
        const token = req.cookies.token;
        if (!token) return res.status(401).json({ error: 'Not authorized' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const calls = await CallLog.find({ clientId: decoded.id }).sort({ createdAt: -1 });
        
        res.json(calls);
    } catch (err) {
        res.status(500).json({ error: 'Server error fetching call history' });
    }
});

// Razorpay Configuration
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_mockkey123',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'mock_secret_abc123'
});

// Billing Endpoint: Create Razorpay Order
router.post('/v1/billing/create-order', async (req, res) => {
    try {
        const token = req.cookies.token;
        if (!token) return res.status(401).json({ error: 'Not authorized' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const { minutesPurchased } = req.body;
        
        let amount = 0;
        if (minutesPurchased == 100) amount = 250;
        else if (minutesPurchased == 500) amount = 1000;
        else if (minutesPurchased == 1000) amount = 1500;
        else return res.status(400).json({ error: 'Invalid minute amount' });

        const options = {
            amount: amount * 100, // amount in smallest currency unit (paise)
            currency: "INR",
            receipt: `receipt_${Date.now()}`
        };

        const order = await razorpay.orders.create(options);

        // Pre-create the transaction as Pending
        const tx = new Transaction({
            clientId: decoded.id,
            razorpayOrderId: order.id,
            amount: amount,
            minutesAdded: minutesPurchased,
            status: 'Pending',
            description: `Top-up ${minutesPurchased} Minutes`
        });
        await tx.save();

        res.json({ orderId: order.id, amount: order.amount, key: razorpay.key_id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error creating order' });
    }
});

// Billing Endpoint: Verify Payment & Add Minutes
router.post('/v1/billing/verify', async (req, res) => {
    try {
        const token = req.cookies.token;
        if (!token) return res.status(401).json({ error: 'Not authorized' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

        const sign = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSign = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || 'mock_secret_abc123')
                                   .update(sign.toString())
                                   .digest("hex");

        if (razorpay_signature === expectedSign) {
            // Payment is successful
            const tx = await Transaction.findOne({ razorpayOrderId: razorpay_order_id });
            if (!tx) return res.status(404).json({ error: 'Transaction not found' });

            if (tx.status === 'Paid') return res.status(400).json({ error: 'Already processed' });

            tx.status = 'Paid';
            tx.razorpayPaymentId = razorpay_payment_id;
            await tx.save();

            const client = await Client.findById(decoded.id);
            client.trialMinutes += tx.minutesAdded;
            await client.save();

            res.json({ message: 'Payment successful! Minutes added.', newBalance: client.trialMinutes });
        } else {
            // Payment failed validation
            await Transaction.updateOne({ razorpayOrderId: razorpay_order_id }, { status: 'Failed' });
            res.status(400).json({ error: 'Invalid signature. Payment failed.' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error verifying payment' });
    }
});

// Billing Endpoint: Get Transaction History
router.get('/v1/billing/history', async (req, res) => {
    try {
        const token = req.cookies.token;
        if (!token) return res.status(401).json({ error: 'Not authorized' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const txs = await Transaction.find({ clientId: decoded.id }).sort({ createdAt: -1 });
        
        res.json(txs);
    } catch (err) {
        res.status(500).json({ error: 'Server error fetching billing history' });
    }
});

module.exports = router;
