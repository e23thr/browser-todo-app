/**
 * E3 data-engine corruption & data-loss drills (test card t_f0702c05, epic E3).
 *
 * This is ADR-004's "Testing contract" (drills 1–14) executed against the REAL engine
 * (`src/portability` + `src/storage`) inside a REAL Chromium page with REAL IndexedDB —
 * bundled once per worker into `tests/e2e/.fixtures/data-safety-<pid>/` and served by the
 * ADR-005 fixture server. Every drill runs with the browser context OFFLINE and asserts
 * ZERO network requests during the drill (§6.1: nothing leaves the browser; import/export
 * are file-local operations).
 *
 * Scenario map:
 * - Drill 1 (acceptance) — ADR-004 Decision 10's four steps: export -> wipe -> import ->
 *   restored (byte-equivalent, §2.4), scripted here and runnable in CI
 *   (`npm run e2e:data-safety`), plus PROJECT_ANALYSIS §7.4 (portability/deletion),
 *   §9.3 (no partial writes; snapshot restore tested like a feature), §5.4 (migrations).
 * - Drills 2–14 — stability, old-format upgrade, hostile imports (§10 E8), quarantine to a
 *   recovery file (§5.4/§10 E4), quota (§5.5/§10 E3), retention + undo (M12).
 *
 * Test-only seams live in `tests/e2e/data-safety/harness.ts` (deterministic corpus, DB
 * fingerprinting, `IDBObjectStore.put` fault injection) — `src/` is untouched.
 *
 * NOTE (Playwright serialization): functions passed to `page.evaluate`/`waitForFunction`
 * run in the page and may not close over spec-module values — everything cross-boundary is
 * passed as an argument and the page side reaches the harness via `window.__e3`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import type { Fingerprint } from './data-safety/harness';
import type { StaticServer } from './fixtures/static-server.mjs';
import { startFixtureServer } from './sw-utils';
import type {
  ExportError,
  ExportReport,
  ImportError,
  ImportPlan,
  ImportReport,
} from '../../src/portability/types';
import type { Result } from '../../src/storage/errors';
import { APP_SCHEMA_VERSION } from '../../src/storage/schema';
import type { Snapshot } from '../../src/storage/types';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HARNESS_CONFIG = 'tests/e2e/data-safety/vite.config.mjs';
/** Per-worker output dir: parallel workers must never build the same directory concurrently. */
const OUT_DIR = resolve(
  REPO_ROOT,
  'tests',
  'e2e',
  '.fixtures',
  `data-safety-${String(process.pid)}`,
);

const T0 = 1_700_000_000_000;

let server: StaticServer;
let harnessUrl = '';

test.beforeAll(async () => {
  execFileSync('npx', ['vite', 'build', '--config', HARNESS_CONFIG, '--outDir', OUT_DIR], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
  });
  server = await startFixtureServer('/');
  server.setRoot(OUT_DIR);
  harnessUrl = `${server.origin}/index.html`;
});

test.afterAll(async () => {
  await server.close();
});

/* ------------------------------------------------------------------ *
 * Harness plumbing                                                    *
 * ------------------------------------------------------------------ */

type AnyError = { code: string };

/**
 * Boot the harness page, open a fresh per-test database, then go OFFLINE.
 * Returns a counter of network requests attempted after the switch (drills assert 0).
 */
async function bootHarness(
  page: Page,
  context: BrowserContext,
  dbName: string,
): Promise<{ networkRequests: () => number }> {
  await page.goto(harnessUrl);
  await page.waitForFunction(() => window.__e3.ready);
  const opened = await page.evaluate((name) => window.__e3.open(name), dbName);
  expect(opened).toEqual({ ok: true });
  let requests = 0;
  page.on('request', () => {
    requests += 1;
  });
  await context.setOffline(true);
  await page.waitForFunction(() => !navigator.onLine);
  return { networkRequests: () => requests };
}

const fingerprint = (page: Page): Promise<Fingerprint> =>
  page.evaluate(() => window.__e3.fingerprint());

const buildDoc = (
  page: Page,
  kind: 'valid' | 'v1' | 'snapshots-meta' | 'corrupt-mixed' | 'variant',
): Promise<string> => page.evaluate(([k, at]) => window.__e3.buildDoc(k, at), [kind, T0] as const);

const prepare = (
  page: Page,
  text: string,
  migration?: 'backfill' | 'failing',
): Promise<Result<ImportPlan, ImportError>> =>
  page.evaluate<Result<ImportPlan, ImportError>, [string, 'none' | 'backfill' | 'failing']>(
    ([t, m]) => window.__e3.prepare(t, m),
    [text, migration ?? 'none'],
  );

const apply = (
  page: Page,
  plan: ImportPlan,
  nowMs: number,
  allowWithoutSnapshot?: boolean,
): Promise<Result<ImportReport, ImportError>> =>
  page.evaluate<Result<ImportReport, ImportError>, [ImportPlan, number, boolean | undefined]>(
    ([p, n, a]) => window.__e3.apply(p, n, a),
    [plan, nowMs, allowWithoutSnapshot],
  );

const exportDoc = (page: Page, nowMs: number): Promise<Result<ExportReport, ExportError>> =>
  page.evaluate((n) => window.__e3.exportDoc(n), nowMs);

const listSnapshots = (page: Page): Promise<Snapshot[]> =>
  page.evaluate(async () => {
    const listed = await window.__e3.listSnapshots();
    if (!listed.ok) throw new Error(`listSnapshots failed: ${listed.error.code}`);
    return listed.value;
  });

function ok<T>(result: Result<T, AnyError>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
}

function err<T>(result: Result<T, AnyError>): AnyError {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected a typed error, got ok');
  return result.error;
}

/** A drill fixture from `tests/fixtures/backup/` as raw text (hostile input stays raw). */
function fixture(name: string): string {
  return readFileSync(resolve(REPO_ROOT, 'tests/fixtures/backup', name), 'utf8');
}

/**
 * Drill 15 evidence: always attach the bytes to the run's report; when
 * `E3_ARCHIVE_DIR` is set (the QA card's evidence run), also write them to the
 * archive directory that ships with docs/qa/e3-data-engine.md.
 */
async function archive(
  testInfo: { attach: (name: string, a: { body: string; contentType: string }) => Promise<void> },
  name: string,
  body: string,
): Promise<void> {
  await testInfo.attach(name, { body, contentType: 'application/json' });
  const dir = process.env['E3_ARCHIVE_DIR'];
  if (dir !== undefined && dir !== '') {
    writeFileSync(resolve(dir, name), body, 'utf8');
  }
}

/* ------------------------------------------------------------------ *
 * Drill 1 — the acceptance journey (ADR-004 Decision 10)              *
 * ------------------------------------------------------------------ */

test('drill 1 (acceptance): export -> wipe -> import -> restored byte-equivalent, offline', async ({
  page,
  context,
}, testInfo) => {
  const net = await bootHarness(page, context, `e3-drill1-${String(testInfo.workerIndex)}`);

  const seeded = await page.evaluate(() => window.__e3.seed());
  expect(seeded.lists).toHaveLength(2);
  expect(seeded.tasks).toHaveLength(3);
  expect(seeded.snapshots).toHaveLength(1);

  /* Step 1 — Export */
  const exported = ok(await exportDoc(page, T0));
  // Drill 15 evidence: archive the exact download bytes with the run's report.
  await archive(testInfo, 'backup-document.json', exported.document);
  expect(exported.counts).toEqual({ lists: 2, tasks: 3, snapshots: 1 });
  // Decision 9.4: `local-first-todo-backup-YYYY-MM-DDTHHmmssZ.json` (no colons in the time).
  expect(exported.fileName).toMatch(/^local-first-todo-backup-\d{4}-\d{2}-\d{2}T\d{6}Z\.json$/u);
  const expected = await page.evaluate((doc) => window.__e3.canonicalDoc(doc), exported.document);

  /* Step 2 — Wipe ("Delete all data": real, immediate, confirmed) */
  ok(await page.evaluate(() => window.__e3.wipe()));
  const afterWipe = await fingerprint(page);
  expect(afterWipe.lists).toEqual([]);
  expect(afterWipe.tasks).toEqual([]);
  expect(afterWipe.snapshots).toEqual([]);
  expect(afterWipe.payloadIds).toEqual([]);
  // Settings reset to EXACTLY the fresh-profile default (Decision 10's "effectively fresh
  // install with the same deviceId"): window.__e3.defaultSettings() is the domain model's
  // DEFAULT_SETTINGS — the single literal the wipe target derives from. QA defect D1
  // (the wipe used to land on weekStart 0 while a fresh profile gets 1) is fixed.
  expect(afterWipe.settings).toEqual(await page.evaluate(() => window.__e3.defaultSettings()));
  // Boot prefs cleared (theme mirror -> default) and meta kept: NO pre-wipe snapshot
  // (Decision 10 pins this — a snapshot here would be a forbidden shadow copy).
  expect(await page.evaluate(() => window.__e3.prefsKeys())).toEqual([]);
  const metaAfterWipe = await page.evaluate(() => window.__e3.meta());
  expect(metaAfterWipe).toMatchObject({ deviceId: '01ARZ3NDEKTSV4RRFFQ6000000' });
  expect(metaAfterWipe?.['lastPurgeAt']).toBeUndefined();

  /* Step 3 — Import the file from step 1 (pipeline: prepare -> confirm -> apply) */
  const plan = ok(await prepare(page, exported.document));
  expect(plan.accepted).toEqual({ lists: 2, tasks: 3, settings: true });
  expect(plan.quarantined).toEqual([]);
  const report = ok(await apply(page, plan, T0 + 60_000));
  expect(report.outcome).toBe('applied');
  expect(report.undoSnapshot).not.toBeNull();

  /* Step 4 — Restored */
  const restored = await fingerprint(page);
  // Byte-equivalence (§2.4): every record and settings as canonical bytes vs the document.
  expect(restored.lists).toEqual(expected.lists);
  expect(restored.tasks).toEqual(expected.tasks);
  expect(restored.settings).toEqual(expected.settings);
  // Tombstones restored on purpose (both sides carry deletedAt rows).
  expect(restored.lists.filter((r) => !r.includes('"deletedAt":null'))).toHaveLength(1);
  expect(restored.tasks.filter((r) => !r.includes('"deletedAt":null'))).toHaveLength(1);
  // Snapshot metadata from the file is device-local and IGNORED — only the pre-import
  // undo row exists (drill 13 semantics, asserted here for the journey).
  expect(restored.snapshots).toHaveLength(1);
  expect(report.warnings.join(' ')).toMatch(/snapshot/iu);
  // Counts match step 1.
  expect(restored.lists).toHaveLength(exported.counts.lists);
  expect(restored.tasks).toHaveLength(exported.counts.tasks);

  // Offline guarantee (§6.1): the whole journey ran with zero network attempts.
  expect(net.networkRequests()).toBe(0);
});

/* ------------------------------------------------------------------ *
 * Drills 2–4, 7, 14 — stability and hostile input                     *
 * ------------------------------------------------------------------ */

test('drill 2: two exports with no data change differ only in exportedAt/lastBackupAt', async ({
  page,
  context,
}, testInfo) => {
  await bootHarness(page, context, `e3-drill2-${String(testInfo.workerIndex)}`);
  await page.evaluate(() => window.__e3.seed());
  const first = ok(await exportDoc(page, T0));
  const second = ok(await exportDoc(page, T0 + 1_000));

  // Byte-stable apart from the two stamped timestamps (canonical serializer).
  const mask = (doc: string): string =>
    doc
      .replace(/"exportedAt":\s*\d+/gu, '"exportedAt":<TS>')
      .replace(/"lastBackupAt":\s*\d+/gu, '"lastBackupAt":<TS>');
  expect(mask(first.document)).toEqual(mask(second.document));
  expect(first.document).not.toEqual(second.document);
});

test('drill 3: old exports upgrade through the migration chain (failing step = zero side effects)', async ({
  page,
  context,
}, testInfo) => {
  await bootHarness(page, context, `e3-drill3-${String(testInfo.workerIndex)}`);
  const seeded = await page.evaluate(() => window.__e3.seed());
  const v1doc = await buildDoc(page, 'v1');

  const upgraded = ok(await prepare(page, v1doc, 'backfill'));
  // The chain lands on the APP baseline: the injected step stands in for the
  // v2 migration and every production step above it rides along (targetVersionOf
  // floors at APP_SCHEMA_VERSION — an import never lands on a stale schema),
  // so the expectation tracks the schema version instead of a literal that
  // goes stale on every schema bump (this drill broke exactly that way).
  expect(upgraded.fileSummary).toMatchObject({
    schemaVersion: 1,
    upgradedTo: APP_SCHEMA_VERSION,
  });
  // The v1 tasks carry NO notes field at all; the injected v1->v2 step backfilled ''.
  expect(upgraded.records.tasks.map((t) => t.notes)).toEqual(['', '', '']);
  expect(upgraded.records.tasks.every((t) => t.notes !== null)).toBe(true);
  expect(await fingerprint(page)).toEqual(seeded);

  const failed = err(await prepare(page, v1doc, 'failing'));
  expect(failed.code).toBe('UPGRADE_FAILED');
  expect(await fingerprint(page)).toEqual(seeded);
});

test('drills 4/7: hostile and malformed files are rejected with zero side effects', async ({
  page,
  context,
}, testInfo) => {
  await bootHarness(page, context, `e3-drill4-${String(testInfo.workerIndex)}`);
  const seeded = await page.evaluate(() => window.__e3.seed());
  const before = await fingerprint(page);
  const snapshotsBefore = await listSnapshots(page);

  const valid = await buildDoc(page, 'valid');
  const missingSchema = JSON.parse(valid) as Record<string, unknown>;
  delete missingSchema['schemaVersion'];

  const cases: {
    label: string;
    run: () => Promise<Result<ImportPlan, ImportError>>;
    code: string;
  }[] = [
    {
      label: 'wrong format token',
      run: () => prepare(page, fixture('drill4-wrong-format-token.json')),
      code: 'NOT_A_BACKUP',
    },
    {
      label: 'recovery document offered as a backup',
      run: () => prepare(page, fixture('drill14-recovery-document.json')),
      code: 'NOT_A_BACKUP',
    },
    {
      label: 'formatVersion from the future',
      run: () => prepare(page, fixture('drill4-format-too-new.json')),
      code: 'FORMAT_TOO_NEW',
    },
    {
      label: 'schemaVersion from the future',
      run: () => prepare(page, fixture('drill4-schema-too-new.json')),
      code: 'NEWER_SCHEMA',
    },
    {
      label: 'missing schemaVersion',
      run: () => prepare(page, JSON.stringify(missingSchema)),
      code: 'NOT_A_BACKUP',
    },
    {
      label: 'missing data.settings',
      run: () => prepare(page, fixture('drill4-missing-settings.json')),
      code: 'NOT_A_BACKUP',
    },
    {
      label: 'prototype-pollution keys',
      run: () => prepare(page, fixture('drill4-proto-pollution.json')),
      code: 'MALICIOUS_SHAPE',
    },
    {
      label: 'deep-nesting bomb',
      run: () => prepare(page, fixture('drill4-deep-nesting.json')),
      code: 'MALICIOUS_SHAPE',
    },
    {
      label: 'every record corrupt (drill 7)',
      run: () => prepare(page, fixture('drill7-all-records-corrupt.json')),
      code: 'NOTHING_TO_IMPORT',
    },
    {
      label: 'truncated JSON',
      run: () => prepare(page, '{"format": "local-first-todo-ba'),
      code: 'PARSE_ERROR',
    },
    {
      label: 'oversize file (real File, > 50 MiB)',
      run: () => page.evaluate(() => window.__e3.prepareOversizeFile()),
      code: 'FILE_TOO_LARGE',
    },
    {
      label: 'count-limit bomb (100 001 tasks)',
      run: () => page.evaluate(() => window.__e3.prepareCountBomb()),
      code: 'LIMIT_EXCEEDED',
    },
  ];

  for (const c of cases) {
    const result = await c.run();
    expect(err(result).code, c.label).toBe(c.code);
  }

  // Zero side effects: nothing was written and NO snapshot was taken by any reject.
  expect(await fingerprint(page)).toEqual(before);
  expect(await fingerprint(page)).toEqual(seeded);
  expect(await listSnapshots(page)).toEqual(snapshotsBefore);
});

test('drill 14: the real recovery file is a report — not importable, never persisted', async ({
  page,
  context,
}, testInfo) => {
  await bootHarness(page, context, `e3-drill14-${String(testInfo.workerIndex)}`);
  await page.evaluate(() => window.__e3.seed());
  const doc = await buildDoc(page, 'corrupt-mixed');
  const report = ok(await apply(page, ok(await prepare(page, doc)), T0 + 1_000));
  expect(report.outcome).toBe('partial');
  expect(report.recoveryFileName).not.toBeNull();
  expect(report.recoveryFile).not.toBeNull();

  const recoveryJson = report.recoveryFile?.json ?? '';
  // Drill 15 evidence: archive the recovery file alongside the backup document.
  await archive(testInfo, 'recovery-document.json', recoveryJson);
  const recovery = JSON.parse(recoveryJson) as {
    format: string;
    entries: { store: string; id: string; issues: string[]; raw: unknown }[];
  };
  expect(recovery.format).toBe('local-first-todo-recovery');
  expect(recovery.entries).toHaveLength(3);
  for (const entry of recovery.entries) {
    expect(entry.issues.length).toBeGreaterThan(0);
    expect(entry.raw).toBeDefined();
  }

  // A recovery document must never be importable (repair the SOURCE file instead).
  expect(err(await prepare(page, recoveryJson)).code).toBe('NOT_A_BACKUP');
  // ...and is never persisted anywhere (no shadow copies, §7.4): the ONLY payload row
  // in the DB is the pre-import undo's, none is the recovery document's.
  expect(await page.evaluate(() => window.__e3.payloadIds())).toEqual([report.undoSnapshot?.id]);
});

/* ------------------------------------------------------------------ *
 * Drills 5/6/8 — quarantine semantics                                 *
 * ------------------------------------------------------------------ */

test('drills 5/6/8: corrupt records quarantine to the recovery file, valid ones apply', async ({
  page,
  context,
}, testInfo) => {
  await bootHarness(page, context, `e3-drill5-${String(testInfo.workerIndex)}`);
  await page.evaluate(() => window.__e3.seed());
  const doc = await buildDoc(page, 'corrupt-mixed');

  const plan = ok(await prepare(page, doc));
  // 2 lists + 3 valid tasks accepted; bad title, dangling listId and the duplicate
  // id quarantine (first occurrence wins).
  expect(plan.accepted).toEqual({ lists: 2, tasks: 3, settings: true });
  expect(plan.quarantined).toHaveLength(3);
  const issues = plan.quarantined.map((q) => q.issues.join(' ')).join(' | ');
  expect(issues).toMatch(/title/iu);
  expect(issues).toMatch(/listId/iu);
  expect(issues).toMatch(/duplicate id/iu);

  const report = ok(await apply(page, plan, T0 + 2_000));
  expect(report.outcome).toBe('partial');
  expect(report.quarantined).toBe(3);
  expect(report.recoveryFileName).not.toBeNull();

  // The DB contains ONLY the valid records (quarantined rows are not written).
  const fp = await fingerprint(page);
  expect(fp.lists).toHaveLength(2);
  expect(fp.tasks).toHaveLength(3);
  expect(fp.tasks.filter((t) => t.includes('duplicate id'))).toEqual([]);
  expect(fp.tasks.filter((t) => t.includes('orphan'))).toEqual([]);
});

/* ------------------------------------------------------------------ *
 * Drill 9 — retention, drill 10 — undo                                *
 * ------------------------------------------------------------------ */

test('drill 9: auto snapshots rotate to the newest 3, manual ones never evict', async ({
  page,
  context,
}, testInfo) => {
  await bootHarness(page, context, `e3-drill9-${String(testInfo.workerIndex)}`);

  const taken: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const snap = ok(
      await page.evaluate((n) => window.__e3.takeSnapshot('scheduled', n), T0 + (i + 1) * 1_000),
    );
    taken.push(snap.id);
  }
  let listed = await listSnapshots(page);
  expect(listed).toHaveLength(3);
  expect(listed.map((s) => s.id)).toEqual(taken.slice(2).reverse());
  expect(await page.evaluate(() => window.__e3.payloadIds())).toHaveLength(3);

  // Manual snapshots are permanent (Decision 8.2).
  const manual = ok(await page.evaluate((n) => window.__e3.takeSnapshot('manual', n), T0 + 10_000));
  for (let i = 0; i < 5; i += 1) {
    ok(
      await page.evaluate((n) => window.__e3.takeSnapshot('scheduled', n), T0 + 20_000 + i * 1_000),
    );
  }
  listed = await listSnapshots(page);
  expect(listed.filter((s) => s.kind === 'auto')).toHaveLength(3);
  expect(listed.filter((s) => s.kind === 'manual').map((s) => s.id)).toEqual([manual.id]);

  // deleteSnapshot works for any kind (explicit user action).
  ok(await page.evaluate((id) => window.__e3.deleteSnapshot(id), manual.id));
  listed = await listSnapshots(page);
  expect(listed.map((s) => s.id)).not.toContain(manual.id);
});

test('drill 10: the pre-import snapshot undoes an import byte-equivalently', async ({
  page,
  context,
}, testInfo) => {
  await bootHarness(page, context, `e3-drill10-${String(testInfo.workerIndex)}`);
  const before = await page.evaluate(() => window.__e3.seed());

  const plan = ok(await prepare(page, await buildDoc(page, 'variant')));
  const report = ok(await apply(page, plan, T0 + 1_000));
  const undoId = report.undoSnapshot?.id;
  if (undoId === undefined) throw new Error('apply did not report a pre-import undo snapshot');
  const afterImport = await fingerprint(page);
  expect(afterImport.tasks).not.toEqual(before.tasks);

  // Undo = the full import pipeline on the stored snapshot payload (§8.1).
  const undone = ok(
    await page.evaluate<Result<ImportReport, ImportError>, [string, number]>(
      ([id, at]) => window.__e3.restoreSnapshot(id, at),
      [undoId, T0 + 2_000],
    ),
  );
  expect(undone.outcome).toBe('applied');
  const restored = await fingerprint(page);
  expect(restored.lists).toEqual(before.lists);
  expect(restored.tasks).toEqual(before.tasks);
  expect(restored.settings).toEqual(before.settings);

  // Undo-of-undo: restoring took its own pre-import snapshot (2 undo rows) on top of the
  // seeded corpus snapshot.
  const listed = await listSnapshots(page);
  expect(listed).toHaveLength(3);
  expect(listed.filter((s) => s.reason === 'pre-import')).toHaveLength(2);
});

/* ------------------------------------------------------------------ *
 * Drills 11–13 — failure semantics (never a silent write drop)        *
 * ------------------------------------------------------------------ */

test('drill 11: a failing pre-import snapshot aborts the apply (opt-in proceeds)', async ({
  page,
  context,
}, testInfo) => {
  await bootHarness(page, context, `e3-drill11-${String(testInfo.workerIndex)}`);
  const before = await page.evaluate(() => window.__e3.seed());
  const plan = ok(await prepare(page, await buildDoc(page, 'variant')));

  await page.evaluate(() => {
    window.__e3.armPutFault('snapshot_payloads', 'UnknownError');
  });
  const aborted = err(await apply(page, plan, T0 + 1_000));
  expect(aborted.code).toBe('SNAPSHOT_FAILED');
  expect(await fingerprint(page)).toEqual(before);

  // Explicit user opt-in: apply proceeds WITHOUT an undo snapshot (warned, not silent).
  const report = ok(await apply(page, plan, T0 + 2_000, true));
  expect(report.undoSnapshot).toBeNull();
  expect(report.warnings.join(' ')).toMatch(/without an undo snapshot/iu);
  await page.evaluate(() => {
    window.__e3.disarmPutFault();
  });
});

test('drill 12: QuotaExceededError aborts the apply atomically; export survives its stamp failure', async ({
  page,
  context,
}, testInfo) => {
  await bootHarness(page, context, `e3-drill12-${String(testInfo.workerIndex)}`);
  const before = await page.evaluate(() => window.__e3.seed());
  const plan = ok(await prepare(page, await buildDoc(page, 'variant')));

  await page.evaluate(() => {
    window.__e3.armPutFault('tasks', 'QuotaExceededError');
  });
  const failed = err(await apply(page, plan, T0 + 1_000));
  expect(failed.code).toBe('QUOTA_EXCEEDED');
  await page.evaluate(() => {
    window.__e3.disarmPutFault();
  });
  // Atomic abort (§9.3): the USER DATA is exactly as before — the pending deletes were
  // rolled back together with the failing puts. (Stage 5's pre-import snapshot of the
  // untouched state is the only side effect — the documented undo, not data loss.)
  const after = await fingerprint(page);
  expect(after.lists).toEqual(before.lists);
  expect(after.tasks).toEqual(before.tasks);
  expect(after.settings).toEqual(before.settings);
  expect(after.snapshots).toHaveLength(before.snapshots.length + 1);
  expect(after.snapshots.filter((s) => s.includes('"pre-import"'))).toHaveLength(1);

  // Best-effort `settings.lastBackupAt` stamp (Decision 9.2): a quota failure there must
  // NEVER cost the user the download.
  await page.evaluate(() => {
    window.__e3.armPutFault('settings', 'QuotaExceededError');
  });
  const exported = ok(await exportDoc(page, T0 + 2_000));
  await page.evaluate(() => {
    window.__e3.disarmPutFault();
  });
  expect(exported.warnings.join(' ')).toMatch(/lastBackupAt/iu);
  expect(exported.document.length).toBeGreaterThan(0);
  // Seed snapshot + the failed apply's pre-import undo = 2 metadata rows in the export.
  expect(exported.counts).toEqual({ lists: 2, tasks: 3, snapshots: 2 });
});

test('drill 13: imported snapshot metadata is ignored (payloads are device-local)', async ({
  page,
  context,
}, testInfo) => {
  await bootHarness(page, context, `e3-drill13-${String(testInfo.workerIndex)}`);
  await page.evaluate(() => window.__e3.seed());
  const doc = await buildDoc(page, 'snapshots-meta');

  const plan = ok(await prepare(page, doc));
  expect(plan.warnings.join(' ')).toMatch(/snapshot/iu);
  const report = ok(await apply(page, plan, T0 + 1_000));

  // The document declared 3 snapshot rows (incl. two the DB never had); the store holds
  // ONLY the seeded row plus the pre-import undo — imported metadata is ignored and its
  // payloads (device-local) never materialize.
  const listed = await listSnapshots(page);
  expect(listed).toHaveLength(2);
  expect(listed.map((s) => s.reason).sort()).toEqual(['pre-import', 'scheduled']);
  expect(listed.map((s) => s.id)).not.toContain('01ARZ3NDEKTSV4RRFFQ6000041');
  expect(listed.map((s) => s.id)).not.toContain('01ARZ3NDEKTSV4RRFFQ6000042');
  expect(report.warnings.join(' ')).toMatch(/snapshot/iu);
});
