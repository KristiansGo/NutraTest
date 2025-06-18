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

// Try to type inside iframes if input not found on main page
async function typeInIframeInput(page, selector, value) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const el = await frame.waitForSelector(selector, { timeout: 3000 });
            if (el) {
                await el.focus();
                await el.click({ clickCount: 3 });
                await el.type(value, { delay: 50 });
                return true;
            }
        } catch {
            // Ignore and try next frame
        }
    }
    return false;
}

async function safeClick(page, selector) {
    try {
        const el = await page.waitForSelector(selector, { visible: true, timeout: 5000 });
        await el.evaluate(e => e.scrollIntoView({ behavior: 'smooth', block: 'center' }));
        await el.click();
        return true;
    } catch {
        return false;
    }
}

(async () => {
    browser = await puppeteer.launch({
        headless: 'new',
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
        dumpio: true,
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
                let clicked = false;

                if (detail.id) {
                    clicked = await safeClick(page, `#${detail.id}`);
                }

                if (!clicked && detail.selector) {
                    clicked = await safeClick(page, detail.selector);
                }

                if (!clicked && (detail.tag === 'LABEL' || detail.tag === 'SPAN')) {
                    clicked = await page.evaluate(async (selector) => {
                        const el = document.querySelector(selector);
                        if (!el) return false;

                        if (el.tagName === 'LABEL' && el.htmlFor) {
                            const input = document.getElementById(el.htmlFor);
                            if (input) {
                                input.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                input.click();
                                return true;
                            }
                        }

                        let input = el.querySelector('input[type="checkbox"], input[type="radio"]');
                        if (input) {
                            input.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            input.click();
                            return true;
                        }

                        if (el.previousElementSibling && (el.previousElementSibling.type === 'checkbox' || el.previousElementSibling.type === 'radio')) {
                            el.previousElementSibling.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            el.previousElementSibling.click();
                            return true;
                        }

                        return false;
                    }, detail.selector || '');
                }

                if (!clicked) {
                    clicked = await page.evaluate(async (text) => {
                        const elements = Array.from(document.querySelectorAll('button, a, input, label, span'));
                        const el = elements.find(e => e.innerText.trim() === text.trim());
                        if (el) {
                            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            el.click();
                            return true;
                        }
                        return false;
                    }, detail.text);
                }

                if (!clicked) {
                    await failWithScreenshot(i, `Click target not found or not clickable: ${detail.text || detail.id || detail.selector}`);
                } else {
                    console.log(`✅ Clicked successfully: ${detail.text || detail.id || detail.selector}`);
                }
            }

            if (type === 'input') {
                // Skip input events for checkboxes and radios, handled by clicks
                if (detail.type === 'checkbox' || detail.type === 'radio') {
                    console.log(`ℹ️ Skipping input event for ${detail.type} (handled by click)`);
                    continue;
                }

                const selector = detail.selector || `[name="${detail.name}"]`;
                try {
                    // Try main page first
                    let elHandle;
                    try {
                        elHandle = await page.waitForSelector(selector, { timeout: 3000 });
                        await elHandle.focus();
                        await elHandle.click({ clickCount: 3 });
                        await elHandle.type(detail.value || '', { delay: 50 });
                        console.log(`⌨️ Typed into ${selector}: ${detail.value}`);
                    } catch {
                        // Try typing inside iframes
                        const typed = await typeInIframeInput(page, selector, detail.value || '');
                        if (!typed) throw new Error(`Input field not found: ${selector}`);
                        else console.log(`⌨️ Typed into iframe input: ${selector}: ${detail.value}`);
                    }
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
