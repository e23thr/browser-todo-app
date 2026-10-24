/**
 * E2 repo-layer QA probes (test card t_7080a238) — independent re-verification
 * of the ADR-002/ADR-003 persistence behaviors: tombstone purge boundary
 * (strictly older than 90 days), single-record fractional reorder (exactly one
 * put; neighbors byte-identical), and tombstone visibility for reads vs the
 * export/sync paths. Evidence for docs/qa/e2-domain.md.
 */
import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import { openForTests, type AppDB, type QuerySpec, type Tx } from '../../../src/storage/db';
import type { StorageError } from '../../../src/storage/errors';
import type { Result } from '../../../src/domain/kernel';
import { newUlid } from '../../../src/storage/id';
import { purgeTombstones, TOMBSTONE_TTL_MS } from '../../../src/storage/purge';
import { ListRepo } from '../../../src/storage/repos/listRepo';
import { TaskRepo } from '../../../src/storage/repos/taskRepo';
import type { Row, StoreName } from '../../../src/storage/types';
import { T0, uniqueDbName } from './fixtures';

/** Delegating AppDB that counts every `put` — the single-write proof. */
class PutCountingAppDB implements AppDB {
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

async function setup(prefix: string) {
  const opened = await openForTests({ dbName: uniqueDbName(prefix) });
  if (!opened.ok) throw new Error('open failed');
  const db = new PutCountingAppDB(opened.value);
  let now = T0;
  let seq = 0;
  const deps = {
    db,
    clock: () => now,
    ids: () => {
      seq += 1;
      return newUlid(T0 + seq);
    },
  };
  return {
    inner: opened.value,
    db,
    tasks: new TaskRepo(deps),
    lists: new ListRepo(deps),
    setNow: (t: number) => {
      now = t;
    },
  };
}

describe('QA: tombstone purge policy (§5.2: purge older than 90 days / explicit clean up)', () => {
  it('auto purge boundary is STRICT: exactly-90-day tombstone survives, one ms older is purged', async () => {
    const h = await setup('qa-purge-boundary');
    const list = await h.lists.create({ name: 'Inbox', color: '#336699' });
    if (!list.ok) throw new Error('seed failed');
    const atBoundary = await h.tasks.create({
      listId: list.value.id,
      title: 'boundary',
      notes: null,
      priority: 0,
      tags: [],
    });
    const overBoundary = await h.tasks.create({
      listId: list.value.id,
      title: 'over',
      notes: null,
      priority: 0,
      tags: [],
    });
    if (!atBoundary.ok || !overBoundary.ok) throw new Error('create failed');

    const now = T0 + TOMBSTONE_TTL_MS * 2;
    h.setNow(now - TOMBSTONE_TTL_MS); // t1 deletedAt == now - TTL — exactly 90 days old
    await h.tasks.remove(atBoundary.value.id);
    h.setNow(now - TOMBSTONE_TTL_MS - 1); // t2 deletedAt == now - TTL - 1ms — strictly older
    await h.tasks.remove(overBoundary.value.id);
    h.setNow(now);

    const purged = await purgeTombstones(h.inner, { now, mode: 'auto' });
    expect(purged.ok && purged.value).toBe(1);
    const raw = await h.inner.readUnfiltered('tasks');
    if (!raw.ok) throw new Error('raw read failed');
    const survivors = raw.value.filter((t) => t.deletedAt !== null).map((t) => t.id);
    expect(survivors).toEqual([atBoundary.value.id]); // exactly 90d old = NOT "older than 90 days"
  });

  it('explicit clean-up purges tombstones of every age and never a live row', async () => {
    const h = await setup('qa-purge-explicit');
    const list = await h.lists.create({ name: 'Inbox', color: '#336699' });
    if (!list.ok) throw new Error('seed failed');
    const dead = await h.tasks.create({
      listId: list.value.id,
      title: 'dead',
      notes: null,
      priority: 0,
      tags: [],
    });
    const alive = await h.tasks.create({
      listId: list.value.id,
      title: 'alive',
      notes: null,
      priority: 0,
      tags: [],
    });
    if (!dead.ok || !alive.ok) throw new Error('create failed');
    await h.tasks.remove(dead.value.id); // seconds old — auto would keep it

    const purged = await purgeTombstones(h.inner, { now: T0 + 1, mode: 'explicit' });
    expect(purged.ok && purged.value).toBe(1);
    const all = await h.tasks.loadAll();
    if (!all.ok) throw new Error('load failed');
    expect(all.value.tasks.map((t) => t.id)).toEqual([alive.value.id]);
    const raw = await h.inner.readUnfiltered('tasks');
    if (!raw.ok) throw new Error('raw read failed');
    expect(raw.value.map((t) => t.id)).toEqual([alive.value.id]); // dead row HARD-purged, live row untouched
    expect(raw.value.filter((t) => t.deletedAt !== null)).toHaveLength(0);
  });
});

describe('QA: reorder is a single-record write (ADR-003 Decision 4)', () => {
  it('move() writes EXACTLY one record, keeps neighbors byte-identical, keys stay strictly ordered', async () => {
    const h = await setup('qa-reorder');
    const list = await h.lists.create({ name: 'Inbox', color: '#336699' });
    if (!list.ok) throw new Error('seed failed');
    const mk = async (title: string) => {
      const r = await h.tasks.create({
        listId: list.value.id,
        title,
        notes: null,
        priority: 0,
        tags: [],
      });
      if (!r.ok) throw new Error('create failed');
      return r.value;
    };
    const a = await mk('a');
    const b = await mk('b');
    const c = await mk('c');

    const group = { listId: list.value.id, parentTaskId: null };
    const before = await h.inner.readUnfiltered('tasks');
    if (!before.ok) throw new Error('read failed');
    const snapshot = new Map(before.value.map((t) => [t.id, JSON.stringify(t)]));

    h.db.puts = 0;
    const moved = await h.tasks.move(b.id, { group, position: { beforeId: a.id } });
    expect(moved.ok).toBe(true);
    expect(h.db.puts).toBe(1); // SINGLE put

    const after = await h.inner.readUnfiltered('tasks');
    if (!after.ok) throw new Error('read failed');
    const byId = new Map(after.value.map((t) => [t.id, t]));
    // Neighbors untouched byte-for-byte:
    expect(JSON.stringify(byId.get(a.id))).toBe(snapshot.get(a.id));
    expect(JSON.stringify(byId.get(c.id))).toBe(snapshot.get(c.id));
    // Moved key precedes a's key:
    const movedKey = byId.get(b.id)?.sortOrder ?? '';
    const aKey = byId.get(a.id)?.sortOrder ?? '';
    expect(movedKey < aKey).toBe(true);
    // Only the moved row's JSON changed:
    const changed = after.value
      .filter((t) => JSON.stringify(t) !== snapshot.get(t.id))
      .map((t) => t.id);
    expect(changed).toEqual([b.id]);
  });
});

describe('QA: tombstone visibility (reads vs export/sync paths)', () => {
  it('tombstones vanish from loadAll and changedSince-visible rows but stay in readUnfiltered', async () => {
    const h = await setup('qa-tomb-visibility');
    const list = await h.lists.create({ name: 'Inbox', color: '#336699' });
    if (!list.ok) throw new Error('seed failed');
    const t1 = await h.tasks.create({
      listId: list.value.id,
      title: 'doomed',
      notes: null,
      priority: 0,
      tags: [],
    });
    if (!t1.ok) throw new Error('create failed');
    h.setNow(T0 + 5);
    await h.tasks.remove(t1.value.id);

    const all = await h.tasks.loadAll();
    if (!all.ok) throw new Error('load failed');
    expect(all.value.tasks).toHaveLength(0); // invisible to app reads

    const changed = await h.tasks.changedSince(T0 + 1);
    if (!changed.ok) throw new Error('changedSince failed');
    expect(changed.value.map((t) => [t.id, t.deletedAt])).toEqual([[t1.value.id, T0 + 5]]); // visible to sync

    const raw = await h.inner.readUnfiltered('tasks');
    if (!raw.ok) throw new Error('raw read failed');
    expect(raw.value.map((t) => t.deletedAt)).toEqual([T0 + 5]); // visible to export/backup
  });
});
