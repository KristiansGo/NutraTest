const puppeteer = require('puppeteer');
const { PuppeteerScreenRecorder } = require('puppeteer-screen-recorder');
const fs = require('fs');
const path = require('path');
const https = require('https');
const FormData = require('form-data');
const { URL } = require('url');
require('dotenv').config();

const [, , testName] = process.argv;
if (!testName) {
  console.error('❌ Usage: node replay.js <testName>');
  process.exit(1);
}

const discordWebhook = 'https://discord.com/api/webhooks/1384555272164479107/DGJKcvptzPkAoh2VDlKB1mjVVZ0WE7WQQwOnC7Gl47c8-tDgPkWcL0cmu547dWagIQ2a';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeText(str = '') {
  return str.replace(/\u2013/g, '-').replace(/\s+/g, ' ').trim();
}

function sendDiscordWebhookWithScreenshot(message, screenshotPath, logFilePath = null, videoPath = null) {
  return new Promise((resolve, reject) => {
    if (!discordWebhook) {
      console.warn('⚠️ No webhook URL provided. Skipping Discord notification.');
      return resolve();
    }

    console.log('📤 Preparing Discord webhook...');
    const form = new FormData();
    form.append('content', message);

    let index = 0;

    if (screenshotPath && fs.existsSync(screenshotPath)) {
      console.log(`📎 Attaching screenshot: ${screenshotPath}`);
      form.append(`file${index++}`, fs.createReadStream(screenshotPath));
    } else {
      console.warn('⚠️ Screenshot file not found or invalid.');
    }

    if (logFilePath && fs.existsSync(logFilePath)) {
      console.log(`📎 Attaching log: ${logFilePath}`);
      form.append(`file${index++}`, fs.createReadStream(logFilePath));
    } else {
      console.warn('⚠️ Log file not found or invalid.');
    }

    if (videoPath && fs.existsSync(videoPath)) {
      const stats = fs.statSync(videoPath);
      if (stats.size <= 8 * 1024 * 1024) {
        console.log(`📎 Attaching video: ${videoPath}`);
        form.append(`file${index++}`, fs.createReadStream(videoPath));
      } else {
        console.warn('⚠️ Video too large to upload. Kept locally at:', videoPath);
      }
    } else {
      console.warn('⚠️ Video file not found or invalid.');
    }

    const webhookUrl = new URL(discordWebhook);
    const options = {
      method: 'POST',
      hostname: webhookUrl.hostname,
      path: webhookUrl.pathname + webhookUrl.search,
      headers: form.getHeaders(),
    };

    console.log(`📡 Sending webhook to https://${options.hostname}${options.path}`);

    const req = https.request(options, res => {
      let body = '';
      res.on('data', chunk => body += chunk.toString());
      res.on('end', () => {
        console.log(`📬 Discord response (${res.statusCode}): ${body}`);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          console.error('❌ Discord rejected the webhook.');
          return reject(new Error(`Webhook rejected with status ${res.statusCode}`));
        }
        resolve();
      });
    });

    req.on('error', err => {
      console.error(`❌ Webhook request error: ${err.message}`);
      reject(err);
    });

    form.on('error', err => {
      console.error(`❌ FormData error: ${err.message}`);
      reject(err);
    });

    try {
      form.pipe(req);
    } catch (pipeErr) {
      console.error('❌ Failed to pipe form to request:', pipeErr);
      reject(pipeErr);
    }
  });
}

let browser;
let recorder;
let testFailed = false;
const logData = {
  consoleMessages: [],
  pageErrors: [],
  networkRequests: []
};

process.on('unhandledRejection', async reason => {
  console.error('❌ Unhandled Promise Rejection:', reason);
  if (browser) await browser.close();
  process.exit(1);
});

process.on('exit', code => {
  console.log(`📤 Process exiting with code ${code}`);
});

async function tryClickElementHandle(el) {
  if (!el) return false;
  const isConnected = await el.evaluate(e => e.isConnected).catch(() => false);
  if (!isConnected) return false;
  const box = await el.boundingBox();
  if (box && box.width > 0 && box.height > 0) {
    await el.click();
    return true;
  }
  return false;
}

async function handleFailure(page, stepIndex, testName, screenshotDir, message) {
  testFailed = true;
  const screenshotPath = path.join(screenshotDir, `${testName}-step${stepIndex + 1}.png`);
  const logPath = path.join(screenshotDir, `${testName}-step${stepIndex + 1}-log.json`);
  const videoPath = path.join(screenshotDir, `${testName}-video.mp4`);

  await page.screenshot({ path: screenshotPath });
  fs.writeFileSync(logPath, JSON.stringify(logData, null, 2));

  if (recorder) {
    try {
      await recorder.stop();
      await sleep(1000); // Allow recorder to flush file
    } catch (err) {
      console.error('❌ Failed to stop recorder:', err);
    }
  }

  const stats = fs.existsSync(videoPath) ? fs.statSync(videoPath) : null;
  const videoInfo = stats && stats.size > 8 * 1024 * 1024
    ? `\n📁 Video too large to upload. Saved locally at: \`${videoPath}\``
    : '';

  await sendDiscordWebhookWithScreenshot(
    `❌ **Test Failed**: \`${testName}\` step ${stepIndex + 1}\n${message}${videoInfo}`,
    screenshotPath,
    logPath,
    fs.existsSync(videoPath) && stats?.size <= 8 * 1024 * 1024 ? videoPath : null
  );

  await browser.close();
  process.exit(1);
}

async function findAndClick(page, detail, targetText, stepIndex, screenshotDir, testName) {
  if (detail.tag === 'INPUT' && (detail.type === 'checkbox' || detail.type === 'radio')) {
    return true;
  }

  const attempts = [
    async () => detail.id && tryClickElementHandle(await page.$(`#${detail.id}`)),
    async () => detail.selector && tryClickElementHandle(await page.$(detail.selector)),
    async () => detail.name && tryClickElementHandle(await page.$(`[name="${detail.name}"]`)),
    async () => {
      const els = await page.$$('button, a, label, span, div');
      for (const el of els) {
        const text = await el.evaluate(e => e.innerText || e.value || '');
        if (normalizeText(text).toLowerCase() === targetText.toLowerCase()) {
          return tryClickElementHandle(el);
        }
      }
      return false;
    },
    async () => {
      const els = await page.$$('button, a, label, span, div');
      for (const el of els) {
        const text = await el.evaluate(e => e.innerText || e.value || '');
        if (normalizeText(text).toLowerCase().includes(targetText.toLowerCase())) {
          return tryClickElementHandle(el);
        }
      }
      return false;
    }
  ];

  for (const attempt of attempts) {
    if (await attempt()) return true;
  }

  await handleFailure(page, stepIndex, testName, screenshotDir, `Could not click "${targetText}"`);
}

(async () => {
  const sessionFile = path.join(__dirname, 'sessions', `${testName}.json`);
  if (!fs.existsSync(sessionFile)) {
    console.error(`❌ Test file not found: sessions/${testName}.json`);
    process.exit(1);
  }

  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
  if (!Array.isArray(session) || session.length === 0) {
    console.error('❌ Session file is empty or invalid');
    process.exit(1);
  }

  const screenshotDir = path.join(__dirname, 'screenshots');
  if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir);

  browser = await puppeteer.launch({
    headless: 'new',
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1920,1080'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  const videoPath = path.join(screenshotDir, `${testName}-video.mp4`);
  recorder = new PuppeteerScreenRecorder(page);
  await page.goto(session[0].href, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.bringToFront();
  await sleep(1000);
  console.log('🟡 Attempting to start video stream...');
  await recorder.start(videoPath);
  console.log('✅ Recording started');

  page.on('console', msg => logData.consoleMessages.push({
    type: msg.type(), text: msg.text(), location: msg.location()
  }));

  page.on('pageerror', error => logData.pageErrors.push({ message: error.message, stack: error.stack }));

  page.on('requestfinished', async req => {
    try {
      const res = await req.response();
      const body = await res.text();
      logData.networkRequests.push({
        url: req.url(),
        method: req.method(),
        status: res.status(),
        headers: res.headers(),
        requestPostData: req.postData(),
        responseBody: body.slice(0, 1000)
      });
    } catch (err) {
      logData.networkRequests.push({ url: req.url(), error: err.message });
    }
  });

  let lastTimestamp = session[0].timestamp;
  try {
    for (let i = 0; i < session.length; i++) {
      const curr = session[i];
      const next = session[i + 1];

      const dt = Math.min(curr.timestamp - lastTimestamp, 10000);
      lastTimestamp = curr.timestamp;
      if (dt > 0) await sleep(dt);

      if (curr.type === 'navigate') continue;

      if (curr.type === 'click') {
        const rawText = curr.detail.text || curr.detail.name || '';
        const targetText = normalizeText(rawText);
        console.log(`➡️ Step ${i + 1}: Click "${rawText}"`);
        await findAndClick(page, curr.detail, targetText, i, screenshotDir, testName);

        if (
          next && next.type === 'input' &&
          (next.detail.name === curr.detail.name || next.detail.id === curr.detail.id) &&
          next.timestamp - curr.timestamp < 300
        ) {
          console.log(`⚠️ Skipping auto-triggered input at step ${i + 2}`);
          i++;
        }

        continue;
      }

      if (curr.type === 'input') {
        if (curr.detail.type === 'checkbox' || curr.detail.type === 'radio') continue;
        const sel = curr.detail.selector || `[name="${curr.detail.name}"]`;
        const val = curr.detail.value || '';
        console.log(`➡️ Step ${i + 1}: Input "${val}" into "${sel}"`);
        try {
          const el = await page.waitForSelector(sel, { timeout: 3000 });
          if (el) {
            await el.focus();
            await el.click({ clickCount: 3 });
            await el.type(val, { delay: 50 });
          }
        } catch {
          await handleFailure(page, i, testName, screenshotDir, `Could not input "${val}"`);
        }
      }
    }
  } catch (err) {
    console.error(`❌ Unhandled error during test loop: ${err.message}`);
    await handleFailure(page, 0, testName, screenshotDir, `Unexpected error: ${err.message}`);
  }

  if (recorder && !testFailed) {
    await recorder.stop();
    await sleep(1000);
    console.log('🛑 Recording stopped (test passed)');
  }

  await browser.close();
  process.exit(0);
})();