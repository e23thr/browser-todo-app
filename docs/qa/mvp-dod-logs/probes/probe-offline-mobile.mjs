/**
 * MVP DoD release gate (task t_7f1e8f29) — Q15 criterion 1 probe:
 * the capture -> plan -> complete loop works OFFLINE on MOBILE viewports.
 *
 * Why this probe exists (the gap it closes):
 *   - E4's offline suites (offline*.spec.ts) run the offline journeys at Desktop Chrome only.
 *   - E2's 320/375 px runs (core-ui-keyboard / qa-search-reorder) run at mobile viewports but ONLINE.
 *   - Q15 criterion 1 requires BOTH: offline AND mobile. This probe is the intersection,
 *     driven through the real UI (composer, editor, chip, checkbox) against a production build.
 *
 * Run (from the repo root, after a base-path build):
 *   BASE_PATH=/browser-todo-app/ npm run build
 *   npx vite preview --port 4188 --strictPort &
 *   node docs/qa/mvp-dod-logs/probes/probe-offline-mobile.mjs
 *
 * Evidence: docs/qa/mvp-dod-logs/offline-mobile-probe.json
 */
import { addTasks, dismissOnboarding, launch, writeEvidence } from '../../a11y-gate-logs/probes/lib.mjs';

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:4188/browser-todo-app/';
const TASK_TITLE = 'DoD offline mobile task';
const VIEWPORTS = [
  { name: 'mobile-375x667', width: 375, height: 667, deviceScaleFactor: 3 },
  { name: 'mobile-320x640', width: 320, height: 640, deviceScaleFactor: 2 },
];

async function runViewport(browser, vp) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: vp.deviceScaleFactor,
    locale: 'en-US',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });

  const evidence = { viewport: vp.name, steps: [] };
  const step = (name, ok, detail = '') => {
    evidence.steps.push({ step: name, ok, detail });
    console.log(`[${vp.name}] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) throw new Error(`${vp.name}: ${name}${detail ? ` — ${detail}` : ''}`);
  };

  try {
    // 1. Online first load — the service worker must take control BEFORE the network is cut.
    await page.goto(APP_URL);
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, {
      timeout: 20_000,
    });
    await dismissOnboarding(page, {});
    const controlled = await page.evaluate(() => navigator.serviceWorker?.controller != null);
    step('sw-controls-page', controlled === true, 'service worker controls the page before offline');

    // 2. Cut the network. Everything below must work with zero connectivity.
    await context.setOffline(true);
    step('offline-engaged', true, 'context.setOffline(true)');

    // 3. Fresh profile has no lists, so the composer is disabled until one exists (S3).
    //    Create the list through the Manage-lists screen (layout-independent: the compact
    //    #/all view renders an empty state + FAB, not an inline composer — found the hard way).
    await page.goto(`${APP_URL}#/lists`);
    await page.waitForTimeout(400);
    const newListButton = page.getByRole('button', { name: 'New list', exact: true }).first();
    await newListButton.waitFor({ state: 'visible', timeout: 10_000 });
    await newListButton.click();
    await page.getByLabel('List name', { exact: true }).fill('DoD List');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForTimeout(400);

    // 4. CAPTURE — real composer (FAB/sheet path on compact layouts, handled by addTasks).
    await addTasks(page, [TASK_TITLE]);
    const row = page.getByRole('listitem').filter({ hasText: TASK_TITLE });
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    step('capture-offline', true, 'task captured and visible on #/all while offline');

    // 5. PLAN — open the editor, set due = today via the chip, save; the task must then be a
    //    member of the Today view (S2 membership) — still offline.
    await row.locator('button.task-title').click();
    const dialog = page.locator('.dialog').last();
    await dialog.locator('[data-testid="chip-today"]').click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForTimeout(400);
    if ((await page.locator('.dialog').count()) > 0) await page.keyboard.press('Escape');
    await page.goto(`${APP_URL}#/today`);
    const todayRow = page.getByRole('listitem').filter({ hasText: TASK_TITLE });
    await todayRow.waitFor({ state: 'visible', timeout: 10_000 });
    step('plan-offline', true, 'due-today task is a member of the Today view while offline');

    // 6. COMPLETE — optimistic toggle from the Today view; the row collapses out of open views (F3).
    await todayRow.getByRole('checkbox').check();
    await todayRow.waitFor({ state: 'hidden', timeout: 5_000 });
    step('complete-offline', true, 'task completed and collapsed out of the open view');

    // 7. RELOAD OFFLINE — the shell must boot from the SW cache and the data must be present.
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, {
      timeout: 20_000,
    });
    const h1 = (await page.locator('h1').first().textContent()) ?? '';
    step('offline-reload-boots', h1.length > 0, `shell booted offline, h1=${JSON.stringify(h1.trim())}`);

    await page.goto(`${APP_URL}#/completed`);
    const doneRow = page.getByRole('listitem').filter({ hasText: TASK_TITLE });
    await doneRow.waitFor({ state: 'visible', timeout: 10_000 });
    const checked = await doneRow.getByRole('checkbox').isChecked();
    step(
      'data-present-after-offline-reload',
      checked === true,
      'completed task present and checked after the offline reload',
    );

    evidence.verdict = 'PASS';
  } catch (err) {
    evidence.verdict = 'FAIL';
    evidence.error = String(err instanceof Error ? err.stack ?? err.message : err);
    console.error(`[${vp.name}] FAILED: ${evidence.error}`);
  } finally {
    evidence.consoleErrors = errors;
    await context.close().catch(() => undefined);
  }
  return evidence;
}

const browser = await launch();
const viewports = [];
for (const vp of VIEWPORTS) viewports.push(await runViewport(browser, vp));
await browser.close();

const summary = {
  probe: 'Q15 criterion 1 — offline capture→plan→complete at mobile viewports',
  task: 't_7f1e8f29 (MVP Definition-of-Done gate)',
  appUrl: APP_URL,
  ranAt: new Date().toISOString(),
  viewports,
  verdict: viewports.every((v) => v.verdict === 'PASS') ? 'PASS' : 'FAIL',
};
writeEvidence('offline-mobile-probe.json', summary);
console.log(`VERDICT: ${summary.verdict}`);
process.exit(summary.verdict === 'PASS' ? 0 : 1);
