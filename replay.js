// replay.js
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

const discordWebhook = process.env.DISCORD_WEBHOOK;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeText(str = '') {
    return str.replace(/\u2013/g, '-').replace(/\s+/g, ' ').trim();
}

async function countSelector(page, selector) {
    try {
        return await page.$$eval(selector, els => els.length);
    } catch {
        return 0;
    }
}

async function logVisibleTextOptions(page) {
    const texts = await page.$$eval(
        'button, a, label, span, div',
        els => els.map(e => e.innerText.trim()).filter(t => t)
    );
    console.log('🔍 Visible clickable texts:', texts);
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

async function typeInIframeInput(page, selector, value) {
    for (const frame of page.frames()) {
        try {
            const el = await frame.waitForSelector(selector, { timeout: 3000 });
            if (el) {
                await el.focus();
                await el.click({ clickCount: 3 });
                await el.type(value, { delay: 50 });
                return true;
            }
        } catch { }
    }
    return false;
}

(async () => {
    const sessionFile = path.join(__dirname, 'sessions', `${testName}.json`);
    if (!fs.existsSync(sessionFile)) {
        console.error(`❌ Test file not found: sessions/${testName}.json`);
        process.exit(1);
    }

    let session;
    try {
        session = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
    } catch (err) {
        console.error(`❌ Failed to parse JSON:`, err.message);
        process.exit(1);
    }

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

    async function fail(stepIndex, reason) {
        const img = path.join(screenshotDir, `${testName}-step${stepIndex + 1}.png`);
        await page.screenshot({ path: img });
        console.error(`📸 Screenshot: ${img}`);
        console.error(`❌ Step ${stepIndex + 1} failed: ${reason}`);
        sendDiscordWebhookWithScreenshot(
            `❌ **Test Failed**: \`${testName}\` step ${stepIndex + 1}: ${reason}`,
            img
        );
        await browser.close();
        process.exit(1);
    }

    // Navigate to the first URL
    const firstNav = session.find(e => e.type === 'navigate');
    console.log(`🚀 Navigating to ${firstNav.href}`);
    try {
        await page.goto(firstNav.href, { waitUntil: 'domcontentloaded', timeout: 10000 });
    } catch (err) {
        await fail(0, `Failed to navigate to ${firstNav.href}`);
    }

    // Replay all events
    let lastTimestamp = firstNav.timestamp;
    for (let i = 0; i < session.length; i++) {
        const { type, detail, timestamp } = session[i];
        const dt = Math.min(timestamp - lastTimestamp, 10000);
        lastTimestamp = timestamp;
        if (dt > 0) await sleep(dt);

        // Handle waitFor steps
        if (type === 'waitFor') {
            const sel = detail.selector;
            const to = detail.timeout || 5000;
            console.log(`⏳ Waiting for selector "${sel}"…`);
            try {
                await page.waitForSelector(sel, { timeout: to });
            } catch {
                console.warn(`  ⚠️ waitFor("${sel}") timed out after ${to}ms`);
            }
            continue;
        }

        // skip navigate
        if (type === 'navigate') continue;
        // skip malformed
        if ((type === 'click' || type === 'input') && !detail) continue;

        // —— CLICK logic
        if (type === 'click') {
            const rawText = detail.text || detail.name || '';
            const sel = detail.selector || '';
            const tag = detail.tag || '';
            const targetText = normalizeText(rawText);

            console.log(`➡️ Step ${i + 1}: click "${rawText}" selector="${sel}" tag="${tag}"`);

            // special wait for hungerTime group
            if (sel.includes('hungerTime') && targetText) {
                console.log(`⏳ Waiting for hungerTime option "${targetText}"…`);
                await page.waitForFunction(
                    text => {
                        const normalize = s => s.replace(/\u2013/g, '-').replace(/\s+/g, ' ').trim();
                        return [...document.querySelectorAll('button, label, span, div')]
                            .some(el => normalize(el.innerText) === text);
                    },
                    { timeout: 5000 },
                    targetText
                ).catch(() => { });
            }

            let clicked = false;

            // 1) by recorded ID
            if (detail.id && !clicked) {
                const byId = `#${detail.id}`;
                if (await countSelector(page, byId)) {
                    clicked = await page.click(byId).then(() => true).catch(() => false);
                }
            }

            // 2) by recorded CSS selector
            if (!clicked && sel) {
                if (await countSelector(page, sel)) {
                    clicked = await page.click(sel).then(() => true).catch(() => false);
                }
            }

            // 3) by name attribute
            if (!clicked && detail.name) {
                const byName = `[name="${detail.name}"]`;
                if (await countSelector(page, byName)) {
                    clicked = await page.click(byName).then(() => true).catch(() => false);
                }
            }

            // 4) by xpath
            if (!clicked && detail.xpath) {
                clicked = await page.evaluate(xp => {
                    const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                    if (el) { el.scrollIntoView(); el.click(); return true; }
                    return false;
                }, detail.xpath).catch(() => false);
            }

            // 5) nested input under LABEL or SPAN
            if (!clicked && ['LABEL', 'SPAN'].includes(tag)) {
                clicked = await page.evaluate(sel => {
                    const el = document.querySelector(sel);
                    if (!el) return false;
                    if (el.tagName === 'LABEL' && el.htmlFor) {
                        const inp = document.getElementById(el.htmlFor);
                        if (inp) { inp.click(); return true; }
                    }
                    const child = el.querySelector('input');
                    if (child) { child.click(); return true; }
                    return false;
                }, sel).catch(() => false);
            }

            // 6) exact text match
            if (!clicked && targetText) {
                clicked = await page.evaluate(text => {
                    const normalize = s => s.replace(/\u2013/g, '-').replace(/\s+/g, ' ').trim();
                    for (const el of document.querySelectorAll('button,a,label,span,div')) {
                        if (normalize(el.innerText) === text) {
                            el.scrollIntoView({ block: 'center' }); el.click();
                            return true;
                        }
                    }
                    return false;
                }, targetText).catch(() => false);
            }

            // 7) substring match
            if (!clicked && targetText) {
                clicked = await page.evaluate(text => {
                    text = text.toLowerCase();
                    for (const el of document.querySelectorAll('button,a,label,span,div')) {
                        const txt = el.innerText.replace(/\s+/g, ' ').trim().toLowerCase();
                        if (txt.includes(text)) {
                            el.scrollIntoView({ block: 'center' }); el.click();
                            return true;
                        }
                    }
                    return false;
                }, targetText).catch(() => false);
            }

            // 8) by className
            if (!clicked && detail.className) {
                const cls = detail.className.trim().split(/\s+/).join('.');
                clicked = await page.evaluate(c => {
                    const el = document.querySelector('.' + c);
                    if (el) { el.scrollIntoView({ block: 'center' }); el.click(); return true; }
                    return false;
                }, cls).catch(() => false);
            }

            // 9) regex fallback for numeric labels
            if (!clicked && /\d/.test(targetText)) {
                const esc = targetText.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, ch => ch === '-' ? '-' : `\\${ch}`);
                clicked = await page.evaluate(src => {
                    const re = new RegExp(src, 'i');
                    for (const el of document.querySelectorAll('button,a,label,span,div')) {
                        const txt = el.innerText.replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
                        if (re.test(txt)) {
                            el.scrollIntoView({ block: 'center' }); el.click();
                            return true;
                        }
                    }
                    return false;
                }, esc).catch(() => false);
            }

            // 10) fuzzy-regex fallback: allow extra words between tokens
            if (!clicked && targetText) {
                const tokens = targetText.split(' ');
                const pattern = tokens
                    .map(tok => tok.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'))
                    .join('.*');
                clicked = await page.evaluate(pat => {
                    const re = new RegExp(pat, 'i');
                    for (const el of document.querySelectorAll('button,a,label,span,div')) {
                        const txt = el.innerText.replace(/\s+/g, ' ').trim();
                        if (re.test(txt)) {
                            el.scrollIntoView({ block: 'center' }); el.click();
                            return true;
                        }
                    }
                    return false;
                }, pattern).catch(() => false);
            }

            // if still not clicked, print diagnostics and fail
            if (!clicked) {
                console.error(`  ❗ could not click "${rawText}", here’s why:\n`);
                const reasons = [];

                if (detail.id) {
                    const cnt = await countSelector(page, `#${detail.id}`);
                    reasons.push(`    • by recorded id "#${detail.id}" → ${cnt} matches`);
                }
                if (sel) {
                    const cnt = await countSelector(page, sel);
                    reasons.push(`    • by recorded selector "${sel}" → ${cnt} matches`);
                }
                if (detail.name) {
                    const cnt = await countSelector(page, `[name="${detail.name}"]`);
                    reasons.push(`    • by name "[name=${detail.name}]" → ${cnt} matches`);
                }
                if (detail.xpath) {
                    const has = await page.evaluate(xp =>
                        !!document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue,
                        detail.xpath
                    );
                    reasons.push(`    • by xpath "${detail.xpath}" → ${has ? 'found' : 'not found'}`);
                }
                if (['LABEL', 'SPAN'].includes(tag)) {
                    const nest = await page.evaluate(sel => {
                        const el = document.querySelector(sel);
                        if (!el) return 0;
                        let c = 0;
                        if (el.tagName === 'LABEL' && el.htmlFor && document.getElementById(el.htmlFor)) c++;
                        if (el.querySelector('input')) c++;
                        return c;
                    }, sel);
                    reasons.push(`    • nested input under ${tag} → ${nest} matches`);
                }
                const exactCnt = await page.evaluate(text => {
                    const normalize = s => s.replace(/\u2013/g, '-').replace(/\s+/g, ' ').trim();
                    return Array.from(document.querySelectorAll('button,a,label,span,div'))
                        .filter(el => normalize(el.innerText) === text).length;
                }, targetText);
                reasons.push(`    • exact text "${targetText}" → ${exactCnt} matches`);
                const subCnt = await page.evaluate(text => {
                    const t = text.toLowerCase();
                    return Array.from(document.querySelectorAll('button,a,label,span,div'))
                        .filter(el => el.innerText.replace(/\s+/g, ' ').trim().toLowerCase().includes(t))
                        .length;
                }, targetText);
                reasons.push(`    • substring match → ${subCnt} matches`);
                if (detail.className) {
                    const cls = detail.className.trim().split(/\s+/).join('.');
                    const clsCnt = await page.evaluate(c => document.querySelectorAll('.' + c).length, cls);
                    reasons.push(`    • by className ".${cls}" → ${clsCnt} matches`);
                }
                console.error(reasons.join('\n') + '\n');
                await logVisibleTextOptions(page);
                await fail(i, `could not click "${rawText}"`);
            }

            await sleep(500);
            continue;
        }

        // —— INPUT logic
        if (type === 'input') {
            if (detail.type === 'checkbox' || detail.type === 'radio') continue;

            const sel = detail.selector || `[name="${detail.name}"]`;
            const val = detail.value || '';
            console.log(`➡️ Step ${i + 1}: input "${val}" into "${sel}"`);

            let typed = false;

            // 1) standard
            try {
                const el = await page.waitForSelector(sel, { timeout: 3000 });
                await el.focus();
                await el.click({ clickCount: 3 });
                await el.type(val, { delay: 50 });
                typed = true;
            } catch { }

            // 2) iframe
            if (!typed) typed = await typeInIframeInput(page, sel, val);

            // 3) parent-id
            if (!typed && sel.includes('#')) {
                const m = sel.match(/#([^ >]+)/);
                if (m) {
                    typed = await page.evaluate((id, v) => {
                        const p = document.getElementById(id);
                        if (!p) return false;
                        const inp = p.querySelector('input');
                        if (!inp) return false;
                        inp.value = v;
                        inp.dispatchEvent(new Event('input', { bubbles: true }));
                        return true;
                    }, m[1], val).catch(() => false);
                }
            }

            // 4) xpath
            if (!typed && detail.xpath) {
                typed = await page.evaluate((xp, v) => {
                    const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                    if (el && el.tagName.toLowerCase() === 'input') {
                        el.value = v;
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        return true;
                    }
                    return false;
                }, detail.xpath, val).catch(() => false);
            }

            // 5) className
            if (!typed && detail.className) {
                const cls = detail.className.trim().split(/\s+/).join('.');
                typed = await page.evaluate((c, v) => {
                    const el = document.querySelector('input.' + c);
                    if (!el) return false;
                    el.value = v;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    return true;
                }, cls, val).catch(() => false);
            }

            // 6) generic first
            if (!typed) {
                typed = await page.evaluate(v => {
                    const all = Array.from(document.querySelectorAll('input[type="text"],input[type="number"],input:not([type])'));
                    const el = all.find(e => !e.disabled && e.offsetParent);
                    if (!el) return false;
                    el.value = v;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    return true;
                }, val).catch(() => false);
            }

            if (!typed) await fail(i, `Input field not found: ${sel}`);
            continue;
        }
    }

    console.log(`🎉 Replay finished successfully for "${testName}"`);
    await browser.close();
    process.exit(0);
})().catch(async err => {
    console.error('❌ Uncaught error in replay:', err);
    if (browser) await browser.close();
    process.exit(1);
});
