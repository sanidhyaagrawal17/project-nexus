const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();
const mongoose = require('mongoose');
const { faker } = require('@faker-js/faker');
const http = require('http');
const { Server } = require('socket.io');
const rateLimit = require('express-rate-limit');
const { pipeline } = require('stream/promises');

const Alert = require('./models/Alert');
const ProcessedFile = require('./models/ProcessedFile');
const ActivityLog = require('./models/ActivityLog');
const AnalystFeedback = require('./models/AnalystFeedback');

const app = express();
const PORT = Number.parseInt(process.env.PORT || '5000', 10);
const server = http.createServer(app);
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
const io = new Server(server, { cors: { origin: allowedOrigins, methods: ["GET", "POST"] } });
app.set('trust proxy', 1);

const MAX_JSON_BODY_SIZE = process.env.MAX_JSON_BODY_SIZE || '100mb';
const MAX_URLENCODED_BODY_SIZE = process.env.MAX_URLENCODED_BODY_SIZE || '100mb';
const MAX_UPLOAD_SIZE_MB = Number.parseInt(process.env.MAX_UPLOAD_SIZE_MB || '100', 10);

function isAllowedOrigin(origin) {
    return !origin || allowedOrigins.includes(origin);
}

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
});

app.use(cors({
    origin(origin, callback) {
        if (isAllowedOrigin(origin)) return callback(null, true);
        return callback(new Error(`CORS blocked for origin ${origin}`));
    },
    credentials: true,
}));
app.use(express.json({ limit: MAX_JSON_BODY_SIZE }));
app.use(express.urlencoded({ limit: MAX_URLENCODED_BODY_SIZE, extended: true }));

const mongoUri = process.env.MONGO_URI;

let currentEngineStatus = 'Idle';
let _lastEngineEmit = { msg: '', at: 0 };
let dbReady = false;

const simpleRateBuckets = new Map();

function createSimpleRateLimit({ windowMs, maxRequests }) {
    return (req, res, next) => {
        const key = `${req.ip || req.connection.remoteAddress || 'unknown'}:${req.path}`;
        const now = Date.now();
        const bucket = simpleRateBuckets.get(key) || [];
        const windowStart = now - windowMs;
        const recentHits = bucket.filter(timestamp => timestamp >= windowStart);
        recentHits.push(now);
        simpleRateBuckets.set(key, recentHits);

        if (recentHits.length > maxRequests) {
            return res.status(429).json({ success: false, message: 'Too many requests. Please try again later.' });
        }

        next();
    };
}

const uploadRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many uploads. Please try again later.' },
});

mongoose.connection.on('connected', () => { dbReady = true; });
mongoose.connection.on('disconnected', () => { dbReady = false; });

function emitEngineProgress(status) {
    try {
        const now = Date.now();
        const s = String(status || '').trim();
        if (!s) return;
        if (s !== _lastEngineEmit.msg || (now - _lastEngineEmit.at) > 500) {
            io.emit('ENGINE_PROGRESS', { status: s });
            _lastEngineEmit.msg = s;
            _lastEngineEmit.at = now;
        }
    } catch (e) { console.error('[!] emitEngineProgress failed', e); }
}

const metricsPath = path.join(__dirname, '../ml-pipeline/outputs/model_metrics.json');

io.on('connection', (socket) => {
    console.log(` [+] Analyst Dashboard Connected (WebSocket ID: ${socket.id})`);
});

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, '../ml-pipeline/data')),
    filename: (req, file, cb) => cb(null, `live_stream_${Date.now()}.csv`)
});

const upload = multer({ storage: storage, limits: { fileSize: MAX_UPLOAD_SIZE_MB * 1024 * 1024 } });

async function createLog(actor, actionType, message, accountId = null) {
    const log = new ActivityLog({ actor, actionType, message, accountId });
    await log.save();
    io.emit('NEW_LOG', log);
}

function readJsonFileSafe(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        }
    } catch (err) {
        console.error(`[!] Failed to read ${filePath}:`, err.message);
    }
    return null;
}

async function hashFileSha256(filePath) {
    const hash = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(filePath), hash);
    return hash.digest('hex');
}

async function requestInferenceFromMlService(csvPath) {
    const serviceBaseUrl = (process.env.ML_SERVICE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
    const endpoint = new URL('/predict', serviceBaseUrl);
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv_path: csvPath }),
        signal: AbortSignal.timeout(600000),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ML service request failed (${response.status}): ${errorText}`);
    }

    return response.json();
}

async function persistInferenceResults(fileHash, originalFileName, predictionPayload) {
    if (!predictionPayload || !predictionPayload.data) {
        return;
    }

    await ProcessedFile.findOneAndUpdate(
        { fileHash: fileHash },
        { $set: { totalAccountsScanned: predictionPayload.totalScanned || 0 } },
        { returnDocument: 'after' }
    );

    const hydratedAlerts = predictionPayload.data.map(alert => ({
        ...alert,
        sourceFileName: originalFileName,
        kycData: {
            fullName: faker.person.fullName(),
            email: faker.internet.email(),
            phone: faker.phone.number(),
            currentBalance: faker.finance.amount({ min: 50, max: 150000, dec: 2, symbol: '$' }),
            lastLoginIp: faker.internet.ipv4(),
            deviceType: faker.helpers.arrayElement(['iPhone 14 Pro', 'Windows 11 PC', 'MacBook Air', 'Android (Unknown)', 'Linux Server']),
            recentTransactions: Array.from({ length: 3 }).map(() => ({
                txnId: faker.string.uuid().slice(0, 8).toUpperCase(),
                amount: faker.finance.amount({ min: 1000, max: 9500, dec: 2, symbol: '$' }),
                type: faker.helpers.arrayElement(['WIRE_TRANSFER', 'CRYPTO_EXCHANGE', 'P2P_PAYMENT', 'OFFSHORE_DEPOSIT']),
                date: faker.date.recent({ days: 3 })
            }))
        }
    }));

    if (hydratedAlerts.length > 0) {
        await Alert.insertMany(hydratedAlerts);
    }

    const criticalCount = hydratedAlerts.filter(a => a.status === 'Critical').length;
    const highRiskCount = hydratedAlerts.filter(a => a.status === 'High Risk').length;

    if (criticalCount > 0 || highRiskCount > 0) {
        io.emit('SCAN_COMPLETE', {
            fileName: originalFileName,
            criticalCount,
            highRiskCount
        });
        await createLog('AI_ENGINE', 'DETECTION', `Pipeline execution complete on ${originalFileName}. Detected ${criticalCount} CRITICAL and ${highRiskCount} HIGH RISK anomalies.`);
    }

    io.emit('SILENT_REFRESH');
}

app.get('/api/alerts', async (req, res) => {
    try {
        const alerts = await Alert.find().sort({ riskScore: -1 }).lean();
        res.json({ success: true, count: alerts.length, data: alerts });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/healthz', (req, res) => res.json({ ok: true, service: 'backend' }));

app.get('/readyz', (req, res) => {
    res.status(dbReady ? 200 : 503).json({ ok: dbReady, dbReady, service: 'backend' });
});

app.get('/api/datasets', async (req, res) => {
    try {
        const datasets = await Alert.distinct('sourceFileName');
        res.json({ success: true, data: datasets });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/logs', async (req, res) => {
    try {
        const logs = await ActivityLog.find().sort({ timestamp: -1 }).limit(200).lean();
        res.json({ success: true, data: logs });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/files', async (req, res) => {
    try {
        const files = await ProcessedFile.find().sort({ processedAt: -1 }).lean();
        res.json({ success: true, data: files });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/status', (req, res) => res.json({ status: currentEngineStatus }));

app.get('/api/config', (req, res) => {
    const metrics = readJsonFileSafe(metricsPath);
    const thresholds = metrics?.thresholds || { alert_threshold: parseFloat(process.env.NEXUS_ALERT_THRESHOLD || '0.85'), critical_threshold: parseFloat(process.env.NEXUS_CRITICAL_THRESHOLD || '0.95') };
    res.json({
        success: true,
        inputSchema: metrics?.inputSchema || null,
        thresholds,
        modelMetrics: metrics?.metrics || null,
        thresholdCurve: metrics?.thresholdCurve || [],
        droppedFeatures: metrics?.droppedFeatures || [],
        featureImportance: metrics?.featureImportance || [],
    });
});

app.get('/api/metrics', (req, res) => {
    const metrics = readJsonFileSafe(metricsPath);
    if (!metrics) {
        return res.json({ success: true, data: null });
    }
    res.json({ success: true, data: metrics });
});

app.delete('/api/system-wipe', createSimpleRateLimit({ windowMs: 15 * 60 * 1000, maxRequests: 3 }), async (req, res) => {
    try {
        await Alert.deleteMany({});
        await ProcessedFile.deleteMany({});
        await ActivityLog.deleteMany({});
        await AnalystFeedback.deleteMany({});

        const dataDir = path.join(__dirname, '../ml-pipeline/data');
        if (fs.existsSync(dataDir)) {
            const files = fs.readdirSync(dataDir);
            for (const file of files) {
                if (file.startsWith('live_stream_') && file.endsWith('.csv')) {
                    fs.unlinkSync(path.join(dataDir, file));
                }
            }
        }

        await createLog('SYSTEM', 'RESOLUTION', 'Master System Wipe Executed. Databases and physical files completely scrubbed.');
        io.emit('SILENT_REFRESH');
        res.json({ success: true, message: 'System Wiped Successfully' });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/resolve', createSimpleRateLimit({ windowMs: 15 * 60 * 1000, maxRequests: 60 }), async (req, res) => {
    const { accountId, decision = 'SAFE', notes = '', sourceFileName = null } = req.body;
    try {
        await AnalystFeedback.create({ accountId, decision, notes, sourceFileName, reviewedBy: 'ANALYST' });
        const message = decision === 'CONFIRMED_FRAUD'
            ? `Analyst reviewed and confirmed Threat [${accountId}] as FRAUD.`
            : `Analyst reviewed and marked Threat [${accountId}] as SAFE.`;
        await createLog('ANALYST', 'RESOLUTION', message, accountId);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/upload', uploadRateLimiter, upload.single('telemetryFile'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

    const targetCsvPath = path.join('data', req.file.filename);
    const fullPath = path.join(__dirname, '../ml-pipeline/data', req.file.filename);
    const originalFileName = req.file.originalname;

    currentEngineStatus = 'Hashing file for deduplication check...';
    emitEngineProgress(currentEngineStatus);
    const fileHash = await hashFileSha256(fullPath);

    const existingFile = await ProcessedFile.findOne({ fileHash: fileHash });
    if (existingFile) {
        await fs.promises.unlink(fullPath);
        currentEngineStatus = 'Duplicate Rejected';
        emitEngineProgress(currentEngineStatus);
        await createLog('SYSTEM', 'REJECTION', `Data Replay Blocked: Uploaded dataset hash [${fileHash.substring(0, 8)}...] already exists in system.`);
        return res.status(409).json({ success: false, message: 'DUPLICATE_FILE' });
    }

    await ProcessedFile.create({ fileHash: fileHash, fileName: originalFileName });
    await createLog('SYSTEM', 'UPLOAD', `New telemetry stream ingested: ${originalFileName}`);

    currentEngineStatus = 'Initializing Nexus ML Engine...';
    emitEngineProgress(currentEngineStatus);

    res.status(202).json({ success: true, message: 'Upload accepted. Processing started.' });

    void (async () => {
        try {
            const predictionPayload = await requestInferenceFromMlService(targetCsvPath);
            currentEngineStatus = 'Committing to NoSQL Database...';
            emitEngineProgress(currentEngineStatus);

            await persistInferenceResults(fileHash, originalFileName, predictionPayload);

            currentEngineStatus = 'Complete';
            emitEngineProgress(currentEngineStatus);
        } catch (error) {
            console.error('[!] ML Service Error:', error);
            currentEngineStatus = 'Engine Failure';
            emitEngineProgress(currentEngineStatus);
        }
    })();
});

async function bootstrap() {
    try {
        if (!mongoUri) {
            throw new Error('MONGO_URI is required.');
        }

        await mongoose.connect(mongoUri);
        console.log(' [+] Connected to Nexus NoSQL Database');
        server.listen(PORT, () => console.log(` [+] Nexus Backend & WebSocket listening on port ${PORT}`));
    } catch (err) {
        console.error(' [!] Database Connection Error:', err);
        process.exit(1);
    }
}

bootstrap();
server.setTimeout(600000);