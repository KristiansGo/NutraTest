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

// Sanitize testName to a safe file name (replace slashes and invalid chars with '-')
function sanitizeFileName(name) {
  return name.replace(/[\/\\?%*:|"<>]/g, '-');
}
const safeTestName = sanitizeFileName(testName);

const sessionFile = path.join(sessionDir, `${safeTestName}.json`);

(async () => {
  const recordedEvents = [{
    type: 'navigate',
    href: targetUrl,
    timestamp: Date.now()
  }];

  const browser = await puppeteer.launch({
    headless: false,
    // Change or remove executablePath if needed for your environment
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  page.on('pageerror', err => {
    console.error('❌ Page error:', err);
  });

  await page.evaluateOnNewDocument((initialEvents) => {
    window.recordedEvents = initialEvents;

    // Helper: build unique CSS selector for an element
    function getSelector(el) {
      if (!el) return '';
      const path = [];
      while (el && el.nodeType === 1) { // Element node
        let selector = el.nodeName.toLowerCase();
        if (el.id) {
          selector += `#${el.id}`;
          path.unshift(selector);
          break; // id is unique, no need to go further
        } else {
          let siblingIndex = 1;
          let sibling = el.previousElementSibling;
          while (sibling) {
            if (sibling.nodeName.toLowerCase() === selector) {
              siblingIndex++;
            }
            sibling = sibling.previousElementSibling;
          }
          if (siblingIndex > 1) {
            selector += `:nth-of-type(${siblingIndex})`;
          }
          path.unshift(selector);
          el = el.parentElement;
        }
      }
      return path.join(' > ');
    }

    document.addEventListener('click', (e) => {
      const t = e.target.closest('button, a, input, label, span');
      if (!t) return;

      window.recordedEvents.push({
        type: 'click',
        detail: {
          tag: t.tagName,
          text: t.innerText || '',
          id: t.id || '',
          name: t.name || '',
          className: t.className || '',
          href: t.href || '',
          type: t.type || '',
          selector: getSelector(t)
        },
        timestamp: Date.now()
      });
    });

    document.addEventListener('input', (e) => {
      const t = e.target;
      window.recordedEvents.push({
        type: 'input',
        detail: {
          name: t.name || '',
          value: t.value || '',
          checked: t.checked || false,
          tag: t.tagName.toLowerCase() || '',
          type: t.type || '',
          id: t.id || '',
          className: t.className || '',
          selector: getSelector(t)
        },
        timestamp: Date.now()
      });
    });

    window.getRecordedEvents = () => window.recordedEvents;

  }, recordedEvents);

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  console.log(`🚀 Recording started at ${targetUrl}`);

  // Save session when the page is closed
  page.on('close', async () => {
    try {
      const events = await page.evaluate(() => window.getRecordedEvents());
      fs.writeFileSync(sessionFile, JSON.stringify(events, null, 2));
      console.log(`✅ Session saved: sessions/${safeTestName}.json (on page close)`);
    } catch (err) {
      console.error("❌ Error saving session:", err);
    }
  });

  // Also handle manual terminal stop (Ctrl+C)
  process.on('SIGINT', async () => {
    try {
      const events = await page.evaluate(() => window.getRecordedEvents());
      fs.writeFileSync(sessionFile, JSON.stringify(events, null, 2));
      console.log(`✅ Session saved: sessions/${safeTestName}.json (on SIGINT)`);
      process.exit();
    } catch (err) {
      console.error("❌ Error saving session on exit:", err);
      process.exit(1);
    }
  });
})();
