const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const https = require('https');
const FormData = require('form-data');
const { URL } = require('url');
const [, , testName] = process.argv;

require('dotenv').config();

const discordWebhook = process.env.DISCORD_WEBHOOK;

if (!testName) {
    console.error("❌ Usage: node replay.js <testName>");
    process.exit(1);
}

const sessionFile = path.join(__dirname, 'sessions', `${testName}.json`);
if (!fs.existsSync(sessionFile)) {
    console.error(`❌ Test file not found: sessions/${testName}.json`);
    process.exit(1);
}

const session = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
if (!Array.isArray(session) || session.length === 0) {
    console.error(`❌ Session file is empty or invalid`);
    process.exit(1);
}

const screenshotDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir);

function sendDiscordWebhookWithScreenshot(message, screenshotPath) {
    if (!discordWebhook) return;

    const form = new FormData();
    form.append('content', message);
    form.append('file', fs.createReadStream(screenshotPath));

    const webhookUrl = new URL(discordWebhook);

    const request = https.request({
        method: 'POST',
        hostname: webhookUrl.hostname,
        path: webhookUrl.pathname + webhookUrl.search,
        headers: form.getHeaders()
    }, res => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
            console.error(`❌ Webhook failed: HTTP ${res.statusCode}`);
        }
    });

    request.on('error', err => {
        console.error(`❌ Webhook error: ${err.message}`);
    });

    form.pipe(request);
}

let browser;

process.on('unhandledRejection', async (reason) => {
    console.error('❌ Unhandled Promise Rejection:', reason);
    if (browser) await browser.close();
    process.exit(1);
});

(async () => {
    browser = await puppeteer.launch({
        headless: 'new', // use new headless mode for stability
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--mute-audio',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            '--disable-software-rasterizer',
            '--disable-features=site-per-process,IsolateOrigins,site-per-process',
            '--disable-site-isolation-trials',
        ],
        dumpio: true, // logs chromium stdout/stderr
    });

    const page = await browser.newPage();

    page.on('pageerror', err => {
        console.error('❌ Page error:', err);
    });

    const failWithScreenshot = async (stepIndex, reason) => {
        try {
            if (!page.isClosed()) {
                const screenshotPath = path.join(screenshotDir, `${testName}-step${stepIndex + 1}.png`);
                await page.screenshot({ path: screenshotPath });
                console.error(`📸 Screenshot saved: ${screenshotPath}`);

                const message = `❌ **Test Failed**: \`${testName}\`\n**Step**: ${stepIndex + 1}\n**Reason**: ${reason}`;
                sendDiscordWebhookWithScreenshot(message, screenshotPath);
            } else {
                console.warn(`⚠️ Cannot take screenshot, page already closed`);
            }
        } catch (e) {
            console.warn(`⚠️ Error taking screenshot: ${e.message}`);
        }

        console.error(`❌ Step ${stepIndex + 1} failed: ${reason}`);

        await browser.close();
        process.exit(1);
    };

    const firstNav = session.find(e => e.type === 'navigate');
    if (!firstNav || !firstNav.href) {
        console.error("❌ No starting URL found in session.");
        process.exit(1);
    }

    console.log(`🚀 Starting replay: ${testName}`);
    try {
        await page.goto(firstNav.href, { waitUntil: 'domcontentloaded', timeout: 10000 });
    } catch (err) {
        await failWithScreenshot(0, `Failed to navigate to ${firstNav.href}`);
    }

    let lastTimestamp = firstNav.timestamp;

    for (let i = 0; i < session.length; i++) {
        const step = session[i];
        const { type, detail, timestamp } = step;

        const waitTime = Math.min(timestamp - lastTimestamp, 10000);
        lastTimestamp = timestamp;
        if (waitTime > 0) await new Promise(resolve => setTimeout(resolve, waitTime));


        console.log(`➡️ Step ${i + 1}: ${type} ${detail?.text || detail?.name || ''}`);

        try {
            if (type === 'click') {
                const clicked = await page.evaluate((d) => {
                    const byId = d.id && document.getElementById(d.id);
                    if (byId) { byId.click(); return 'id'; }

                    const bySelector = d.selector && document.querySelector(d.selector);
                    if (bySelector) { bySelector.click(); return 'selector'; }

                    const byText = Array.from(document.querySelectorAll('a, button, input, label'))
                        .find(el => el.innerText.trim() === d.text.trim());
                    if (byText) { byText.click(); return 'text'; }

                    return null;
                }, detail);

                if (!clicked) {
                    await failWithScreenshot(i, `Click target not found: ${detail.text || detail.id || detail.selector}`);
                }

                console.log(`✅ Clicked using ${clicked}: ${detail.text || detail.id || detail.selector}`);
            }

            if (type === 'input') {
                const selector = detail.selector || `[name="${detail.name}"]`;
                try {
                    const elHandle = await page.waitForSelector(selector, { timeout: 5000 });
                    await elHandle.focus();
                    await elHandle.click({ clickCount: 3 });
                    await elHandle.type(detail.value || '', { delay: 50 });
                    console.log(`⌨️ Typed into ${selector}: ${detail.value}`);
                } catch (err) {
                    await failWithScreenshot(i, `Input field not found: ${selector}`);
                }
            }

        } catch (err) {
            await failWithScreenshot(i, err.message);
        }
    }

    console.log(`🎉 Replay finished successfully for ${testName}`);
    await browser.close();
})().catch(async (err) => {
    console.error("❌ Uncaught error in replay:", err);
    if (browser) await browser.close();
    process.exit(1);
});
