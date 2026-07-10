const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
    razorpayOrderId: { type: String, required: true },
    razorpayPaymentId: { type: String },
    amount: { type: Number, required: true }, // in rupees
    minutesAdded: { type: Number, required: true },
    status: { type: String, enum: ['Pending', 'Paid', 'Failed'], default: 'Pending' },
    description: { type: String }
}, { timestamps: true });

module.exports = mongoose.model('Transaction', transactionSchema);
