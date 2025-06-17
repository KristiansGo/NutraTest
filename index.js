const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const scheduler = require('./scheduler');
const { getNextRunTime } = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

const sessionDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionDir)) {
  fs.mkdirSync(sessionDir, { recursive: true });
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/schedule', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'schedule.html'));
});

app.get('/tests', (req, res) => {
  if (!fs.existsSync(sessionDir)) {
    return res.json([]);
  }

  const files = fs.readdirSync(sessionDir)
    .filter(f => f.endsWith('.json') && !f.endsWith('.status.json') && !f.endsWith('.recording.status.json'));

  const tests = files.map(file => {
    const fullPath = path.join(sessionDir, file);
    const stats = fs.statSync(fullPath);

    let href = '';
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const session = JSON.parse(content);
      const firstNav = session.find(event => event.type === 'navigate' && event.href);
      href = firstNav ? firstNav.href : '';
    } catch {
      href = '';
    }

    const name = file.replace('.json', '');
    const scheduled = scheduler.scheduledJobs.has(name);

    return {
      name,
      href,
      mtime: stats.mtime,
      scheduled
    };
  });

  tests.sort((a, b) => b.mtime - a.mtime);

  res.json(tests);
});

app.get('/run/:testName', (req, res) => {
  const testName = req.params.testName;
  const sessionFile = path.join(sessionDir, `${testName}.json`);
  const statusFile = path.join(sessionDir, `${testName}.status.json`);

  if (!fs.existsSync(sessionFile)) {
    return res.status(404).json({ error: 'Test not found' });
  }

  try {
    fs.writeFileSync(statusFile, JSON.stringify({ status: 'running', timestamp: new Date().toISOString() }));
  } catch (err) {
    console.error('❌ Failed to write run status:', err.message);
  }

  res.json({ status: 'started' });

  const child = spawn('node', ['replay.js', testName], { stdio: ['ignore', 'pipe', 'pipe'] });

  child.stdout.on('data', (data) => {
    console.log(`[replay.js stdout]: ${data.toString().trim()}`);
  });

  child.stderr.on('data', (data) => {
    console.error(`[replay.js stderr]: ${data.toString().trim()}`);
  });

  child.on('close', (code) => {
    const status = code === 0 ? 'done' : 'failed';
    try {
      fs.writeFileSync(statusFile, JSON.stringify({ status, timestamp: new Date().toISOString() }));
    } catch (err) {
      console.error('❌ Failed to write final run status:', err.message);
    }
    console.log(`${status === 'done' ? '✅' : '❌'} Finished test '${testName}' with exit code ${code}`);
  });
});

app.get('/status/:testName', (req, res) => {
  const statusFile = path.join(sessionDir, `${req.params.testName}.status.json`);
  if (!fs.existsSync(statusFile)) {
    return res.json({ status: 'unknown', timestamp: null });
  }
  try {
    res.json(JSON.parse(fs.readFileSync(statusFile, 'utf-8')));
  } catch (err) {
    console.error('❌ Failed to read run status file:', err.message);
    res.json({ status: 'unknown', timestamp: null });
  }
});

app.get('/recording-status/:testName', (req, res) => {
  const recordingStatusFile = path.join(sessionDir, `${req.params.testName}.recording.status.json`);
  if (!fs.existsSync(recordingStatusFile)) {
    return res.json({ status: 'stopped', timestamp: null });
  }
  try {
    res.json(JSON.parse(fs.readFileSync(recordingStatusFile, 'utf-8')));
  } catch (err) {
    console.error('❌ Failed to read recording status file:', err.message);
    res.json({ status: 'stopped', timestamp: null });
  }
});

app.delete('/delete/:testName', (req, res) => {
  const testName = req.params.testName;
  const sessionFile = path.join(sessionDir, `${testName}.json`);
  const statusFile = path.join(sessionDir, `${testName}.status.json`);
  const recordingStatusFile = path.join(sessionDir, `${testName}.recording.status.json`);

  let errorOccurred = false;

  if (fs.existsSync(sessionFile)) {
    try {
      fs.unlinkSync(sessionFile);
      console.log(`🗑️ Deleted test file: ${testName}.json`);
    } catch (err) {
      console.error(`❌ Failed to delete test file: ${err.message}`);
      errorOccurred = true;
    }
  }

  if (fs.existsSync(statusFile)) {
    try {
      fs.unlinkSync(statusFile);
      console.log(`🗑️ Deleted status file: ${testName}.status.json`);
    } catch (err) {
      console.error(`❌ Failed to delete status file: ${err.message}`);
      errorOccurred = true;
    }
  }

  if (fs.existsSync(recordingStatusFile)) {
    try {
      fs.unlinkSync(recordingStatusFile);
      console.log(`🗑️ Deleted recording status file: ${testName}.recording.status.json`);
    } catch (err) {
      console.error(`❌ Failed to delete recording status file: ${err.message}`);
      errorOccurred = true;
    }
  }

  if (errorOccurred) {
    return res.status(500).send('Failed to delete some test files');
  }

  // Cancel scheduled run if any
  scheduler.cancelScheduledRun(testName);

  res.status(200).send('Deleted');
});

app.post('/record', async (req, res) => {
  const { url, testName } = req.body;
  if (!url || !testName) return res.status(400).send('Missing URL or test name');

  const sessionFile = path.join(sessionDir, `${testName}.json`);
  const recordingStatusFile = path.join(sessionDir, `${testName}.recording.status.json`);

  const recordedEvents = [{
    type: 'navigate',
    href: url,
    timestamp: Date.now()
  }];

  try {
    await fs.promises.writeFile(recordingStatusFile, JSON.stringify({ status: 'running', timestamp: new Date().toISOString() }));
  } catch (err) {
    console.error('❌ Failed to write recording status:', err.message);
  }

  res.status(200).send('Recording started');

  try {
    const browser = await puppeteer.launch({
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--mute-audio',
        '--start-maximized'
      ],
      defaultViewport: null,
    });

    const page = await browser.newPage();

    await page.exposeFunction('pushRecordedEvent', (event) => {
      recordedEvents.push(event);
    });

    await page.evaluateOnNewDocument(() => {
      const getSelector = (el) => {
        if (!el) return '';
        const path = [];
        while (el.parentElement) {
          let name = el.nodeName.toLowerCase();
          if (el.id) {
            name += `#${el.id}`;
            path.unshift(name);
            break;
          }
          const siblings = Array.from(el.parentElement.children);
          const idx = siblings.indexOf(el) + 1;
          if (idx > 1) name += `:nth-child(${idx})`;
          path.unshift(name);
          el = el.parentElement;
        }
        return path.join(' > ');
      };

      window.addEventListener('click', (e) => {
        const el = e.target.closest('button, a, input, label, span');
        if (!el) return;
        window.pushRecordedEvent({
          type: 'click',
          detail: {
            tag: el.tagName,
            text: el.innerText || '',
            id: el.id || '',
            name: el.name || '',
            className: el.className || '',
            href: el.href || '',
            type: el.type || '',
            selector: getSelector(el)
          },
          timestamp: Date.now()
        });
      });

      window.addEventListener('input', (e) => {
        const el = e.target;
        window.pushRecordedEvent({
          type: 'input',
          detail: {
            name: el.name || '',
            value: el.value || '',
            checked: el.checked || false,
            tag: el.tagName.toLowerCase(),
            type: el.type || '',
            id: el.id || '',
            className: el.className || '',
            selector: getSelector(el)
          },
          timestamp: Date.now()
        });
      });
    });

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    console.log(`🟢 Recording browser launched for: ${url}`);

    let sessionSaved = false;

    const saveSession = async (reason) => {
      if (sessionSaved) return;
      sessionSaved = true;
      try {
        await fs.promises.writeFile(sessionFile, JSON.stringify(recordedEvents, null, 2));
        console.log(`✅ Session saved: sessions/${testName}.json (${reason})`);

        await fs.promises.writeFile(recordingStatusFile, JSON.stringify({ status: 'stopped', timestamp: new Date().toISOString() }));
      } catch (err) {
        console.error("❌ Error saving session or updating recording status:", err.message);
      }
    };

    page.on('close', async () => {
      await saveSession('page closed');
      try {
        if (!browser.isConnected()) return;
        await browser.close();
      } catch {
        // ignore errors closing browser here
      }
    });

    browser.on('disconnected', async () => {
      await saveSession('browser disconnected');
    });

    process.on('SIGINT', async () => {
      await saveSession('manual stop');
      process.exit();
    });

  } catch (err) {
    console.error("❌ Failed to launch Puppeteer:", err.message);
    try {
      await fs.promises.writeFile(recordingStatusFile, JSON.stringify({ status: 'stopped', timestamp: new Date().toISOString() }));
    } catch (e) {
      console.error('❌ Failed to update recording status on error:', e.message);
    }
  }
});

// Scheduling API endpoints

app.post('/schedule/:testName', (req, res) => {
  const testName = req.params.testName;
  const sessionFile = path.join(sessionDir, `${testName}.json`);
  if (!fs.existsSync(sessionFile)) {
    return res.status(404).json({ error: 'Test not found' });
  }
  scheduler.scheduleTestRun(testName);
  res.json({ status: 'scheduled' });
});

app.delete('/schedule/:testName', (req, res) => {
  const testName = req.params.testName;
  scheduler.cancelScheduledRun(testName);
  res.json({ status: 'unscheduled' });
});

app.get('/schedule/next-run', (req, res) => {
  const nextRuns = {};
  for (const testName of scheduler.scheduledJobs.keys()) {
    const nextRunDate = getNextRunTime(testName);
    nextRuns[testName] = nextRunDate ? nextRunDate.toISOString() : null;
  }
  res.json(nextRuns);
});

app.listen(PORT, () => {
  console.log(`🟢 Server running at http://localhost:${PORT}`);
});
