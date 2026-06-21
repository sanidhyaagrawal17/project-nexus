const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['ADMIN', 'OVERSEER', 'ANALYST'], default: 'ANALYST' },
});

module.exports = mongoose.model('User', userSchema);
