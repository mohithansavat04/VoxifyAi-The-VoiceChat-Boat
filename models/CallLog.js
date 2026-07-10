const mongoose = require('mongoose');

const callLogSchema = new mongoose.Schema({
    clientId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Client',
        required: true
    },
    targetPhone: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ['Initiated', 'Completed', 'Failed'],
        default: 'Initiated'
    },
    durationSeconds: {
        type: Number,
        default: 0
    },
    durationMinutes: {
        type: Number,
        default: 0
    },
    recordingUrl: {
        type: String,
        default: ''
    },
    transcript: {
        type: String,
        default: ''
    },
    extractedData: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('CallLog', callLogSchema);
