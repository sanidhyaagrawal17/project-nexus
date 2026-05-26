const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto'); 
const { spawn } = require('child_process');
const mongoose = require('mongoose');
const { faker } = require('@faker-js/faker');
const http = require('http');
const { Server } = require('socket.io');

const Alert = require('./models/Alert');
const ProcessedFile = require('./models/ProcessedFile');
const ActivityLog = require('./models/ActivityLog');
const AnalystFeedback = require('./models/AnalystFeedback');

const app = express();
const PORT = process.env.PORT || 5000;
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

mongoose.connect('mongodb://127.0.0.1:27017/nexusDB')
    .then(() => console.log(' [+] Connected to Nexus NoSQL Database'))
    .catch(err => console.error(' [!] Database Connection Error:', err));

let currentEngineStatus = "Idle";
const metricsPath = path.join(__dirname, '../ml-pipeline/outputs/model_metrics.json');

io.on('connection', (socket) => {
    console.log(` [+] Analyst Dashboard Connected (WebSocket ID: ${socket.id})`);
});

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, '../ml-pipeline/data')),
    filename: (req, file, cb) => cb(null, `live_stream_${Date.now()}.csv`)
});

const upload = multer({ storage: storage, limits: { fileSize: 500 * 1024 * 1024 } });

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

app.get('/api/alerts', async (req, res) => {
    try {
        const alerts = await Alert.find().sort({ riskScore: -1 });
        res.json({ success: true, count: alerts.length, data: alerts });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/datasets', async (req, res) => {
    try {
        const datasets = await Alert.distinct('sourceFileName');
        res.json({ success: true, data: datasets });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/logs', async (req, res) => {
    try {
        const logs = await ActivityLog.find().sort({ timestamp: -1 }).limit(200);
        res.json({ success: true, data: logs });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/files', async (req, res) => {
    try {
        const files = await ProcessedFile.find().sort({ processedAt: -1 });
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

app.delete('/api/system-wipe', async (req, res) => {
    try {
        await Alert.deleteMany({});
        await ProcessedFile.deleteMany({});
        await ActivityLog.deleteMany({});
        await AnalystFeedback.deleteMany({});
        
        // --- FIX 1: PHYSICAL STORAGE LEAK CLEANUP ---
        const dataDir = path.join(__dirname, '../ml-pipeline/data');
        if (fs.existsSync(dataDir)) {
            const files = fs.readdirSync(dataDir);
            for (const file of files) {
                if (file.startsWith('live_stream_') && file.endsWith('.csv')) {
                    fs.unlinkSync(path.join(dataDir, file)); // Physically scrubs the hard drive
                }
            }
        }

        await createLog('SYSTEM', 'RESOLUTION', 'Master System Wipe Executed. Databases and physical files completely scrubbed.');
        io.emit('SILENT_REFRESH');
        res.json({ success: true, message: "System Wiped Successfully" });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/resolve', async (req, res) => {
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

app.post('/api/upload', upload.single('telemetryFile'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded." });

    const targetCsvPath = path.join('data', req.file.filename);
    const fullPath = path.join(__dirname, '../ml-pipeline/data', req.file.filename);
    const originalFileName = req.file.originalname;

    currentEngineStatus = "Hashing file for deduplication check...";
    const fileBuffer = fs.readFileSync(fullPath);
    const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    const existingFile = await ProcessedFile.findOne({ fileHash: fileHash });
    if (existingFile) {
        fs.unlinkSync(fullPath); 
        currentEngineStatus = "Duplicate Rejected";
        await createLog('SYSTEM', 'REJECTION', `Data Replay Blocked: Uploaded dataset hash [${fileHash.substring(0,8)}...] already exists in system.`);
        return res.status(409).json({ success: false, message: "DUPLICATE_FILE" });
    }

    await ProcessedFile.create({ fileHash: fileHash, fileName: originalFileName });
    await createLog('SYSTEM', 'UPLOAD', `New telemetry stream ingested: ${originalFileName}`);

    currentEngineStatus = "Initializing Nexus ML Engine...";

    const pythonExe = process.platform === 'win32' ? '..\\ml-pipeline\\venv\\Scripts\\python.exe' : '../ml-pipeline/venv/bin/python';
    const pyProcess = spawn(pythonExe, ['predict_live.py', targetCsvPath], { cwd: path.join(__dirname, '../ml-pipeline') });

    pyProcess.stdout.on('data', (data) => {
        const output = data.toString();
        console.log(output.trim());
        if (output.includes('[*]')) {
            const cleanMessage = output.split('[*]')[1].split('\n')[0].trim();
            if (cleanMessage) currentEngineStatus = cleanMessage;
        }
    });

    pyProcess.stderr.on('data', (data) => console.error(`[!] Python Error: ${data}`));

    pyProcess.on('close', async (code) => {
        if (code === 0) {
            currentEngineStatus = "Committing to NoSQL Database...";
            try {
                const jsonPath = path.join(__dirname, '../ml-pipeline/nexus_alerts.json');
                const rawData = fs.readFileSync(jsonPath);
                const parsedData = JSON.parse(rawData);

                if (parsedData.data) {
                    
                    // --- FIX 2: STRICT ASYNC/AWAIT TO CURE THE '0 SCANNED' RACE CONDITION ---
                    await ProcessedFile.findOneAndUpdate(
                        { fileHash: fileHash },
                        { $set: { totalAccountsScanned: parsedData.totalScanned || 0 } },
                        { new: true } // Forces Mongo to finish writing to disk before moving on
                    );

                    const hydratedAlerts = parsedData.data.map(alert => ({
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

                    if(hydratedAlerts.length > 0) {
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
                    
                    // Emitting the refresh ONLY after all database writing is mathematically finalized
                    io.emit('SILENT_REFRESH'); 
                }

                currentEngineStatus = "Complete";
                res.status(200).json({ success: true, message: "Data processed and committed to DB." });
                
            } catch (dbError) {
                console.error("[!] Database Commit Error:", dbError);
                currentEngineStatus = "Database Error";
                res.status(500).json({ success: false, message: "Failed to save to database." });
            }
        } else {
            currentEngineStatus = "Engine Failure";
            res.status(500).json({ success: false, message: "ML Engine failed." });
        }
    });
});

server.listen(PORT, () => console.log(` [+] Nexus Backend & WebSocket listening on port ${PORT}`));
server.setTimeout(600000);