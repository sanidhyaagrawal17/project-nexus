const mongoose = require('mongoose');

const analystFeedbackSchema = new mongoose.Schema({
    accountId: { type: String, required: true },
    decision: { type: String, required: true, enum: ['SAFE', 'CONFIRMED_FRAUD', 'REVIEW'] },
    notes: { type: String, default: '' },
    reviewedBy: { type: String, default: 'ANALYST' },
    sourceFileName: { type: String, default: null },
    reviewedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('AnalystFeedback', analystFeedbackSchema);