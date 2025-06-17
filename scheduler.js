const cron = require('node-cron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const sessionDir = path.join(__dirname, 'sessions');

// scheduledJobs: Map<testName, { task, cronExpression, lastRun: Date|null }>
const scheduledJobs = new Map();

function runTest(testName) {
    const statusFile = path.join(sessionDir, `${testName}.status.json`);
    const now = new Date();

    try {
        fs.writeFileSync(statusFile, JSON.stringify({ status: 'running', timestamp: now.toISOString() }));
    } catch (err) {
        console.error('❌ Failed to write run status:', err.message);
    }

    // Update lastRun timestamp
    if (scheduledJobs.has(testName)) {
        scheduledJobs.get(testName).lastRun = now;
    }

    const child = spawn('node', ['replay.js', testName], { stdio: ['ignore', 'pipe', 'pipe'] });

    child.stdout.on('data', data => {
        console.log(`[Scheduled replay.js stdout]: ${data.toString().trim()}`);
    });

    child.stderr.on('data', data => {
        console.error(`[Scheduled replay.js stderr]: ${data.toString().trim()}`);
    });

    child.on('close', code => {
        const status = code === 0 ? 'done' : 'failed';
        try {
            fs.writeFileSync(statusFile, JSON.stringify({ status, timestamp: new Date().toISOString() }));
        } catch (err) {
            console.error('❌ Failed to write final run status:', err.message);
        }
        console.log(`🕒 Scheduled run finished for test '${testName}' with exit code ${code}`);
    });
}

function scheduleTestRun(testName, cronExpression = '0 * * * *') {
    // Stop existing if any
    if (scheduledJobs.has(testName)) {
        scheduledJobs.get(testName).task.stop();
    }

    // Only support '0 * * * *' for now (hourly at minute 0)
    if (cronExpression !== '0 * * * *') {
        console.warn(`⚠️ Only '0 * * * *' cron expression (hourly) is supported currently. Ignoring others.`);
        cronExpression = '0 * * * *';
    }

    const task = cron.schedule(cronExpression, () => {
        console.log(`🕒 Scheduled run started for test: ${testName}`);
        runTest(testName);
    });

    scheduledJobs.set(testName, { task, cronExpression, lastRun: null });
    task.start();

    console.log(`🕒 Scheduled hourly run enabled for test: ${testName} with cron expression "${cronExpression}"`);
}

// Cancel scheduled job and remove from map
function cancelScheduledRun(testName) {
    if (scheduledJobs.has(testName)) {
        scheduledJobs.get(testName).task.stop();
        scheduledJobs.delete(testName);
        console.log(`🕒 Scheduled run canceled for test: ${testName}`);
    }
}

// Calculate next run time based on lastRun or current time
function getNextRunTime(testName) {
    if (!scheduledJobs.has(testName)) return null;

    const job = scheduledJobs.get(testName);
    const now = new Date();
    const lastRun = job.lastRun;

    // We only support hourly schedule at minute 0
    // Compute next run as next top of the hour after lastRun or now
    let base = lastRun && lastRun > now ? lastRun : now;
    let next = new Date(base);
    next.setMinutes(0, 0, 0); // set to start of hour

    if (next <= base) {
        next.setHours(next.getHours() + 1);
    }

    return next;
}

module.exports = {
    scheduleTestRun,
    cancelScheduledRun,
    scheduledJobs,
    getNextRunTime,
};
