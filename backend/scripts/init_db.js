require('dotenv').config();

const mongoose = require('mongoose');
const ProcessedFile = require('../models/ProcessedFile');
const Alert = require('../models/Alert');

async function main() {
    const mongoUri = process.env.MONGO_URI;

    if (!mongoUri) {
        throw new Error('MONGO_URI is required.');
    }

    await mongoose.connect(mongoUri);

    await Promise.all([
        ProcessedFile.syncIndexes(),
        Alert.syncIndexes(),
    ]);

    console.log('[+] MongoDB indexes synced successfully for nexusDB.');
}

main()
    .catch((error) => {
        console.error('[!] Failed to initialize database indexes:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect();
        process.exit(process.exitCode || 0);
    });