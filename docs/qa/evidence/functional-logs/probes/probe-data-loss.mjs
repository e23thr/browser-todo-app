/**
 * Functional verification (task t_eff4b9fa) — sub-criterion 3:
 * ZERO DATA LOSS across the test cycle.
 *
 * Cycle (real UI, desktop 1920x1080, production build):
 *   create 50 items → complete 30 → delete 10 → refresh → all 40 remaining items
 *   must persist with the correct state (30 completed + 10 open).
 *
 * Evidence:
 *   - full console log (console.* + pageerror + requestfailed, wall-clock stamped)
 *   - raw IndexedDB snapshots BEFORE and AFTER the refresh + a structural diff
 *   - timestamped screenshots at each phase
 *   - per-item state verification from the after-refresh IndexedDB snapshot
 *
 * Notes on semantics the verification encodes (docs/design + ADR-004):
 *   - deleting a task is a tombstone write (`deletedAt`), so the 10 deleted items
 *     remain in the store as tombstones; "40 remaining" = 40 rows with deletedAt null.
 */
import {
  APP_URL,
  captureConsole,
  consoleText,
  diff,
  dumpIdb,
  en,
  launch,
  label,
  shot,
  th,
  writeJson,
} from './qa-lib.mjs';

import { createLists, dismissOnboarding, addTasks } from '../../../a11y-gate-logs/probes/lib.mjs';

const CATALOGS = { en, th };
const LIST_NAME = 'Data-loss List';
const ALL_ITEMS = Array.from({ length: 50 }, (_, i) => `Item ${String(i + 1).padStart(2, '0')}`);
const TO_COMPLETE = ALL_ITEMS.slice(0, 30); // Item 01..30
const TO_DELETE = ALL_ITEMS.slice(40, 50); // Item 41..50
const SURVIVING_OPEN = ALL_ITEMS.slice(30, 40); // Item 31..40

const browser = await launch();
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  locale: 'en-US',
});
const page = await context.newPage();
const consoleRecs = [];
captureConsole(page, consoleRecs);
const timeline = [];
const steps = [];
const step = (name, ok, detail = '') => {
  steps.push({ step: name, ok, detail, at: new Date().toISOString() });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(`${name}${detail ? ` — ${detail}` : ''}`);
};

const verdict = { task: 't_eff4b9fa sub-criterion 3 (zero data loss)', steps };
try {
  /* ---- setup: boot, list, 50 items ---- */
  await page.goto(APP_URL);
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, {
    timeout: 20_000,
  });
  await dismissOnboarding(page, CATALOGS);
  await createLists(page, CATALOGS, [LIST_NAME]);
  await addTasks(page, ALL_ITEMS);
  await page.goto(`${APP_URL}#/all`);
  const first = page.locator('li.task-row', { hasText: 'Item 01' });
  await first.waitFor({ state: 'visible', timeout: 15_000 });
  await shot(page, timeline, '01-created-50-items');
  const visibleAfterCreate = await page.locator('li.task-row').count();
  step(
    'create-50-items',
    visibleAfterCreate === 50,
    `50 items created through the real composer; ${visibleAfterCreate} rows visible on #/all`,
  );

  /* ---- complete 30 ---- */
  for (const title of TO_COMPLETE) {
    const row = page.locator('li.task-row', { hasText: title });
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    await row.getByRole('checkbox').check();
    await row.waitFor({ state: 'hidden', timeout: 8_000 });
  }
  await shot(page, timeline, '02-completed-30-items');
  step('complete-30-items', true, 'Item 01..30 completed through the row checkboxes (F3 collapse each)');

  /* ---- delete 10 ---- */
  for (const title of TO_DELETE) {
    const row = page.locator('li.task-row', { hasText: title });
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    await row.locator('button.task-title').click();
    const dialog = page.locator('.dialog').last();
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    await dialog.getByRole('button', { name: label('editor.delete'), exact: true }).click();
    const confirm = page.getByRole('button', { name: label('confirm.deleteTask.confirm'), exact: true });
    await confirm.waitFor({ state: 'visible', timeout: 10_000 });
    await confirm.click();
    await row.waitFor({ state: 'hidden', timeout: 10_000 });
    if ((await page.locator('.dialog').count()) > 0) await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }
  await shot(page, timeline, '03-deleted-10-items');
  step('delete-10-items', true, 'Item 41..50 deleted through the editor → confirm dialog');

  /* ---- settle (human pause), then snapshot BEFORE the refresh ---- */
  await page.waitForTimeout(2_000);
  await page.goto(`${APP_URL}#/all`);
  const openBefore = await page.locator('li.task-row').count();
  const before = await dumpIdb(page);
  writeJson('data-loss-idb-before-refresh.json', before);
  writeJson('data-loss-timeline.json', timeline);
  step(
    'before-refresh-state',
    openBefore === SURVIVING_OPEN.length,
    `${openBefore} open rows before the refresh (expected ${SURVIVING_OPEN.length})`,
  );

  /* ---- refresh ---- */
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, {
    timeout: 20_000,
  });
  await page.waitForTimeout(1_500);

  /* ---- snapshot AFTER the refresh ---- */
  await page.goto(`${APP_URL}#/all`);
  await page.waitForTimeout(500);
  const after = await dumpIdb(page);
  writeJson('data-loss-idb-after-refresh.json', after);
  const idbDiff = diff(before, after);
  const userData = (snap) => {
    const stores = Object.values(snap).flatMap((db) => Object.entries(db.stores));
    return {
      tasks: stores.find(([n]) => n === 'tasks')?.[1] ?? [],
      lists: stores.find(([n]) => n === 'lists')?.[1] ?? [],
      settings: stores.find(([n]) => n === 'settings')?.[1] ?? [],
    };
  };
  const userDiff = diff(userData(before), userData(after));
  writeJson('data-loss-idb-diff-before-vs-after.json', {
    userDataIdentical: userDiff.length === 0,
    userDataDifferences: userDiff,
    wholeDbIdentical: idbDiff.length === 0,
    wholeDbDifferenceCount: idbDiff.length,
    wholeDbDifferences: idbDiff,
  });
  step(
    'idb-identical-across-refresh',
    userDiff.length === 0,
    userDiff.length === 0
      ? 'user-data stores (tasks/lists/settings) before the refresh are canonically identical to those after'
      : `${userDiff.length} structural differences across the refresh`,
  );

  /* ---- verify the 40 remaining items, per item, from the after-refresh snapshot ---- */
  const stores = Object.values(after).flatMap((db) => Object.entries(db.stores));
  const taskRows = stores.find(([name]) => name === 'tasks')?.[1] ?? [];
  const listsRows = stores.find(([name]) => name === 'lists')?.[1] ?? [];
  const live = taskRows.filter((r) => r.deletedAt === null || r.deletedAt === undefined);
  const tombstoned = taskRows.filter((r) => r.deletedAt !== null && r.deletedAt !== undefined);
  const completed = live.filter((r) => r.completedAt !== null && r.completedAt !== undefined);
  const open = live.filter((r) => r.completedAt === null || r.completedAt === undefined);
  const byTitle = new Map(live.map((r) => [r.title, r]));

  const missing = ALL_ITEMS.slice(0, 40).filter((t) => !byTitle.has(t));
  const wrongState = [];
  for (const t of TO_COMPLETE) {
    const r = byTitle.get(t);
    if (r !== undefined && (r.completedAt === null || r.completedAt === undefined))
      wrongState.push(`${t}: expected completed`);
  }
  for (const t of SURVIVING_OPEN) {
    const r = byTitle.get(t);
    if (r !== undefined && r.completedAt !== null && r.completedAt !== undefined)
      wrongState.push(`${t}: expected open`);
  }
  const deletedStillLive = TO_DELETE.filter((t) => byTitle.has(t));

  writeJson('data-loss-item-state-after-refresh.json', {
    counts: {
      taskRowsTotal: taskRows.length,
      live: live.length,
      completed: completed.length,
      open: open.length,
      tombstoned: tombstoned.length,
      lists: listsRows.length,
    },
    missing,
    wrongState,
    deletedStillLive,
    items: ALL_ITEMS.map((t) => {
      const r = byTitle.get(t);
      return {
        title: t,
        present: r !== undefined,
        completed: r === undefined ? null : r.completedAt !== null && r.completedAt !== undefined,
      };
    }),
  });
  step(
    'zero-data-loss-40-items-correct-state',
    missing.length === 0 &&
      wrongState.length === 0 &&
      deletedStillLive.length === 0 &&
      live.length === 40 &&
      completed.length === 30 &&
      open.length === 10,
    `live=${live.length} completed=${completed.length} open=${open.length} tombstoned=${tombstoned.length}; missing=${missing.length} wrongState=${wrongState.length} deletedStillLive=${deletedStillLive.length}`,
  );

  /* ---- UI cross-check after the refresh ---- */
  const openRowsUi = await page.locator('li.task-row').count();
  await shot(page, timeline, '04-after-refresh-open-view');
  await page.goto(`${APP_URL}#/completed`);
  await page.waitForTimeout(500);
  const doneCount = await page.locator('li.task-row').count();
  const checkedCount = await page.locator('li.task-row').getByRole('checkbox').evaluateAll((els) =>
    els.filter((el) => el.checked === true || el.getAttribute('aria-checked') === 'true').length,
  );
  await shot(page, timeline, '05-after-refresh-completed-view');
  step(
    'ui-state-after-refresh',
    openRowsUi === 10 && doneCount === 30 && checkedCount === 30,
    `UI after refresh: open rows on #/all=${openRowsUi} (10), rows on #/completed=${doneCount} (30), checked=${checkedCount} (30)`,
  );

  verdict.verdict = 'PASS';
} catch (err) {
  verdict.verdict = 'FAIL';
  verdict.error = String(err instanceof Error ? (err.stack ?? err.message) : err);
  console.error(`FAILED: ${verdict.error}`);
  await shot(page, timeline, '99-failure-state').catch(() => undefined);
} finally {
  verdict.consoleErrors = consoleRecs.filter((r) => r.kind === 'pageerror' || r.kind === 'console.error');
  writeJson('data-loss-console.txt', consoleText(consoleRecs));
  writeJson('data-loss-summary.json', {
    ...verdict,
    appUrl: APP_URL,
    buildSha: process.env.BUILD_SHA ?? 'unknown',
    ranAt: new Date().toISOString(),
    chromiumVersion: browser.version(),
  });
}
await context.close();
await browser.close();
console.log(`VERDICT: ${verdict.verdict}`);
process.exit(verdict.verdict === 'PASS' ? 0 : 1);
