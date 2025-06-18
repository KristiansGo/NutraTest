const express = require('express');
const puppeteer = require('puppeteer');
const devices = puppeteer.devices;
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
  if (!fs.existsSync(sessionDir)) return res.json([]);

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

  fs.writeFileSync(statusFile, JSON.stringify({ status: 'running', timestamp: new Date().toISOString() }));
  res.json({ status: 'started' });

  const child = spawn('node', ['replay.js', testName], { stdio: ['ignore', 'pipe', 'pipe'] });

  child.stdout.on('data', data => console.log(`[replay.js stdout]: ${data}`));
  child.stderr.on('data', data => console.error(`[replay.js stderr]: ${data}`));

  child.on('close', code => {
    const status = code === 0 ? 'done' : 'failed';
    fs.writeFileSync(statusFile, JSON.stringify({ status, timestamp: new Date().toISOString() }));
    console.log(`${status === 'done' ? '✅' : '❌'} Finished test '${testName}' with exit code ${code}`);
  });
});

app.post('/record', async (req, res) => {
  const { url, testName, device } = req.body;
  if (!url || !testName) return res.status(400).send('Missing URL or test name');

  const sessionFile = path.join(sessionDir, `${testName}.json`);
  const recordingStatusFile = path.join(sessionDir, `${testName}.recording.status.json`);

  const recordedEvents = [{
    type: 'navigate',
    href: url,
    timestamp: Date.now()
  }];

  await fs.promises.writeFile(recordingStatusFile, JSON.stringify({ status: 'running', timestamp: new Date().toISOString() }));
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

    if (device && device !== 'desktop') {
      const availableDevices = Object.keys(devices);
      if (devices[device]) {
        await page.emulate(devices[device]);
      } else {
        console.warn(`⚠️ Device descriptor for "${device}" not found`);
        console.log(`🔍 Available devices: ${availableDevices.join(', ')}`);
      }
    }

    await page.exposeFunction('pushRecordedEvent', (event) => recordedEvents.push(event));

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

    const saveSession = async (reason) => {
      try {
        await fs.promises.writeFile(sessionFile, JSON.stringify(recordedEvents, null, 2));
        console.log(`✅ Session saved: sessions/${testName}.json (${reason})`);
        await fs.promises.writeFile(recordingStatusFile, JSON.stringify({ status: 'stopped', timestamp: new Date().toISOString() }));
      } catch (err) {
        console.error("❌ Error saving session or updating status:", err.message);
      }
    };

    page.on('close', () => saveSession('page closed'));
    browser.on('disconnected', () => saveSession('browser disconnected'));
    process.on('SIGINT', () => {
      saveSession('manual stop').then(() => process.exit());
    });

  } catch (err) {
    console.error("❌ Failed to launch Puppeteer:", err.message);
    await fs.promises.writeFile(recordingStatusFile, JSON.stringify({ status: 'stopped', timestamp: new Date().toISOString() }));
  }
});

app.delete('/delete/:testName', (req, res) => {
  const testName = req.params.testName;
  const filesToDelete = [
    `${testName}.json`,
    `${testName}.status.json`,
    `${testName}.recording.status.json`
  ];

  filesToDelete.forEach(file => {
    const filePath = path.join(sessionDir, file);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        console.log(`🗑️ Deleted: ${file}`);
      } catch (err) {
        console.error(`❌ Failed to delete ${file}:`, err.message);
      }
    }
  });

  scheduler.cancelScheduledRun(testName);
  res.status(200).send('Deleted');
});

// Scheduler endpoints
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
  scheduler.cancelScheduledRun(req.params.testName);
  res.json({ status: 'unscheduled' });
});

app.get('/schedule/next-run', (req, res) => {
  const nextRuns = {};
  for (const testName of scheduler.scheduledJobs.keys()) {
    const next = getNextRunTime(testName);
    nextRuns[testName] = next ? next.toISOString() : null;
  }
  res.json(nextRuns);
});

app.get('/status/:testName', (req, res) => {
  const file = path.join(sessionDir, `${req.params.testName}.status.json`);
  if (!fs.existsSync(file)) return res.json({ status: 'unknown' });
  res.json(JSON.parse(fs.readFileSync(file, 'utf-8')));
});

app.get('/recording-status/:testName', (req, res) => {
  const file = path.join(sessionDir, `${req.params.testName}.recording.status.json`);
  if (!fs.existsSync(file)) return res.json({ status: 'stopped' });
  res.json(JSON.parse(fs.readFileSync(file, 'utf-8')));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🟢 Server running at http://0.0.0.0:${PORT}`);
});