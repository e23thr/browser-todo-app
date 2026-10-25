/**
 * Boot integration drills — the acceptance criteria of t_eba4b531:
 *   1. v1 -> v2 migration roundtrip at boot;
 *   2. migration interrupted mid-chain (rollback via pre-migration snapshot);
 *   3. corrupt-record quarantine producing a loadable recovery file;
 *   4. QuotaExceededError propagation (typed, never swallowed).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { boot, resetBootSingleton } from '../../../src/storage/boot';
import { openRawAppDB, type AppDBImpl } from '../../../src/storage/db';
import { err, ok } from '../../../src/storage/errors';
import type { MigrationRegistry, MigrationStep } from '../../../src/storage/migrations';
import { ULID_RE } from '../../../src/storage/id';
import { TOMBSTONE_TTL_MS } from '../../../src/storage/purge';

import {
  fixedNow,
  injectQuotaOnPuts,
  makeMeta,
  makeTask,
  openFixtureDb,
  seedDb,
  uniqueDbName,
} from './fixtures';

const booted: AppDBImpl[] = [];
afterEach(() => {
  for (const db of booted.splice(0)) db.close();
  resetBootSingleton();
});

/** v2 step: backfill `notes: ''` on every task (observable v1 -> v2 data change). */
const v2Step: MigrationStep = {
  to: 2,
  stores: ['tasks'],
  run: async (t) => {
    const tasks = await t.getAll('tasks');
    for (const task of tasks) await t.put('tasks', { ...task, notes: task.notes ?? '' });
    return ok(undefined);
  },
};

const failingV3Step: MigrationStep = {
  to: 3,
  stores: ['tasks'],
  run: async (t) => {
    const tasks = await t.getAll('tasks');
    const first = tasks[0];
    if (first !== undefined) await t.put('tasks', { ...first, title: 'NEVER VISIBLE' });
    return err({ code: 'MIGRATION_FAILED', from: 2, to: 3, cause: 'deliberate mid-chain failure' });
  },
};

/** Passing v3 companion so the toy registry spans the APP_SCHEMA_VERSION target. */
const noopV3Step: MigrationStep = {
  to: 3,
  stores: ['tasks'],
  run: () => ok(undefined),
};

/** Passing v4 companion (same reason — the chain must be contiguous to the floor). */
const noopV4Step: MigrationStep = {
  to: 4,
  stores: ['settings'],
  run: () => ok(undefined),
};

describe('boot: fresh start', () => {
  it('seeds meta with a ULID deviceId and reports a clean boot', async () => {
    const name = uniqueDbName('boot-fresh');
    const result = await boot({ dbName: name, now: fixedNow });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    booted.push(result.value as AppDBImpl);
    expect(result.value.schemaVersion).toBe(4);
    expect(result.value.deviceId).toMatch(ULID_RE);
    expect(result.value.bootReport.quarantined).toBe(0);
    expect(result.value.bootReport.migrated).toBeNull();
    expect(result.value.bootReport.bootWarnings).toEqual([]);

    const meta = await result.value.get('meta', 'meta');
    if (meta.ok) {
      expect(meta.value?.schemaVersion).toBe(4);
      expect(meta.value?.lastOpenedAt).toBe(fixedNow());
    }
  });

  it('is a singleton per app instance and resetBootSingleton tears it down', async () => {
    const name = uniqueDbName('boot-singleton');
    const a = await boot({ dbName: name, now: fixedNow });
    const b = await boot({ dbName: name, now: fixedNow });
    expect(a).toBe(b);
    resetBootSingleton(name);
    const c = await boot({ dbName: name, now: fixedNow });
    expect(c).not.toBe(a);
    if (c.ok) booted.push(c.value as AppDBImpl);
    resetBootSingleton();
  });

  it('reports UNAVAILABLE when the browser has no IndexedDB (private mode)', async () => {
    const globals = globalThis as unknown as { indexedDB?: IDBFactory | undefined };
    const original = globals.indexedDB;
    try {
      globals.indexedDB = undefined;
      const result = await boot({ dbName: uniqueDbName('boot-noidb') });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('UNAVAILABLE');
    } finally {
      globals.indexedDB = original;
    }
  });
});

describe('boot: acceptance — v1 -> v2 migration roundtrip', () => {
  it('migrates data, bumps meta in-step, and snapshots first', async () => {
    const name = uniqueDbName('boot-mig');
    const v1Task = makeTask({ title: 'v1 row' }) as unknown as Record<string, unknown>;
    delete v1Task['notes'];
    await seedDb(name, { meta: makeMeta({ schemaVersion: 1 }), tasks: [v1Task as never] });

    const result = await boot({
      dbName: name,
      registry: [v2Step, noopV3Step, noopV4Step],
      now: fixedNow,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    booted.push(result.value as AppDBImpl);

    expect(result.value.schemaVersion).toBe(4);
    expect(result.value.bootReport.migrated).toEqual({ from: 1, to: 4 });
    expect(result.value.bootReport.preMigrationSnapshotId).not.toBeNull();

    const tasks = await result.value.getAll('tasks');
    if (tasks.ok) expect(tasks.value[0]?.notes).toBe(''); // migrated shape

    // The pre-migration snapshot is an auto/pre-migration one and carries v1 data.
    const snaps = await result.value.getAll('snapshots');
    if (snaps.ok) {
      expect(snaps.value[0]).toMatchObject({
        kind: 'auto',
        reason: 'pre-migration',
        schemaVersion: 1,
      });
    }

    // Reboot at the new version: no re-migration.
    resetBootSingleton(name);
    const again = await boot({
      dbName: name,
      registry: [v2Step, noopV3Step, noopV4Step],
      now: fixedNow,
    });
    expect(again.ok).toBe(true);
    if (again.ok) {
      booted.push(again.value as AppDBImpl);
      expect(again.value.bootReport.migrated).toBeNull();
      expect(again.value.schemaVersion).toBe(4);
    }
    resetBootSingleton(name);
  });
});

describe('boot: acceptance — migration interrupted mid-chain rolls back', () => {
  it('restores the pre-migration snapshot; failing step leaves no trace', async () => {
    const name = uniqueDbName('boot-rollback');
    const task = makeTask({ title: 'original' }) as unknown as Record<string, unknown>;
    delete task['notes'];
    await seedDb(name, { meta: makeMeta({ schemaVersion: 1 }), tasks: [task as never] });

    const registry: MigrationRegistry = [v2Step, failingV3Step, noopV4Step];
    const result = await boot({ dbName: name, registry, now: fixedNow });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('MIGRATION_FAILED');
    }

    // Verify the rollback left the DB byte-equivalent to the v1 fixture.
    // Meta is asserted through RAW reads (QA defect D5): inspection must never
    // ride a fixture-layer open that could rewrite what it is asserting.
    const raw = await openRawAppDB({ dbName: name });
    expect(raw.ok).toBe(true);
    if (raw.ok) {
      const meta = (await raw.value.get('meta', 'meta')) as { schemaVersion?: number } | undefined;
      expect(meta?.schemaVersion).toBe(1);
      raw.value.close();
    }
    const check = await openFixtureDb(name);
    booted.push(check);
    const tasks = await check.readUnfiltered('tasks');
    expect(tasks.ok).toBe(true);
    if (tasks.ok) {
      expect(tasks.value).toHaveLength(1);
      expect(tasks.value[0]?.title).toBe('original'); // failing step's write gone
      expect((tasks.value[0] as unknown as { notes?: string }).notes).toBeUndefined(); // v2 change rolled back
    }
    const snaps = await check.getAll('snapshots');
    if (snaps.ok) expect(snaps.value).toHaveLength(1); // rollback evidence kept
  });
});

describe('boot: acceptance — corrupt records quarantine to a recovery file', () => {
  it('never crashes, never silently drops; recovery file is loadable JSON', async () => {
    const name = uniqueDbName('boot-quarantine');
    const good = makeTask({ title: 'fine' });
    const badDue = makeTask({ title: 'bad due', dueDate: '2026-02-30' });
    const badTitle = makeTask({ title: 'x'.repeat(1001) });
    await seedDb(name, { meta: makeMeta({ schemaVersion: 1 }), tasks: [good, badDue, badTitle] });

    const result = await boot({ dbName: name, now: fixedNow });
    expect(result.ok).toBe(true); // boot survives corruption
    if (!result.ok) return;
    const db = result.value;
    booted.push(db as AppDBImpl);

    expect(db.bootReport.quarantined).toBe(2);

    // Denylist: app reads never see the invalid rows.
    const seen = await db.getAll('tasks');
    if (seen.ok) expect(seen.value.map((t) => t.id)).toEqual([good.id]);
    const byKey = await db.get('tasks', badDue.id);
    if (byKey.ok) expect(byKey.value).toBeUndefined();

    // Tx.get applies the same denylist — the primary repo read path (ADR-002 Dec. 8 step 4).
    const viaTx = await db.tx(['tasks'], 'readonly', async (t) => ({
      ok: true as const,
      value: { bad: await t.get('tasks', badDue.id), good: await t.get('tasks', good.id) },
    }));
    expect(viaTx.ok).toBe(true);
    if (viaTx.ok) {
      expect(viaTx.value.bad).toBeUndefined();
      expect(viaTx.value.good?.title).toBe('fine');
    }

    // Non-destructive: rows are still in the database.
    const raw = await (db as AppDBImpl).readUnfiltered('tasks');
    if (raw.ok) expect(raw.value).toHaveLength(3);

    // Quarantine API: entries + downloadable recovery file.
    const entries = db.quarantine.list();
    expect(entries).toHaveLength(2);
    const issues = entries.flatMap((e) => e.issues).join(' ');
    expect(issues).toContain('dueDate');
    expect(issues).toContain('title');

    const file = db.quarantine.recoveryFile();
    expect(file.filename).toMatch(/^local-first-todo-recovery-\d{4}-\d{2}-\d{2}T\d{6}Z\.json$/u);
    const parsed = JSON.parse(file.json) as {
      format: string;
      formatVersion: number;
      schemaVersion: number;
      deviceId: string;
      source: { kind: string; fileName: string | null; fileSchemaVersion: number };
      entries: { store: string; id: string | null; issues: string[]; raw: { title?: string } }[];
    };
    // ADR-004 Decision 7.1 envelope (boot-validation source), one pinned format.
    expect(parsed.format).toBe('local-first-todo-recovery');
    expect(parsed.formatVersion).toBe(1);
    expect(parsed.deviceId).toBe(db.deviceId);
    expect(parsed.source).toEqual({
      kind: 'boot-validation',
      fileName: null,
      fileSchemaVersion: 4,
    });
    expect(parsed.entries).toHaveLength(2);
    const recoveredTitles = parsed.entries.map((e) => e.raw.title);
    expect(recoveredTitles).toContain('bad due');
    expect(recoveredTitles).toContain('x'.repeat(1001));
    for (const e of parsed.entries) {
      expect(e.store).toBe('tasks');
      expect(e.issues.length).toBeGreaterThan(0);
    }

    // Explicit purge is the ONLY way records leave the DB.
    const purged = await db.quarantine.purge();
    expect(purged.ok).toBe(true);
    if (purged.ok) expect(purged.value).toBe(2);
    const afterPurge = await (db as AppDBImpl).readUnfiltered('tasks');
    if (afterPurge.ok) expect(afterPurge.value.map((t) => t.id)).toEqual([good.id]);
  });
});

describe('boot: acceptance — QuotaExceededError propagation', () => {
  it('surfaces QUOTA_EXCEEDED as a typed boot warning, never swallowed', async () => {
    const name = uniqueDbName('boot-quota');
    await seedDb(name, { meta: makeMeta({ schemaVersion: 4 }), tasks: [makeTask()] });

    const restore = injectQuotaOnPuts();
    const result = await boot({ dbName: name, now: fixedNow }).finally(() => {
      restore();
    });
    expect(result.ok).toBe(true); // boot itself survives (bookkeeping writes fail)
    if (result.ok) {
      booted.push(result.value as AppDBImpl);
      const warnings = result.value.bootReport.bootWarnings;
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0]?.error.code).toBe('QUOTA_EXCEEDED');
    }

    // And every write keeps refusing with the typed error while quota is blown.
    const restore2 = injectQuotaOnPuts();
    try {
      if (result.ok) {
        const db = result.value as AppDBImpl;
        const write = await db.put('tasks', makeTask());
        expect(write.ok).toBe(false);
        if (!write.ok) expect(write.error.code).toBe('QUOTA_EXCEEDED');
      }
    } finally {
      restore2();
    }
    resetBootSingleton(name);
  });
});

describe('boot: newer schema write guard (Decision 2)', () => {
  it('reads work, writes refuse with NEWER_SCHEMA', async () => {
    const name = uniqueDbName('boot-newer');
    await seedDb(name, { meta: makeMeta({ schemaVersion: 9 }), tasks: [makeTask()] });

    const result = await boot({ dbName: name, now: fixedNow });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    booted.push(result.value as AppDBImpl);

    expect(result.value.bootReport.newerSchema).toEqual({ found: 9, supported: 4 });
    const read = await result.value.getAll('tasks');
    expect(read.ok).toBe(true);
    const write = await result.value.put('tasks', makeTask());
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.error.code).toBe('NEWER_SCHEMA');
    resetBootSingleton(name);
  });
});

describe('boot: tombstone purge runs throttled at boot (Decision 6)', () => {
  it('purges >90d tombstones and reports the count', async () => {
    const name = uniqueDbName('boot-purge');
    const oldTomb = makeTask({ deletedAt: fixedNow() - TOMBSTONE_TTL_MS - 1 });
    const live = makeTask();
    await seedDb(name, {
      meta: makeMeta({ schemaVersion: 1, lastPurgeAt: 0 }),
      tasks: [oldTomb, live],
    });

    const result = await boot({ dbName: name, now: fixedNow });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    booted.push(result.value as AppDBImpl);
    expect(result.value.bootReport.purgedTombstones).toBe(1);
    const tasks = await result.value.getAll('tasks');
    if (tasks.ok) expect(tasks.value.map((t) => t.id)).toEqual([live.id]);
    resetBootSingleton(name);
  });
});
