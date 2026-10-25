/** B2 evidence: on a fresh profile (CI's state), do the a11y spec's CORE_ROUTES ever leave
 *  first-run onboarding? If every route scans onboarding, CI's axe job is vacuous. */
import { APP_URL, launch, loadCatalogs, writeEvidence } from './lib.mjs';

const CORE_ROUTES = ['', '#/today', '#/week', '#/all', '#/completed', '#/search', '#/list/01TESTLIST', '#/settings'];
const out = { routes: [] };

const browser = await launch();
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  for (const route of CORE_ROUTES) {
    await page.goto(`${APP_URL}${route}`);
    await page.waitForTimeout(350);
    const state = await page.evaluate(() => ({
      h1: [...document.querySelectorAll('h1')].map((h) => h.textContent?.trim()),
      onboarding: document.querySelector('[data-surface="onboarding"]') !== null,
      theme: document.documentElement.getAttribute('data-theme'),
    }));
    out.routes.push({ route: route || '/', ...state });
    console.log(`${route || '/'}: h1=${JSON.stringify(state.h1)} onboarding=${state.onboarding}`);
  }
  await context.close();
} finally {
  await browser.close();
}
writeEvidence('ci-routes-fresh-profile.json', out);
process.exit(0);
