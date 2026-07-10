const mongoose = require('mongoose');

const clientSchema = new mongoose.Schema({
    emailOrPhone: {
        type: String,
        required: true,
        unique: true
    },
    password: {
        type: String,
        required: true
    },
    industry: {
        type: String,
        enum: ['Health', 'Finance', 'Real Estate', 'Education', 'General Business'],
        required: true
    },
    trialMinutes: {
        type: Number,
        default: 10
    },
    questions: {
        type: [String],
        validate: [arrayLimit, '{PATH} exceeds the limit of 10'],
        default: []
    },
    apiKey: {
        type: String,
        unique: true,
        sparse: true
    },
    isAdmin: {
        type: Boolean,
        default: false
    },
    subscriptionPlan: {
        type: String,
        enum: ['Free Trial', 'Pro', 'Enterprise'],
        default: 'Free Trial'
    },
    status: {
        type: String,
        enum: ['Active', 'Suspended'],
        default: 'Active'
    },
    telecomProvider: {
        type: String,
        enum: ['browser', 'twilio', 'exotel'],
        default: 'browser'
    },
    telecomCredentials: {
        type: Object,
        default: {} // e.g., { exotelAccountSid: '...', exotelApiKey: '...' }
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

function arrayLimit(val) {
    return val.length <= 10;
}

module.exports = mongoose.model('Client', clientSchema);
