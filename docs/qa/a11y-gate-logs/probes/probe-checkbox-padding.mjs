/** Empirical: does author padding actually lay out on the native checkbox? (M13 target-size root cause) */
import { APP_URL, addTasks, bootPage, createLists, launch, loadCatalogs, writeEvidence } from './lib.mjs';

const catalogs = loadCatalogs();
const browser = await launch();
const out = {};
try {
  const { context, page } = await bootPage(browser, catalogs, { colorScheme: 'light' });
  await createLists(page, catalogs, ['Home']);
  await addTasks(page, ['Buy milk', 'Second task']);
  await page.goto(`${APP_URL}#/all`);
  await page.waitForTimeout(400);
  out.result = await page.evaluate(() => {
    const cb = document.querySelector('.task-check');
    const snap = () => {
      const cs = getComputedStyle(cb);
      const r = cb.getBoundingClientRect();
      return { padding: cs.padding, margin: cs.margin, appearance: cs.appearance, rect: { w: r.width, h: r.height }, x: r.x, y: r.y };
    };
    const base = snap();
    // 1. author padding inline
    cb.style.padding = '10px';
    const inlineP = snap();
    cb.style.padding = '';
    // 2. explicit appearance: none + padding
    cb.style.appearance = 'none';
    cb.style.padding = '10px';
    const appearanceNone = snap();
    cb.style.appearance = '';
    cb.style.padding = '';
    const restored = snap();
    // 3. what the neighbours look like (overlap geometry)
    const title = cb.parentElement.querySelector('.task-title');
    const tr = title.getBoundingClientRect();
    const r0 = cb.getBoundingClientRect();
    return {
      base,
      inlineP,
      appearanceNone,
      restored,
      title: { x: tr.x, w: tr.width, h: tr.height, left: tr.left },
      checkboxRight: r0.right,
      overlapPx: r0.right - tr.left,
      // where does a click 12px right of the checkbox's left edge (inside its visual box) land?
      hitAtLeft: (() => {
        const el = document.elementFromPoint(r0.x + 4, r0.y + r0.height / 2);
        return el === null ? null : `${el.tagName}.${el.className}`;
      })(),
      hitAtRight: (() => {
        const el = document.elementFromPoint(r0.x + r0.width - 4, r0.y + r0.height / 2);
        return el === null ? null : `${el.tagName}.${el.className}`;
      })(),
    };
  });
  await context.close();
} finally {
  await browser.close();
}
writeEvidence('checkbox-padding.json', out);
console.log(JSON.stringify(out, null, 2));
process.exit(0);
