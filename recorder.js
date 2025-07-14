const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { setupRecorder } = require('./lib/recorderHelpers');

// Usage: node recorder.js <URL> <testName>
const [, , targetUrl, testName] = process.argv;
if (!targetUrl || !testName) {
  console.error('❌ Usage: node recorder.js <URL> <testName>');
  process.exit(1);
}

const sessionDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
const safeName = testName.replace(/[^a-zA-Z0-9_-]/g, '_');
const sessionFile = path.join(sessionDir, `${safeName}.json`);

(async () => {
  const recordedEvents = [{
    type: 'navigate',
    href: targetUrl,
    timestamp: Date.now()
  }];

  const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();

  await page.exposeFunction('recordEvent', (event) => {
    recordedEvents.push(event);
    console.log(`📥 Recorded event: ${event.type} → ${event.detail?.text || event.detail?.value || '[no text]'}`);
  });

  await page.evaluateOnNewDocument(setupRecorder, 'recordEvent');

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  console.log(`🚀 Recording started at ${targetUrl}`);

  const saveSession = async () => {
    fs.writeFileSync(sessionFile, JSON.stringify(recordedEvents, null, 2));
    console.log(`✅ Session saved: ${sessionFile}`);
    await browser.close();
    process.exit(0);
  };

  page.on('close', saveSession);
  process.on('SIGINT', saveSession);
})();
