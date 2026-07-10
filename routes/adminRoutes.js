const express = require('express');
const jwt = require('jsonwebtoken');
const Client = require('../models/Client');
const CallLog = require('../models/CallLog');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_voxify_key_2026';

// Middleware to verify Super Admin
async function authenticateAdmin(req, res, next) {
    try {
        const token = req.cookies.token;
        if (!token) return res.status(401).json({ error: 'Not authorized' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const client = await Client.findById(decoded.id);

        if (!client) {
            console.error('Admin Auth Failed: Client not found for ID', decoded.id);
            return res.status(403).json({ error: 'Forbidden.' });
        }
        if (!client.isAdmin) {
            console.error('Admin Auth Failed: Client is not admin. Client:', client);
            return res.status(403).json({ error: 'Forbidden. Super Admin access required.' });
        }

        req.admin = client;
        next();
    } catch (err) {
        console.error('Admin Auth Error:', err);
        res.status(401).json({ error: 'Invalid token' });
    }
}

// GET /api/admin/stats
router.get('/stats', authenticateAdmin, async (req, res) => {
    try {
        const totalClients = await Client.countDocuments();
        
        const aggregation = await CallLog.aggregate([
            {
                $group: {
                    _id: null,
                    totalCalls: { $sum: 1 },
                    totalMinutesConsumed: { $sum: "$durationMinutes" }
                }
            }
        ]);

        const metrics = aggregation[0] || { totalCalls: 0, totalMinutesConsumed: 0 };
        
        // Assume an MRR calculation based on active Pro users or simply a mock projection for now
        const proClients = await Client.countDocuments({ subscriptionPlan: 'Pro' });
        const estimatedMRR = proClients * 2999; 

        res.json({
            totalClients,
            totalCalls: metrics.totalCalls,
            totalMinutesConsumed: metrics.totalMinutesConsumed,
            estimatedMRR
        });
    } catch (err) {
        console.error('Stats Error:', err);
        res.status(500).json({ error: 'Error fetching stats' });
    }
});

// GET /api/admin/clients
router.get('/clients', authenticateAdmin, async (req, res) => {
    try {
        const clients = await Client.find().select('-password').sort({ createdAt: -1 });
        res.json(clients);
    } catch (err) {
        res.status(500).json({ error: 'Error fetching clients' });
    }
});

// POST /api/admin/credit-minutes
router.post('/credit-minutes', authenticateAdmin, async (req, res) => {
    try {
        const { clientId, minutes } = req.body;
        if (!clientId || !minutes) return res.status(400).json({ error: 'Missing parameters' });

        const client = await Client.findById(clientId);
        if (!client) return res.status(404).json({ error: 'Client not found' });

        client.trialMinutes += parseInt(minutes, 10);
        await client.save();

        res.json({ message: `Successfully added ${minutes} minutes.`, newBalance: client.trialMinutes });
    } catch (err) {
        res.status(500).json({ error: 'Error crediting minutes' });
    }
});

// POST /api/admin/client/status
router.post('/client/status', authenticateAdmin, async (req, res) => {
    try {
        const { clientId, status } = req.body;
        if (!clientId || !['Active', 'Suspended'].includes(status)) {
            return res.status(400).json({ error: 'Invalid parameters' });
        }
        
        const client = await Client.findByIdAndUpdate(clientId, { status }, { new: true });
        if (!client) return res.status(404).json({ error: 'Client not found' });
        
        res.json({ message: `Client status updated to ${status}`, status: client.status });
    } catch (err) {
        res.status(500).json({ error: 'Error updating status' });
    }
});

// POST /api/admin/client/subscription
router.post('/client/subscription', authenticateAdmin, async (req, res) => {
    try {
        const { clientId, subscriptionPlan } = req.body;
        // The available plans can be loaded from a config, for now we validate against the enum in Client.js
        if (!clientId || !['Free Trial', 'Pro', 'Enterprise'].includes(subscriptionPlan)) {
            return res.status(400).json({ error: 'Invalid parameters' });
        }
        
        const client = await Client.findByIdAndUpdate(clientId, { subscriptionPlan }, { new: true });
        if (!client) return res.status(404).json({ error: 'Client not found' });
        
        res.json({ message: `Client upgraded to ${subscriptionPlan}`, plan: client.subscriptionPlan });
    } catch (err) {
        res.status(500).json({ error: 'Error updating subscription' });
    }
});

// GET /api/admin/client/:id/calls
router.get('/client/:id/calls', authenticateAdmin, async (req, res) => {
    try {
        const clientId = req.params.id;
        const calls = await CallLog.find({ clientId }).sort({ createdAt: -1 });
        res.json(calls);
    } catch (err) {
        res.status(500).json({ error: 'Error fetching call logs' });
    }
});

module.exports = router;
