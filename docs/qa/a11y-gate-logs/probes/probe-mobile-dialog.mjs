/** Mobile: after create+add steps, what dialog (if any) is still open at #/settings — and does it
 *  survive a route change (focus-trap on the wrong route would itself be a defect)? */
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
  const dump = async (label) => {
    out[label] = await page.evaluate(() => {
      const layer = document.querySelector('.dialog-layer');
      const visibleDialogs = [...document.querySelectorAll('.dialog-layer .dialog, .dialog')].filter((d) => {
        const r = d.getBoundingClientRect();
        const cs = getComputedStyle(d);
        return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
      });
      return {
        url: location.href,
        layerHtml: (layer?.innerHTML ?? '').slice(0, 400),
        visibleDialogCount: visibleDialogs.length,
        visibleDialogClasses: visibleDialogs.map((d) => d.className),
        active: `${document.activeElement?.tagName}.${document.activeElement?.className}`.slice(0, 120),
        ariaHiddenBody: document.body.getAttribute('aria-hidden'),
      };
    });
  };
  await createLists(page, catalogs, ['Home']);
  await dump('after-create-list');
  await addTasks(page, ['Buy milk']);
  await dump('after-add-task');
  await page.goto(`${APP_URL}#/settings`);
  await page.waitForTimeout(500);
  await dump('at-settings-hashchange');
  await page.reload();
  await page.waitForTimeout(600);
  await dump('at-settings-after-reload');
  await context.close();
} finally {
  await browser.close();
}
writeEvidence('mobile-dialog-state.json', out);
console.log(JSON.stringify(out, null, 2));
process.exit(0);
