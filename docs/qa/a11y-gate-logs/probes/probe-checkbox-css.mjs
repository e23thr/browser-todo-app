/** Find which CSS rule actually wins for `.task-check` padding (M13 target-size root cause). */
import { APP_URL, addTasks, bootPage, createLists, launch, loadCatalogs, writeEvidence } from './lib.mjs';

const catalogs = loadCatalogs();
const browser = await launch();
const out = {};
try {
  const { context, page } = await bootPage(browser, catalogs, { colorScheme: 'light' });
  await createLists(page, catalogs, ['Home']);
  await addTasks(page, ['Buy milk']);
  await page.goto(`${APP_URL}#/all`);
  await page.waitForTimeout(400);
  out.rules = await page.evaluate(() => {
    const cb = document.querySelector('.task-check');
    const found = [];
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      const walk = (list, media) => {
        for (const r of list) {
          if (r.cssRules !== undefined && r.cssRules !== null) {
            walk(r.cssRules, r.conditionText ?? media ?? '');
            continue;
          }
          if (r.selectorText === undefined) continue;
          let matches = false;
          try {
            matches = cb.matches(r.selectorText);
          } catch {
            continue;
          }
          if (matches && /padding|margin|width|height|box-sizing/.test(r.style.cssText)) {
            found.push({ selector: r.selectorText, media: media ?? '', css: r.style.cssText.slice(0, 200) });
          }
        }
      };
      walk(rules, '');
    }
    const cs = getComputedStyle(cb);
    return {
      found,
      computed: {
        padding: cs.padding,
        margin: cs.margin,
        width: cs.width,
        height: cs.height,
        boxSizing: cs.boxSizing,
      },
      rect: (() => {
        const r = cb.getBoundingClientRect();
        return { w: r.width, h: r.height };
      })(),
      matchedCbp: CSS.supports('padding', '10px'),
    };
  });
  await context.close();
} finally {
  await browser.close();
}
writeEvidence('checkbox-css.json', out);
console.log(JSON.stringify(out, null, 2));
process.exit(0);
