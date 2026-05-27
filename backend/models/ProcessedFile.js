const mongoose = require('mongoose');

const processedFileSchema = new mongoose.Schema({
    fileHash: { type: String, required: true, unique: true },
    fileName: { type: String, required: true },
    // --- THE FIX: Store the true total rows here ---
    totalAccountsScanned: { type: Number, default: 0 }, 
    processedAt: { type: Date, default: Date.now }
});

processedFileSchema.index({ fileHash: 1 });

module.exports = mongoose.model('ProcessedFile', processedFileSchema);