const puppeteer = require('puppeteer');
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

function sendDiscordWebhookWithScreenshot(message, screenshotPath) {
  if (!discordWebhook) return;
  const form = new FormData();
  form.append('content', message);
  form.append('file', fs.createReadStream(screenshotPath));
  const webhookUrl = new URL(discordWebhook);
  const req = https.request({
    method: 'POST',
    hostname: webhookUrl.hostname,
    path: webhookUrl.pathname + webhookUrl.search,
    headers: form.getHeaders(),
  }, res => {
    if (res.statusCode < 200 || res.statusCode >= 300) {
      console.error(`❌ Webhook failed: HTTP ${res.statusCode}`);
    }
  });
  req.on('error', err => console.error(`❌ Webhook error: ${err.message}`));
  form.pipe(req);
}

let browser;
process.on('unhandledRejection', async reason => {
  console.error('❌ Unhandled Promise Rejection:', reason);
  if (browser) await browser.close();
  process.exit(1);
});

async function tryClickElementHandle(el) {
  if (!el) return false;
  const isConnected = await el.evaluate(e => e.isConnected).catch(() => false);
  if (!isConnected) {
    console.log(`⚠ Element disconnected before click.`);
    return false;
  }
  const box = await el.boundingBox();
  if (box && box.width > 0 && box.height > 0) {
    await el.click();
    return true;
  }
  console.log(`⚠ Element found but not clickable (zero size).`);
  return false;
}

async function findAndClick(page, detail, targetText, stepIndex, screenshotDir, testName) {
  // Skip direct click on hidden form controls
  if (detail.tag === 'INPUT' && (detail.type === 'checkbox' || detail.type === 'radio')) {
    console.log(`⚠️ Skipping direct click on hidden form control: ${detail.tag} ${detail.type}`);
    return true;
  }

  const attempts = [
    async () => {
      if (detail.id) {
        console.log(`🔍 Trying id: #${detail.id}`);
        const el = await page.$(`#${detail.id}`);
        if (el) console.log(`➡️ Found element by id: ${detail.id}`);
        return await tryClickElementHandle(el);
      }
      return false;
    },
    async () => {
      if (detail.selector) {
        console.log(`🔍 Trying selector: ${detail.selector}`);
        const el = await page.$(detail.selector);
        if (el) console.log(`➡️ Found element by selector: ${detail.selector}`);
        return await tryClickElementHandle(el);
      }
      return false;
    },
    async () => {
      if (detail.name) {
        console.log(`🔍 Trying name: ${detail.name}`);
        const el = await page.$(`[name="${detail.name}"]`);
        if (el) console.log(`➡️ Found element by name: ${detail.name}`);
        return await tryClickElementHandle(el);
      }
      return false;
    },
    async () => {
      if (targetText) {
        console.log(`🔍 Trying exact text match: ${targetText}`);
        const els = await page.$$('button, a, label, span, div');
        for (const el of els) {
          const text = await el.evaluate(e => e.innerText || e.value || '');
          console.log(`📝 Candidate: "${normalizeText(text)}"`);
          if (normalizeText(text).toLowerCase() === targetText.toLowerCase()) {
            console.log(`➡️ Found exact text match: "${normalizeText(text)}"`);
            return await tryClickElementHandle(el);
          }
        }
      }
      return false;
    },
    async () => {
      if (targetText) {
        console.log(`🔍 Trying substring text match: ${targetText}`);
        const els = await page.$$('button, a, label, span, div');
        for (const el of els) {
          const text = await el.evaluate(e => e.innerText || e.value || '');
          console.log(`📝 Candidate: "${normalizeText(text)}"`);
          if (normalizeText(text).toLowerCase().includes(targetText.toLowerCase())) {
            console.log(`➡️ Found substring text match: "${normalizeText(text)}"`);
            return await tryClickElementHandle(el);
          }
        }
      }
      return false;
    }
  ];

  for (const attempt of attempts) {
    if (await attempt()) {
      console.log(`✅ Clicked successfully at step ${stepIndex + 1}`);
      return true;
    }
  }

  const img = path.join(screenshotDir, `${testName}-step${stepIndex + 1}.png`);
  await page.screenshot({ path: img });
  console.error(`📸 Screenshot: ${img}`);
  console.error(`❌ Step ${stepIndex + 1} failed: Could not click "${targetText}"`);
  sendDiscordWebhookWithScreenshot(
    `❌ **Test Failed**: \`${testName}\` step ${stepIndex + 1}: Could not click "${targetText}"`,
    img
  );
  await browser.close();
  process.exit(1);
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
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  page.on('pageerror', err => console.error('❌ Page error:', err));

  const firstNav = session.find(e => e.type === 'navigate');
  console.log(`🚀 Navigating to ${firstNav.href}`);
  await page.goto(firstNav.href, { waitUntil: 'domcontentloaded', timeout: 15000 });

  let lastTimestamp = firstNav.timestamp;
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
      console.log(`➡️ Processing click event: ${JSON.stringify(curr.detail)}`);
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
      let typed = false;
      try {
        const el = await page.waitForSelector(sel, { timeout: 3000 });
        if (el) {
          await el.focus();
          await el.click({ clickCount: 3 });
          await el.type(val, { delay: 50 });
          typed = true;
        }
      } catch {}
      if (!typed) {
        const img = path.join(screenshotDir, `${testName}-step${i + 1}.png`);
        await page.screenshot({ path: img });
        console.error(`📸 Screenshot: ${img}`);
        console.error(`❌ Step ${i + 1} failed: Could not input "${val}"`);
        sendDiscordWebhookWithScreenshot(
          `❌ **Test Failed**: \`${testName}\` step ${i + 1}: Could not input "${val}"`,
          img
        );
        await browser.close();
        process.exit(1);
      }
    }
  }

  console.log(`🎉 Replay finished successfully for "${testName}"`);
  await browser.close();
  process.exit(0);
})();
