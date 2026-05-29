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
const Setting = require('./models/Setting');
const { createLiveStreamProcessor } = require('./liveStreamProcessor');
const { startRetrainScheduler, stopRetrainScheduler } = require('./scheduler');

const app = express();
const PORT = Number.parseInt(process.env.PORT || '5000', 10);
const server = http.createServer(app);
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost,http://127.0.0.1,http://localhost:5173,http://127.0.0.1:5173,http://nexus')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
const io = new Server(server, {
    cors: {
        origin(origin, callback) {
            if (isAllowedOrigin(origin)) return callback(null, true);
            return callback(new Error(`CORS blocked for origin ${origin}`));
        },
        methods: ["GET", "POST"],
        credentials: true,
    },
});
app.set('trust proxy', 1);

const activeChildProcesses = new Set();

const MAX_JSON_BODY_SIZE = process.env.MAX_JSON_BODY_SIZE || '100mb';
const MAX_URLENCODED_BODY_SIZE = process.env.MAX_URLENCODED_BODY_SIZE || '100mb';
let maxUploadSizeMB = Number.parseInt(process.env.MAX_UPLOAD_SIZE_MB || '100', 10);
let uploadLimitEnabled = (typeof process.env.UPLOAD_LIMIT_ENABLED === 'undefined') ? true : String(process.env.UPLOAD_LIMIT_ENABLED).toLowerCase() !== 'false';

function isAllowedOrigin(origin) {
    if (!origin) return true;
    if (allowedOrigins.includes(origin)) return true;

    try {
        const parsed = new URL(origin);
        const isLocalHost = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
        return parsed.protocol === 'http:' && isLocalHost;
    } catch {
        return false;
    }
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

// API navigation guard:
// - If a human navigates directly to an `/api/*` URL in the browser (Accept: text/html),
//   redirect them to the frontend SPA root instead of returning raw JSON.
// - Require JSON/AJAX requests for direct API access; simple browser navigations are denied.
app.use('/api', (req, res, next) => {
    const accept = String(req.get('accept') || '').toLowerCase();
    const isHtmlNav = accept.includes('text/html');
    const isJsonAccept = accept.includes('application/json') || accept.includes('*/*');
    const isAjax = (req.get('x-requested-with') || '').toLowerCase() === 'xmlhttprequest' || req.xhr;

    if (isHtmlNav && !isAjax) {
        // Redirect browser navigations to the SPA root so users see the styled frontend.
        return res.redirect('/');
    }

    // If the request doesn't accept JSON and is not an AJAX call, reject access.
    if (!isJsonAccept && !isAjax) {
        return res.status(403).json({ success: false, message: 'Direct browser access to API endpoints is not allowed.' });
    }

    return next();
});

const mongoUri = process.env.MONGO_URI;

let currentEngineStatus = 'Idle';
let _lastEngineEmit = { msg: '', at: 0 };
let dbReady = false;
let shuttingDown = false;

const liveStreamWindowMs = Number.parseInt(process.env.LIVE_STREAM_WINDOW_MS || '10000', 10);
const liveStreamMaxBatchSize = Number.parseInt(process.env.LIVE_STREAM_MAX_BATCH_SIZE || '250', 10);

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

function pad2(value) {
    return String(value).padStart(2, '0');
}

function getLiveDatasetLabel(date = new Date()) {
    return `LIVE_STREAM_${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}_${pad2(date.getUTCHours())}00Z`;
}

function hashDatasetLabel(label) {
    return crypto.createHash('sha256').update(label).digest('hex');
}

mongoose.connection.on('connected', () => { dbReady = true; });
mongoose.connection.on('disconnected', () => { dbReady = false; });

// Helper: gather current state for clients to sync
async function getSyncState() {
    try {
        const [alerts, files, logs] = await Promise.all([
            Alert.find().sort({ riskScore: -1 }).limit(1000).lean(),
            ProcessedFile.find().sort({ processedAt: -1 }).lean(),
            ActivityLog.find().sort({ timestamp: -1 }).limit(200).lean(),
        ]);
        const metrics = readJsonFileSafe(metricsPath) || {};
        return { alerts, files, logs, config: { thresholds: metrics.thresholds || null, modelMetrics: metrics.metrics || null } };
    } catch (err) {
        console.error('[!] Failed to build sync state:', err && err.message ? err.message : err);
        return { alerts: [], files: [], logs: [], config: {} };
    }
}

async function broadcastSync() {
    const state = await getSyncState();
    try { io.emit('SYNC_STATE', state); } catch (e) { console.error('[!] Failed to broadcast SYNC_STATE', e); }
}

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

function registerActiveChildProcess(childProcess) {
    if (!childProcess) {
        return;
    }

    activeChildProcesses.add(childProcess);

    const cleanup = () => {
        activeChildProcesses.delete(childProcess);
    };

    childProcess.once('close', cleanup);
    childProcess.once('error', cleanup);
}

async function stopActiveChildProcesses() {
    const processes = Array.from(activeChildProcesses);
    if (processes.length === 0) {
        return;
    }

    console.log(` [!] Stopping ${processes.length} active child process(es)...`);
    for (const childProcess of processes) {
        try {
            if (!childProcess.killed) {
                childProcess.kill('SIGTERM');
                setTimeout(() => {
                    try {
                        if (!childProcess.killed) {
                            childProcess.kill('SIGKILL');
                        }
                    } catch (error) {
                        console.error('[!] Failed to SIGKILL child process:', error);
                    }
                }, 5000).unref?.();
            }
        } catch (error) {
            console.error('[!] Failed to stop child process:', error);
        }
    }
}

process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    console.error('[!] Unhandled promise rejection:', reason);
    currentEngineStatus = 'Engine Failure';
    emitEngineProgress(currentEngineStatus);
    try {
        io.emit('ENGINE_ERROR', { message });
    } catch (emitError) {
        console.error('[!] Failed to emit ENGINE_ERROR:', emitError);
    }
});

async function shutdown(signal) {
    if (shuttingDown) {
        return;
    }

    shuttingDown = true;
    console.log(` [!] Received ${signal}; shutting down gracefully...`);
    await stopActiveChildProcesses();
    stopRetrainScheduler();

    try {
        await liveStreamProcessor.stop();
        await new Promise((resolve) => server.close(resolve));
        await mongoose.connection.close();
        console.log(' [+] MongoDB connection closed. Shutdown complete.');
        process.exit(0);
    } catch (error) {
        console.error(' [!] Graceful shutdown failed:', error);
        process.exit(1);
    }
}

process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
});

process.once('SIGINT', () => {
    void shutdown('SIGINT');
});

const metricsPath = path.join(__dirname, '../ml-pipeline/outputs/model_metrics.json');

// Track socket connections per remote address and limit to prevent resource exhaustion
const socketCountsByAddress = new Map();
const MAX_SOCKETS_PER_ADDRESS = Number.parseInt(process.env.MAX_SOCKETS_PER_ADDRESS || '6', 10);

io.on('connection', (socket) => {
    const addr = (socket.handshake && (socket.handshake.address || socket.handshake.headers['x-forwarded-for'])) || socket.request?.connection?.remoteAddress || 'unknown';
    const key = String(addr).split(':').slice(-1).join(''); // normalize IPv6/IPv4
    const current = socketCountsByAddress.get(key) || 0;

    if (current >= MAX_SOCKETS_PER_ADDRESS) {
        console.warn(` [!] Socket connection limit exceeded for ${key} (current=${current}). Rejecting socket ${socket.id}`);
        try { socket.emit('ERROR', { message: 'Too many connections from this client' }); } catch (e) {}
        socket.disconnect(true);
        return;
    }

    socketCountsByAddress.set(key, current + 1);
    console.log(` [+] Analyst Dashboard Connected (WebSocket ID: ${socket.id}, addr: ${key}, count: ${current + 1})`);

    // Send initial sync state to the connecting client so all sessions show same data
    (async () => {
        try {
            const state = await getSyncState();
            socket.emit('SYNC_STATE', state);
        } catch (e) { console.error('[!] Failed to send initial SYNC_STATE to socket', e); }
    })();

    socket.on('disconnect', (reason) => {
        const prev = socketCountsByAddress.get(key) || 1;
        const next = Math.max(0, prev - 1);
        if (next === 0) socketCountsByAddress.delete(key);
        else socketCountsByAddress.set(key, next);
        console.log(` [-] Analyst Dashboard Disconnected (WebSocket ID: ${socket.id}, addr: ${key}, remaining: ${next}) reason=${reason}`);
    });
});

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, '../ml-pipeline/data')),
    filename: (req, file, cb) => cb(null, `live_stream_${Date.now()}.csv`)
});

// Note: we construct a multer instance per-request below so the file size limit can be adjusted at runtime.
const upload = multer({ storage: storage, limits: { fileSize: maxUploadSizeMB * 1024 * 1024 } });

const HARD_UPLOAD_CAP_MB = Number.parseInt(process.env.HARD_UPLOAD_CAP_MB || '1024', 10);

function getMulterMiddleware(overrideMB) {
    let effectiveMB = null;

    // Per-upload override is authoritative for that request, as long as it stays under the hard cap.
    if (typeof overrideMB === 'number' && !Number.isNaN(overrideMB) && overrideMB > 0) {
        effectiveMB = Math.min(overrideMB, HARD_UPLOAD_CAP_MB);
    } else if (uploadLimitEnabled) {
        // Fall back to the persisted global default when no per-upload override is provided.
        effectiveMB = Math.min(Number.parseInt(maxUploadSizeMB || 0, 10) || 0, HARD_UPLOAD_CAP_MB);
    } else {
        // If global limiting is disabled and no override is provided, still keep a sane hard cap.
        effectiveMB = HARD_UPLOAD_CAP_MB;
    }

    const limits = { fileSize: Number.parseInt(effectiveMB || 0, 10) * 1024 * 1024 };
    return multer({ storage: storage, limits });
}

// Ensure ml-pipeline data directory exists so uploads don't fail silently
const mlPipelineDataDir = path.join(__dirname, '../ml-pipeline/data');
try {
    fs.mkdirSync(mlPipelineDataDir, { recursive: true });
} catch (e) {
    console.error('[!] Could not ensure ml-pipeline data directory exists:', e && e.message ? e.message : e);
}

async function createLog(actor, actionType, message, accountId = null) {
    const log = new ActivityLog({ actor, actionType, message, accountId });
    await log.save();
    io.emit('NEW_LOG', log);
}

async function raiseModelGuardrailAlert({ sourceFileName, guardrail, scannedCount }) {
    if (!guardrail || !guardrail.downgradedToHighRisk || guardrail.downgradedToHighRisk <= 0) {
        return;
    }

    const message = 'XGBoost degraded due to duplicate live stream patterns. Retrain recommended or activate a standby model.';
    const accountId = 'MODEL-GUARDRAIL';
    const alert = {
        accountId,
        riskScore: 100,
        anomalyScore: 100,
        topFeatures: [
            {
                name: 'Guardrail_Trigger',
                raw: Number(scannedCount || 0),
                contribution: 100,
                direction: 'UP',
            },
        ],
        sourceFileName,
        rawTelemetry: {
            message,
            scannedCount: Number(scannedCount || 0),
            criticalShareMax: guardrail.criticalShareMax,
            criticalCountCappedTo: guardrail.criticalCountCappedTo,
            downgradedToHighRisk: guardrail.downgradedToHighRisk,
        },
        status: 'Critical',
        detectedAt: new Date(),
        kycData: {
            fullName: 'Model Guardrail',
            email: 'model-guardrail@nexus.local',
            phone: 'N/A',
            currentBalance: 'N/A',
            lastLoginIp: 'N/A',
            deviceType: 'XGBoost Model',
            recentTransactions: [],
        },
    };

    await Alert.bulkWrite([
        {
            updateOne: {
                filter: { accountId, sourceFileName },
                update: { $set: alert },
                upsert: true,
            },
        },
    ], { ordered: false });

    await createLog('AI_ENGINE', 'DETECTION', message, accountId);
}

function readJsonFileSafe(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf-8');
            try {
                return JSON.parse(raw);
            } catch (parseError) {
                console.error(`[!] Failed to parse JSON from ${filePath}:`, parseError.message);
                return null;
            }
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

async function validateCsvFile(filePath) {
    const preview = await fs.promises.readFile(filePath, { encoding: 'utf8' });
    const lines = preview
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);

    if (lines.length < 2) {
        throw new Error('Invalid CSV: upload must contain a header row and at least one data row.');
    }

    const header = lines[0];
    const sampleRow = lines[1];
    if (!header.includes(',') || !sampleRow.includes(',')) {
        throw new Error('Invalid CSV: expected comma-separated rows.');
    }

    return true;
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

async function requestLiveInferenceFromMlService(events) {
    const serviceBaseUrl = (process.env.ML_SERVICE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
    const endpoint = new URL('/predict_stream_batch', serviceBaseUrl);
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(600000),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Live ML batch request failed (${response.status}): ${errorText}`);
    }

    return response.json();
}

async function persistInferenceResults(fileHash, originalFileName, predictionPayload) {
    if (!predictionPayload || !predictionPayload.data) {
        return;
    }

    await ProcessedFile.findOneAndUpdate(
        { fileHash: fileHash },
        { $set: { totalAccountsScanned: predictionPayload.totalScanned || 0, sourceType: 'STATIC_INGEST' } },
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
        const batchSize = 5000;
        const totalBatches = Math.ceil(hydratedAlerts.length / batchSize);
        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
            const chunk = hydratedAlerts.slice(batchIndex * batchSize, (batchIndex + 1) * batchSize);
            const ops = chunk.map(alert => ({
                updateOne: {
                    filter: { accountId: alert.accountId, sourceFileName: alert.sourceFileName },
                    update: { $set: alert },
                    upsert: true,
                }
            }));
            currentEngineStatus = `Committing batch ${batchIndex + 1} of ${totalBatches}...`;
            emitEngineProgress(currentEngineStatus);
            await Alert.bulkWrite(ops, { ordered: false });
        }
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

    await raiseModelGuardrailAlert({
        sourceFileName: originalFileName,
        guardrail: predictionPayload.guardrail,
        scannedCount: predictionPayload.totalScanned || 0,
    });

    // Push a full sync to all connected sessions so they show the same data
    await broadcastSync();
    io.emit('SILENT_REFRESH');
}

async function persistLiveBatchResults(batchHash, batchLabel, predictionPayload) {
    if (!predictionPayload || !predictionPayload.data) {
        return;
    }

    await ProcessedFile.findOneAndUpdate(
        { fileHash: batchHash },
        {
            $setOnInsert: { fileHash: batchHash, fileName: batchLabel, sourceType: 'LIVE_STREAM' },
            $inc: { totalAccountsScanned: predictionPayload.totalScanned || 0 },
        },
        { upsert: true, returnDocument: 'after' }
    );

    const hydratedAlerts = predictionPayload.data.map(alert => ({
        ...alert,
        sourceFileName: batchLabel,
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
        const batchSize = 5000;
        const totalBatches = Math.ceil(hydratedAlerts.length / batchSize);
        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
            const chunk = hydratedAlerts.slice(batchIndex * batchSize, (batchIndex + 1) * batchSize);
            const ops = chunk.map(alert => ({
                updateOne: {
                    filter: { accountId: alert.accountId, sourceFileName: alert.sourceFileName },
                    update: { $set: alert },
                    upsert: true,
                }
            }));
            currentEngineStatus = `Committing batch ${batchIndex + 1} of ${totalBatches}...`;
            emitEngineProgress(currentEngineStatus);
            await Alert.bulkWrite(ops, { ordered: false });
        }
    }

    const criticalCount = hydratedAlerts.filter(a => a.status === 'Critical').length;
    const highRiskCount = hydratedAlerts.filter(a => a.status === 'High Risk').length;

    if (criticalCount > 0 || highRiskCount > 0) {
        io.emit('LIVE_STREAM_COMPLETE', {
            batchName: batchLabel,
            criticalCount,
            highRiskCount,
            scanned: predictionPayload.totalScanned || 0,
        });
        await createLog('AI_ENGINE', 'DETECTION', `Live stream batch ${batchLabel} completed with ${criticalCount} CRITICAL and ${highRiskCount} HIGH RISK anomalies.`);
    }

    await raiseModelGuardrailAlert({
        sourceFileName: batchLabel,
        guardrail: predictionPayload.guardrail,
        scannedCount: predictionPayload.totalScanned || 0,
    });

    // Push a full sync to all connected sessions so they show the same data
    await broadcastSync();
    io.emit('SILENT_REFRESH');
}

const liveStreamProcessor = createLiveStreamProcessor({
    windowMs: liveStreamWindowMs,
    maxBatchSize: liveStreamMaxBatchSize,
    onFlush: async ({ batchId, events, reason }) => {
        if (!events.length) {
            return { skipped: true };
        }

        const batchLabel = getLiveDatasetLabel(new Date());
        const batchHash = hashDatasetLabel(batchLabel);

        currentEngineStatus = `Scoring live batch (${events.length} events)...`;
        emitEngineProgress(currentEngineStatus);

        const predictionPayload = await requestLiveInferenceFromMlService(events);

        currentEngineStatus = 'Committing live stream results...';
        emitEngineProgress(currentEngineStatus);

        await persistLiveBatchResults(batchHash, batchLabel, predictionPayload);
        await createLog('SYSTEM', 'UPLOAD', `Live stream batch ${batchLabel} processed (${events.length} events, ${reason}).`);

        currentEngineStatus = 'Complete';
        emitEngineProgress(currentEngineStatus);

        return { batchId, count: predictionPayload.count || 0 };
    },
});

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

app.post('/api/live-events', createSimpleRateLimit({ windowMs: 60 * 1000, maxRequests: 120 }), async (req, res) => {
    try {
        const incoming = Array.isArray(req.body)
            ? req.body
            : Array.isArray(req.body?.events)
                ? req.body.events
                : req.body?.event || req.body;

        const events = Array.isArray(incoming) ? incoming : [incoming];
        const validEvents = events.filter(event => event && typeof event === 'object');

        if (validEvents.length === 0) {
            return res.status(400).json({ success: false, message: 'No live events provided.' });
        }

        const result = await liveStreamProcessor.enqueue(validEvents);
        res.status(202).json({ success: true, accepted: result.accepted, queued: result.queued });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
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
                    await fs.promises.unlink(path.join(dataDir, file)).catch(error => {
                        console.warn('[!] Could not delete live stream file:', error.message);
                    });
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

app.post('/api/upload', uploadRateLimiter, async (req, res) => {
    // Determine per-upload override from query param (e.g., ?max_upload_mb=50)
    const overrideRaw = req.query?.max_upload_mb || req.get('x-max-upload-mb');
    const overrideMB = overrideRaw ? Number.parseInt(String(overrideRaw), 10) : undefined;

    console.log(`[+] Upload request received: overrideRaw=${overrideRaw || 'none'}, overrideMB=${Number.isNaN(overrideMB) ? 'NaN' : (overrideMB ?? 'none')}, globalMaxMB=${maxUploadSizeMB}, enabled=${uploadLimitEnabled}, hardCapMB=${HARD_UPLOAD_CAP_MB}`);

    // Use a per-request multer instance so runtime-configurable limits apply
    const mw = getMulterMiddleware(overrideMB).single('telemetryFile');
    mw(req, res, async (err) => {
        let targetCsvPath = null;
        let fullPath = null;
        let originalFileName = null;

        if (err) {
            if (err instanceof multer.MulterError) {
                if (err.code === 'LIMIT_FILE_SIZE' || (err.message && err.message.toLowerCase().includes('file too large'))) {
                    return res.status(413).json({ success: false, message: 'File too large', maxUploadMB: maxUploadSizeMB });
                }
                return res.status(400).json({ success: false, message: err.message || 'Upload error' });
            }
            console.error('[!] Upload middleware error:', err);
            return res.status(500).json({ success: false, message: 'Upload failed' });
        }

        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

            targetCsvPath = path.join('data', req.file.filename);
            fullPath = path.join(__dirname, '../ml-pipeline/data', req.file.filename);
            originalFileName = req.file.originalname;

        currentEngineStatus = 'Hashing file for deduplication check...';
        emitEngineProgress(currentEngineStatus);
        try {
            const fileHash = await hashFileSha256(fullPath);

            await validateCsvFile(fullPath);

            const existingFile = await ProcessedFile.findOne({ fileHash: fileHash });
            if (existingFile) {
                    await fs.promises.unlink(fullPath).catch(error => {
                        console.warn('[!] Could not delete duplicate file:', error.message);
                    });
                currentEngineStatus = 'Duplicate Rejected';
                emitEngineProgress(currentEngineStatus);
                await createLog('SYSTEM', 'REJECTION', `Data Replay Blocked: Uploaded dataset hash [${fileHash.substring(0, 8)}...] already exists in system.`);
                return res.status(409).json({ success: false, message: 'DUPLICATE_FILE' });
            }

            await ProcessedFile.create({ fileHash: fileHash, fileName: originalFileName, sourceType: 'STATIC_INGEST' });
            await createLog('SYSTEM', 'UPLOAD', `New telemetry stream ingested: ${originalFileName}`);

            currentEngineStatus = 'Initializing Nexus ML Engine...';
            emitEngineProgress(currentEngineStatus);

            res.status(202).json({ success: true, message: 'Upload accepted. Processing started.' });

            void (async () => {
                try {
                    const predictionPayload = await requestInferenceFromMlService(targetCsvPath);

                    if (!predictionPayload || Number(predictionPayload.totalScanned || 0) <= 0) {
                        await ProcessedFile.deleteOne({ fileHash });
                        await fs.promises.unlink(fullPath).catch(() => {});
                        currentEngineStatus = 'Engine Failure';
                        emitEngineProgress(currentEngineStatus);
                        await createLog('SYSTEM', 'REJECTION', `Upload rejected: ${originalFileName} did not contain any parsable CSV rows.`);
                        return;
                    }

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
        } catch (hashErr) {
                console.error('[!] File hashing or persistence error:', hashErr);
                currentEngineStatus = 'Engine Failure';
                emitEngineProgress(currentEngineStatus);
                if (typeof fullPath === 'string') {
                    await fs.promises.unlink(fullPath).catch(unlinkError => {
                        console.warn('[!] Could not delete failed upload file:', unlinkError.message);
                    });
                }
                if (!res.headersSent) {
                    return res.status(500).json({ success: false, message: 'Failed to process uploaded file.' });
                }
        }
    });
});

async function bootstrap() {
    try {
        if (!mongoUri) {
            throw new Error('MONGO_URI is required.');
        }

        await mongoose.connect(mongoUri);
        console.log(' [+] Connected to Nexus NoSQL Database');
        // Load persisted runtime settings
        try {
            const s = await Setting.findOne({ key: 'uploadConfig' }).lean();
            if (s && s.value) {
                if (typeof s.value.maxUploadMB === 'number') maxUploadSizeMB = s.value.maxUploadMB;
                if (typeof s.value.enabled === 'boolean') uploadLimitEnabled = s.value.enabled;
                console.log(` [+] Loaded uploadConfig from DB: maxUploadMB=${maxUploadSizeMB}, enabled=${uploadLimitEnabled}`);
            }
        } catch (err) { console.error('[!] Failed to load uploadConfig from DB:', err && err.message ? err.message : err); }

        startRetrainScheduler(registerActiveChildProcess);
        liveStreamProcessor.start();
        server.listen(PORT, () => console.log(` [+] Nexus Backend & WebSocket listening on port ${PORT}`));
    } catch (err) {
        console.error(' [!] Database Connection Error:', err);
        process.exit(1);
    }
}

bootstrap();
server.setTimeout(600000);

// Runtime upload configuration endpoints
app.get('/api/upload-config', (req, res) => {
    res.json({ success: true, maxUploadMB: Number.isFinite(maxUploadSizeMB) ? maxUploadSizeMB : null, enabled: Boolean(uploadLimitEnabled) });
});

app.post('/api/upload-config', async (req, res) => {
    try {
        const { maxUploadMB, enabled } = req.body || {};
        if (typeof enabled === 'boolean') uploadLimitEnabled = enabled;
        if (maxUploadMB === null) {
            uploadLimitEnabled = false;
        } else if (typeof maxUploadMB === 'number' || (typeof maxUploadMB === 'string' && maxUploadMB !== '')) {
            const parsed = Number.parseInt(maxUploadMB, 10);
            if (!Number.isNaN(parsed) && parsed > 0) {
                maxUploadSizeMB = parsed;
                uploadLimitEnabled = true;
            }
        }

        // Persist to DB so settings survive restarts
        try {
            await Setting.updateOne(
                { key: 'uploadConfig' },
                { $set: { value: { maxUploadMB: maxUploadSizeMB, enabled: uploadLimitEnabled }, updatedAt: new Date() } },
                { upsert: true }
            );
        } catch (err) {
            console.error('[!] Failed to persist uploadConfig to DB:', err && err.message ? err.message : err);
        }

        // Response reflects the effective runtime values
        return res.json({ success: true, maxUploadMB: maxUploadSizeMB, enabled: uploadLimitEnabled });
    } catch (err) {
        return res.status(500).json({ success: false, message: err && err.message ? err.message : 'Failed to update upload config' });
    }
});

// Centralized error handler for upload-related errors (Multer)
app.use((err, req, res, next) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
        console.error('[!] Multer upload error:', err && err.message ? err.message : err);
        if (err.code === 'LIMIT_FILE_SIZE' || err.message && err.message.toLowerCase().includes('file too large')) {
            return res.status(413).json({ success: false, message: 'File too large', maxUploadMB: maxUploadSizeMB });
        }

        return res.status(400).json({ success: false, message: err.message || 'Upload error' });
    }

    // fallback for other errors — log and pass through
    console.error('[!] Unhandled error in request pipeline:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, message: err && err.message ? err.message : 'Internal Server Error' });
});