/**
 * Corruption drills — QA suite for t_ae894274 (independent of the impl suite).
 *
 * Each `describe` is one drill demanded by the card:
 *   1. migration interrupted mid-chain -> rollback via pre-migration snapshot;
 *   2. corrupt records quarantined to a downloadable, loadable recovery file
 *      (never crash, never silent drop);
 *   3. QuotaExceededError propagates as a typed error on every write surface;
 *   4. boot validation on a mixed valid/invalid dataset;
 *   5. tombstone purge timing (>90 days / 24h throttle / explicit clean-up);
 *   6. snapshot restore works like a feature (take -> corrupt -> restore).
 * Plus wrapper resilience drills (BLOCKED, closed-DB errors, missing payload).
 *
 * The QA regression section at the bottom pins the contract-deviation probes
 * (docs/qa/e1-storage-logs/probe-contract-deviations.txt P1-P4) as green tests
 * for fix card t_dbe04ac6 (D1-D6).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { boot, resetBootSingleton } from '../../../src/storage/boot';
import type { AppDB, AppDBImpl } from '../../../src/storage/db';
import { openRawAppDB } from '../../../src/storage/db';
import { err, ok, unknownError } from '../../../src/storage/errors';
import type { Result, StorageError } from '../../../src/storage/errors';
import type { MigrationRegistry, MigrationStep } from '../../../src/storage/migrations';
import { IDB_VERSION } from '../../../src/storage/schema';
import { purgeTombstones, PURGE_INTERVAL_MS, TOMBSTONE_TTL_MS } from '../../../src/storage/purge';
import {
  getSnapshotPayload,
  listSnapshots,
  restoreSnapshot,
  takeSnapshot,
} from '../../../src/storage/snapshots';
import type { SnapshotCodec } from '../../../src/storage/snapshots';
import type { List, Meta, Settings, Task } from '../../../src/storage/types';

import {
  fixedNow,
  injectQuotaOnGets,
  injectQuotaOnPuts,
  makeList,
  makeMeta,
  makeSettings,
  makeSnapshot,
  makeTask,
  openFixtureDb,
  seedDb,
  T0,
  uniqueDbName,
} from './fixtures';

const DAY = 24 * 60 * 60 * 1000;

const booted: AppDBImpl[] = [];
afterEach(() => {
  for (const db of booted.splice(0)) db.close();
  resetBootSingleton();
});

async function bootOk(name: string, registry?: MigrationRegistry): Promise<AppDBImpl> {
  const result = await boot(
    registry === undefined
      ? { dbName: name, now: fixedNow }
      : { dbName: name, registry, now: fixedNow },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`boot failed: ${result.error.code}`);
  const db = result.value as AppDBImpl;
  booted.push(db);
  return db;
}

function byId<T extends { id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * Fixture-independent raw inspection: byte-equivalence checks read through raw
 * IDB so no fixture-layer open can influence what is asserted (QA defect D5
 * made the point concrete — `openFixtureDb` used to rewrite meta on every open;
 * it now reads-and-keeps, and raw reads remain the ground truth).
 */
type RawHandle = {
  get(store: string, key: string): Promise<unknown>;
  getAll(store: string): Promise<unknown[]>;
  close(): void;
};

async function inspectRaw(name: string): Promise<{
  meta: unknown;
  rows: (store: string) => Promise<unknown[]>;
  close: () => void;
}> {
  const opened = await openRawAppDB({ dbName: name });
  if (!opened.ok) throw new Error(`inspect open failed: ${opened.error.code}`);
  const raw = opened.value as unknown as RawHandle;
  return {
    meta: await raw.get('meta', 'meta'),
    rows: (store) => raw.getAll(store),
    close: () => {
      raw.close();
    },
  };
}

/* ================= Drill 1: migration interrupted mid-chain ================= */

/** v2: backfill `notes: ''` on every task (observable v1 -> v2 change). */
const v2Step: MigrationStep = {
  to: 2,
  stores: ['tasks'],
  run: async (t) => {
    const tasks = await t.getAll('tasks');
    for (const task of tasks) await t.put('tasks', { ...task, notes: task.notes ?? '' });
    return ok(undefined);
  },
};

/** v3: rename every list (observable v1 -> v3 change). */
const v3Step: MigrationStep = {
  to: 3,
  stores: ['lists'],
  run: async (t) => {
    const lists = await t.getAll('lists');
    for (const list of lists) await t.put('lists', { ...list, name: `v3: ${list.name}` });
    return ok(undefined);
  },
};

/** v4: writes, then fails — the mid-chain interruption. */
const failingV4Step: MigrationStep = {
  to: 4,
  stores: ['tasks'],
  run: async (t) => {
    const tasks = await t.getAll('tasks');
    const first = tasks[0];
    if (first !== undefined) await t.put('tasks', { ...first, title: 'NEVER VISIBLE' });
    return err({ code: 'MIGRATION_FAILED', from: 3, to: 4, cause: 'deliberate drill failure' });
  },
};

/** v4 companion: the "fixed chain" completes to the APP baseline. */
const v4Step: MigrationStep = {
  to: 4,
  stores: ['settings'],
  run: () => ok(undefined),
};

async function seedV1(name: string): Promise<{
  meta: Meta;
  lists: List[];
  tasks: Task[];
  settings: Settings;
}> {
  const meta = makeMeta({ schemaVersion: 1 });
  const inbox = makeList({ name: 'Inbox' });
  const work = makeList({ name: 'Work' });
  const lists = [inbox, work];
  const tasks = [
    makeTask({ title: 'alpha', notes: null, listId: inbox.id }),
    makeTask({ title: 'beta', notes: 'keep me', listId: work.id }),
  ];
  const settings = makeSettings();
  await seedDb(name, { meta, lists, tasks, settings: [settings] });
  return { meta, lists, tasks, settings };
}

describe('Drill 1: migration interrupted mid-chain rolls back via the pre-migration snapshot', () => {
  it('v1 -> v4 chain failing at the last step restores the DB byte-equivalent to v1', async () => {
    const name = uniqueDbName('drill1-rollback');
    const seeded = await seedV1(name);

    // Capture the exact pre-boot state for byte-equivalence (raw reads: the
    // fixture open would rewrite meta — defect D5).
    const before = await inspectRaw(name);
    const metaBefore = before.meta;
    const listsBefore = (await before.rows('lists')) as List[];
    const tasksBefore = (await before.rows('tasks')) as Task[];
    before.close();
    expect(metaBefore).toEqual(seeded.meta);
    expect(byId(listsBefore)).toEqual(byId(seeded.lists));
    expect(byId(tasksBefore)).toEqual(byId(seeded.tasks));

    const registry: MigrationRegistry = [v2Step, v3Step, failingV4Step];
    const result = await boot({ dbName: name, registry, now: fixedNow });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MIGRATION_FAILED');
    if (result.error.code === 'MIGRATION_FAILED') {
      expect(result.error.from).toBe(1);
      expect(result.error.to).toBe(4);
    }

    // Byte-equivalence: every store back to the v1 fixture, no trace of v2/v3/v4 writes.
    const check = await inspectRaw(name);
    expect(check.meta).toEqual(metaBefore);
    expect(byId((await check.rows('lists')) as List[])).toEqual(byId(seeded.lists));
    expect(byId((await check.rows('tasks')) as Task[])).toEqual(byId(seeded.tasks));
    expect(await check.rows('settings')).toEqual([seeded.settings]);

    // The pre-migration snapshot survives as rollback evidence.
    const snaps = (await check.rows('snapshots')) as {
      reason?: string;
      kind?: string;
    }[];
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.reason).toBe('pre-migration');
    expect(snaps[0]?.kind).toBe('auto');
    check.close();
  });

  it('the rolled-back DB still migrates cleanly on the next boot with a fixed chain', async () => {
    const name = uniqueDbName('drill1-recover');
    const seeded = await seedV1(name);
    const bad = await boot({
      dbName: name,
      registry: [v2Step, v3Step, failingV4Step],
      now: fixedNow,
    });
    expect(bad.ok).toBe(false);
    resetBootSingleton(name); // failed boot must not poison the retry

    const db = await bootOk(name, [v2Step, v3Step, v4Step]);
    expect(db.bootReport.migrated).toEqual({ from: 1, to: 4 });
    expect(db.schemaVersion).toBe(4);
    const tasks = await db.getAll('tasks');
    // v2 backfills notes on rows that had none; existing notes survive.
    expect(tasks.ok && byId(tasks.value).map((t) => t.notes)).toEqual(['', 'keep me']);
    const lists = await db.getAll('lists');
    expect(lists.ok && lists.value.map((l) => l.name).sort()).toEqual(
      seeded.lists.map((l) => `v3: ${l.name}`).sort(),
    );
  });

  it('a step that wipes meta aborts as MIGRATION_FAILED and rolls back (no crash)', async () => {
    const name = uniqueDbName('drill1-metawipe');
    const seeded = await seedV1(name);
    const metaWipe: MigrationStep = {
      to: 2,
      stores: ['tasks'],
      run: async (t) => {
        await t.delete('meta', 'meta');
        return ok(undefined);
      },
    };
    const result = await boot({ dbName: name, registry: [metaWipe], now: fixedNow });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MIGRATION_FAILED');

    const check = await inspectRaw(name);
    expect(check.meta).toEqual(seeded.meta); // meta restored byte-equivalent
    check.close();
  });

  it('rollback failure surfaces BOTH the step error and the rollback error', async () => {
    const name = uniqueDbName('drill1-doublefail');
    await seedV1(name);
    const brokenCodec: SnapshotCodec = {
      name: 'drill-broken-deserializer',
      serialize: (source) => JSON.stringify(source),
      deserialize: () => err(unknownError(new Error('deserialize boom'))),
    };
    const result = await boot({
      dbName: name,
      registry: [v2Step, v3Step, failingV4Step],
      codec: brokenCodec,
      now: fixedNow,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MIGRATION_FAILED');
    if (result.error.code === 'MIGRATION_FAILED') {
      const cause = result.error.cause as {
        stepError?: StorageError;
        rollbackError?: StorageError;
      };
      expect(cause.stepError).toBeDefined();
      expect(cause.rollbackError).toBeDefined();
    }
  });
});

/* ============ Drill 2: corrupt records quarantine to a recovery file ============ */

describe('Drill 2: corrupt records quarantine to a downloadable, loadable recovery file', () => {
  it('never crashes, never silently drops; the recovery file is loadable JSON with records verbatim', async () => {
    const name = uniqueDbName('drill2-recovery');
    const good = makeTask({ title: 'fine' });
    const badDue = makeTask({ title: 'bad due', dueDate: '2026-02-30' });
    const badTitle = makeTask({ title: 'x'.repeat(1001) });
    const weird = { ...makeTask({ title: 'extra field' }), hacked: true } as unknown as Task;
    await seedDb(name, {
      meta: makeMeta({ schemaVersion: 1 }),
      tasks: [good, badDue, badTitle, weird],
    });

    const db = await bootOk(name);
    expect(db.bootReport.quarantined).toBe(3);

    // Not dropped: every row is still in the DB.
    const raw = await db.readUnfiltered('tasks');
    expect(raw.ok && raw.value).toHaveLength(4);

    // Recovery file: produced, downloadable, and loadable after a real disk round-trip.
    const file = db.quarantine.recoveryFile();
    expect(file.filename).toMatch(/^local-first-todo-recovery-\d{4}-\d{2}-\d{2}T\d{6}Z\.json$/u);
    const dir = mkdtempSync(join(tmpdir(), 'e1-storage-drill2-'));
    try {
      const path = join(dir, file.filename);
      writeFileSync(path, file.json, 'utf8');
      const reloaded = JSON.parse(readFileSync(path, 'utf8')) as {
        format: string;
        createdAt: number;
        schemaVersion: number;
        entries: { store: string; id: string | null; issues: string[]; raw: unknown }[];
      };
      // Pinned ADR-004 Decision 7.1 envelope (fix t_d40034ae re-pinned this drill
      // to the binding format; the pre-fix shape was defect D7).
      expect(reloaded.format).toBe('local-first-todo-recovery'); // NOT importable
      expect(reloaded.createdAt).toBeTruthy();
      expect(reloaded.schemaVersion).toBe(4);
      expect(reloaded.entries).toHaveLength(3);

      // Every quarantined record appears VERBATIM (nothing lost in the file).
      const rawIds = raw.ok ? raw.value.map((t) => t.id) : [];
      for (const entry of reloaded.entries) {
        expect(entry.store).toBe('tasks');
        const record = entry.raw as { id: string };
        expect(rawIds).toContain(record.id);
        expect(entry.issues.length).toBeGreaterThan(0);
      }
      const recovered = reloaded.entries.map((q) => (q.raw as { id: string }).id);
      expect(recovered.sort()).toEqual([badDue.id, badTitle.id, weird.id].sort());

      // Records in the file deep-equal the records in the DB (verbatim).
      const rawById = new Map((raw.ok ? raw.value : []).map((t) => [t.id, t]));
      for (const entry of reloaded.entries) {
        const record = entry.raw as { id: string };
        expect(entry.raw).toEqual(rawById.get(record.id));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // Explicit purge is the ONLY way quarantined records leave the DB.
    const purged = await db.quarantine.purge();
    expect(purged.ok && purged.value).toBe(3);
    const after = await db.readUnfiltered('tasks');
    expect(after.ok && after.value.map((t) => t.id)).toEqual([good.id]);
    expect(db.quarantine.list()).toHaveLength(0);
    expect(db.bootReport.quarantined).toBe(0);
  });
});

/* ============= Drill 3: QuotaExceededError propagates as a typed error ============= */

describe('Drill 3: QuotaExceededError is a typed QUOTA_EXCEEDED on every write surface', () => {
  it('put, tx, takeSnapshot, restoreSnapshot and purgeTombstones all surface the typed error', async () => {
    const name = uniqueDbName('drill3-quota');
    const db = await openFixtureDb(name);
    booted.push(db);
    await db.put('tasks', makeTask());

    // takeSnapshot while quota-exhausted.
    let restore = injectQuotaOnPuts();
    const snap = await takeSnapshot(db, { kind: 'manual', reason: 'manual', now: fixedNow });
    restore();
    expect(snap.ok).toBe(false);
    if (!snap.ok) expect(snap.error.code).toBe('QUOTA_EXCEEDED');

    // A healthy snapshot first, then restore under quota exhaustion.
    const healthy = await takeSnapshot(db, { kind: 'manual', reason: 'manual', now: fixedNow });
    expect(healthy.ok).toBe(true);
    restore = injectQuotaOnPuts();
    const restored = await restoreSnapshot(db, healthy.ok ? healthy.value.id : 'x');
    restore();
    expect(restored.ok).toBe(false);
    if (!restored.ok) expect(restored.error.code).toBe('QUOTA_EXCEEDED');

    // purge auto pass stamps meta.lastPurgeAt — quota must surface there too.
    restore = injectQuotaOnPuts();
    const purged = await purgeTombstones(db, { now: T0 + DAY, mode: 'auto' });
    restore();
    expect(purged.ok).toBe(false);
    if (!purged.ok) {
      expect(purged.error.code).toBe('QUOTA_EXCEEDED');
      expect((purged.error as { cause?: unknown }).cause).toBeInstanceOf(DOMException);
    }

    // put and tx surfaces.
    restore = injectQuotaOnPuts();
    const put = await db.put('tasks', makeTask());
    const tx = await db.tx(['tasks'], 'readwrite', async (t) => {
      await t.put('tasks', makeTask());
      return ok(undefined);
    });
    restore();
    expect(put.ok).toBe(false);
    if (!put.ok) expect(put.error.code).toBe('QUOTA_EXCEEDED');
    expect(tx.ok).toBe(false);
    if (!tx.ok) expect(tx.error.code).toBe('QUOTA_EXCEEDED');
  });

  it('boot survives quota exhaustion in bookkeeping: warnings carry QUOTA_EXCEEDED, never silent', async () => {
    const name = uniqueDbName('drill3-bootwarn');
    await seedDb(name, {
      meta: makeMeta({ schemaVersion: 4 }),
      tasks: [makeTask({ deletedAt: T0 - 100 * DAY })],
    });
    const restore = injectQuotaOnPuts();
    let result: Result<AppDB, StorageError> | null = null;
    try {
      result = await boot({ dbName: name, now: fixedNow });
    } finally {
      restore();
    }
    expect(result.ok).toBe(true); // bookkeeping failure is non-fatal
    if (!result.ok) return;
    const db = result.value as AppDBImpl;
    booted.push(db);
    const warnings = db.bootReport.bootWarnings;
    expect(warnings.map((w) => w.step).sort()).toEqual(['lastOpenedAt', 'purge']);
    for (const warning of warnings) expect(warning.error.code).toBe('QUOTA_EXCEEDED');
    // D6 FIXED (atomic pass): the throttle stamp and the deletions commit or
    // roll back together — under quota the tombstone SURVIVES, the pass reports
    // the typed error, and the count stays a truthful 0 (retried next boot).
    const raw = await db.readUnfiltered('tasks');
    expect(raw.ok && raw.value).toHaveLength(1);
    expect(db.bootReport.purgedTombstones).toBe(0); // truthful: nothing was purged
  });
});

/* ========== Drill 4: boot validation on a mixed valid/invalid dataset ========== */

describe('Drill 4: boot validation on a mixed valid/invalid dataset', () => {
  it('quarantines invalid rows across stores, keeps valid rows live, and purges >90d tombstones at boot', async () => {
    const name = uniqueDbName('drill4-mixed');
    const goodTask = makeTask({ title: 'valid task' });
    const goodList = makeList({ name: 'valid list' });
    const badDue = makeTask({ title: 'bad due', dueDate: '2026-02-30' });
    const badList = { ...makeList({ name: 'bad color' }), color: 'not a color!' };
    const badSettings = { ...makeSettings(), theme: 'neon' } as unknown as Settings;
    const oldTombstone = makeTask({ title: 'ancient', deletedAt: T0 - 91 * DAY });
    const freshTombstone = makeTask({ title: 'recent', deletedAt: T0 - DAY });
    await seedDb(name, {
      meta: makeMeta({ schemaVersion: 4 }),
      lists: [goodList, badList],
      tasks: [goodTask, badDue, oldTombstone, freshTombstone],
      settings: [badSettings],
    });

    const db = await bootOk(name);

    // BootReport: the whole mixed picture in numbers.
    expect(db.bootReport.migrated).toBeNull();
    expect(db.bootReport.newerSchema).toBeNull();
    expect(db.bootReport.quarantined).toBe(3); // badDue + badList + badSettings
    expect(db.bootReport.purgedTombstones).toBe(1); // only the >90d tombstone
    expect(db.bootReport.bootWarnings).toEqual([]);

    // Valid rows stay live across stores.
    const tasks = await db.getAll('tasks');
    expect(tasks.ok && tasks.value.map((t) => t.title).sort()).toEqual(['recent', 'valid task']);
    const lists = await db.getAll('lists');
    expect(lists.ok && lists.value.map((l) => l.id)).toEqual([goodList.id]);

    // Invalid rows: invisible to app reads, present in the DB.
    const rawLists = await db.readUnfiltered('lists');
    expect(rawLists.ok && rawLists.value).toHaveLength(2);
    const rawSettings = await db.readUnfiltered('settings');
    expect(rawSettings.ok && rawSettings.value).toHaveLength(1);
    const settingsRead = await db.get('settings', 'settings');
    expect(settingsRead.ok && settingsRead.value).toBeUndefined();

    // Query surfaces filter too.
    const byQuery = await db.query('tasks', {});
    expect(byQuery.ok && byQuery.value.map((t) => t.id)).not.toContain(badDue.id);

    // Recovery file accounts for exactly the 3 quarantined rows.
    const parsed = JSON.parse(db.quarantine.recoveryFile().json) as {
      entries: { store: string; issues: string[] }[];
    };
    expect(parsed.entries.map((e) => e.store).sort()).toEqual(['lists', 'settings', 'tasks']);
  });
});

/* ============ Drill 5: tombstone purge timing (>90d / explicit) ============ */

describe('Drill 5: tombstone purge timing', () => {
  it('constants match the contract: 90-day TTL and 24h auto throttle', () => {
    expect(TOMBSTONE_TTL_MS).toBe(90 * DAY);
    expect(PURGE_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('auto purges only tombstones strictly older than 90 days; live rows and snapshots untouched', async () => {
    const name = uniqueDbName('drill5-auto');
    const db = await openFixtureDb(name);
    booted.push(db);
    const ancient = makeTask({ title: '91d', deletedAt: T0 - 91 * DAY });
    const boundary = makeTask({ title: 'exactly 90d', deletedAt: T0 - 90 * DAY });
    const recent = makeTask({ title: '89d', deletedAt: T0 - 89 * DAY });
    const live = makeTask({ title: 'live', deletedAt: null });
    await db.put('tasks', ancient);
    await db.put('tasks', boundary);
    await db.put('tasks', recent);
    await db.put('tasks', live);
    await db.put('snapshots', makeSnapshot('01ARZ3NDEKTSV4RRFFQ69G5FAV'));
    await db.put('snapshot_payloads', { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', payload: '{}' });

    const result = await purgeTombstones(db, { now: T0, mode: 'auto' });
    expect(result.ok && result.value).toBe(1); // strictly-older-than-90d only

    const rows = await db.readUnfiltered('tasks');
    expect(rows.ok && rows.value.map((t) => t.title).sort()).toEqual(
      ['exactly 90d', '89d', 'live'].sort(),
    );
    const snaps = await db.readUnfiltered('snapshots');
    expect(snaps.ok && snaps.value).toHaveLength(1); // snapshots never touched
  });

  it('auto is throttled to one pass per 24h, then runs again after the interval', async () => {
    const name = uniqueDbName('drill5-throttle');
    const db = await openFixtureDb(name);
    booted.push(db);
    await db.put('tasks', makeTask({ title: 'first', deletedAt: T0 - 91 * DAY }));
    const first = await purgeTombstones(db, { now: T0, mode: 'auto' });
    expect(first.ok && first.value).toBe(1);

    // A new ancient tombstone appears; the throttled pass must NOT run.
    await db.put('tasks', makeTask({ title: 'second', deletedAt: T0 - 95 * DAY }));
    const throttled = await purgeTombstones(db, { now: T0 + 23 * 60 * 60 * 1000, mode: 'auto' });
    expect(throttled.ok && throttled.value).toBe(0);
    const midRows = await db.readUnfiltered('tasks');
    expect(midRows.ok && midRows.value).toHaveLength(1); // still there

    // Past the interval the pass runs.
    const later = await purgeTombstones(db, { now: T0 + PURGE_INTERVAL_MS + 1, mode: 'auto' });
    expect(later.ok && later.value).toBe(1);
    const endRows = await db.readUnfiltered('tasks');
    expect(endRows.ok && endRows.value).toHaveLength(0);
  });

  it('explicit "Clean up storage" purges ALL tombstones immediately, any age', async () => {
    const name = uniqueDbName('drill5-explicit');
    const db = await openFixtureDb(name);
    booted.push(db);
    await db.put('tasks', makeTask({ title: '1h', deletedAt: T0 - 60 * 60 * 1000 }));
    await db.put('tasks', makeTask({ title: '200d', deletedAt: T0 - 200 * DAY }));
    await db.put('lists', makeList({ name: 'deleted list', deletedAt: T0 - 30 * DAY }));
    await db.put('tasks', makeTask({ title: 'live', deletedAt: null }));

    const result = await purgeTombstones(db, { now: T0, mode: 'explicit' });
    expect(result.ok && result.value).toBe(3); // both tasks + the list, any age

    const tasks = await db.readUnfiltered('tasks');
    expect(tasks.ok && tasks.value.map((t) => t.title)).toEqual(['live']);
    const lists = await db.readUnfiltered('lists');
    expect(lists.ok && lists.value).toHaveLength(0);
  });
});

/* ============ Drill 6: snapshot restore works like a feature ============ */

describe('Drill 6: snapshot restore (take -> corrupt -> restore)', () => {
  it('restores the exact data, keeps deviceId, and resets meta.schemaVersion to the payload', async () => {
    const name = uniqueDbName('drill6-restore');
    const db = await bootOk(name, [v2Step]);
    const deviceId = db.deviceId;

    // Feature state at schemaVersion 2.
    const list = makeList({ name: 'Projects' });
    const taskA = makeTask({ title: 'keep A', listId: list.id });
    await db.put('lists', list);
    await db.put('tasks', taskA);
    await db.put('settings', makeSettings({ theme: 'dark' }));

    const snap = await takeSnapshot(db, { kind: 'manual', reason: 'manual', now: fixedNow });
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;

    // Corrupt the working state: mutate, delete, and add.
    await db.put('tasks', { ...taskA, title: 'CORRUPTED' });
    await db.delete('lists', list.id);
    await db.put('tasks', makeTask({ title: 'junk' }));
    await db.delete('settings', 'settings');

    const restored = await restoreSnapshot(db, snap.value.id);
    expect(restored.ok).toBe(true);

    // Exact restoration.
    const lists = await db.readUnfiltered('lists');
    expect(lists.ok && byId(lists.value)).toEqual([list]);
    const tasks = await db.readUnfiltered('tasks');
    expect(tasks.ok && byId(tasks.value)).toEqual([taskA]);
    const settings = await db.readUnfiltered('settings');
    expect(settings.ok && settings.value).toEqual([makeSettings({ theme: 'dark' })]);

    // Identity stays with the profile; schemaVersion follows the payload.
    expect(db.deviceId).toBe(deviceId);
    const meta = await db.get('meta', 'meta');
    expect(meta.ok && meta.value?.schemaVersion).toBe(4);
    expect(db.schemaVersion).toBe(4);

    // The snapshot itself survives its own restore (evidence kept).
    const snaps = await listSnapshots(db);
    expect(snaps.ok && snaps.value.map((s) => s.id)).toContain(snap.value.id);
  });

  it('restoring a snapshot whose payload is missing is a typed error, not a crash', async () => {
    const name = uniqueDbName('drill6-missing');
    await seedDb(name, {
      meta: makeMeta({ schemaVersion: 1 }),
      snapshots: [makeSnapshot('01ARZ3NDEKTSV4RRFFQ69G5FAV')],
      payloads: [], // metadata without payload — torn write shape
    });
    const db = await bootOk(name);
    const result = await restoreSnapshot(db, '01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNKNOWN');
  });
});

/* ============ Drill 7: wrapper resilience (coverage-gap drills) ============ */

describe('Drill 7: wrapper resilience', () => {
  it('reports typed BLOCKED when another connection holds an older version open', async () => {
    const name = uniqueDbName('drill7-blocked');
    const holder = await openFixtureDb(name); // stays open at the current IDB_VERSION
    try {
      const result = await openRawAppDB({ dbName: name, idbVersion: IDB_VERSION + 1 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('BLOCKED');
    } finally {
      holder.close();
    }
  });

  it('snapshot reads on a closed DB return typed errors, never throw', async () => {
    const name = uniqueDbName('drill7-closed');
    const db = await openFixtureDb(name);
    await db.put('snapshots', makeSnapshot('01ARZ3NDEKTSV4RRFFQ69G5FAV'));
    await db.put('snapshot_payloads', { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', payload: '{}' });
    db.close();

    const list = await listSnapshots(db);
    expect(list.ok).toBe(false);
    if (!list.ok) expect(list.error.code).toBe('UNKNOWN');

    const payload = await getSnapshotPayload(db, '01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(payload.ok).toBe(false);
    if (!payload.ok) expect(payload.error.code).toBe('UNKNOWN');

    const restored = await restoreSnapshot(db, '01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(restored.ok).toBe(false);
  });

  it('a codec deserialization failure on restore is a typed error, not a crash', async () => {
    const name = uniqueDbName('drill7-codec');
    const db = await openFixtureDb(name);
    booted.push(db);
    await db.put('tasks', makeTask());
    const snap = await takeSnapshot(db, { kind: 'manual', reason: 'manual', now: fixedNow });
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;

    const broken: SnapshotCodec = {
      name: 'drill-broken',
      serialize: (source) => JSON.stringify(source),
      deserialize: () => err(unknownError(new Error('payload corrupt beyond repair'))),
    };
    const restored = await restoreSnapshot(db, snap.value.id, broken);
    expect(restored.ok).toBe(false);
    if (!restored.ok) expect(restored.error.code).toBe('UNKNOWN');

    // Data untouched by the failed restore.
    const rows = await db.readUnfiltered('tasks');
    expect(rows.ok && rows.value).toHaveLength(1);
  });
});

/* ======== QA regression drills (t_dbe04ac6): probes P1-P4 as green tests ======== */

describe('Regression P1 (D1): Tx.get applies the quarantine denylist end-to-end', () => {
  it('a quarantined row is invisible to Tx.get and Tx.getAll, still in the DB', async () => {
    const name = uniqueDbName('p1-txget');
    const bad = makeTask({ title: 'x'.repeat(1001) });
    const good = makeTask({ title: 'fine' });
    await seedDb(name, { meta: makeMeta({ schemaVersion: 1 }), tasks: [bad, good] });

    const db = await bootOk(name);
    expect(db.bootReport.quarantined).toBe(1);

    const viaTx = await db.tx(['tasks'], 'readonly', async (t) => ({
      ok: true as const,
      value: { one: await t.get('tasks', bad.id), all: await t.getAll('tasks') },
    }));
    expect(viaTx.ok).toBe(true);
    if (viaTx.ok) {
      expect(viaTx.value.one).toBeUndefined(); // denied single-row read
      expect(viaTx.value.all.map((t) => t.id)).toEqual([good.id]);
    }

    const raw = await db.readUnfiltered('tasks');
    expect(raw.ok && raw.value).toHaveLength(2); // never dropped
  });
});

describe('Regression P2 (D2): quarantine.purge() never destroys the singletons', () => {
  it('a quarantined meta survives purge + reboot — deviceId is never reset (ADR-002 §3.1)', async () => {
    const name = uniqueDbName('p2-purge-meta');
    const badMeta = makeMeta({ deviceId: 'not-a-ulid', schemaVersion: 3 });
    await seedDb(name, { meta: badMeta, tasks: [makeTask({ title: 'fine' })] });

    const db = await bootOk(name);
    expect(db.deviceId).toBe('not-a-ulid');
    expect(db.bootReport.quarantined).toBe(1);

    // Purge destroys NOTHING here: the meta singleton is skipped by design.
    const purged = await db.quarantine.purge();
    expect(purged.ok && purged.value).toBe(0);
    expect(db.quarantine.list()).toHaveLength(1); // still quarantined...
    const file = JSON.parse(db.quarantine.recoveryFile().json) as { entries: unknown[] };
    expect(file.entries).toHaveLength(1); // ...and still downloadable
    const raw = await db.readUnfiltered('meta');
    // Identity fields stay byte-identical; `schemaVersion` moved in-step with the
    // migration chain (executeStep bumps meta inside its own transaction).
    expect(raw.ok && raw.value).toEqual([{ ...badMeta, schemaVersion: 4 }]); // byte-identical identity

    resetBootSingleton(name);
    const second = await bootOk(name);
    expect(second.deviceId).toBe(badMeta.deviceId); // identity survives reboot
    expect(second.bootReport.quarantined).toBe(1); // honestly still quarantined
  });

  it('purge hard-deletes data rows but skips the meta/settings singletons', async () => {
    const name = uniqueDbName('p2-purge-mixed');
    const badTask = makeTask({ title: 'x'.repeat(1001) });
    const badSettings = { ...makeSettings(), theme: 'neon' } as unknown as Settings;
    const badMeta = makeMeta({ deviceId: 'not-a-ulid' });
    await seedDb(name, { meta: badMeta, tasks: [badTask], settings: [badSettings] });

    const db = await bootOk(name);
    expect(db.bootReport.quarantined).toBe(3);

    const purged = await db.quarantine.purge();
    expect(purged.ok && purged.value).toBe(1); // the task only
    expect(
      db.quarantine
        .list()
        .map((e) => e.store)
        .sort(),
    ).toEqual(['meta', 'settings']);
    expect(db.bootReport.quarantined).toBe(2);

    const tasks = await db.readUnfiltered('tasks');
    expect(tasks.ok && tasks.value).toHaveLength(0); // explicit purge IS the data-row exit
    const settings = await db.readUnfiltered('settings');
    expect(settings.ok && settings.value).toEqual([badSettings]); // singleton kept
  });
});

describe('Regression P3 (D3): boot classifies QuotaExceededError on the meta paths', () => {
  it('fresh-boot meta seeding under quota exhaustion returns QUOTA_EXCEEDED', async () => {
    const name = uniqueDbName('p3-metaseed');
    const restore = injectQuotaOnPuts();
    let result: Result<AppDB, StorageError> | null = null;
    try {
      result = await boot({ dbName: name, now: fixedNow });
    } finally {
      restore();
    }
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('QUOTA_EXCEEDED'); // §5.5 dialog contract
  });

  it('meta READ failure is classified too (QUOTA_EXCEEDED, never UNKNOWN)', async () => {
    const name = uniqueDbName('p3-metaread');
    await seedDb(name, { meta: makeMeta({ schemaVersion: 1 }) });

    const restore = injectQuotaOnGets();
    let result: Result<AppDB, StorageError> | null = null;
    try {
      result = await boot({ dbName: name, now: fixedNow });
    } finally {
      restore();
    }
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('QUOTA_EXCEEDED');
  });
});

describe('Regression P4 (D4): corrupt meta.schemaVersion never fakes a migration', () => {
  it('a non-integer schemaVersion yields migrated: null and no spurious snapshot, on EVERY boot', async () => {
    const name = uniqueDbName('p4-metaversion');
    await seedDb(name, {
      meta: makeMeta({ schemaVersion: 0.5 }),
      tasks: [makeTask({ title: 'untouched' })],
    });

    const first = await bootOk(name);
    expect(first.bootReport.migrated).toBeNull(); // no real chain ran
    expect(first.bootReport.preMigrationSnapshotId).toBeNull();
    expect(Number.isInteger(first.schemaVersion)).toBe(true); // no 0.5 leaks out
    const snaps = await first.getAll('snapshots');
    expect(snaps.ok && snaps.value).toHaveLength(0);

    // The regression was "a spurious pre-migration snapshot on EVERY boot".
    resetBootSingleton(name);
    const second = await bootOk(name);
    expect(second.bootReport.migrated).toBeNull();
    const snapsAgain = await second.getAll('snapshots');
    expect(snapsAgain.ok && snapsAgain.value).toHaveLength(0);
    expect(second.bootReport.quarantined).toBe(1); // corrupt meta quarantined, not trusted

    const tasks = await second.getAll('tasks');
    expect(tasks.ok && tasks.value.map((t) => t.title)).toEqual(['untouched']);
  });
});
