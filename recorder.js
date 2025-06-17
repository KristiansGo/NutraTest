const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// Args: node recorder.js <URL> <testName>
const [, , targetUrl, testName] = process.argv;

if (!targetUrl || !testName) {
  console.error("❌ Usage: node recorder.js <URL> <testName>");
  process.exit(1);
}

const sessionDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

const sessionFile = path.join(sessionDir, `${testName}.json`);

(async () => {
  const recordedEvents = [{
    type: 'navigate',
    href: targetUrl,
    timestamp: Date.now()
  }];

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', // remove or parametrize if needed
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  // Optional: handle page errors inside browser page
  page.on('pageerror', err => {
    console.error('❌ Page error:', err);
  });

  await page.evaluateOnNewDocument((initialEvents) => {
    window.recordedEvents = initialEvents;

    document.addEventListener('click', (e) => {
      const t = e.target.closest('button, a, input, label');
      if (!t) return;

      recordedEvents.push({
        type: 'click',
        detail: {
          tag: t.tagName,
          text: t.innerText,
          id: t.id || '',
          name: t.name || '',
          href: t.href || '',
          type: t.type || ''
        },
        timestamp: Date.now()
      });
    });

    document.addEventListener('input', (e) => {
      recordedEvents.push({
        type: 'input',
        detail: {
          name: e.target.name,
          value: e.target.value
        },
        timestamp: Date.now()
      });
    });

    window.getRecordedEvents = () => recordedEvents;
  }, recordedEvents);

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  console.log(`🚀 Recording started at ${targetUrl}`);

  // Save session when the page is closed
  page.on('close', async () => {
    try {
      const events = await page.evaluate(() => window.getRecordedEvents());
      fs.writeFileSync(sessionFile, JSON.stringify(events, null, 2));
      console.log(`✅ Session saved: sessions/${testName}.json (on page close)`);
    } catch (err) {
      console.error("❌ Error saving session:", err);
    }
  });

  // Also handle manual terminal stop (Ctrl+C)
  process.on('SIGINT', async () => {
    try {
      const events = await page.evaluate(() => window.getRecordedEvents());
      fs.writeFileSync(sessionFile, JSON.stringify(events, null, 2));
      console.log(`✅ Session saved: sessions/${testName}.json (on SIGINT)`);
      process.exit();
    } catch (err) {
      console.error("❌ Error saving session on exit:", err);
      process.exit(1);
    }
  });
})();
