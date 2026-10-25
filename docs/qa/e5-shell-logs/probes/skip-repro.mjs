/** Minimal repro: what does Enter on the skip link actually do? */
import { chromium } from '@playwright/test';

const BASE = 'http://127.0.0.1:4273/browser-todo-app/';
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 320, height: 568 } });
const page = await context.newPage();
await page.goto(`${BASE}#/today`, { waitUntil: 'load' });
await page.waitForSelector('.shell');

const state = (label) =>
  page.evaluate((l) => {
    const el = document.activeElement;
    return {
      label: l,
      hash: location.hash,
      drawerPresent: !!document.querySelector('.drawer'),
      active: {
        tag: el.tagName.toLowerCase(),
        cls: typeof el.className === 'string' ? el.className : '',
        id: el.id || null,
        text: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30),
      },
      mainExists: !!document.querySelector('#main'),
    };
  }, label);

console.log(JSON.stringify(await state('before tab')));
await page.keyboard.press('Tab');
console.log(JSON.stringify(await state('after 1 tab')));
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
console.log(JSON.stringify(await state('after Enter on skip link')));
await browser.close();
