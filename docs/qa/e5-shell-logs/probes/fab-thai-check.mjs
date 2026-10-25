/** QA follow-up: FAB occlusion of interactive elements + Thai label rendering at 320px. */
import { chromium } from '@playwright/test';

const BASE = 'http://127.0.0.1:4273/browser-todo-app/';
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 320, height: 568 } });
const page = await context.newPage();
await page.goto(`${BASE}#/settings`, { waitUntil: 'load' });
await page.waitForSelector('.shell');
await page.waitForTimeout(300);

const overlap = await page.evaluate(() => {
  const fab = document.querySelector('.fab').getBoundingClientRect();
  const hits = [];
  for (const el of document.querySelectorAll('a[href], button, input, select, label.segment')) {
    const target = el.tagName === 'INPUT' && el.closest('label') ? el.closest('label') : el;
    const r = target.getBoundingClientRect();
    if (r.width === 0) continue;
    const ix = Math.max(0, Math.min(fab.right, r.right) - Math.max(fab.left, r.left));
    const iy = Math.max(0, Math.min(fab.bottom, r.bottom) - Math.max(fab.top, r.top));
    if (ix > 0 && iy > 0) {
      const area = r.width * r.height;
      const inter = ix * iy;
      hits.push({
        label: (el.getAttribute('aria-label') || target.textContent || '').trim().slice(0, 30),
        overlapFraction: +(inter / area).toFixed(2),
      });
    }
  }
  return { fab: { top: fab.top, left: fab.left, w: fab.width, h: fab.height }, hits };
});
console.log('FAB occlusion at 320 settings:', JSON.stringify(overlap, null, 2));

// Language segmented row screenshot for Thai rendering inspection
const row = await page.$('text=Language');
const section = await page.evaluateHandle(() => [...document.querySelectorAll('.settings-section')][1]);
await section.asElement().screenshot({ path: new URL('./shots/language-row-320.png', import.meta.url).pathname });
const labels = await page.evaluate(() =>
  [...document.querySelectorAll('.settings-section')][1]
    ? [...document.querySelectorAll('.settings-section')][1].querySelectorAll('.segment-label')
    : [],
);
console.log(
  'language segments:',
  JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('label.segment')].map((l) => l.textContent.trim()))),
);
await browser.close();
