/**
 * Diagnostic (t_5612df50): isolate two keyboard-probe flags —
 *  1. skip-link as FIRST Tab stop (previous run had stale focus after same-doc goto)
 *  2. route-change focus target (previous run saw an input, contract says h1)
 */
import {
  APP_URL,
  addTasks,
  createLists,
  launch,
  loadCatalogs,
} from '../../../a11y-gate-logs/probes/lib.mjs';

const catalogs = loadCatalogs();
const dump = (page, label) =>
  page
    .evaluate(() => {
      const el = document.activeElement;
      const autofocus = [...document.querySelectorAll('main [data-autofocus]')]
        .filter((n) => n.closest('.dialog') === null)
        .map((n) => n.outerHTML.slice(0, 120));
      const title = document.querySelector('main [data-view-title]');
      return {
        hash: location.hash,
        active:
          el === null
            ? 'null'
            : el === document.body
              ? 'body'
              : `${el.tagName} cls="${String(el.className).slice(0, 60)}" id="${el.id}" label="${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 60)}"`,
        inDialog: el !== null && el.closest('.dialog') !== null,
        viewTitle: title === null ? null : `${title.tagName} "${title.textContent.trim().slice(0, 40)}"`,
        autofocusOutsideDialog: autofocus,
        dialogs: document.querySelectorAll('.dialog').length,
      };
    })
    .then((d) => {
      console.log(`  [${label}] hash=${d.hash}`);
      console.log(`      active=${d.active} inDialog=${d.inDialog} dialogs=${d.dialogs}`);
      console.log(`      viewTitle=${d.viewTitle} autofocus=${JSON.stringify(d.autofocusOutsideDialog)}`);
      return d;
    });

const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
const page = await context.newPage();
await page.goto(APP_URL);
await page.waitForTimeout(400);
const cta = page.locator('[data-surface="onboarding"] .onboarding-actions button');
if ((await cta.count()) > 0) await cta.first().click();
await createLists(page, catalogs, ['Home']);
await addTasks(page, ['Ship audit report', 'Buy oat milk']);
await page.goto(`${APP_URL}#/all`);
await page.waitForTimeout(500);

// 1) reset focus, then Tab from a truly fresh start
await page.evaluate(() => document.activeElement?.blur());
await dump(page, 'after blur');
await page.keyboard.press('Tab');
const first = await dump(page, 'first Tab');
await page.screenshot({ path: 'docs/qa/evidence/accessibility-logs/screenshots/diag-skip-first-tab.png' });
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
await dump(page, 'after Enter on first stop');

// 2) route change via nav link
let onLink = false;
for (let i = 0; i < 80 && !onLink; i++) {
  onLink = await page.evaluate(() => {
    const el = document.activeElement;
    return el !== null && el !== document.body && el.matches('a[href="#/completed"]');
  });
  if (!onLink) await page.keyboard.press('Tab');
}
console.log('  reached #/completed link:', onLink);
await page.keyboard.press('Enter');
await page.waitForTimeout(700);
await dump(page, 'after Enter on nav link (route change)');
await page.screenshot({ path: 'docs/qa/evidence/accessibility-logs/screenshots/diag-route-change-focus.png' });

// 3) direct hash navigation for comparison
await page.goto(`${APP_URL}#/settings`);
await page.waitForTimeout(600);
await dump(page, 'direct goto #/settings');

await browser.close();
console.log('done');
