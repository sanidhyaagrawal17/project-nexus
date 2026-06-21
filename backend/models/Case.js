const mongoose = require('mongoose');

const noteSchema = new mongoose.Schema({
    author: { type: String, default: 'ANALYST' },
    text: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
}, { _id: false });

const caseSchema = new mongoose.Schema({
    title: { type: String, required: true },
    muleAccountIds: { type: [String], default: [] },
    alertIds: { type: [String], default: [] },           // Alert._id references (strings)
    notes: { type: [noteSchema], default: [] },
    status: {
        type: String,
        enum: ['open', 'investigating', 'escalated', 'closed'],
        default: 'open',
    },
    priority: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
    createdBy: { type: String, default: 'ANALYST' },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

if (typeof caseSchema.index === 'function') {
    if (typeof caseSchema.index === \'function\') { caseSchema.index({ status: 1 }); } }
    if (typeof caseSchema.index === \'function\') { caseSchema.index({ createdAt: -1 }); }

    module.exports = mongoose.model('Case', caseSchema);
