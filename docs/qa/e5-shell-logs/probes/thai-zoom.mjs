/** QA follow-up 3: high-DPR zoom capture of the Thai segment alone. */
import { chromium } from '@playwright/test';

const BASE = 'http://127.0.0.1:4273/browser-todo-app/';
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 320, height: 568 }, deviceScaleFactor: 3 });
const page = await context.newPage();
await page.goto(`${BASE}#/settings`, { waitUntil: 'load' });
await page.waitForSelector('.shell');
await page.waitForTimeout(300);
const seg = await page.evaluateHandle(() =>
  [...document.querySelectorAll('label.segment')].find((l) => l.textContent.trim() === 'ไทย'),
);
await seg.asElement().screenshot({ path: new URL('./shots/thai-segment-zoom.png', import.meta.url).pathname });
const style = await page.evaluate(() => {
  const s = [...document.querySelectorAll('label.segment')].find((l) => l.textContent.trim() === 'ไทย');
  const cs = getComputedStyle(s);
  return {
    text: s.textContent.trim(),
    fontFamily: cs.fontFamily,
    fontSize: cs.fontSize,
    overflow: cs.overflow,
    whiteSpace: cs.whiteSpace,
    scrollW: s.scrollWidth,
    clientW: s.clientWidth,
    spanFits: (() => {
      const span = s.querySelector('.segment-label');
      return { scrollW: span.scrollWidth, clientW: span.clientWidth };
    })(),
  };
});
console.log('Thai segment:', JSON.stringify(style, null, 2));
await browser.close();
