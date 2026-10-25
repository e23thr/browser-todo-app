/**
 * E7 repo-layer contracts (S1 tags, S2 subtasks):
 *
 * - `TaskRepo.remove(id, disposition)`: `cascade` tombstones the task AND its
 *   direct subtasks, `promote` tombstones only the task and moves its direct
 *   subtasks up to the list's top level — ONE transaction either way (the
 *   put-counting wrapper pins the write budget), idempotent on absent rows.
 * - `TaskRepo.sweepTag(from, to)`: the S1 rename/delete sweep over the
 *   DENORMALIZED `tags: string[]` model (ADR-002 §3.5) — one transaction,
 *   tombstoned rows included, rename de-duplicates, changed rows restamped.
 * - rename-propagation timing at 10,000 tasks (recorded below and in the
 *   card's completion metadata).
 */
import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import type { Result } from '../../../src/domain/kernel';
import type { Task } from '../../../src/domain/model';
import { openForTests, type AppDB, type QuerySpec, type Tx } from '../../../src/storage/db';
import { ok, type StorageError } from '../../../src/storage/errors';
import { createErrorLog, type ErrorLog } from '../../../src/storage/errorLog';
import { newUlid } from '../../../src/storage/id';
import { TaskRepo } from '../../../src/storage/repos/taskRepo';
import type { Row, StoreName } from '../../../src/storage/types';
import { T0, uniqueDbName } from './fixtures';

/** Wraps `tx` to count every `put` (write-budget assertions) — mirrors repos.test.ts. */
class CountingAppDB implements AppDB {
  puts = 0;
  readonly #inner: AppDB;

  constructor(inner: AppDB) {
    this.#inner = inner;
  }

  get deviceId(): string {
    return this.#inner.deviceId;
  }
  get schemaVersion(): number {
    return this.#inner.schemaVersion;
  }
  get bootReport(): AppDB['bootReport'] {
    return this.#inner.bootReport;
  }
  get quarantine(): AppDB['quarantine'] {
    return this.#inner.quarantine;
  }

  tx<T>(
    stores: StoreName[],
    mode: 'readonly' | 'readwrite',
    fn: (t: Tx) => Promise<Result<T, StorageError>>,
  ): Promise<Result<T, StorageError>> {
    return this.#inner.tx(stores, mode, async (t) => {
      const counting: Tx = {
        get: <K extends StoreName>(store: K, key: string) => t.get(store, key),
        getAll: <K extends StoreName>(store: K, spec?: QuerySpec) => t.getAll(store, spec),
        put: <K extends StoreName>(store: K, row: Row<K>) => {
          this.puts += 1;
          return t.put(store, row);
        },
        delete: (store: StoreName, key: string) => t.delete(store, key),
      };
      return fn(counting);
    });
  }

  get<K extends StoreName>(store: K, key: string) {
    return this.#inner.get(store, key);
  }
  getAll<K extends StoreName>(store: K, spec?: QuerySpec) {
    return this.#inner.getAll(store, spec);
  }
  put<K extends StoreName>(store: K, row: Row<K>) {
    this.puts += 1;
    return this.#inner.put(store, row);
  }
  query<K extends StoreName>(store: K, spec: QuerySpec) {
    return this.#inner.query(store, spec);
  }
  delete(store: StoreName, key: string) {
    return this.#inner.delete(store, key);
  }
  close(): void {
    this.#inner.close();
  }
}

/**
 * Map-backed `AppDB` — the full-size benchmark substrate (fake-indexeddb's
 * update path is quadratic; see the timing test's substrate note). Only the
 * members `TaskRepo` touches are real; the rest satisfy the interface.
 */
class MemoryAppDB implements AppDB {
  readonly rows = new Map<string, Task>();
  readonly #stores = new Map<StoreName, Map<string, unknown>>();
  readonly deviceId = '0'.repeat(26);
  readonly schemaVersion = 3;
  readonly bootReport: AppDB['bootReport'] = {
    schemaVersion: 3,
    migrated: null,
    preMigrationSnapshotId: null,
    quarantined: 0,
    purgedTombstones: 0,
    newerSchema: null,
    bootWarnings: [],
  };
  readonly quarantine: AppDB['quarantine'] = {
    list: () => [],
    recoveryFile: () => {
      throw new Error('MemoryAppDB does not implement recoveryFile (benchmark double)');
    },
    purge: () => Promise.resolve(ok(0)),
  };

  #map(store: StoreName): Map<string, unknown> {
    const existing = this.#stores.get(store);
    if (existing !== undefined) return existing;
    const created = new Map<string, unknown>();
    this.#stores.set(store, created);
    return created;
  }

  #tx(): Tx {
    return {
      get: <K extends StoreName>(store: K, key: string) =>
        Promise.resolve(this.#map(store).get(key)) as Promise<Row<K> | undefined>,
      getAll: <K extends StoreName>(store: K) =>
        Promise.resolve([...this.#map(store).values()]) as Promise<Row<K>[]>,
      put: <K extends StoreName>(store: K, row: Row<K>) => {
        const task = row as unknown as Task;
        this.#map(store).set(task.id, task);
        if (store === 'tasks') this.rows.set(task.id, task);
        return Promise.resolve();
      },
      delete: (store: StoreName, key: string) => {
        this.#map(store).delete(key);
        this.rows.delete(key);
        return Promise.resolve();
      },
    };
  }

  tx<T>(
    _stores: StoreName[],
    _mode: 'readonly' | 'readwrite',
    fn: (t: Tx) => Promise<Result<T, StorageError>>,
  ): Promise<Result<T, StorageError>> {
    return fn(this.#tx());
  }
  get<K extends StoreName>(store: K, key: string) {
    return this.#tx()
      .get(store, key)
      .then((row) => ok(row));
  }
  getAll<K extends StoreName>(store: K, spec?: QuerySpec) {
    return this.#tx()
      .getAll(store, spec)
      .then((rows) => ok(rows));
  }
  put<K extends StoreName>(store: K, row: Row<K>) {
    return this.#tx()
      .put(store, row)
      .then(() => ok(undefined));
  }
  query<K extends StoreName>(store: K, spec: QuerySpec) {
    return this.#tx()
      .getAll(store, spec)
      .then((rows) => ok(rows));
  }
  delete(store: StoreName, key: string) {
    return this.#tx()
      .delete(store, key)
      .then(() => ok(undefined));
  }
  close(): void {}
}

async function setup(prefix: string) {
  const opened = await openForTests({ dbName: uniqueDbName(prefix) });
  if (!opened.ok) throw new Error(`open failed: ${JSON.stringify(opened.error)}`);
  const db = new CountingAppDB(opened.value);
  let seq = 0;
  const errorLog: ErrorLog = createErrorLog();
  const deps = {
    db,
    clock: () => T0,
    ids: () => {
      seq += 1;
      return newUlid(T0 + seq);
    },
    errorLog,
  };
  return { db, tasks: new TaskRepo(deps), errorLog };
}

function row(over: Partial<Task>): Task {
  return {
    id: over.id ?? newUlid(T0),
    listId: over.listId ?? '0'.repeat(26),
    title: over.title ?? 'task',
    notes: null,
    status: 'open',
    priority: 'P4',
    tags: over.tags ?? [],
    sortOrder: over.sortOrder ?? 'h',
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    deviceId: '0'.repeat(26),
    ...over,
  };
}

/** Raw rows (tombstones INCLUDED) via one readonly transaction. */
async function allRows(db: AppDB): Promise<Task[]> {
  const read = await db.tx(['tasks'], 'readonly', async (t) => ok(await t.getAll('tasks')));
  if (!read.ok) throw new Error('read failed');
  return read.value;
}

async function putRows(db: AppDB, rows: Task[]): Promise<void> {
  const written = await db.tx(['tasks'], 'readwrite', async (t) => {
    // Batched requests (one transaction, no per-row round trip) — seeding 10k
    // rows must not dominate the benchmark below.
    const puts = rows.map((task) => t.put('tasks', task));
    await Promise.all(puts);
    return ok(undefined);
  });
  if (!written.ok) throw new Error('seed write failed');
}

describe('TaskRepo.remove — subtask disposition (S2)', () => {
  it('cascade tombstones the task AND its direct subtasks in one transaction', async () => {
    const h = await setup('e7-cascade');
    const parent = row({ id: 'P'.repeat(26), title: 'parent' });
    const child1 = row({ id: 'C'.repeat(26), parentTaskId: parent.id, sortOrder: 'h' });
    const child2 = row({ id: 'D'.repeat(26), parentTaskId: parent.id, sortOrder: 'i' });
    await putRows(h.db, [parent, child1, child2]);
    h.db.puts = 0;

    const removed = await h.tasks.remove(parent.id, { mode: 'cascade' });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.value.tombstoned.map((t) => t.id).sort()).toEqual(
      [parent.id, child1.id, child2.id].sort(),
    );
    expect(removed.value.promoted).toEqual([]);
    // One transaction, three tombstone writes (task + its direct subtasks).
    expect(h.db.puts).toBe(3);

    const all = await h.tasks.loadAll();
    expect(all.ok && all.value.tasks).toEqual([]);
    const raw = await allRows(h.db);
    expect(raw.every((t) => t.deletedAt !== null)).toBe(true);
    h.db.close();
  });

  it('promote tombstones the task and moves direct subtasks to the list top level', async () => {
    const h = await setup('e7-promote');
    const parent = row({ id: 'P'.repeat(26), title: 'parent' });
    const child = row({ id: 'C'.repeat(26), parentTaskId: parent.id, sortOrder: 'h' });
    await putRows(h.db, [parent, child]);
    h.db.puts = 0;

    const removed = await h.tasks.remove(parent.id, { mode: 'promote' });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.value.tombstoned.map((t) => t.id)).toEqual([parent.id]);
    expect(removed.value.promoted.map((t) => t.id)).toEqual([child.id]);

    const promoted = removed.value.promoted[0];
    if (promoted === undefined) throw new Error('missing promoted row');
    expect(promoted.parentTaskId).toBeUndefined();
    expect(promoted.listId).toBe(child.listId);
    expect(promoted.sortOrder).toBe(child.sortOrder); // order key kept
    expect(promoted.updatedAt).toBe(T0); // restamped by the repo clock

    // Still ONE transaction: 1 tombstone + 1 re-parent put.
    expect(h.db.puts).toBe(2);
    const all = await h.tasks.loadAll();
    expect(all.ok && all.value.tasks.map((t) => t.id)).toEqual([child.id]);
    h.db.close();
  });

  it('is idempotent on absent rows', async () => {
    const h = await setup('e7-idempotent');
    const removed = await h.tasks.remove('X'.repeat(26), { mode: 'cascade' });
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.value).toEqual({ tombstoned: [], promoted: [] });
    h.db.close();
  });
});

describe('TaskRepo.sweepTag — denormalized rename/delete sweep (S1)', () => {
  it('renames in ONE transaction across live and tombstoned rows, de-duplicating', async () => {
    const h = await setup('e7-sweep-rename');
    const live = row({ id: 'A'.repeat(26), tags: ['work'] });
    const both = row({ id: 'B'.repeat(26), tags: ['work', 'office'] });
    const other = row({ id: 'C'.repeat(26), tags: ['home'] });
    const tomb = row({ id: 'D'.repeat(26), tags: ['work'], deletedAt: T0 - 1 });
    await putRows(h.db, [live, both, other, tomb]);
    h.db.puts = 0;

    const swept = await h.tasks.sweepTag('work', 'office');
    expect(swept.ok).toBe(true);
    if (!swept.ok) return;
    // Every row carrying the tag is rewritten — the tombstone too (exports and
    // sync must never resurrect a renamed-away name).
    expect(swept.value.map((t) => t.id).sort()).toEqual([live.id, both.id, tomb.id].sort());
    expect(h.db.puts).toBe(3);

    const raw = await allRows(h.db);
    const byId = new Map(raw.map((t) => [t.id, t]));
    expect(byId.get(live.id)?.tags).toEqual(['office']);
    expect(byId.get(both.id)?.tags).toEqual(['office']); // de-duplicated
    expect(byId.get(other.id)?.tags).toEqual(['home']); // untouched
    expect(byId.get(tomb.id)?.tags).toEqual(['office']);
    // Changed rows are restamped like every other write.
    expect(byId.get(live.id)?.updatedAt).toBe(T0);
    h.db.close();
  });

  it('deletes the name everywhere with `to: null`', async () => {
    const h = await setup('e7-sweep-delete');
    await putRows(h.db, [
      row({ id: 'A'.repeat(26), tags: ['work', 'home'] }),
      row({ id: 'B'.repeat(26), tags: ['work'] }),
    ]);
    const swept = await h.tasks.sweepTag('work', null);
    expect(swept.ok).toBe(true);
    if (!swept.ok) return;
    expect(swept.value).toHaveLength(2);
    const raw = await allRows(h.db);
    expect(raw.map((t) => t.tags).sort()).toEqual([[], ['home']]);
    h.db.close();
  });

  it('resolves with an empty write set when no row carries the name', async () => {
    const h = await setup('e7-sweep-noop');
    await putRows(h.db, [row({ id: 'A'.repeat(26), tags: ['home'] })]);
    h.db.puts = 0;
    const swept = await h.tasks.sweepTag('ghost', 'renamed');
    expect(swept.ok).toBe(true);
    if (swept.ok) expect(swept.value).toEqual([]);
    expect(h.db.puts).toBe(0);
    h.db.close();
  });
});

describe('S1 rename propagation at 10,000 tasks (recorded timing)', () => {
  it('rewrites 10k tagged tasks through the REAL TaskRepo sweep (in-memory AppDB)', async () => {
    // Substrate note: fake-indexeddb's UPDATE path is quadratic (~3.5 ms per
    // rewritten row — measured; inserts are ~0.05 ms), so an emulated-IDB 10k
    // rewrite cannot finish inside a CI-sane budget. The full-size proof
    // therefore runs the REAL repo code (`TaskRepo.sweepTag`: getAll + per-row
    // transform + validation + batched puts, ONE transaction) over an in-memory
    // `AppDB` — the application path is what must be O(n) at 10k; the fake
    // engine's index-rewrite cost is not ours. The next test records the real
    // emulated-IDB timing at 2,000 rows as the substrate-bound data point.
    const db = new MemoryAppDB();
    const rows: Task[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      rows.push(row({ id: newUlid(T0 + i), tags: ['work', `bucket-${String(i % 50)}`] }));
    }
    await putRows(db, rows);

    let seq = 0;
    const repo = new TaskRepo({
      db,
      clock: () => T0,
      ids: () => {
        seq += 1;
        return newUlid(T0 + seq);
      },
      errorLog: createErrorLog(),
    });

    const started = performance.now();
    const swept = await repo.sweepTag('work', 'office');
    const durationMs = performance.now() - started;
    // eslint-disable-next-line no-console
    console.log(
      `[e7] rename propagation at 10,000 tasks (in-memory AppDB): ${durationMs.toFixed(1)} ms`,
    );
    expect(swept.ok).toBe(true);
    if (!swept.ok) return;
    expect(swept.value).toHaveLength(10_000);
    expect([...db.rows.values()].every((t) => t.tags.includes('office'))).toBe(true);
    expect(durationMs).toBeLessThan(10_000);
  }, 60_000);

  it('records the emulated-IDB end-to-end sweep timing at 2,000 tasks', async () => {
    const h = await setup('e7-sweep-idb');
    const rows: Task[] = [];
    for (let i = 0; i < 2_000; i += 1) {
      rows.push(row({ id: newUlid(T0 + i), tags: ['work', `bucket-${String(i % 50)}`] }));
    }
    await putRows(h.db, rows);
    h.db.puts = 0;

    const started = performance.now();
    const swept = await h.tasks.sweepTag('work', 'office');
    const durationMs = performance.now() - started;
    // eslint-disable-next-line no-console
    console.log(
      `[e7] rename propagation at 2,000 tasks (fake-indexeddb, quadratic update path): ${durationMs.toFixed(1)} ms`,
    );
    expect(swept.ok).toBe(true);
    if (!swept.ok) return;
    expect(swept.value).toHaveLength(2_000);
    expect(h.db.puts).toBe(2_000);
    expect(durationMs).toBeLessThan(60_000);
    h.db.close();
  }, 120_000);
});
