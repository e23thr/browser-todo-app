// Replay the B submit with window.fetch wrapped: what does the engine actually
// request, what comes back, and what does the panel settle into?
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript(() => {
  try {
    localStorage.setItem('todo:prefs:v1:onboardingStep', 'done');
  } catch {}
  window.__csp = [];
  const rec = (e) => window.__csp.push({ directive: e.violatedDirective, blockedURI: e.blockedURI });
  document.addEventListener('securitypolicyviolation', rec);
  window.addEventListener('securitypolicyviolation', rec);
  window.__fetchLog = [];
  const orig = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const entry = { url: String(typeof input === 'object' && 'url' in input ? input.url : input), method: init?.method ?? 'GET' };
    window.__fetchLog.push(entry);
    return orig(input, init).then(
      (r) => {
        entry.status = r.status;
        return r;
      },
      (e) => {
        entry.error = String(e);
        throw e;
      },
    );
  };
});
const page = await ctx.newPage();
page.on('console', (m) => console.log(`CONSOLE[${m.type()}]`, m.text().slice(0, 220)));
page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 220)));

await page.goto('http://localhost:4193/#/settings', { waitUntil: 'load' });
await page.waitForSelector('text=Sync is off', { timeout: 15000 });
for (let i = 0; i < 60; i += 1) {
  if ((await page.evaluate(() => document.activeElement?.id ?? '')) === 'sync-url') break;
  await page.keyboard.press('Tab');
}
await page.keyboard.type('http://localhost:4193/dav-dead/');
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
await page.keyboard.type('alice');
await page.keyboard.press('Tab');
await page.keyboard.type('pw-x');
await page.keyboard.press('Enter');

for (const wait of [500, 1500, 4000]) {
  await page.waitForTimeout(wait);
  const state = await page.evaluate(() => ({
    wizard: !!document.querySelector('[data-testid="sync-wizard"]'),
    statusLine: document.querySelector('[data-testid="sync-status-line"]')?.textContent ?? null,
    setupError: document.querySelector('[data-testid="setup-error"]')?.textContent ?? null,
    submitLabel: document.querySelector('[data-testid="sync-wizard"] button[type="submit"]')?.textContent ?? null,
    polite: document.querySelector('[role="status"][aria-live="polite"]')?.textContent ?? null,
    assertive: document.querySelector('[role="alert"][aria-live="assertive"]')?.textContent ?? null,
    fetchLog: window.__fetchLog,
    csp: window.__csp,
  }));
  console.log(`\n== t+${String(wait)} ==\n${JSON.stringify(state, null, 1)}`);
}
await browser.close();
