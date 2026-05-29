const mongoose = require('mongoose');

const processedFileSchema = new mongoose.Schema({
    fileHash: { type: String, required: true, unique: true, index: true },
    fileName: { type: String, required: true },
    sourceType: { type: String, enum: ['STATIC_INGEST', 'LIVE_STREAM'], default: 'STATIC_INGEST', index: true },
    // --- THE FIX: Store the true total rows here ---
    totalAccountsScanned: { type: Number, default: 0 }, 
    processedAt: { type: Date, default: Date.now }
});

// fileHash already declared with unique/index in the schema above; avoid duplicate index declaration

module.exports = mongoose.model('ProcessedFile', processedFileSchema);