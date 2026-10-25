// Diagnostic: replay phases A->B with full state dumps after every step.
import { chromium } from '@playwright/test';

const APP = 'http://localhost:4193/';
const dump = async (page, label) => {
  const state = await page.evaluate(() => ({
    active: document.activeElement
      ? {
          tag: document.activeElement.tagName,
          id: document.activeElement.id ?? '',
          text: (document.activeElement.textContent ?? '').trim().slice(0, 40),
        }
      : null,
    wizard: !!document.querySelector('[data-testid="sync-wizard"]'),
    statusLine: document.querySelector('[data-testid="sync-status-line"]')?.textContent ?? null,
    setupError: document.querySelector('[data-testid="setup-error"]')?.textContent ?? null,
    url: document.querySelector('#sync-url')?.value ?? null,
    user: document.querySelector('#sync-user')?.value ?? null,
    step: document.querySelector('li[aria-current="step"]')?.textContent ?? null,
    syncNow: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Sync now'),
    intro: document.querySelector('.sync-intro')?.textContent ?? null,
    csp: window.__csp ?? [],
  }));
  console.log(`\n== ${label} ==\n${JSON.stringify(state, null, 1)}`);
};

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
});
const page = await ctx.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text().slice(0, 200));
});
await page.goto(`${APP}#/settings`, { waitUntil: 'load' });
await page.waitForSelector('[data-testid="sync-panel"]', { timeout: 15000 });
await page.waitForSelector('text=Sync is off', { timeout: 10000 });
await dump(page, 'after boot');

// Tab to URL field
for (let i = 0; i < 60; i += 1) {
  const id = await page.evaluate(() => document.activeElement?.id ?? '');
  if (id === 'sync-url') break;
  await page.keyboard.press('Tab');
}
await dump(page, 'focused sync-url');

await page.keyboard.type('http://evil.example/dav/');
await dump(page, 'typed evil url');
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
await dump(page, 'after Enter on evil url (expect refusal)');

// replace value the keyboard-only way
await page.keyboard.press('Shift+Home');
await page.keyboard.type('https://sync.example/dav/');
await dump(page, 'after Shift+Home + retype');
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
await dump(page, 'after Enter (expect step 2)');

// Back
for (let i = 0; i < 30; i += 1) {
  const found = await page.evaluate(() =>
    [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Back'),
  );
  const isBack = await page.evaluate(() => document.activeElement?.textContent?.trim() === 'Back');
  if (found && isBack) break;
  await page.keyboard.press('Tab');
}
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
await dump(page, 'after Back (expect step 1, focus url)');

// Phase B replay
await page.keyboard.press('Shift+Home');
await page.keyboard.type('http://localhost:4193/dav-dead/');
await dump(page, 'B: typed dead url');
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
await dump(page, 'B: after Enter (expect step 2)');

await page.keyboard.type('alice');
await page.keyboard.press('Tab');
await page.keyboard.type('pw-x');
await dump(page, 'B: creds typed');
await page.keyboard.press('Enter');
await page.waitForTimeout(1200);
await dump(page, 'B: after submit (expect setup-error)');

console.log('dav log:', JSON.stringify(await (await import('node:fs')).promises.readFile('qa-e8-dav-requests.jsonl', 'utf8').catch(() => '')));
await browser.close();
