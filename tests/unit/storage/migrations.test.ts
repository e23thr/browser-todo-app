import { afterEach, describe, expect, it } from 'vitest';

import type { AppDBImpl } from '../../../src/storage/db';
import { err, ok } from '../../../src/storage/errors';
import {
  MemoryTx,
  migrateRows,
  runMigrations,
  targetVersionOf,
} from '../../../src/storage/migrations';
import type { MigrationRegistry, MigrationStep } from '../../../src/storage/migrations';
import type { StoreRows, Task } from '../../../src/storage/types';

import { fixedNow, makeMeta, makeTask, openFixtureDb, uniqueDbName } from './fixtures';

const opened: AppDBImpl[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

/**
 * Test chain v1 -> v2 -> v3 (the registry shape future production steps use):
 * v2 backfills `notes: ''` on every task; v3 stamps notes with '!' (observable
 * change), except a `fail` step that returns an error after attempting a write
 * (to prove step atomicity).
 */
const v2Step: MigrationStep = {
  to: 2,
  stores: ['tasks'],
  run: async (t) => {
    const tasks = await t.getAll('tasks');
    for (const task of tasks) {
      await t.put('tasks', { ...task, notes: task.notes ?? '' });
    }
    return ok(undefined);
  },
};

const v3Step: MigrationStep = {
  to: 3,
  stores: ['tasks'],
  run: async (t) => {
    const tasks = await t.getAll('tasks');
    for (const task of tasks) {
      await t.put('tasks', { ...task, notes: (task.notes ?? '') + '!' });
    }
    return ok(undefined);
  },
};

const failingV3Step: MigrationStep = {
  to: 3,
  stores: ['tasks'],
  run: async (t) => {
    const tasks = await t.getAll('tasks');
    const first = tasks[0];
    if (first !== undefined) {
      await t.put('tasks', { ...first, title: 'SHOULD NOT PERSIST' });
    }
    return err({ code: 'MIGRATION_FAILED', from: 2, to: 3, cause: 'deliberate' });
  },
};

const chain: MigrationRegistry = [v2Step, v3Step];

describe('migration chain (ADR-002 Decision 8)', () => {
  it('targetVersionOf tracks the registry max and the APP baseline', () => {
    expect(targetVersionOf([])).toBe(1);
    expect(targetVersionOf(chain)).toBe(3);
    expect(targetVersionOf([v2Step])).toBe(2);
  });

  it('v1 -> v2 roundtrip: one atomic step per version, meta bumped in-step', async () => {
    const name = uniqueDbName('mig');
    const db = await openFixtureDb(name, makeMeta({ schemaVersion: 1 }));
    opened.push(db);
    const task = makeTask({ notes: undefined as never });
    await db.put('tasks', task);

    const result = await runMigrations(db, { registry: [v2Step], now: fixedNow });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ from: 1, to: 2 });

    expect(db.schemaVersion).toBe(2);
    const meta = await db.get('meta', 'meta');
    if (meta.ok) expect(meta.value?.schemaVersion).toBe(2);

    const after = await db.get('tasks', task.id);
    if (after.ok) expect((after.value as Task).notes).toBe('');

    // Pre-migration snapshot exists and is an auto/pre-migration one.
    const snapshots = await db.getAll('snapshots');
    if (snapshots.ok) {
      expect(snapshots.value).toHaveLength(1);
      expect(snapshots.value[0]).toMatchObject({ kind: 'auto', reason: 'pre-migration' });
    }
  });

  it('is a no-op when already at target (no snapshot taken)', async () => {
    const db = await openFixtureDb(uniqueDbName('mig-noop'), makeMeta({ schemaVersion: 3 }));
    opened.push(db);
    const result = await runMigrations(db, { registry: chain, now: fixedNow });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.preMigrationSnapshotId).toBeNull();
  });

  it('NEWER_SCHEMA: refuses the chain and arms the write guard', async () => {
    const db = await openFixtureDb(uniqueDbName('mig-newer'), makeMeta({ schemaVersion: 5 }));
    opened.push(db);
    const result = await runMigrations(db, { registry: [v2Step], now: fixedNow });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ code: 'NEWER_SCHEMA', found: 5, supported: 2 });

    const write = await db.put('tasks', makeTask());
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.error.code).toBe('NEWER_SCHEMA');
    const read = await db.getAll('tasks');
    expect(read.ok).toBe(true); // reads still work
  });

  it('registry gaps are a typed MIGRATION_FAILED, not a crash', async () => {
    const db = await openFixtureDb(uniqueDbName('mig-gap'), makeMeta({ schemaVersion: 1 }));
    opened.push(db);
    const result = await runMigrations(db, { registry: [v3Step], now: fixedNow }); // missing v2
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MIGRATION_FAILED');
  });

  it('snapshot failure aborts the migration with data untouched', async () => {
    const db = await openFixtureDb(uniqueDbName('mig-snapfail'), makeMeta({ schemaVersion: 1 }));
    opened.push(db);
    const task = makeTask();
    await db.put('tasks', task);

    const brokenCodec = {
      name: 'broken',
      serialize: (): string => {
        throw new Error('serializer exploded');
      },
      deserialize: () => err({ code: 'UNKNOWN' as const, cause: 'nope' }),
    };
    const result = await runMigrations(db, { registry: [v2Step], codec: brokenCodec, now: fixedNow });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MIGRATION_FAILED');

    // Nothing touched: still v1, no snapshot rows, task unchanged.
    expect(db.schemaVersion).toBe(1);
    const meta = await db.get('meta', 'meta');
    if (meta.ok) expect(meta.value?.schemaVersion).toBe(1);
    const snapshots = await db.getAll('snapshots');
    if (snapshots.ok) expect(snapshots.value).toHaveLength(0);
    const after = await db.get('tasks', task.id);
    if (after.ok) expect((after.value as Task).notes).toBeNull();
  });

  it('interrupted mid-chain: failed step rolls back via the pre-migration snapshot', async () => {
    const name = uniqueDbName('mig-rollback');
    const db = await openFixtureDb(name, makeMeta({ schemaVersion: 1 }));
    opened.push(db);
    const task = makeTask({ title: 'original' });
    await db.put('tasks', task);
    const before = await db.getAll('tasks');

    const registry: MigrationRegistry = [v2Step, failingV3Step];
    const result = await runMigrations(db, { registry, now: fixedNow });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('MIGRATION_FAILED');
      expect(result.error).toMatchObject({ from: 1, to: 3 });
    }

    // Rolled back to the pre-migration state: v1 data, v1 meta.
    expect(db.schemaVersion).toBe(1);
    const meta = await db.get('meta', 'meta');
    if (meta.ok) expect(meta.value?.schemaVersion).toBe(1);
    const after = await db.getAll('tasks');
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.value).toEqual(before.ok ? before.value : []);
    const titles = after.ok ? after.value.map((t) => t.title) : [];
    expect(titles).toEqual(['original']); // failing step's write never landed
  });
});

describe('migrateRows — export-upgrade hook (ADR-002 §8, for ADR-004 imports)', () => {
  it('upgrades old-schema rows through the same registry without touching IDB', async () => {
    const taskV1: Record<string, unknown> = { ...makeTask({ title: 'old export row' }) };
    delete taskV1['notes'];
    const rows: StoreRows = {
      meta: [makeMeta({ schemaVersion: 1 })],
      lists: [],
      tasks: [taskV1 as Task],
      settings: [],
      snapshots: [],
      snapshot_payloads: [],
    };
    const result = await migrateRows(chain, rows, 1, 3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.schemaVersion).toBe(3);
    const tasks = result.value.rows.tasks;
    expect(tasks[0]?.tags).toEqual([]);
    expect(tasks[0]?.notes).toBe('!');
  });

  it('returns MIGRATION_FAILED for gaps or failing steps', async () => {
    const rows: StoreRows = {
      meta: [makeMeta()],
      lists: [],
      tasks: [makeTask()],
      settings: [],
      snapshots: [],
      snapshot_payloads: [],
    };
    const gap = await migrateRows([v3Step], rows, 1, 3);
    expect(gap.ok).toBe(false);
    if (!gap.ok) expect(gap.error.code).toBe('MIGRATION_FAILED');

    const failing = await migrateRows([v2Step, failingV3Step], rows, 1, 3);
    expect(failing.ok).toBe(false);
    if (!failing.ok) expect(failing.error.code).toBe('MIGRATION_FAILED');
  });
});

describe('MemoryTx (in-memory Tx for export upgrades)', () => {
  it('behaves like the IDB Tx surface', async () => {
    const mem = new MemoryTx({
      meta: [makeMeta()],
      lists: [],
      tasks: [makeTask({ listId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' })],
      settings: [],
      snapshots: [],
      snapshot_payloads: [],
    });
    const task = makeTask({ listId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', updatedAt: 5 });
    await mem.put('tasks', task);
    const got = await mem.get('tasks', task.id);
    expect(got).toEqual(task);
    const byIndex = await mem.getAll('tasks', {
      index: 'by_listId',
      range: { eq: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
    });
    expect(byIndex).toHaveLength(2);
    const bySort = await mem.getAll('tasks', {
      index: 'by_list_sort',
      range: { lower: ['01ARZ3NDEKTSV4RRFFQ69G5FAV', 'h'] },
      limit: 1,
    });
    expect(bySort).toHaveLength(1);
    const prev = await mem.getAll('tasks', { index: 'by_updatedAt', direction: 'prev' });
    expect(prev[0]?.updatedAt).toBeGreaterThanOrEqual(0);
    await mem.delete('tasks', task.id);
    expect(await mem.get('tasks', task.id)).toBeUndefined();
    await mem.put('meta', makeMeta({ schemaVersion: 7 }));
    expect((await mem.get('meta', 'meta'))?.schemaVersion).toBe(7);
    expect(mem.toStoreRows().tasks).toHaveLength(1);
    const noRange = await mem.getAll('lists');
    expect(noRange).toEqual([]);
  });

  it('upper bounds and open bounds filter correctly', async () => {
    const a = makeTask({ updatedAt: 1 });
    const b = makeTask({ updatedAt: 2 });
    const c = makeTask({ updatedAt: 3 });
    const mem = new MemoryTx({
      meta: [],
      lists: [],
      tasks: [a, b, c],
      settings: [],
      snapshots: [],
      snapshot_payloads: [],
    });
    const upper = await mem.getAll('tasks', { index: 'by_updatedAt', range: { upper: 2, upperOpen: true } });
    expect(upper.map((t) => t.updatedAt)).toEqual([1]);
    const eq = await mem.getAll('tasks', { index: 'by_updatedAt', range: { eq: 2 } });
    expect(eq.map((t) => t.updatedAt)).toEqual([2]);
  });
});
