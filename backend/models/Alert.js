const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
    txnId: String,
    amount: String,
    type: String,
    date: Date
}, { _id: false }); 

const alertSchema = new mongoose.Schema({
    accountId: { type: String, required: true, index: true },
    riskScore: { type: Number, required: true },
    anomalyScore: { type: Number, required: true },
    topFeatures: { type: [mongoose.Schema.Types.Mixed], default: [] },
    
    // --- NEW: Batch Tagging ---
    sourceFileName: { type: String, required: true }, 
    
    rawTelemetry: { type: mongoose.Schema.Types.Mixed, required: true },
    
    kycData: {
        fullName: String,
        email: String,
        phone: String,
        currentBalance: String,
        lastLoginIp: String,
        deviceType: String,
        recentTransactions: [transactionSchema] 
    },
    
    status: { type: String, required: true },
    muleStatus: { type: String, enum: ['Pending', 'Confirmed Mule', 'Not a Mule'], default: 'Pending' },
    detectedAt: { type: Date, default: Date.now } 
});

// index already declared on accountId; avoid duplicate index declaration

module.exports = mongoose.model('Alert', alertSchema);