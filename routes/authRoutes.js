const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Client = require('../models/Client');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_voxify_key_2026';

// Register Route
router.post('/signup', async (req, res) => {
    try {
        let { emailOrPhone, password, industry } = req.body;
        emailOrPhone = emailOrPhone.trim().toLowerCase();

        // Check if client exists
        let client = await Client.findOne({ emailOrPhone });
        if (client) {
            return res.status(400).json({ error: 'Account already exists with this email or phone number.' });
        }

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Generate API Key
        const crypto = require('crypto');
        const apiKey = 'vox_' + crypto.randomBytes(16).toString('hex');

        // Create new client
        client = new Client({
            emailOrPhone,
            password: hashedPassword,
            industry,
            trialMinutes: 10, // 10 free minutes for testing
            apiKey
        });

        await client.save();

        // Create token
        const token = jwt.sign({ id: client._id }, JWT_SECRET, { expiresIn: '1d' });
        res.cookie('token', token, { httpOnly: true });

        res.status(201).json({ message: 'Signup successful!', client });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error during signup.' });
    }
});

// Login Route
router.post('/login', async (req, res) => {
    try {
        let { emailOrPhone, password } = req.body;
        emailOrPhone = emailOrPhone.trim().toLowerCase();

        const client = await Client.findOne({ emailOrPhone });
        if (!client) {
            return res.status(400).json({ error: 'Invalid credentials.' });
        }

        const isMatch = await bcrypt.compare(password, client.password);
        if (!isMatch) {
            return res.status(400).json({ error: 'Invalid credentials.' });
        }

        if (client.status === 'Suspended') {
            return res.status(403).json({ error: 'Account suspended. Contact administrator.' });
        }

        const token = jwt.sign({ id: client._id }, JWT_SECRET, { expiresIn: '1d' });
        res.cookie('token', token, { httpOnly: true });

        res.json({ message: 'Login successful!', client });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error during login.' });
    }
});

// Get Current Logged In Client
router.get('/me', async (req, res) => {
    try {
        const token = req.cookies.token;
        if (!token) return res.status(401).json({ error: 'Not authorized' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const client = await Client.findById(decoded.id).select('-password');
        
        if (!client) return res.status(404).json({ error: 'Client not found' });
        if (client.status === 'Suspended') return res.status(403).json({ error: 'Account suspended' });
        
        res.json(client);
    } catch (err) {
        res.status(401).json({ error: 'Token is not valid' });
    }
});

// Update Questions
router.post('/update-questions', async (req, res) => {
    try {
        const token = req.cookies.token;
        if (!token) return res.status(401).json({ error: 'Not authorized' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const { questions } = req.body; // Array of strings

        if (!Array.isArray(questions) || questions.length > 10) {
            return res.status(400).json({ error: 'You can only add up to 10 questions.' });
        }

        // Validate question length
        for (let q of questions) {
            if (q.length > 100) {
                return res.status(400).json({ error: 'Each question must be a one-liner (max 100 characters).' });
            }
        }

        const client = await Client.findByIdAndUpdate(decoded.id, { questions }, { new: true }).select('-password');
        res.json({ message: 'Questions updated successfully!', client });
    } catch (err) {
        res.status(500).json({ error: 'Server error updating questions.' });
    }
});

// Update Telecom Credentials
router.post('/update-telecom', async (req, res) => {
    try {
        const token = req.cookies.token;
        if (!token) return res.status(401).json({ error: 'Not authorized' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const { telecomProvider, telecomCredentials } = req.body;

        if (!['browser', 'twilio', 'exotel'].includes(telecomProvider)) {
            return res.status(400).json({ error: 'Invalid telecom provider.' });
        }

        const client = await Client.findByIdAndUpdate(decoded.id, { 
            telecomProvider, 
            telecomCredentials 
        }, { new: true }).select('-password');
        
        res.json({ message: 'Telecom settings updated successfully!', client });
    } catch (err) {
        res.status(500).json({ error: 'Server error updating telecom settings.' });
    }
});

// Logout
router.post('/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ message: 'Logged out successfully.' });
});

module.exports = router;
