/**
 * Functional verification (task t_eff4b9fa) — sub-criteria 1 + 2:
 * the capture → plan → complete loop works OFFLINE at
 *   (1) desktop viewport  1920x1080 (Chrome 120+), and
 *   (2) mobile viewport   iPhone 14 Pro, 393x852 (Chrome DevTools device toolbar emulation).
 *
 * Evidence per step: timestamped screenshot (ISO-8601 UTC in the file name AND burned
 * into the frame as a QA watermark) + a full-session video + timeline JSON.
 *
 * Run (from the repo root, after a base-path build):
 *   BASE_PATH=/browser-todo-app/ npm run build
 *   npx vite preview --port 4290 --strictPort &
 *   node docs/qa/evidence/functional-logs/probes/probe-functional-loop.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

import { addTasks, createLists, dismissOnboarding } from '../../../a11y-gate-logs/probes/lib.mjs';
import {
  APP_URL,
  REPO_ROOT,
  VIDEOS,
  captureConsole,
  consoleText,
  en,
  launch,
  label,
  shot,
  th,
  writeJson,
} from './qa-lib.mjs';

const TASK_TITLE = 'QA offline loop task';
const LIST_NAME = 'QA Loop List';
const CATALOGS = { en, th };

const VIEWPORTS = [
  {
    name: 'desktop-1920x1080',
    context: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 },
  },
  {
    name: 'mobile-iphone14pro-393x852',
    context: {
      viewport: { width: 393, height: 852 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    },
  },
];

async function runViewport(browser, vp, meta) {
  const context = await browser.newContext({
    ...vp.context,
    locale: 'en-US',
    recordVideo: { dir: VIDEOS, size: vp.context.viewport },
  });
  const page = await context.newPage();
  const consoleRecs = [];
  captureConsole(page, consoleRecs);
  const timeline = [];
  const evidence = {
    viewport: vp.name,
    viewportSpec: vp.context,
    userAgent: await page.evaluate(() => navigator.userAgent),
    steps: [],
  };
  const step = (name, ok, detail = '') => {
    evidence.steps.push({ step: name, ok, detail, at: new Date().toISOString() });
    console.log(`[${vp.name}] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) throw new Error(`${vp.name}: ${name}${detail ? ` — ${detail}` : ''}`);
  };

  try {
    /* 1. Boot online; the service worker must take control BEFORE the network is cut. */
    await page.goto(APP_URL);
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, {
      timeout: 20_000,
    });
    await dismissOnboarding(page, CATALOGS);
    await shot(page, timeline, '01-boot-onboarding-dismissed');
    step(
      'sw-controls-page',
      (await page.evaluate(() => navigator.serviceWorker?.controller != null)) === true,
      'service worker controls the page before the network is cut',
    );

    /* 2. Fresh profile has no lists → create one through the Manage-lists screen. */
    await createLists(page, CATALOGS, [LIST_NAME]);
    const listRow = page.locator('.list-row[data-list-id]', { hasText: LIST_NAME }).first();
    await listRow.waitFor({ state: 'visible', timeout: 10_000 });
    await shot(page, timeline, '02-list-created');
    step('list-created', true, `list ${JSON.stringify(LIST_NAME)} created through the Lists screen`);

    /* 3. OFFLINE. Everything below runs with zero connectivity. */
    await context.setOffline(true);
    step('offline-engaged', true, 'context.setOffline(true)');

    /* 4. CAPTURE — real composer while offline. */
    await addTasks(page, [TASK_TITLE]);
    const row = page.getByRole('listitem').filter({ hasText: TASK_TITLE });
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    await shot(page, timeline, '03-capture-offline');
    step('capture-offline', true, 'task captured and visible on #/all while offline');

    /* 5. PLAN — editor → due = today chip → Save; task becomes a member of Today (S2). */
    await row.locator('button.task-title').click();
    const dialog = page.locator('.dialog').last();
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    await dialog.locator('[data-testid="chip-today"]').click();
    await shot(page, timeline, '04-plan-editor-due-today');
    await dialog.getByRole('button', { name: label('editor.save'), exact: true }).click();
    await page.waitForTimeout(400);
    if ((await page.locator('.dialog').count()) > 0) await page.keyboard.press('Escape');
    await page.goto(`${APP_URL}#/today`);
    const todayRow = page.getByRole('listitem').filter({ hasText: TASK_TITLE });
    await todayRow.waitFor({ state: 'visible', timeout: 10_000 });
    await shot(page, timeline, '05-plan-today-view');
    step('plan-offline', true, 'due-today task is a member of the Today view while offline');

    /* 6. COMPLETE — optimistic toggle; the row collapses out of open views (F3). */
    await todayRow.getByRole('checkbox').check();
    await todayRow.waitFor({ state: 'hidden', timeout: 5_000 });
    await shot(page, timeline, '06-complete-offline');
    step('complete-offline', true, 'task completed and collapsed out of the open view');

    /* 7. RELOAD WHILE OFFLINE — the shell must boot from the SW cache. */
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, {
      timeout: 20_000,
    });
    const h1 = (await page.locator('h1').first().textContent()) ?? '';
    await shot(page, timeline, '07-offline-reload-boot');
    step('offline-reload-boots', h1.trim().length > 0, `shell booted offline, h1=${JSON.stringify(h1.trim())}`);

    /* 8. Data present after the offline reload: completed task, checked. */
    await page.goto(`${APP_URL}#/completed`);
    const doneRow = page.getByRole('listitem').filter({ hasText: TASK_TITLE });
    await doneRow.waitFor({ state: 'visible', timeout: 10_000 });
    const checked = await doneRow.getByRole('checkbox').isChecked();
    await shot(page, timeline, '08-data-present-after-reload');
    step(
      'data-present-after-offline-reload',
      checked === true,
      'completed task present and checked after the offline reload',
    );

    evidence.verdict = 'PASS';
  } catch (err) {
    evidence.verdict = 'FAIL';
    evidence.error = String(err instanceof Error ? (err.stack ?? err.message) : err);
    console.error(`[${vp.name}] FAILED: ${evidence.error}`);
    await shot(page, timeline, '99-failure-state').catch(() => undefined);
  } finally {
    evidence.consoleLog = consoleRecs;
    evidence.consoleErrors = consoleRecs.filter((r) => r.kind !== 'console.log');
    evidence.timeline = timeline;
    const video = page.video();
    await context.close().catch(() => undefined);
    if (video !== null) {
      const src = await video.path();
      const target = path.join(VIDEOS, `${vp.name}.webm`);
      fs.mkdirSync(VIDEOS, { recursive: true });
      fs.renameSync(src, target);
      evidence.video = path.relative(REPO_ROOT, target);
    }
    writeJson(`functional-loop-${vp.name}.json`, evidence);
    writeJson(`functional-loop-${vp.name}-console.txt`, consoleText(consoleRecs));
    meta.viewports.push({
      viewport: vp.name,
      verdict: evidence.verdict,
      consoleErrors: evidence.consoleErrors.length,
      video: evidence.video,
      screenshots: timeline.length,
    });
  }
  return evidence;
}

const browser = await launch();
const meta = {
  probe: 'functional loop (capture→plan→complete) OFFLINE — desktop 1920x1080 + iPhone 14 Pro 393x852',
  task: 't_eff4b9fa (functional verification)',
  appUrl: APP_URL,
  buildSha: process.env.BUILD_SHA ?? 'unknown',
  buildDir: process.env.BUILD_DIR ?? 'unknown',
  ranAt: new Date().toISOString(),
  chromiumVersion: browser.version(),
  node: process.version,
  viewports: [],
};
for (const vp of VIEWPORTS) await runViewport(browser, vp, meta);
await browser.close();

meta.verdict = meta.viewports.every((v) => v.verdict === 'PASS' && v.consoleErrors === 0)
  ? 'PASS'
  : 'FAIL';
writeJson('functional-loop-summary.json', meta);
console.log(`VERDICT: ${meta.verdict}`);
process.exit(meta.verdict === 'PASS' ? 0 : 1);
