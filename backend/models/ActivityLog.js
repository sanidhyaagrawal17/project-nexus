const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema({
    timestamp: { type: Date, default: Date.now },
    actor: { type: String, required: true }, // 'SYSTEM', 'AI_ENGINE', or 'ANALYST'
    actionType: { type: String, required: true }, // 'UPLOAD', 'REJECTION', 'DETECTION', 'RESOLUTION'
    message: { type: String, required: true },
    accountId: { type: String, default: null } // Optional, linking to a specific account
});

module.exports = mongoose.model('ActivityLog', activityLogSchema);