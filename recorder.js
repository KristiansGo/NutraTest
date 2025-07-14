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
      let curr = el;

      while (curr && curr.nodeType === 1) {
        let part = curr.tagName.toLowerCase();

        if (curr.id) {
          part += `#${CSS.escape(curr.id)}`;
        } else if (curr.classList.length) {
          part += Array.from(curr.classList)
            .map(cls => `.${CSS.escape(cls)}`)
            .join('');
        }

        let selector = parts.length ? `${part} > ${parts.join(' > ')}` : part;
        if (document.querySelectorAll(selector).length === 1) {
          return selector;
        }

        if (!curr.id) {
          for (const attr of Array.from(curr.attributes)) {
            if (attr.name.startsWith('data-')) {
              const withData = `${part}[${attr.name}="${CSS.escape(attr.value)}"]`;
              selector = parts.length ? `${withData} > ${parts.join(' > ')}` : withData;
              if (document.querySelectorAll(selector).length === 1) {
                return selector;
              }
              break;
            }
          }
        }

        if (curr.parentNode) {
          const siblings = Array.from(curr.parentNode.children).filter(e => e.tagName === curr.tagName);
          if (siblings.length > 1) {
            const index = siblings.indexOf(curr) + 1;
            const withNth = `${part}:nth-of-type(${index})`;
            selector = parts.length ? `${withNth} > ${parts.join(' > ')}` : withNth;
            if (document.querySelectorAll(selector).length === 1) {
              return selector;
            }
            part = withNth;
          }
        }

        parts.unshift(part);
        curr = curr.parentNode;
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
