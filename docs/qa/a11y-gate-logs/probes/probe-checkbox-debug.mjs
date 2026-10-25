/** Debug: enumerate stylesheets/rules and locate every rule matching `.task-check`. */
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
  out.result = await page.evaluate(() => {
    const cb = document.querySelector('.task-check');
    const report = { sheets: [], matches: [], total: 0, err: null };
    try {
      for (let i = 0; i < document.styleSheets.length; i++) {
        const sheet = document.styleSheets[i];
        let rules;
        try {
          rules = sheet.cssRules;
        } catch (e) {
          report.sheets.push({ i, href: sheet.href, err: String(e) });
          continue;
        }
        report.sheets.push({ i, href: sheet.href, rules: rules.length });
        for (const r of rules) {
          report.total++;
          const sel = r.selectorText;
          if (sel === undefined) continue;
          let m = false;
          try {
            m = cb.matches(sel);
          } catch {
            continue;
          }
          if (m) report.matches.push({ sel, css: (r.style?.cssText ?? '').slice(0, 220) });
        }
      }
    } catch (e) {
      report.err = String(e);
    }
    const cs = getComputedStyle(cb);
    report.computed = { padding: cs.padding, margin: cs.margin, width: cs.width, boxSizing: cs.boxSizing };
    // brute force: which declarations exist for task-check in raw CSS text?
    report.rawHit = [...document.styleSheets].map((s) => {
      try {
        return [...s.cssRules].map((r) => r.cssText).filter((t) => t.includes('task-check')).slice(0, 5);
      } catch {
        return ['<cross-origin>'];
      }
    }).flat();
    return report;
  });
  await context.close();
} finally {
  await browser.close();
}
writeEvidence('checkbox-css-debug.json', out);
console.log(JSON.stringify(out, null, 2));
process.exit(0);
