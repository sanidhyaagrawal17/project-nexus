const { spawn } = require('child_process');
const Alert = require('../models/Alert'); // Your Mongoose model
const FileMetadata = require('../models/FileMetadata');

exports.processUpload = async (req, res) => {
    const filePath = req.file.path;
    const fileName = req.file.originalname;
    
    // Emit progress to dashboard via Socket.io
    req.io.emit('ENGINE_PROGRESS', { status: 'initializing nexus ml engine...', phase: 2 });

    const pythonProcess = spawn('python3', ['nexus_inference.py', filePath]);

    let dataString = '';

    pythonProcess.stdout.on('data', (data) => {
        dataString += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
        console.error(`Python stderr: ${data}`);
    });

    pythonProcess.on('close', async (code) => {
        if (code !== 0) {
            req.io.emit('ENGINE_ERROR', { message: 'Inference engine crashed' });
            return res.status(500).json({ success: false, message: 'Python execution failed' });
        }

        try {
            const parsedData = JSON.parse(dataString);
            
            if (!parsedData.success) {
                req.io.emit('ENGINE_ERROR', { message: parsedData.error });
                return res.status(500).json({ success: false, message: parsedData.error });
            }

            req.io.emit('ENGINE_PROGRESS', { status: 'committing to nosql database...', phase: 3 });

            const alertsToInsert = parsedData.data.map(item => ({
                ...item,
                sourceFileName: fileName,
                detectedAt: new Date(),
                muleStatus: 'Pending'
            }));

            // THE CRITICAL FIX: Bulk Insert with ordered: false
            // ordered: false ensures that if one row fails (e.g. unique constraint), 
            // the rest will still process instantly.
            await Alert.insertMany(alertsToInsert, { ordered: false });

            // Record the file metadata
            const criticalCount = alertsToInsert.filter(a => a.status === 'Critical').length;
            const highRiskCount = alertsToInsert.filter(a => a.status === 'High Risk').length;

            await FileMetadata.create({
                fileName: fileName,
                totalAccountsScanned: alertsToInsert.length,
                processedAt: new Date()
            });

            req.io.emit('ENGINE_PROGRESS', { status: 'Complete', phase: 4 });
            req.io.emit('SCAN_COMPLETE', { 
                fileName: fileName, 
                criticalCount, 
                highRiskCount 
            });

            res.status(200).json({ success: true, message: 'Scoring complete' });

        } catch (err) {
            console.error('Commit error:', err);
            req.io.emit('ENGINE_ERROR', { message: 'Database commit failed' });
            res.status(500).json({ success: false, message: 'Database error' });
        }
    });
};