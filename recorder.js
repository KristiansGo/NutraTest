const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

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

  await page.evaluateOnNewDocument(() => {
    window.getSelector = el => {
      if (!el || el.nodeType !== 1) return '';
      const parts = [];
      while (el && el.nodeType === 1) {
        let part = el.tagName.toLowerCase();
        if (el.id) {
          part += `#${el.id}`;
          parts.unshift(part);
          break;
        } else {
          if (el.className) {
            part += '.' + el.className.trim().split(/\s+/).join('.');
          }
          const siblings = Array.from(el.parentNode ? el.parentNode.children : []).filter(e => e.tagName === el.tagName);
          if (siblings.length > 1) {
            const index = siblings.indexOf(el) + 1;
            part += `:nth-of-type(${index})`;
          }
        }
        parts.unshift(part);
        el = el.parentNode;
      }
      return parts.join(' > ');
    };

    window.extractDetails = el => ({
      tag: el.tagName,
      text: el.innerText?.trim() || '',
      id: el.id || '',
      name: el.name || '',
      className: el.className || '',
      type: el.type || '',
      value: el.value || '',
      checked: el.checked ?? undefined,
      selector: window.getSelector(el)
    });

    window._lastAction = { type: null, el: null, time: 0 };

    document.addEventListener('click', e => {
      const now = Date.now();
      window._lastAction = { type: 'click', el: e.target, time: now };
      const detail = window.extractDetails(e.target);
      window.recordEvent({
        type: 'click',
        detail,
        timestamp: now
      });
    }, true);

    document.addEventListener('input', e => {
      const now = Date.now();
      if (
        window._lastAction.type === 'click' &&
        (window._lastAction.el === e.target || window._lastAction.el.contains(e.target)) &&
        now - window._lastAction.time < 300
      ) {
        // Skip input triggered by the prior click
        console.log('⚠️ Skipped input caused by click');
        return;
      }
      const detail = window.extractDetails(e.target);
      window.recordEvent({
        type: 'input',
        detail,
        timestamp: now
      });
    }, true);
  });

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
