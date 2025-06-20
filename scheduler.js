const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const sessionDir = path.join(__dirname, 'sessions');
const scheduledJobs = new Map();
const activeProcesses = new Set();
const queue = [];

function getTimestamp() {
    return new Date().toLocaleTimeString('en-GB'); // HH:mm:ss
}

function log(...args) {
    console.log(`[${getTimestamp()}]`, ...args);
}

function error(...args) {
    console.error(`[${getTimestamp()}]`, ...args);
}

// Run a test
function runTest(testName) {
    if (activeProcesses.size >= 3) {
        log(`⏳ Queuing test "${testName}" (limit reached)`);
        queue.push(testName);
        return;
    }

    const statusFile = path.join(sessionDir, `${testName}.status.json`);
    const now = new Date();
    fs.writeFileSync(statusFile, JSON.stringify({ status: 'running', timestamp: now.toISOString() }));

    if (scheduledJobs.has(testName)) {
        scheduledJobs.get(testName).lastRun = now;
    }

    const child = spawn('node', ['replay.js', testName], { stdio: ['ignore', 'pipe', 'pipe'] });
    activeProcesses.add(child);

    log(`🚀 Starting test "${testName}" (active: ${activeProcesses.size})`);

    child.stdout.on('data', data => {
        log(`[replay.js stdout]: ${data.toString().trim()}`);
    });

    child.stderr.on('data', data => {
        error(`[replay.js stderr]: ${data.toString().trim()}`);
    });

    child.on('close', code => {
        activeProcesses.delete(child);
        const status = code === 0 ? 'done' : 'failed';
        fs.writeFileSync(statusFile, JSON.stringify({ status, timestamp: new Date().toISOString() }));
        log(`✅ Test "${testName}" finished with exit code ${code} (${status})`);

        // Try to run next in queue
        if (queue.length > 0) {
            const nextTest = queue.shift();
            log(`🔁 Running next queued test: "${nextTest}"`);
            runTest(nextTest);
        }
    });
}

// Schedule test run (5 minutes after activation, repeating)
function scheduleTestRun(testName) {
    cancelScheduledRun(testName); // cancel previous if exists

    const job = {
        timeout: null,
        lastRun: null,
        scheduledAt: new Date(),
        startDelayMs: 60 * 60 * 1000, // 1 hour
    };

    function startTimer() {
        job.timeout = setTimeout(() => {
            runTest(testName);
            job.lastRun = new Date();
            startTimer(); // schedule next
        }, job.startDelayMs);
    }

    startTimer();
    scheduledJobs.set(testName, job);

    log(`🕒 Scheduled test "${testName}" to run every 5 minutes (offset from now)`);
}

// Cancel schedule
function cancelScheduledRun(testName) {
    const job = scheduledJobs.get(testName);
    if (job && job.timeout) {
        clearTimeout(job.timeout);
    }
    scheduledJobs.delete(testName);
    log(`🛑 Cancelled schedule for test "${testName}"`);
}

// When next run is expected
function getNextRunTime(testName) {
    if (!scheduledJobs.has(testName)) return null;

    const job = scheduledJobs.get(testName);
    const { lastRun, startDelayMs, scheduledAt } = job;

    const base = lastRun || scheduledAt || new Date();
    const nextRun = new Date(base.getTime() + (startDelayMs || 60 * 60 * 1000));

    return nextRun;
}

module.exports = {
    scheduleTestRun,
    cancelScheduledRun,
    scheduledJobs,
    getNextRunTime
};
