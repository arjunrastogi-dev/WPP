/**
 * End-to-end UI smoke test. Drives the real app in headless Chrome and fails
 * on ANY console error, page error or failed request.
 *
 * Needs both dev servers running:  npm run dev
 * Then:                            npm --prefix server run smoke
 *
 * If puppeteer's bundled Chromium refuses to launch on Windows, point it at
 * the installed Chrome:
 *   CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" npm run smoke
 */
import puppeteer from 'puppeteer';

const APP = 'http://localhost:5173';
const OUT = process.env.SHOT_DIR ?? '.';

const errors = [];
const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 820 });

page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
page.on('response', async (r) => {
  if (r.status() >= 400) {
    const body = await r.text().catch(() => '');
    errors.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()} :: ${body.slice(0, 200)}`);
  }
});

const step = async (label, fn) => {
  const before = errors.length;
  await fn();
  const fresh = errors.slice(before);
  console.log(`${fresh.length ? 'FAIL' : ' ok '}  ${label}${fresh.length ? ` -> ${fresh.join(' | ')}` : ''}`);
};

await step('load login page', async () => {
  await page.goto(APP, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.login__card', { timeout: 10000 });
});
await page.screenshot({ path: `${OUT}/shot-login.png` });

await step('sign in', async () => {
  await page.type('input[autocomplete="username"]', '');
  await page.type('input[autocomplete="current-password"]', 'admin123');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.shell', { timeout: 10000 });
});
await page.screenshot({ path: `${OUT}/shot-inbox.png` });

// Navigate by clicking the sidebar, the way a user does. A hard page.goto()
// tears down the socket mid-poll and produces a spurious 400 from Socket.IO.
const go = (label, linkText, selector) =>
  step(label, async () => {
    await page.evaluate((text) => {
      const link = [...document.querySelectorAll('.rail__link')]
        .find((a) => a.textContent.trim().endsWith(text));
      link.click();
    }, linkText);
    await page.waitForSelector(selector, { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 600)); // let the page settle its fetches
  });

await go('sessions page', 'Sessions', '.page');
await page.screenshot({ path: `${OUT}/shot-sessions.png` });
await go('auto-replies page', 'Auto-replies', '.page');
await go('queue page', 'Queue', '.page');
await go('webhooks page', 'Webhooks', '.page');

await step('create an auto-reply rule', async () => {
  await go('nav to rules', 'Auto-replies', '.page');
  await page.type('input[placeholder="Greeting"]', 'Smoke greeting');
  await page.type('input[placeholder="hi"]', 'hello');
  await page.type('textarea', 'Hi {{name}}, thanks for reaching out!');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.table tbody tr', { timeout: 10000 });
});
await page.screenshot({ path: `${OUT}/shot-rules.png` });

await browser.close();

console.log(`\n${errors.length} error(s) total`);
if (errors.length) {
  for (const e of errors) console.log(`  - ${e}`);
  process.exitCode = 1;
}
