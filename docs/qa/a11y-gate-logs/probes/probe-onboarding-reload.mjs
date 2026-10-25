/** Real-user repro: complete onboarding, create NOTHING, reload. RecoveryScreen (false wipe)? */
import { APP_URL, bootPage, launch, loadCatalogs, writeEvidence } from './lib.mjs';

const catalogs = loadCatalogs();
const browser = await launch();
const out = { steps: [] };
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(APP_URL);
  await page.waitForTimeout(700);

  const dump = async (label) => {
    const info = await page.evaluate(() => ({
      url: location.href,
      h1: [...document.querySelectorAll('h1')].map((h) => h.textContent?.trim()),
      onboarding: document.querySelector('[data-surface="onboarding"]') !== null,
      recovery: document.querySelector('.recovery') !== null,
      lsStep: localStorage.getItem('todo:prefs:v1:onboardingStep'),
    }));
    out.steps.push({ label, ...info });
    console.log(`${label}: ${JSON.stringify(info)}`);
  };

  await dump('fresh');
  const cta = page.locator('[data-surface="onboarding"] .onboarding-actions button');
  if ((await cta.count()) > 0) {
    await cta.first().click();
    await page.waitForTimeout(700);
  }
  await dump('after-onboarding');

  // real user closes the tab WITHOUT creating any list/task, then returns
  await page.reload();
  await page.waitForTimeout(900);
  await dump('reload-1 (no data created)');

  await page.reload();
  await page.waitForTimeout(900);
  await dump('reload-2');

  // what if they DO create a list, then wipe localStorage-level data? (skip — just note state)
  out.meta = await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    return { dbs: dbs.map((d) => ({ name: d.name, version: d.version })), ls: Object.entries(localStorage) };
  });
  await context.close();
} finally {
  await browser.close();
}
writeEvidence('onboarding-reload.json', out);
console.log('evidence written');
process.exit(0);
