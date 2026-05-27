const cron = require('node-cron');
const path = require('path');
const { spawn } = require('child_process');

let retrainJob = null;

function startRetrainScheduler() {
    if (retrainJob) {
        return retrainJob;
    }

    retrainJob = cron.schedule('0 2 * * 0', () => {
        const scriptPath = path.join(__dirname, '../ml-pipeline/retrain_cron.py');
        const pythonExecutable = process.env.PYTHON_EXECUTABLE || 'python';

        console.log('[scheduler] Retraining job started.');

        const child = spawn(pythonExecutable, [scriptPath], {
            cwd: path.join(__dirname, '..'),
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });

        child.stdout.on('data', (data) => {
            process.stdout.write(`[retrain stdout] ${data.toString()}`);
        });

        child.stderr.on('data', (data) => {
            process.stderr.write(`[retrain stderr] ${data.toString()}`);
        });

        child.on('error', (error) => {
            console.error('[scheduler] Failed to spawn retraining process:', error);
        });

        child.on('close', (code) => {
            if (code === 0) {
                console.log('[scheduler] Retraining job completed successfully.');
            } else {
                console.error(`[scheduler] Retraining job exited with code ${code}.`);
            }
        });
    }, {
        scheduled: true,
        timezone: process.env.CRON_TIMEZONE || 'UTC',
    });

    return retrainJob;
}

module.exports = { startRetrainScheduler };