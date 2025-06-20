// recorder.js
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

  // Listen for our "📥" logs from the page context
  page.on('console', async msg => {
    for (const arg of msg.args()) {
      try {
        const val = await arg.jsonValue();
        if (typeof val === 'string' && val.startsWith('📥')) {
          console.log(val);
        }
      } catch { /* ignore */ }
    }
  });

  await page.evaluateOnNewDocument(initial => {
    window.recordedEvents = initial;

    // Build a CSS path to the element
    function getSelector(el) {
      if (!el || el.tagName.toLowerCase() === 'html') return '';
      const parts = [];
      while (el && el.tagName.toLowerCase() !== 'html') {
        let sel = el.tagName.toLowerCase();
        if (el.id) {
          sel += `#${el.id}`;
          parts.unshift(sel);
          break;
        }
        if (el.classList.length) {
          sel += Array.from(el.classList).map(c => `.${c}`).join('');
        } else {
          const siblings = el.parentNode
            ? Array.from(el.parentNode.children).filter(s => s.tagName === el.tagName)
            : [];
          if (siblings.length > 1) {
            const idx = siblings.indexOf(el) + 1;
            sel += `:nth-of-type(${idx})`;
          }
        }
        parts.unshift(sel);
        el = el.parentElement;
      }
      return parts.join(' > ');
    }

    // Build an XPath to the element
    function getXPath(el) {
      if (!el || el.nodeType !== 1) return '';
      if (el.id) return `//*[@id="${el.id}"]`;
      const parts = [];
      while (el && el.nodeType === 1) {
        let idx = 1, sib = el.previousSibling;
        while (sib) {
          if (sib.nodeType === 1 && sib.nodeName === el.nodeName) idx++;
          sib = sib.previousSibling;
        }
        parts.unshift(`${el.nodeName.toLowerCase()}[${idx}]`);
        el = el.parentNode;
      }
      return '/' + parts.join('/');
    }

    // Extract every bit of info from the element
    function extractDetails(el) {
      const attrs = {};
      for (const a of el.attributes) {
        attrs[a.name] = a.value;
      }
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        text: el.innerText?.trim() || '',
        id: el.id || '',
        name: el.name || '',
        className: el.className || '',
        href: el.href || '',
        type: el.type || '',
        value: el.value || '',
        checked: typeof el.checked === 'boolean' ? el.checked : undefined,
        disabled: el.disabled === true,
        attributes: attrs,
        dataset: { ...el.dataset },
        boundingClientRect: {
          x: rect.x, y: rect.y,
          width: rect.width, height: rect.height
        },
        selector: getSelector(el),
        xpath: getXPath(el),
        outerHTML: el.outerHTML?.slice(0, 1000) || ''
      };
    }

    function record(event) {
      window.recordedEvents.push(event);
      // Prefix with 📥 so our Node listener sees it
      console.log('📥 Recorded event:', event);
    }

    document.addEventListener('click', e => {
      // prefer the exact thing clicked if it's one of our tags
      let t = e.target;
      if (!t.matches('button,a,input,label,span,div')) {
        t = t.closest('button,a,input,label,span,div') || t;
      }
      const detail = extractDetails(t);

      record({ type: 'click', detail, timestamp: Date.now() });

      // your existing "waitFor" injections
      if (/^continue$/i.test(detail.text)) {
        const nextI = Array.from(document.querySelectorAll('input'))
          .find(i => !i.disabled && i.offsetParent && i.closest('div')?.id);
        if (nextI) {
          const pid = nextI.closest('div').id;
          record({
            type: 'waitFor',
            detail: { selector: `div#${pid} input`, timeout: 5000 },
            timestamp: Date.now() + 50
          });
        }
      }
      if (detail.selector.includes('hungerTime')) {
        record({
          type: 'waitFor',
          detail: { selector: detail.selector, timeout: 5000 },
          timestamp: Date.now() + 50
        });
      }
    });

    document.addEventListener('input', e => {
      const t = e.target;
      const detail = extractDetails(t);
      record({ type: 'input', detail, timestamp: Date.now() });
    });

    window.getRecordedEvents = () => window.recordedEvents;
  }, recordedEvents);

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  console.log(`🚀 Recording started at ${targetUrl}`);

  async function saveAndExit() {
    try {
      const events = await page.evaluate(() => window.getRecordedEvents());
      fs.writeFileSync(sessionFile, JSON.stringify(events, null, 2));
      console.log(`✅ Session saved: ${sessionFile}`);
    } catch (err) {
      console.error('❌ Error saving session:', err);
    }
    await browser.close();
    process.exit(0);
  }

  page.on('close', saveAndExit);
  process.on('SIGINT', saveAndExit);
})();
