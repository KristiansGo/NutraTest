const puppeteer = require('puppeteer');
const devices = puppeteer.devices;
const fs = require('fs');
const path = require('path');

const deviceAliases = {
  'Samsung Galaxy S9': 'Galaxy S9+',
  'iPhone 11': 'iPhone 11',
  'iPad': 'iPad'
};
function mapDevice(name) {
  return deviceAliases[name] || name;
}

const [, , targetUrl, deviceArg] = process.argv;
if (!targetUrl) {
  console.error('Usage: node autoRunner.js <URL> [device]');
  process.exit(1);
}

const maxDepth = 1;
const visited = new Set();
const screenshotDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });

const logData = {
  consoleMessages: [],
  pageErrors: [],
  networkRequests: []
};

(async () => {
  const device = mapDevice(deviceArg || 'desktop');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();

  if (device && device !== 'desktop') {
    if (devices[device]) {
      await page.emulate(devices[device]);
    } else {
      console.warn(`Device descriptor for "${device}" not found, using desktop.`);
    }
  }

  page.on('console', msg => logData.consoleMessages.push({
    type: msg.type(), text: msg.text(), location: msg.location()
  }));
  page.on('pageerror', err => logData.pageErrors.push({ message: err.message, stack: err.stack }));
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

  async function visit(url, depth) {
    if (depth > maxDepth || visited.has(url)) return;
    visited.add(url);
    console.log('Visiting', url);
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const screenshotPath = path.join(screenshotDir, `auto-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath });

    await page.$$eval('input[type="text"],input[type="email"],textarea', inputs => {
      inputs.forEach((input, i) => { if (!input.value) input.value = `test${i}`; });
    });

    const links = await page.$$eval('a[href]', as => as.map(a => a.href).slice(0,3));
    for (const link of links) {
      if (!visited.has(link)) {
        await visit(link, depth + 1);
        await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
      }
    }
  }

  await visit(targetUrl, 0);

  const logPath = path.join(screenshotDir, `auto-log-${Date.now()}.json`);
  fs.writeFileSync(logPath, JSON.stringify(logData, null, 2));

  await browser.close();
})();
