/** QA follow-up 2: measure FAB vs ไทย segment overlap at the scroll position where they collide,
 *  and capture the same row scrolled AWAY from the FAB to prove the Thai text renders fully. */
import { chromium } from '@playwright/test';

const BASE = 'http://127.0.0.1:4273/browser-todo-app/';
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 320, height: 568 } });
const page = await context.newPage();
await page.goto(`${BASE}#/settings`, { waitUntil: 'load' });
await page.waitForSelector('.shell');
await page.waitForTimeout(300);

// Scroll the Thai segment so its center is at the FAB's vertical zone
await page.evaluate(() => {
  const seg = [...document.querySelectorAll('label.segment')].find((l) => l.textContent.trim() === 'ไทย');
  const r = seg.getBoundingClientRect();
  window.scrollBy(0, r.top - 455);
});
await page.waitForTimeout(150);
const state = await page.evaluate(() => {
  const fab = document.querySelector('.fab').getBoundingClientRect();
  const seg = [...document.querySelectorAll('label.segment')].find((l) => l.textContent.trim() === 'ไทย');
  const r = seg.getBoundingClientRect();
  const ix = Math.max(0, Math.min(fab.right, r.right) - Math.max(fab.left, r.left));
  const iy = Math.max(0, Math.min(fab.bottom, r.bottom) - Math.max(fab.top, r.top));
  return {
    segment: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height },
    fab: { left: fab.left, right: fab.right, top: fab.top, bottom: fab.bottom },
    overlap: { w: +ix.toFixed(1), h: +iy.toFixed(1), fractionOfSegment: +((ix * iy) / (r.width * r.height)).toFixed(2) },
    unobscuredWidth: +(Math.max(r.left, fab.left) - r.left).toFixed(1),
  };
});
console.log('FAB vs Thai segment at collision scroll position:', JSON.stringify(state, null, 2));
await page.screenshot({ path: new URL('./shots/fab-overlap-320.png', import.meta.url).pathname });

// Same row scrolled clear of the FAB zone (y ~250)
await page.evaluate(() => {
  const seg = [...document.querySelectorAll('label.segment')].find((l) => l.textContent.trim() === 'ไทย');
  const r = seg.getBoundingClientRect();
  window.scrollBy(0, r.top - 250);
});
await page.waitForTimeout(150);
await page.screenshot({ path: new URL('./shots/thai-clear-320.png', import.meta.url).pathname });
await browser.close();
