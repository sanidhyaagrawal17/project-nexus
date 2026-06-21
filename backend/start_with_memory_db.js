// Start the backend with an in-memory mock database (no MongoDB needed)
// Use this when MongoDB is not available

// Mock mongoose first
const mockMongoose = require('./mongoose_mock');
const mongoosePath = require.resolve('mongoose');
require.cache[mongoosePath] = {
    id: mongoosePath,
    filename: mongoosePath,
    loaded: true,
    exports: mockMongoose,
};

// Mock faker (ESM module that can't be required in CJS)
const mockFaker = {
    person: { fullName: () => 'Test User' },
    internet: { email: () => 'test@example.local', ipv4: () => '127.0.0.1' },
    phone: { number: () => '000-000-0000' },
    finance: { amount: ({ min = 0, max = 1000, dec = 2 } = {}) => String(min + Math.random() * (max - min)) },
    helpers: { arrayElement: (arr) => (Array.isArray(arr) ? arr[Math.floor(Math.random() * arr.length)] : arr) },
    string: { uuid: () => Math.random().toString(36).substring(2, 10) },
    date: { recent: () => new Date() }
};
try {
    const fakerPath = require.resolve('@faker-js/faker');
    require.cache[fakerPath] = {
        id: fakerPath,
        filename: fakerPath,
        loaded: true,
        exports: { faker: mockFaker, default: { faker: mockFaker } },
    };
} catch(e) { /* ignore */ }

console.log('[+] Using in-memory mock database');
process.env.MONGO_URI = 'mock://localhost';
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const server = require('./server');
console.log('[+] Server initialized with in-memory database');

// Pre-populate with sample alerts from nexus_alerts.json
const fs = require('fs');
const path = require('path');
const alertsJsonPath = path.join(__dirname, '..', 'ml-pipeline', 'nexus_alerts.json');
if (fs.existsSync(alertsJsonPath)) {
    try {
        const nexusData = JSON.parse(fs.readFileSync(alertsJsonPath, 'utf-8'));
        if (nexusData.success && Array.isArray(nexusData.data) && nexusData.data.length > 0) {
            const Alert = mockMongoose.model('Alert');
            const alertsToInsert = nexusData.data.map(item => ({
                ...item,
                sourceFileName: 'demo_upload_data.csv',
                detectedAt: new Date(),
                muleStatus: 'Pending'
            }));
            Alert.insertMany(alertsToInsert).then(() => {
                console.log(`[+] Seeded ${alertsToInsert.length} alerts from nexus_alerts.json`);
            // Auth Seeding
            const User = mockMongoose.model('User');
            User.countDocuments().then(async adminCount => {
                if (adminCount === 0) {
                    const bcrypt = require('bcrypt');
                    const defaultPassword = await bcrypt.hash('admin123', 10);
                    await User.insertMany([
                        { username: 'admin', passwordHash: defaultPassword, role: 'ADMIN' },
                        { username: 'overseer', passwordHash: defaultPassword, role: 'OVERSEER' },
                        { username: 'analyst', passwordHash: defaultPassword, role: 'ANALYST' }
                    ]);
                    console.log(' [+] Seeded default users (admin, overseer, analyst) with password admin123');
                }
            });

            });
        }
    } catch (e) {
        console.error('[!] Failed to seed alerts:', e.message);
    }
}
