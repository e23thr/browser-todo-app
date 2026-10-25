/** At c590ab2: does .task-check-hit (label wrapper) provide the >=44px hit area at 360px?
 *  Also measure the settings radio effective targets (input + label). */
import { APP_URL, addTasks, bootPage, createLists, launch, loadCatalogs, writeEvidence } from './lib.mjs';

const catalogs = loadCatalogs();
const browser = await launch();
const out = {};
try {
  const { context, page } = await bootPage(browser, catalogs, {
    colorScheme: 'light',
    viewport: { width: 360, height: 740 },
    isMobile: true,
    hasTouch: true,
  });
  await createLists(page, catalogs, ['Home']);
  await addTasks(page, ['Buy milk']);
  await page.goto(`${APP_URL}#/all`);
  await page.waitForTimeout(500);
  out.checkbox = await page.evaluate(() => {
    const cb = document.querySelector('.task-check');
    const hit = document.querySelector('.task-check-hit') ?? cb.closest('label');
    const r = cb.getBoundingClientRect();
    const hr = hit?.getBoundingClientRect() ?? null;
    const at = (dx, dy) => {
      const el = document.elementFromPoint(r.x + r.width / 2 + dx, r.y + r.height / 2 + dy);
      return el === null ? null : `${el.tagName}.${(el.className ?? '').toString().slice(0, 40)}`;
    };
    return {
      input: { w: r.width, h: r.height },
      hit: hr === null ? null : { w: Math.round(hr.width * 100) / 100, h: Math.round(hr.height * 100) / 100, cls: hit.className },
      hitAtLeftEdge: at(-21, 0),
      hitAtRightEdge: at(21, 0),
      hitAtTopEdge: at(0, -21),
      hitAtBottomEdge: at(0, 21),
      sameHitTarget: at(-21, 0) !== null && at(21, 0) !== null && at(0, -21) !== null && at(0, 21) !== null,
    };
  });
  await page.goto(`${APP_URL}#/settings`);
  await page.waitForTimeout(500);
  out.radios = await page.evaluate(() =>
    [...document.querySelectorAll('input[name="settings-locale"], input[name="settings-theme"], input[name="settings-week"]')].map((i) => {
      const r = i.getBoundingClientRect();
      const lab = i.labels?.[0] ?? null;
      const lr = lab?.getBoundingClientRect() ?? null;
      return {
        name: i.name,
        input: { w: r.width, h: r.height },
        label: lr === null ? null : { w: Math.round(lr.width), h: Math.round(lr.height) },
        labelActivates: lab !== null,
      };
    }),
  );
  await context.close();
} finally {
  await browser.close();
}
writeEvidence('hit-area-c590ab2.json', out);
console.log(JSON.stringify(out, null, 2));
process.exit(0);
