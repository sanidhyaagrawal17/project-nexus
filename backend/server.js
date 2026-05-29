const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();
const mongoose = require('mongoose');
// Conditional lightweight faker shim for test environments to avoid ESM parsing issues in Jest.
let faker;
if (String(process.env.NODE_ENV || '').toLowerCase() === 'test') {
    faker = {
        person: { fullName: () => 'Test User' },
        internet: { email: () => 'test@example.local', ipv4: () => '127.0.0.1' },
        phone: { number: () => '000-000-0000' },
        finance: { amount: ({ min = 0 }) => String(min) },
        helpers: { arrayElement: (arr) => (Array.isArray(arr) ? arr[0] : arr) },
        string: { uuid: () => '00000000-0000-0000-0000-000000000000' },
        date: { recent: () => new Date() }
    };
} else {
    ({ faker } = require('@faker-js/faker'));
}
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
const { spawn } = require('child_process');

const app = express();
const PORT = Number.parseInt(process.env.PORT || '5000', 10);
const server = http.createServer(app);
const IS_TEST = String(process.env.NODE_ENV || '').toLowerCase() === 'test';
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
const rawEnvMB = String(process.env.MAX_UPLOAD_SIZE_MB || '100').replace(/[^0-9]/g, '');
let maxUploadSizeMB = Number.parseInt(rawEnvMB || '100', 10);
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

// Simple role check middleware for Admin-only endpoints
function requireAdmin(req, res, next) {
    try {
        const role = String(req.get('X-User-Role') || '').trim();
        if (role !== 'Admin') {
            return res.status(403).json({ success: false, message: 'Forbidden: admin role required' });
        }
        return next();
    } catch (err) {
        return res.status(403).json({ success: false, message: 'Forbidden' });
    }
}

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

// Lightweight wrapper that delegates to express-rate-limit while keeping a
// compatible factory signature. This avoids the previous Map-based implementation
// that never cleaned up keys and caused a memory leak.
function createSimpleRateLimit({ windowMs, maxRequests }) {
    return rateLimit({
        windowMs: Number(windowMs) || 60 * 1000,
        max: Number(maxRequests) || 60,
        standardHeaders: true,
        legacyHeaders: false,
        message: { success: false, message: 'Too many requests. Please try again later.' },
    });
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
const diagOutputsDir = path.join(__dirname, '../ml-pipeline/outputs');
const DIAG_THRESHOLD_MS = Number.parseInt(process.env.DIAG_THRESHOLD_MS || String(60 * 1000), 10);

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

async function gatherScoringDiagnostics({ fileHash, fullPath, originalFileName } = {}) {
    try {
        const timestamp = Date.now();
        const note = {
            timestamp,
            fileHash: fileHash || null,
            originalFileName: originalFileName || null,
            nodePid: process.pid,
            memory: process.memoryUsage(),
            dbReady: Boolean(dbReady),
            env: { ML_SERVICE_URL: process.env.ML_SERVICE_URL || null },
            file: null,
            hostDns: null,
            healthChecks: [],
        };

        // file stats and preview
        if (fullPath && fs.existsSync(fullPath)) {
            try {
                const st = await fs.promises.stat(fullPath);
                note.file = { path: fullPath, size: st.size, mtime: st.mtimeMs };
                const raw = await fs.promises.readFile(fullPath, { encoding: 'utf8' });
                note.file.preview = raw.split(/\r?\n/).slice(0, 20);
            } catch (e) { note.filePreviewError = String(e && e.message ? e.message : e); }
        }

        // DNS / health checks for common candidates
        const candidates = [];
        if (process.env.ML_SERVICE_URL) candidates.push(String(process.env.ML_SERVICE_URL).replace(/\/$/, ''));
        candidates.push('http://ml-pipeline:8000');
        candidates.push('http://127.0.0.1:8000');

        const dns = require('dns').promises;
        for (const base of candidates) {
            try {
                const url = new URL('/healthz', base);
                const host = url.hostname;
                try {
                    const lookup = await dns.lookup(host).catch(() => null);
                    note.hostDns = note.hostDns || {};
                    note.hostDns[host] = lookup || null;
                } catch (e) { note.hostDns = note.hostDns || {}; note.hostDns[host] = String(e && e.message ? e.message : e); }

                try {
                    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
                    const txt = await res.text().catch(() => null);
                    note.healthChecks.push({ base, status: res.status, body: typeof txt === 'string' && txt.length ? txt.slice(0, 200) : null });
                } catch (e) {
                    note.healthChecks.push({ base, error: String(e && e.message ? e.message : e) });
                }
            } catch (err) {
                note.healthChecks.push({ base, error: String(err && err.message ? err.message : err) });
            }
        }

        // ensure outputs dir exists
        try { await fs.promises.mkdir(diagOutputsDir, { recursive: true }); } catch {}
        const outPath = path.join(diagOutputsDir, `diagnostics_${timestamp}.json`);
        await fs.promises.writeFile(outPath, JSON.stringify(note, null, 2), 'utf8');

        // Emit socket event and system log so analysts see the diag
        try { io.emit('ENGINE_DIAG', { fileHash, originalFileName, path: outPath }); } catch {}
        await createLog('SYSTEM', 'DIAG', `Diagnostics captured for ${originalFileName || fileHash || 'unknown'} -> ${outPath}`);
        console.log('[+] Diagnostics written to', outPath);
        return outPath;
    } catch (err) {
        console.error('[!] Failed to gather scoring diagnostics:', err && err.message ? err.message : err);
    }
}

// small utility sleep
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
    const candidates = [];
    if (process.env.ML_SERVICE_URL) candidates.push(String(process.env.ML_SERVICE_URL).replace(/\/$/, ''));
    // Common service hostnames to try inside Docker networks
    candidates.push('http://ml-pipeline:8000');
    candidates.push('http://127.0.0.1:8000');

    const fullPath = path.join(__dirname, '../ml-pipeline', csvPath);
    let lastErr = null;

    for (const base of candidates) {
        const endpoint = new URL('/predict', base);
        // try a few retries for transient network/DNS failures per candidate
        let attempt = 0;
        const maxAttempts = 3;
        while (attempt < maxAttempts) {
            attempt += 1;
            try {
                // First try: ask the ML service to read the already-written CSV by sending csv_path
                const params = new URLSearchParams();
                params.append('csv_path', csvPath);
                params.append('output_path', '');

                console.log(`[+] ML request attempt #${attempt} to ${endpoint.toString()} with csv_path=${csvPath}`);

                const res = await fetch(endpoint, {
                    method: 'POST',
                    body: params,
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    signal: AbortSignal.timeout(600000),
                });

                const txt = await res.text();
                if (res.ok) {
                    try { return JSON.parse(txt); } catch (e) { return JSON.parse(await Promise.resolve(txt)); }
                }

                // If the service explicitly asks for a file or csv_path, attempt multipart upload fallback
                if (res.status === 400 && String(txt || '').toLowerCase().includes('either file or csv_path must be provided')) {
                    try {
                        console.log('[+] ML service requested multipart upload; attempting native FormData file upload fallback');
                        const fileBuffer = await fs.promises.readFile(fullPath);
                        const form = new globalThis.FormData();
                        const blob = new globalThis.Blob([fileBuffer], { type: 'text/csv' });
                        form.append('file', blob, path.basename(fullPath));
                        form.append('output_path', '');

                        const resp = await fetch(endpoint, {
                            method: 'POST',
                            body: form,
                            signal: AbortSignal.timeout(600000),
                        });

                        const body = await resp.text();
                        if (resp.ok) return JSON.parse(body);
                        throw new Error(`Multipart ML service request failed (${resp.status}): ${body}`);
                    } catch (multipartErr) {
                        lastErr = multipartErr;
                        console.error('[!] Multipart fallback failed:', multipartErr && multipartErr.message ? multipartErr.message : multipartErr);
                        // try next candidate
                        break; // break retry loop and move to next base
                    }
                }

                // Otherwise, return the error payload
                throw new Error(`ML service request failed (${res.status}): ${txt}`);
            } catch (err) {
                const msg = err && err.message ? err.message : String(err);
                console.error(`[!] Failed ML request attempt #${attempt} to ${base}:`, msg);
                lastErr = err;
                // If DNS lookup failed, wait a bit and retry; otherwise break
                if (msg.toLowerCase().includes('getaddrinfo') || msg.toLowerCase().includes('enotfound') || msg.toLowerCase().includes('econnrefused')) {
                    if (attempt < maxAttempts) {
                        await sleep(500 * attempt);
                        continue; // retry same candidate
                    }
                }
                // non-retriable or exhausted attempts: move to next candidate
                break;
            }
        }
        // try next base candidate
        continue;
    }

    throw lastErr || new Error('ML service request failed: no candidates succeeded');
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

    // Process incoming payload in bounded batches and hydrate each batch with
    // Faker-generated kyc data to avoid allocating the entire dataset in memory.
    const incoming = Array.isArray(predictionPayload.data) ? predictionPayload.data : [];
    let criticalCount = 0;
    let highRiskCount = 0;
    const batchSize = 5000;
    const totalBatches = Math.ceil(incoming.length / batchSize);
    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
        const rawChunk = incoming.slice(batchIndex * batchSize, (batchIndex + 1) * batchSize);
        const hydratedChunk = rawChunk.map(alert => ({
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

        if (hydratedChunk.length > 0) {
            const ops = hydratedChunk.map(alert => ({
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

        // Tally counts from this hydrated chunk
        for (const a of hydratedChunk) {
            if (a.status === 'Critical') criticalCount += 1;
            if (a.status === 'High Risk') highRiskCount += 1;
        }
    }

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

    // Process live batch payload in bounded chunks and hydrate on-the-fly.
    const incoming = Array.isArray(predictionPayload.data) ? predictionPayload.data : [];
    let criticalCount = 0;
    let highRiskCount = 0;
    const batchSize = 5000;
    const totalBatches = Math.ceil(incoming.length / batchSize);
    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
        const rawChunk = incoming.slice(batchIndex * batchSize, (batchIndex + 1) * batchSize);
        const hydratedChunk = rawChunk.map(alert => ({
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

        if (hydratedChunk.length > 0) {
            const ops = hydratedChunk.map(alert => ({
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

        for (const a of hydratedChunk) {
            if (a.status === 'Critical') criticalCount += 1;
            if (a.status === 'High Risk') highRiskCount += 1;
        }
    }

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
            const page = Math.max(1, Number.parseInt(req.query.page || '1', 10));
            const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit || '12', 10)));
            const skip = (page - 1) * limit;

            // Filters
            const q = {};
            const dataset = req.query.dataset;
            const status = req.query.status; // e.g., 'Critical' or 'High Risk'
            const search = req.query.search; // free text search on accountId or feature name

            if (dataset && dataset !== 'ALL') {
                q.sourceFileName = dataset;
            }

            if (status && status !== 'ALL') {
                q.status = status;
            }

            if (search && String(search).trim()) {
                const s = String(search).trim();
                // match accountId or topFeatures.name
                q.$or = [
                    { accountId: { $regex: s, $options: 'i' } },
                    { 'topFeatures.name': { $regex: s, $options: 'i' } },
                ];
            }

            const [total, data] = await Promise.all([
                Alert.countDocuments(q),
                Alert.find(q).sort({ riskScore: -1 }).skip(skip).limit(limit).lean(),
            ]);

            res.json({ success: true, total, page, limit, data });
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



// Protect system-wipe: admin-only
// Re-register the route with requireAdmin
app.delete('/api/system-wipe', requireAdmin, createSimpleRateLimit({ windowMs: 15 * 60 * 1000, maxRequests: 3 }), async (req, res) => {
    // delegate to existing handler by calling same logic (kept simple duplication for clarity)
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
        return res.json({ success: true, message: 'System Wiped Successfully' });
    } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
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
                    // Start a diagnostics timer: if scoring takes longer than DIAG_THRESHOLD_MS,
                    // gather system/file/health diagnostics for investigation.
                    let diagTimer = null;
                    let diagFired = false;
                    try {
                        diagTimer = setTimeout(async () => {
                            diagFired = true;
                            try { await gatherScoringDiagnostics({ fileHash, fullPath, originalFileName }); } catch (e) { console.error('[!] diag timer error', e); }
                        }, DIAG_THRESHOLD_MS);

                        const predictionPayload = await requestInferenceFromMlService(targetCsvPath);
                        // clear diag timer if finished in time
                        if (diagTimer) { clearTimeout(diagTimer); diagTimer = null; }

                        // proceed with handling predictionPayload as before
                        
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
                    } finally {
                        if (diagTimer) { clearTimeout(diagTimer); }
                    }
                    
                } catch (error) {
                    try {
                        console.error('[!] ML Service Error:', error);
                        currentEngineStatus = 'Engine Failure';
                        emitEngineProgress(currentEngineStatus);
                        const message = (error && error.message) ? error.message : String(error || 'Unknown ML service error');
                        try { io.emit('ENGINE_ERROR', { message }); } catch (emitErr) { console.error('[!] Failed to emit ENGINE_ERROR:', emitErr); }
                        await createLog('SYSTEM', 'ERROR', `ML Service Error: ${message}`);
                    } catch (innerErr) {
                        console.error('[!] Failed handling ML Service Error:', innerErr);
                    }
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
                let val = s.value;
                if (typeof val === 'string') {
                    try { val = JSON.parse(val); } catch (e) { /* not JSON, keep as string */ }
                }
                if (val && typeof val === 'object') {
                    // maxUploadMB may be a number or a string like "1000" or "1GB"; normalize to integer MB
                    if (typeof val.maxUploadMB === 'number') {
                        maxUploadSizeMB = val.maxUploadMB;
                    } else if (typeof val.maxUploadMB === 'string') {
                        const digits = String(val.maxUploadMB).replace(/[^0-9]/g, '');
                        if (digits) maxUploadSizeMB = Number.parseInt(digits, 10);
                    }
                    if (typeof val.enabled === 'boolean') uploadLimitEnabled = val.enabled;
                }
                console.log(` [+] Loaded uploadConfig from DB: maxUploadMB=${maxUploadSizeMB}, enabled=${uploadLimitEnabled}`);
            }
        } catch (err) { console.error('[!] Failed to load uploadConfig from DB:', err && err.message ? err.message : err); }

        // In test mode we avoid starting background schedulers and the live stream processor
        // to keep the test environment lightweight and deterministic.
        if (!IS_TEST) {
            startRetrainScheduler(registerActiveChildProcess);
            liveStreamProcessor.start();
            server.listen(PORT, () => console.log(` [+] Nexus Backend & WebSocket listening on port ${PORT}`));
        } else {
            console.log(' [+] Bootstrapped in test mode (no background jobs started)');
        }
    } catch (err) {
        console.error(' [!] Database Connection Error:', err);
        process.exit(1);
    }
}

// Export bootstrap for tests to call when NODE_ENV=test. In normal runs bootstrap() is invoked immediately.
async function exportedBootstrap() { return bootstrap(); }

if (!IS_TEST) {
    bootstrap();
}

module.exports = { app, server, bootstrap: exportedBootstrap, IS_TEST };
server.setTimeout(600000);

// Runtime upload configuration endpoints
app.get('/api/upload-config', (req, res) => {
    res.json({ success: true, maxUploadMB: Number.isFinite(maxUploadSizeMB) ? maxUploadSizeMB : null, enabled: Boolean(uploadLimitEnabled) });
});

app.post('/api/upload-config', requireAdmin, async (req, res) => {
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
                    { $set: { value: JSON.stringify({ maxUploadMB: maxUploadSizeMB, enabled: uploadLimitEnabled }), updatedAt: new Date() } },
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

// Analyst: mark an alert's mule status
app.put('/api/alerts/:id/mule', createSimpleRateLimit({ windowMs: 60 * 1000, maxRequests: 30 }), async (req, res) => {
    try {
        const { id } = req.params;
        // allow JSON body, form-encoded, query param or header fallback for convenience
        const fromBody = (req.body && req.body.muleStatus) ? String(req.body.muleStatus) : null;
        const fromQuery = req.query && req.query.muleStatus ? String(req.query.muleStatus) : null;
        const fromHeader = req.get('X-Mule-Status') ? String(req.get('X-Mule-Status')) : null;
        const muleStatus = fromBody || fromQuery || fromHeader || null;
        const allowed = ['Pending', 'Confirmed Mule', 'Not a Mule'];
        if (!muleStatus || !allowed.includes(muleStatus)) return res.status(400).json({ success: false, message: 'Invalid muleStatus' });

        const alert = await Alert.findByIdAndUpdate(id, { $set: { muleStatus } }, { new: true }).lean();
        if (!alert) return res.status(404).json({ success: false, message: 'Alert not found' });

        await createLog('ANALYST', 'MULE', `Analyst marked account ${alert.accountId} as ${muleStatus}`, alert.accountId);
        try { io.emit('MULE_UPDATED', alert); } catch (e) { /* ignore */ }
        return res.json({ success: true, data: alert });
    } catch (err) {
        console.error('[!] Failed to update mule status:', err && err.message ? err.message : err);
        return res.status(500).json({ success: false, message: err && err.message ? err.message : 'Failed to update mule status' });
    }
});

// Admin: trigger an immediate retrain job
app.post('/api/retrain', requireAdmin, async (req, res) => {
    try {
        const scriptPath = path.join(__dirname, '../ml-pipeline/retrain_cron.py');
        const pythonExecutable = process.env.PYTHON_EXECUTABLE || 'python3';
        const child = spawn(pythonExecutable, [scriptPath], {
            cwd: path.join(__dirname, '..'), env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        });
        registerActiveChildProcess(child);
        child.stdout.on('data', d => process.stdout.write(`[retrain stdout] ${d.toString()}`));
        child.stderr.on('data', d => process.stderr.write(`[retrain stderr] ${d.toString()}`));
        await createLog('SYSTEM', 'RETRAIN', 'Manual retrain started by admin');
        return res.status(202).json({ success: true, message: 'Retrain started' });
    } catch (err) {
        console.error('[!] Failed to start retrain:', err && err.message ? err.message : err);
        return res.status(500).json({ success: false, message: 'Failed to start retrain' });
    }
});