/** What does the compact (360px, touch) viewport render at #/all — composer reachable? */
import { APP_URL, createLists, dismissOnboarding, launch, loadCatalogs, writeEvidence } from './lib.mjs';

const catalogs = loadCatalogs();
const browser = await launch();
const out = {};
try {
  const context = await browser.newContext({
    viewport: { width: 360, height: 740 },
    isMobile: true,
    hasTouch: true,
    colorScheme: 'light',
  });
  const page = await context.newPage();
  await page.goto(APP_URL);
  await page.waitForTimeout(500);
  await dismissOnboarding(page, catalogs);
  await createLists(page, catalogs, ['Home']);
  await page.goto(`${APP_URL}#/all`);
  await page.waitForTimeout(500);
  out.all = await page.evaluate(() => ({
    h1: [...document.querySelectorAll('h1')].map((h) => h.textContent),
    composers: document.querySelectorAll('.composer').length,
    textInputs: [...document.querySelectorAll('main input')].map((i) => `${i.type}#${i.id}.${i.className} disabled=${i.disabled}`),
    buttons: [...document.querySelectorAll('main button')].slice(0, 12).map((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim().slice(0, 30)),
    fab: (() => {
      const f = document.querySelector('.fab, [aria-label*="Add"], [aria-label*="new"]');
      return f === null ? null : `${f.tagName}.${f.className} label=${f.getAttribute('aria-label')}`;
    })(),
    mainHtml: document.querySelector('main')?.innerHTML.slice(0, 600),
  }));
  await context.close();
} finally {
  await browser.close();
}
writeEvidence('mobile-composer.json', out);
console.log(JSON.stringify(out, null, 2).slice(0, 4000));
process.exit(0);
