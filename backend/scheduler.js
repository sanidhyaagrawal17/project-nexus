const cron = require('node-cron');
const path = require('path');
const { spawn } = require('child_process');

let retrainJob = null;
let activeRetrainProcess = null;

function startRetrainScheduler() {
    if (retrainJob) {
        return retrainJob;
    }

    retrainJob = cron.schedule('0 2 * * 0', () => {
        const scriptPath = path.join(__dirname, '../ml-pipeline/retrain_cron.py');
        const pythonExecutable = process.env.PYTHON_EXECUTABLE || 'python3';

        console.log('[scheduler] Retraining job started.');

        activeRetrainProcess = spawn(pythonExecutable, [scriptPath], {
            cwd: path.join(__dirname, '..'),
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });

        activeRetrainProcess.stdout.on('data', (data) => {
            process.stdout.write(`[retrain stdout] ${data.toString()}`);
        });

        activeRetrainProcess.stderr.on('data', (data) => {
            process.stderr.write(`[retrain stderr] ${data.toString()}`);
        });

        activeRetrainProcess.on('error', (error) => {
            console.error('[scheduler] Failed to spawn retraining process:', error);
            activeRetrainProcess = null;
        });

        activeRetrainProcess.on('close', (code) => {
            if (code === 0) {
                console.log('[scheduler] Retraining job completed successfully.');
            } else {
                console.error(`[scheduler] Retraining job exited with code ${code}.`);
            }
            activeRetrainProcess = null;
        });
    }, {
        scheduled: true,
        timezone: process.env.CRON_TIMEZONE || 'UTC',
    });

    return retrainJob;
}

function stopRetrainScheduler() {
    if (retrainJob) {
        retrainJob.stop();
        retrainJob = null;
    }

    if (activeRetrainProcess && !activeRetrainProcess.killed) {
        activeRetrainProcess.kill('SIGTERM');
        setTimeout(() => {
            if (activeRetrainProcess && !activeRetrainProcess.killed) {
                activeRetrainProcess.kill('SIGKILL');
            }
        }, 5000).unref?.();
    }
}

module.exports = { startRetrainScheduler, stopRetrainScheduler };