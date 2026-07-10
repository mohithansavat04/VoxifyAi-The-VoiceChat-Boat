require('dotenv').config();
const express = require('express');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const authRoutes = require('./routes/authRoutes');
const apiRoutes = require('./routes/apiRoutes');
const adminRoutes = require('./routes/adminRoutes');
const { setupAIEngine } = require('./services/aiEngine');
const { setupTwilioAIEngine } = require('./services/twilioAiEngine');
const { setupExotelAIEngine } = require('./services/exotelAiEngine');
const Client = require('./models/Client');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static('public'));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api', apiRoutes);
app.use('/api/admin', adminRoutes);

// Page Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/signup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'signup.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/call-logs', (req, res) => res.sendFile(path.join(__dirname, 'public', 'call-logs.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/subscription', (req, res) => res.sendFile(path.join(__dirname, 'public', 'subscription.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'public', 'settings.html')));
app.get('/support', (req, res) => res.sendFile(path.join(__dirname, 'public', 'support.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/voxify';
mongoose.connect(MONGO_URI)
    .then(() => console.log('MongoDB connected'))
    .catch(err => console.error('MongoDB connection error:', err));

// WebSocket Authentication & AI Setup
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_voxify_key_2026';

wss.on('connection', async (ws, req) => {
    // Handle Twilio Media Streams (Temporarily Disabled for BYOT Refactor)
    /*
    if (req.url.startsWith('/twilio-stream/')) {
        const parts = req.url.split('/');
        const clientId = parts[2];
        const callLogId = parts[3];
        try {
            const client = await Client.findById(clientId);
            if (client && client.status !== 'Suspended') {
                setupTwilioAIEngine(ws, client, callLogId);
            } else {
                ws.close(1008, "Account Suspended");
            }
        return;
    }
    */

    // Handle Exotel Voice Bot Streams
    if (req.url.startsWith('/exotel-stream/')) {
        const parts = req.url.split('/');
        const clientId = parts[2];
        const callLogId = parts[3] || null; // Exotel might not generate call log first if inbound
        try {
            const client = await Client.findById(clientId);
            if (client && client.status !== 'Suspended') {
                setupExotelAIEngine(ws, client, callLogId);
            } else {
                ws.close(1008, "Account Suspended");
            }
        } catch (e) { ws.close(); }
        return;
    }

    // Handle Browser Dashboard Streams (with JWT Cookie)
    const cookies = req.headers.cookie;
    let token = null;
    if (cookies) {
        const tokenCookie = cookies.split(';').find(c => c.trim().startsWith('token='));
        if (tokenCookie) token = tokenCookie.split('=')[1];
    }

    let clientData = {
        industry: 'General Business',
        questions: []
    };

    if (token) {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const client = await Client.findById(decoded.id);
            if (client) {
                if (client.status === 'Suspended') {
                    ws.close(1008, "Account Suspended");
                    return;
                }
                clientData = client;
            }
        } catch (err) {
            console.error('Invalid token on WS connection');
        }
    }

    // Setup the AI engine for this specific connection/client
    setupAIEngine(ws, clientData);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Voxify AI SaaS Server running on http://localhost:${PORT}`);
});
