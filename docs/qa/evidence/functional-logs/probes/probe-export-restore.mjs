/**
 * Functional verification (task t_eff4b9fa) — sub-criterion 4:
 * scripted export → wipe → import → restored journey, with 100% fidelity of
 * items, metadata and Thai/English content.
 *
 * Journey (real UI, desktop 1920x1080, production build):
 *   1. Seed a mixed Thai/English corpus through the real UI (lists, tasks, notes,
 *      due dates, priorities, completed items, one tombstone, settings incl.
 *      theme + language) — then EXPORT via Settings → Storage & backup → "Back up now"
 *      (the app's own export path; the download is captured byte-exact).
 *   2. Wipe: the app's own "Delete all data" (real confirm dialog), then DevTools
 *      "Clear site data" semantics via CDP `Storage.clearDataForOrigin(all)` —
 *      IndexedDB + localStorage + CacheStorage + service-worker registrations.
 *   3. Import the exported file through the real import file input + confirm dialog.
 *   4. Verify 100% fidelity: every task/list record and its metadata byte-equal
 *      (canonical), settings equal, Thai/English strings byte-exact in the data AND
 *      visible in the UI. Save the export/import JSONs and their diffs.
 *
 * Evidence files: export-pre-wipe.json, export-post-import.json,
 *   export-restore-idb-after-import.json, storage-after-wipe.json,
 *   diff-export-vs-restored.json, export-restore-content-check.json,
 *   export-restore-summary.json + timestamped screenshots + console log.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  APP_URL,
  EVIDIR,
  captureConsole,
  canon,
  consoleText,
  diff,
  dumpIdb,
  en,
  label,
  labelLoose,
  launch,
  shot,
  th,
  writeJson,
} from './qa-lib.mjs';

import { createLists, dismissOnboarding, addTasks } from '../../../a11y-gate-logs/probes/lib.mjs';

const CATALOGS = { en, th };
const LIST_TH = 'รายการของฉัน';
const LIST_EN = 'Errands';

/** [title, notes | null, due | null, priority | null, complete, delete, list] */
const CORPUS = [
  ['ซื้อนม', 'ซื้อนมสด 2 กล่อง จากตลาด', 'today', 'high', false, false, LIST_TH],
  ['Buy milk', 'Fresh, 2 bottles', 'today', 'medium', false, false, LIST_EN],
  ['อ่านหนังสือ', 'อ่านให้จบบทที่ 3', null, null, false, false, LIST_TH],
  ['Write report', 'Quarterly numbers', null, 'low', false, false, LIST_EN],
  ['นัดพบแพทย์', null, 'today', null, false, false, LIST_TH],
  ['Plan trip', 'Chiang Mai, November', null, null, true, false, LIST_EN],
  ['ล้างจาน', null, null, null, true, false, LIST_TH],
  ['ซื้อผัก', 'ผักกาด หอม มะเขือเทศ', null, null, false, false, LIST_TH],
  ['Delete me', 'tombstone probe', null, null, false, true, LIST_EN],
];
const TH_STRINGS = CORPUS.flatMap(([t, n]) => [t, n]).filter((s) => s && /[\u0E00-\u0E7F]/u.test(s));
const EN_STRINGS = CORPUS.flatMap(([t, n]) => [t, n]).filter(
  (s) => s && !/[\u0E00-\u0E7F]/u.test(s),
);

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
const evidence = { task: 't_eff4b9fa sub-criterion 4 (export→wipe→import→restored)', steps };

/** The Settings → Storage & backup panel (scoped lookups: the backup-nudge banner
 *  carries its own "Back up now" CTA when data exists and no backup was ever made). */
const panel = () => page.locator('[data-mount-point="storage-backup"]');

/** Open the task editor for `title`, run `mutate(dialog)`, Save. */
async function editTask(title, mutate) {
  const row = page.locator('li.task-row', { hasText: title });
  await row.waitFor({ state: 'visible', timeout: 15_000 });
  await row.locator('button.task-title').click();
  const dialog = page.locator('.dialog').last();
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await mutate(dialog);
  await dialog.getByRole('button', { name: label('editor.save'), exact: true }).click();
  await page.waitForTimeout(350);
  if ((await page.locator('.dialog').count()) > 0) await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
}

try {
  /* ---------- 1. seed the corpus through the real UI ---------- */
  await page.goto(APP_URL);
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, {
    timeout: 20_000,
  });
  await dismissOnboarding(page, CATALOGS);
  await createLists(page, CATALOGS, [LIST_TH, LIST_EN]);
  await addTasks(page, CORPUS.map(([t]) => t));
  for (const [title, notes, due, priority, complete, doDelete, listName] of CORPUS) {
    if (notes !== null || due !== null || priority !== null || listName !== LIST_TH) {
      await editTask(title, async (dialog) => {
        if (notes !== null) await dialog.locator('textarea').first().fill(notes);
        if (due === 'today') await dialog.locator('[data-testid="chip-today"]').click();
        if (priority !== null) {
          await dialog
            .getByRole('radio', { name: label(`priority.${priority}`), exact: true })
            .check({ force: true });
        }
        if (listName !== LIST_TH) {
          await dialog.locator('select').first().selectOption({ label: listName });
        }
      });
    }
    if (complete) {
      const row = page.locator('li.task-row', { hasText: title });
      await row.getByRole('checkbox').check();
      await row.waitFor({ state: 'hidden', timeout: 8_000 });
    }
    if (doDelete) {
      const row = page.locator('li.task-row', { hasText: title });
      await row.locator('button.task-title').click();
      const dialog = page.locator('.dialog').last();
      await dialog.waitFor({ state: 'visible', timeout: 10_000 });
      await dialog.getByRole('button', { name: label('editor.delete'), exact: true }).click();
      const confirm = page.getByRole('button', {
        name: label('confirm.deleteTask.confirm'),
        exact: true,
      });
      await confirm.waitFor({ state: 'visible', timeout: 10_000 });
      await confirm.click();
      await row.waitFor({ state: 'hidden', timeout: 10_000 });
      if ((await page.locator('.dialog').count()) > 0) await page.keyboard.press('Escape');
    }
  }
  await page.goto(`${APP_URL}#/all`);
  await page.waitForTimeout(400);
  await shot(page, timeline, '01-corpus-seeded');
  step('seed-corpus', true, `${CORPUS.length} records seeded through the real UI (incl. 1 tombstone)`);

  /* ---------- settings metadata: theme + language (Thai) through the real UI ---------- */
  await page.goto(`${APP_URL}#/settings`);
  await page.waitForTimeout(400);
  await page.getByRole('radio', { name: label('settings.theme.dark'), exact: true }).check({ force: true });
  await page.waitForTimeout(300);
  await page
    .getByRole('radio', { name: label('settings.language.thai'), exact: true })
    .check({ force: true });
  await page.waitForTimeout(600);
  const htmlLangSeeded = await page.evaluate(() => document.documentElement.lang);
  await shot(page, timeline, '01b-settings-theme-dark-language-thai');
  step(
    'seed-settings-metadata',
    htmlLangSeeded === 'th',
    `theme=dark + language=th set through the Settings UI (html lang=${htmlLangSeeded})`,
  );

  /* ---------- export via the real UI ---------- */
  await page.waitForTimeout(1_000); // let the deferred writes flush (human pause)
  await page.goto(`${APP_URL}#/settings`);
  await page.waitForTimeout(400);
  const dlPromise = page.waitForEvent('download', { timeout: 20_000 });
  dlPromise.catch(() => undefined);
  await panel()
    .getByRole('button', { name: label('dataSafety.backup.action'), exact: true })
    .click();
  const dl = await dlPromise;
  const fileName = dl.suggestedFilename();
  const exportPath = path.join(EVIDIR, 'export-pre-wipe.json');
  await dl.saveAs(exportPath);
  const export1 = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  await shot(page, timeline, '02-exported-pre-wipe');
  step(
    'export-via-ui',
    /^local-first-todo-backup-\d{4}-\d{2}-\d{2}T\d{6}Z\.json$/u.test(fileName),
    `download ${fileName} captured byte-exact (${fs.statSync(exportPath).size} bytes)`,
  );

  /* ---------- 2a. wipe through the app's own Delete-all flow ---------- */
  await page
    .getByRole('button', { name: label('dataSafety.danger.action'), exact: true })
    .click();
  const wipeConfirm = page.getByRole('button', {
    name: label('dataSafety.deleteAll.confirm'),
    exact: true,
  });
  await wipeConfirm.waitFor({ state: 'visible', timeout: 10_000 });
  await shot(page, timeline, '03-delete-all-confirm-dialog');
  await wipeConfirm.click();
  await page.waitForTimeout(1_500);
  step('app-delete-all', true, 'Settings → Delete all data → confirm dialog → wiped');

  /* ---------- 2b. clear ALL remaining storage (DevTools "Clear site data") ---------- */
  const origin = new URL(APP_URL).origin;
  const cdp = await context.newCDPSession(page);
  await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
  await page.waitForTimeout(500);

  // Verified AT THE INSTANT of the clear, before anything can recreate storage.
  const storageAtWipe = await page.evaluate(async () => ({
    indexedDatabases: (await indexedDB.databases()).map((d) => d.name),
    localStorageLength: localStorage.length,
    sessionStorageLength: sessionStorage.length,
    cacheKeys: await caches.keys(),
    serviceWorkerRegistrations: (await navigator.serviceWorker.getRegistrations()).length,
  }));
  writeJson('storage-after-wipe.json', storageAtWipe);
  const wipeClean =
    storageAtWipe.indexedDatabases.length === 0 &&
    storageAtWipe.localStorageLength === 0 &&
    storageAtWipe.cacheKeys.length === 0 &&
    storageAtWipe.serviceWorkerRegistrations === 0;
  step(
    'all-storage-cleared',
    wipeClean,
    `at the instant of the wipe: IndexedDB=${JSON.stringify(storageAtWipe.indexedDatabases)} localStorage=${storageAtWipe.localStorageLength} caches=${JSON.stringify(storageAtWipe.cacheKeys)} swRegs=${storageAtWipe.serviceWorkerRegistrations}`,
  );

  // After the reload the app must come back as a FRESH install: first-run onboarding,
  // zero user records. (Its own shell cache + SW registration legitimately return —
  // that is the offline feature, not user data.)
  await page.goto(APP_URL);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1_200);
  const freshBoot = await page.evaluate(async () => ({
    hasOnboarding: document.querySelector('[data-surface="onboarding"]') !== null,
  }));
  const freshDb = await dumpIdb(page);
  const freshStores = Object.values(freshDb).flatMap((db) => Object.entries(db.stores));
  const freshCounts = Object.fromEntries(
    freshStores.map(([n, rows]) => [n, rows.length]),
  );
  writeJson('storage-after-wipe-reload.json', {
    freshBoot,
    storeRowCounts: freshCounts,
    note: 'the app re-creates an EMPTY database and its own SW shell cache on boot — offline feature, not user data',
  });
  await shot(page, timeline, '04-after-full-storage-wipe');
  step(
    'fresh-install-after-wipe',
    freshBoot.hasOnboarding === true &&
      (freshCounts.tasks ?? 0) === 0 &&
      (freshCounts.lists ?? 0) === 0,
    `first-run onboarding=${freshBoot.hasOnboarding}, store rows=${JSON.stringify(freshCounts)}`,
  );
  await dismissOnboarding(page, CATALOGS);

  /* ---------- 3. import the exported file through the real UI ---------- */
  await page.goto(`${APP_URL}#/settings`);
  await page.waitForTimeout(600);
  await page.setInputFiles(
    '[data-mount-point="storage-backup"] [data-testid="import-file-input"]',
    exportPath,
  );
  const importGo = page.getByRole('button', {
    name: label('dataSafety.import.confirm.go'),
    exact: true,
  });
  await importGo.waitFor({ state: 'visible', timeout: 20_000 });
  await shot(page, timeline, '05-import-confirm-dialog');
  await importGo.click();
  const doneToast = page.getByText(labelLoose('dataSafety.import.done.message'));
  await doneToast.waitFor({ state: 'visible', timeout: 20_000 });
  await shot(page, timeline, '06-import-complete-toast');
  step('import-via-ui', true, 'import confirm dialog → "Replace and import" → import-complete toast');

  /* ---------- 4. fidelity ---------- */
  // 4a-0. Post-import UI state BEFORE any reload — finding F1 (fix card t_85e19c39),
  // now a hard expectation: the restored corpus is visible in the RUNNING UI with no
  // page.reload(), the imported theme applies immediately (data-safety §8.3 erratum),
  // and the imported locale is NOT applied yet — it drives `html lang` on next boot,
  // its documented timing (asserted after the reload in 4d).
  await page.goto(`${APP_URL}#/all`);
  await page.waitForTimeout(1_500);
  const preReloadUiRows = await page.locator('li.task-row').count();
  await shot(page, timeline, '06b-post-import-ui-before-reload');
  // List rows live in the list MANAGER view (`ListsManageView`) — same-document hash
  // navigations only, still no reload.
  await page.goto(`${APP_URL}#/lists`);
  await page.waitForTimeout(800);
  const preReloadLists = await page.locator('.list-row[data-list-id]').count();
  // Settings screen follows the imported record immediately (§8.3 erratum).
  await page.goto(`${APP_URL}#/settings`);
  await page.waitForTimeout(800);
  const preReloadTheme = await page.evaluate(() => document.documentElement.dataset.theme ?? null);
  const preReloadLang = await page.evaluate(() => document.documentElement.lang);
  const settingsThemeChecked = await page
    .getByRole('radio', { name: label('settings.theme.dark'), exact: true })
    .isChecked();
  await shot(page, timeline, '06b2-post-import-settings-before-reload');
  evidence.findings = [
    {
      id: 'F1',
      status: 'fixed in t_85e19c39 — asserted as step post-import-ui-live-without-reload',
      title:
        'restored data was not visible in the running UI after a successful import until a manual reload',
      observed: {
        taskRowsVisibleOnAllBeforeReload: preReloadUiRows,
        listRowsVisibleInManageViewBeforeReload: preReloadLists,
        settingsThemeRadioCheckedBeforeReload: settingsThemeChecked,
        themeAppliedImmediately: preReloadTheme,
        htmlLangBeforeReload: preReloadLang,
      },
      mechanism:
        'was: applyPlan() never reloaded the tasks/lists store and the importer announced no bulk change; fixed: applyImport/restoreSnapshot/wipe fire the data-replaced seam (src/portability/side-effects.ts) which reloads the store + settings in the acting tab and announces change:"all" to peer tabs (ADR-003 Decision 8.1)',
    },
  ];
  writeJson('export-restore-findings.json', evidence.findings);
  step(
    'post-import-ui-live-without-reload',
    preReloadUiRows === 6 &&
      preReloadLists === 2 &&
      settingsThemeChecked === true &&
      preReloadTheme === 'dark' &&
      preReloadLang === 'en',
    `before any reload: task rows on #/all=${preReloadUiRows} (6), list rows on #/lists=${preReloadLists} (2), Settings theme radio=dark checked (${settingsThemeChecked}), theme=${preReloadTheme} (dark — applies immediately per §8.3 erratum), html lang=${preReloadLang} (en — imported locale th drives html lang on next boot)`,
  );

  // Reload the page (the user-visible "restored" state), then verify UI fidelity.
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1_500);
  await dismissOnboarding(page, CATALOGS);

  // 4a. raw IndexedDB snapshot after the import
  await page.goto(`${APP_URL}#/all`);
  await page.waitForTimeout(800);
  const idbAfter = await dumpIdb(page);
  writeJson('export-restore-idb-after-import.json', idbAfter);
  const stores = Object.values(idbAfter).flatMap((db) => Object.entries(db.stores));
  const restoredTasks = (stores.find(([n]) => n === 'tasks')?.[1] ?? []).slice();
  const restoredLists = (stores.find(([n]) => n === 'lists')?.[1] ?? []).slice();
  const restoredSettings = stores.find(([n]) => n === 'settings')?.[1] ?? [];
  const sortId = (rows) => rows.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  /** The settings row carries its key as `id` (store keyPath); the document may or may not. */
  const stripId = (obj) => {
    if (obj === null || typeof obj !== 'object') return obj;
    const { id: _id, ...rest } = obj;
    return rest;
  };

  const settingsRow = restoredSettings[0] ?? null;
  const recordDiff = {
    tasks: diff(sortId(export1.data.tasks), sortId(restoredTasks)),
    lists: diff(sortId(export1.data.lists), sortId(restoredLists)),
    settings: diff(stripId(export1.data.settings), stripId(settingsRow)),
  };
  const settingsShapes = {
    exportDocument: export1.data.settings,
    idbRow: settingsRow,
  };
  const recordsFidelity =
    recordDiff.tasks.length === 0 &&
    recordDiff.lists.length === 0 &&
    recordDiff.settings.length === 0;

  // 4b. Thai/English content byte-exact (data) + titles visible in the UI across views
  const restoredBlob = JSON.stringify({ tasks: restoredTasks, lists: restoredLists });
  const contentMissing = [...TH_STRINGS, ...EN_STRINGS].filter((s) => !restoredBlob.includes(s));
  const uiRows = await page.locator('li.task-row button.task-title').allTextContents();
  await page.goto(`${APP_URL}#/completed`);
  await page.waitForTimeout(600);
  const uiRowsDone = await page.locator('li.task-row button.task-title').allTextContents();
  const uiAll = [...uiRows, ...uiRowsDone];
  const titles = CORPUS.filter(([, , , , , doDelete]) => !doDelete).map(([t]) => t);
  const deletedTitle = CORPUS.find(([, , , , , doDelete]) => doDelete)?.[0] ?? null;
  const uiMissing = titles.filter((s) => !uiAll.some((row) => row.includes(s)));
  const deletedStillVisible = deletedTitle !== null && uiAll.some((row) => row.includes(deletedTitle));
  await shot(page, timeline, '06c-restored-ui-completed-view');
  writeJson('export-restore-content-check.json', {
    expectedStrings: { thai: TH_STRINGS, english: EN_STRINGS },
    missingFromRestoredData: contentMissing,
    missingFromUiRows: uiMissing,
    deletedTombstoneStillVisibleInUi: deletedStillVisible,
    uiRowCountOpen: uiRows.length,
    uiRowCountCompleted: uiRowsDone.length,
  });

  // 4c. re-export and diff export1 vs export2 (envelope + snapshots are device-local)
  await page.goto(`${APP_URL}#/settings`);
  await page.waitForTimeout(400);
  const dl2Promise = page.waitForEvent('download', { timeout: 20_000 });
  dl2Promise.catch(() => undefined);
  await panel()
    .getByRole('button', { name: label('dataSafety.backup.action'), exact: true })
    .click();
  const dl2 = await dl2Promise;
  const export2Path = path.join(EVIDIR, 'export-post-import.json');
  await dl2.saveAs(export2Path);
  const export2 = JSON.parse(fs.readFileSync(export2Path, 'utf8'));

  const envelopeDiff = diff(export1, export2, '$');
  const documentedPrefixes = [
    '$.exportedAt',
    '$.deviceId',
    '$.counts.snapshots',
    '$.data.snapshots',
    '$.data.settings.lastBackupAt',
  ];
  const isDocumented = (p) =>
    documentedPrefixes.some((d) => p === d || p.startsWith(`${d}.`) || p.startsWith(`${d}[`));
  const unexpected = envelopeDiff.filter((d) => !isDocumented(d.path));
  writeJson('diff-export-vs-restored.json', {
    explanation: {
      '$.exportedAt': 'per-export timestamp (Document Decision 9)',
      '$.deviceId': 'device identity is per-browser-profile; a full site-data wipe is a fresh profile (ADR-002 §3.1 — identity is never imported across devices)',
      '$.counts.snapshots / $.data.snapshots': 'snapshot metadata + payloads are device-local and never restored from a file (ADR-004 drill 13); the post-import export carries the pre-import undo snapshot instead',
      '$.data.settings.lastBackupAt': 'best-effort export stamp (ADR-004 Decision 9.2)',
    },
    recordFidelity: {
      tasks: { differences: recordDiff.tasks, identical: recordDiff.tasks.length === 0 },
      lists: { differences: recordDiff.lists, identical: recordDiff.lists.length === 0 },
      settings: { differences: recordDiff.settings, shapes: settingsShapes },
    },
    exportEnvelope: { allDifferences: envelopeDiff, unexpectedDifferences: unexpected },
  });
  step(
    'record-fidelity-100-percent',
    recordsFidelity && unexpected.length === 0,
    `tasks diff=${recordDiff.tasks.length}, lists diff=${recordDiff.lists.length}, settings diff=${recordDiff.settings.length}, unexpected envelope diffs=${unexpected.length}`,
  );
  step(
    'thai-english-content-fidelity',
    contentMissing.length === 0 &&
      uiMissing.length === 0 &&
      deletedStillVisible === false &&
      uiRows.length === 6 &&
      uiRowsDone.length === 2,
    `byte-exact strings checked=${TH_STRINGS.length + EN_STRINGS.length}; missing data=${contentMissing.length}, missing UI=${uiMissing.length}; UI rows after reload: open=${uiRows.length} (6), completed=${uiRowsDone.length} (2), tombstone hidden=${deletedStillVisible === false}`,
  );

  // 4d. settings/language round-trip (metadata) — the file carried language=th
  const htmlLang = await page.evaluate(() => document.documentElement.lang);
  await shot(page, timeline, '07-restored-corpus');
  await page.goto(`${APP_URL}#/settings`);
  await page.waitForTimeout(400);
  await shot(page, timeline, '08-restored-settings');
  step(
    'settings-metadata-roundtrip',
    export2.data.settings.locale === export1.data.settings.locale &&
      htmlLang === (export1.data.settings.locale ?? 'en'),
    `locale in file=${export1.data.settings.locale}, restored=${export2.data.settings.locale}, html lang=${htmlLang}; theme restored=${export2.data.settings.theme === export1.data.settings.theme}`,
  );

  evidence.verdict = 'PASS';
} catch (err) {
  evidence.verdict = 'FAIL';
  evidence.error = String(err instanceof Error ? (err.stack ?? err.message) : err);
  console.error(`FAILED: ${evidence.error}`);
  await shot(page, timeline, '99-failure-state').catch(() => undefined);
} finally {
  evidence.consoleErrors = consoleRecs.filter(
    (r) => r.kind === 'pageerror' || r.kind === 'console.error',
  );
  writeJson('export-restore-console.txt', consoleText(consoleRecs));
  writeJson('export-restore-summary.json', {
    ...evidence,
    appUrl: APP_URL,
    buildSha: process.env.BUILD_SHA ?? 'unknown',
    ranAt: new Date().toISOString(),
    chromiumVersion: browser.version(),
  });
}
await context.close();
await browser.close();
console.log(`VERDICT: ${evidence.verdict}`);
process.exit(evidence.verdict === 'PASS' ? 0 : 1);
