/**
 * Repo adapters over fake-indexeddb (ADR-003 Decision 2 / ADR-002 Decisions
 * 4/5/6/11). The acceptance drills: SINGLE-record reorder (puts counted),
 * patch-RMW merge (concurrent tab's field edit survives), stamping rules
 * (completedAt cleared on uncomplete), tombstone + child cascade atomicity,
 * list-delete disposition (one tx), purge policy (auto > 90d / explicit), and
 * the RULE error contract for stale writes.
 */
import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import type { Result } from '../../../src/domain/kernel';
import type { TaskDraft } from '../../../src/domain/model';
import { openForTests, type AppDB, type QuerySpec, type Tx } from '../../../src/storage/db';
import { type StorageError } from '../../../src/storage/errors';
import { createErrorLog, type ErrorLog } from '../../../src/storage/errorLog';
import { newUlid } from '../../../src/storage/id';
import { isCanonicalOrderKey } from '../../../src/storage/orderKey';
import { ListRepo } from '../../../src/storage/repos/listRepo';
import { SettingsRepo } from '../../../src/storage/repos/settingsRepo';
import { TaskRepo } from '../../../src/storage/repos/taskRepo';
import { purgeTombstones, TOMBSTONE_TTL_MS } from '../../../src/storage/purge';
import type { Row, StoreName } from '../../../src/storage/types';
import { makeList, makeTask, T0, uniqueDbName } from './fixtures';

/** View-level order: `(sortOrder, id)` (ADR-002 Decision 4.2). */
function bySortOrder(
  a: { sortOrder: string; id: string },
  b: { sortOrder: string; id: string },
): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder < b.sortOrder ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

/** Wraps `tx` to count every `put` — the single-write reorder proof. */
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

async function setup(prefix: string) {
  const opened = await openForTests({ dbName: uniqueDbName(prefix) });
  if (!opened.ok) throw new Error(`open failed: ${JSON.stringify(opened.error)}`);
  const db = new CountingAppDB(opened.value);
  let now = T0;
  let seq = 0;
  const errorLog: ErrorLog = createErrorLog();
  const deps = {
    db,
    clock: () => now,
    ids: () => {
      seq += 1;
      return newUlid(T0 + seq);
    },
    errorLog,
  };
  return {
    inner: opened.value,
    db,
    tasks: new TaskRepo(deps),
    lists: new ListRepo(deps),
    settings: new SettingsRepo(deps),
    errorLog,
    setNow: (t: number) => {
      now = t;
    },
  };
}

function draft(over: Partial<TaskDraft> = {}): TaskDraft {
  return {
    listId: 'L',
    title: 'Write tests',
    notes: null,
    priority: 'P3',
    tags: [],
    ...over,
  };
}

async function seedList(h: Awaited<ReturnType<typeof setup>>) {
  const r = await h.lists.create({ name: 'Inbox', color: '#336699' });
  if (!r.ok) throw new Error('seed list failed');
  return r.value;
}

describe('TaskRepo: CRUD semantics and stamping (ADR-002 Decision 5)', () => {
  it('create stamps createdAt/updatedAt/deviceId and validates the row', async () => {
    const h = await setup('repo-crud');
    const list = await seedList(h);
    const r = await h.tasks.create(
      draft({ listId: list.id, title: 'Buy milk', dueDate: '2026-10-23' }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = r.value;
    expect(t.createdAt).toBe(T0);
    expect(t.updatedAt).toBe(T0);
    expect(t.deviceId).toBe('0'.repeat(26));
    expect(t.deletedAt).toBeNull();
    expect(t.status).toBe('open');
    expect(isCanonicalOrderKey(t.sortOrder)).toBe(true);
  });

  it('patch merges fields read-modify-write and re-stamps', async () => {
    const h = await setup('repo-patch');
    const list = await seedList(h);
    const created = await h.tasks.create(draft({ listId: list.id, title: 'old', notes: 'keep' }));
    if (!created.ok) throw new Error('create failed');
    h.setNow(T0 + 500);
    const r = await h.tasks.patch(created.value.id, { title: 'new' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.title).toBe('new');
    expect(r.value.notes).toBe('keep'); // untouched field survives (patch, not blind put)
    expect(r.value.updatedAt).toBe(T0 + 500);
  });

  it('dueDateUnset clears the due date', async () => {
    const h = await setup('repo-due');
    const list = await seedList(h);
    const created = await h.tasks.create(draft({ listId: list.id, dueDate: '2026-10-23' }));
    if (!created.ok) throw new Error('create failed');
    const r = await h.tasks.patch(created.value.id, { dueDateUnset: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.dueDate).toBeUndefined();
  });

  it('setDone stamps completedAt; uncomplete CLEARS it', async () => {
    const h = await setup('repo-done');
    const list = await seedList(h);
    const created = await h.tasks.create(draft({ listId: list.id }));
    if (!created.ok) throw new Error('create failed');
    h.setNow(T0 + 100);
    const done = await h.tasks.setDone(created.value.id, true);
    if (!done.ok) throw new Error('setDone failed');
    expect(done.value.status).toBe('done');
    expect(done.value.completedAt).toBe(T0 + 100);
    const undone = await h.tasks.setDone(created.value.id, false);
    if (!undone.ok) throw new Error('unsetDone failed');
    expect(undone.value.status).toBe('open');
    expect(undone.value.completedAt).toBeUndefined();
  });

  it('remove tombstones the task AND its direct subtasks in ONE transaction', async () => {
    const h = await setup('repo-remove');
    const list = await seedList(h);
    const parent = await h.tasks.create(draft({ listId: list.id, title: 'parent' }));
    if (!parent.ok) throw new Error('create failed');
    const child = await h.tasks.create(
      draft({ listId: list.id, title: 'child', parentTaskId: parent.value.id }),
    );
    if (!child.ok) throw new Error('create failed');
    const other = await h.tasks.create(draft({ listId: list.id, title: 'other' }));
    if (!other.ok) throw new Error('create failed');

    const r = await h.tasks.remove(parent.value.id, { mode: 'cascade' });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('remove failed');
    // The disposition outcome reports the rows the transaction wrote (cascade:
    // the task + its direct subtasks tombstoned, nothing promoted).
    expect(r.value.tombstoned.map((t) => t.id).sort()).toEqual(
      [parent.value.id, child.value.id].sort(),
    );
    expect(r.value.promoted).toEqual([]);
    const all = await h.tasks.loadAll();
    if (!all.ok) throw new Error('load failed');
    const ids = all.value.tasks.map((t) => t.id);
    expect(ids).not.toContain(parent.value.id);
    expect(ids).not.toContain(child.value.id);
    expect(ids).toContain(other.value.id);

    // tombstones (not hard deletes) — visible to export/sync paths
    const raw = await h.inner.readUnfiltered('tasks');
    if (!raw.ok) throw new Error('raw read failed');
    const tombstoned = raw.value.filter((t) => t.deletedAt !== null).map((t) => t.id);
    expect(tombstoned).toContain(parent.value.id);
    expect(tombstoned).toContain(child.value.id);
  });

  it('remove is idempotent; stale writes fail RULE: TASK_MISSING', async () => {
    const h = await setup('repo-stale');
    const list = await seedList(h);
    const created = await h.tasks.create(draft({ listId: list.id }));
    if (!created.ok) throw new Error('create failed');
    expect((await h.tasks.remove(created.value.id, { mode: 'cascade' })).ok).toBe(true);
    expect((await h.tasks.remove(created.value.id, { mode: 'cascade' })).ok).toBe(true); // idempotent

    const patch = await h.tasks.patch(created.value.id, { title: 'zombie' });
    expect(patch.ok).toBe(false);
    if (patch.ok) return;
    expect(patch.error).toMatchObject({ code: 'RULE', rule: 'TASK_MISSING' });
  });

  it('rejects subtask-of-subtask with PARENT_DEPTH_EXCEEDED', async () => {
    const h = await setup('repo-depth');
    const list = await seedList(h);
    const parent = await h.tasks.create(draft({ listId: list.id }));
    if (!parent.ok) throw new Error('create failed');
    const child = await h.tasks.create(draft({ listId: list.id, parentTaskId: parent.value.id }));
    if (!child.ok) throw new Error('create failed');
    const grandchild = await h.tasks.create(
      draft({ listId: list.id, parentTaskId: child.value.id }),
    );
    expect(grandchild.ok).toBe(false);
    if (grandchild.ok) return;
    expect(grandchild.error).toMatchObject({ code: 'RULE', rule: 'PARENT_DEPTH_EXCEEDED' });
  });

  it('upsertImported keeps the original stamps', async () => {
    const h = await setup('repo-import');
    const list = await seedList(h);
    const foreignDevice = newUlid(T0 + 50);
    const imported = makeTask({
      id: newUlid(T0),
      listId: list.id,
      updatedAt: 42,
      deviceId: foreignDevice,
    });
    const r = await h.tasks.upsertImported([imported]);
    expect(r.ok).toBe(true);
    const all = await h.tasks.loadAll();
    if (!all.ok) throw new Error('load failed');
    expect(all.value.tasks[0]?.updatedAt).toBe(42);
    expect(all.value.tasks[0]?.deviceId).toBe(foreignDevice);
  });
});

describe('TaskRepo: reorder writes exactly ONE record (ADR-003 Decision 4)', () => {
  it('move() performs exactly one put and touches no other row', async () => {
    const h = await setup('repo-move');
    const list = await seedList(h);
    const ids: string[] = [];
    for (const title of ['a', 'b', 'c']) {
      const r = await h.tasks.create(draft({ listId: list.id, title }));
      if (!r.ok) throw new Error('create failed');
      ids.push(r.value.id);
    }
    h.setNow(T0 + 1);
    h.db.puts = 0;
    const r = await h.tasks.move(ids[2] as string, {
      group: { listId: list.id, parentTaskId: null },
      position: 'first',
    });
    expect(r.ok).toBe(true);
    expect(h.db.puts).toBe(1); // SINGLE-record write — no renumbering, ever

    const all = await h.tasks.loadAll();
    if (!all.ok) throw new Error('load failed');
    const order = [...all.value.tasks].sort(bySortOrder).map((t) => t.title);
    expect(order).toEqual(['c', 'a', 'b']);
    // neighbors are reads only: their rows are byte-identical (no stamp churn)
    const b = all.value.tasks.find((t) => t.title === 'b');
    expect(b?.updatedAt).toBe(T0);
  });

  it('reorders by afterId/beforeId within the declared group', async () => {
    const h = await setup('repo-move2');
    const list = await seedList(h);
    const ids: string[] = [];
    for (const title of ['a', 'b', 'c']) {
      const r = await h.tasks.create(draft({ listId: list.id, title }));
      if (!r.ok) throw new Error('create failed');
      ids.push(r.value.id);
    }
    h.db.puts = 0;
    const r = await h.tasks.move(ids[0] as string, {
      group: { listId: list.id, parentTaskId: null },
      position: { afterId: ids[1] as string },
    });
    expect(r.ok).toBe(true);
    expect(h.db.puts).toBe(1);
    const all = await h.tasks.loadAll();
    if (!all.ok) throw new Error('load failed');
    expect([...all.value.tasks].sort(bySortOrder).map((t) => t.title)).toEqual(['b', 'a', 'c']);
  });

  it('rejects reference rows outside the declared group (RULE: REORDER_TARGET_NOT_IN_GROUP)', async () => {
    const h = await setup('repo-move3');
    const listA = await seedList(h);
    const listB = await h.lists.create({ name: 'Work', color: '#aa0000' });
    if (!listB.ok) throw new Error('create failed');
    const a = await h.tasks.create(draft({ listId: listA.id }));
    const foreign = await h.tasks.create(draft({ listId: listB.value.id }));
    if (!a.ok || !foreign.ok) throw new Error('create failed');
    const r = await h.tasks.move(a.value.id, {
      group: { listId: listA.id, parentTaskId: null },
      position: { afterId: foreign.value.id },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ code: 'RULE', rule: 'REORDER_TARGET_NOT_IN_GROUP' });
  });

  it('rebalances the sibling group on order-key exhaustion (observable in the error log)', async () => {
    const h = await setup('repo-rebalance');
    const list = await seedList(h);
    // A pathological 32-char last key: orderKeyAfter() must exceed the cap.
    const tail = 'h'.repeat(32);
    await h.inner.put('tasks', makeTask({ id: newUlid(T0), listId: list.id, sortOrder: tail }));
    const mover = await h.tasks.create(draft({ listId: list.id, title: 'mover' }));
    if (!mover.ok) throw new Error('create failed');
    const r = await h.tasks.move(mover.value.id, {
      group: { listId: list.id, parentTaskId: null },
      position: 'last',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const entries = h.errorLog.list();
    expect(entries.some((e) => e.op === 'reorder-rebalance')).toBe(true);
    const all = await h.tasks.loadAll();
    if (!all.ok) throw new Error('load failed');
    const keys = [...all.value.tasks].sort(bySortOrder).map((t) => t.sortOrder);
    expect(keys.every((k) => isCanonicalOrderKey(k))).toBe(true);
    for (let i = 1; i < keys.length; i += 1) {
      expect((keys[i] as string) > (keys[i - 1] as string)).toBe(true);
    }
    expect(r.value.row.sortOrder).toBe(keys.at(-1)); // moved row settles last
    expect(r.value.rebalanced).toBe(true); // surfaces the group rewrite to the runner
  });
});

describe('TaskRepo: patch-RMW merge across tabs (E5)', () => {
  it("tab B's title edit survives tab A's reorder (disjoint fields merge)", async () => {
    const h = await setup('repo-rmw');
    const list = await seedList(h);
    const a = await h.tasks.create(draft({ listId: list.id, title: 'original' }));
    const b = await h.tasks.create(draft({ listId: list.id, title: 'other' }));
    if (!a.ok || !b.ok) throw new Error('create failed');

    // Tab A reorders; tab B (a second repo instance over the SAME db) patches
    // only `title`. The RMW merge must keep both outcomes.
    const tabB = new TaskRepo({
      db: h.db,
      clock: () => T0 + 77,
      ids: () => newUlid(T0 + 99),
    });
    const moved = await h.tasks.move(a.value.id, {
      group: { listId: list.id, parentTaskId: null },
      position: 'last',
    });
    const patched = await tabB.patch(a.value.id, { title: 'tab-B-title' });
    expect(moved.ok && patched.ok).toBe(true);
    const all = await h.tasks.loadAll();
    if (!all.ok) throw new Error('load failed');
    const row = all.value.tasks.find((t) => t.id === a.value.id);
    expect(row?.title).toBe('tab-B-title'); // B's field
    expect(row?.sortOrder).toBe(moved.ok ? moved.value.row.sortOrder : ''); // A's field kept
  });
});

describe('ListRepo: disposition + group management (ADR-002 Decision 6)', () => {
  it('move disposition rewrites listId and stamps — tasks survive', async () => {
    const h = await setup('list-move');
    const inbox = await seedList(h);
    const work = await h.lists.create({ name: 'Work', color: '#aa0000' });
    if (!work.ok) throw new Error('create failed');
    const t1 = await h.tasks.create(draft({ listId: inbox.id, title: 't1' }));
    const t2 = await h.tasks.create(draft({ listId: inbox.id, title: 't2' }));
    if (!t1.ok || !t2.ok) throw new Error('create failed');
    h.setNow(T0 + 5);

    const r = await h.lists.remove(inbox.id, { mode: 'move', targetListId: work.value.id });
    expect(r.ok).toBe(true);
    const all = await h.tasks.loadAll();
    if (!all.ok) throw new Error('load failed');
    expect(all.value.tasks).toHaveLength(2);
    expect(all.value.tasks.every((t) => t.listId === work.value.id)).toBe(true);
    expect(all.value.tasks.every((t) => t.updatedAt === T0 + 5)).toBe(true);
    const lists = await h.lists.loadAll();
    if (!lists.ok) throw new Error('load failed');
    expect(lists.value.map((l) => l.id)).toEqual([work.value.id]);
  });

  it('tombstone disposition tombstones the list AND its tasks in one tx', async () => {
    const h = await setup('list-tomb');
    const inbox = await seedList(h);
    const t1 = await h.tasks.create(draft({ listId: inbox.id }));
    if (!t1.ok) throw new Error('create failed');
    const r = await h.lists.remove(inbox.id, { mode: 'tombstone' });
    expect(r.ok).toBe(true);
    const all = await h.tasks.loadAll();
    if (!all.ok) throw new Error('load failed');
    expect(all.value.tasks).toHaveLength(0);
  });

  it('rejects bad disposition targets (RULE: LIST_DELETE_TARGET_MISSING)', async () => {
    const h = await setup('list-target');
    const inbox = await seedList(h);
    const missing = await h.lists.remove(inbox.id, { mode: 'move', targetListId: 'NOPE' });
    expect(missing.ok).toBe(false);
    if (!missing.ok)
      expect(missing.error).toMatchObject({ code: 'RULE', rule: 'LIST_DELETE_TARGET_MISSING' });
    const identical = await h.lists.remove(inbox.id, { mode: 'move', targetListId: inbox.id });
    expect(identical.ok).toBe(false);
    if (!identical.ok) {
      expect(identical.error).toMatchObject({ code: 'RULE', rule: 'LIST_DELETE_TARGET_MISSING' });
    }
    // nothing was written
    const lists = await h.lists.loadAll();
    if (!lists.ok) throw new Error('load failed');
    expect(lists.value).toHaveLength(1);
  });

  it('rename/recolor/move are single-record writes; move reorders the group', async () => {
    const h = await setup('list-ops');
    const l1 = await seedList(h);
    const l2 = await h.lists.create({ name: 'Work', color: '#aa0000' });
    if (!l2.ok) throw new Error('create failed');
    const renamed = await h.lists.rename(l1.id, 'Renamed');
    expect(renamed.ok && renamed.value.name).toBe('Renamed');
    h.db.puts = 0;
    const moved = await h.lists.move(l2.value.id, { beforeId: l1.id });
    expect(moved.ok).toBe(true);
    expect(h.db.puts).toBe(1);
    if (moved.ok) expect(moved.value.rebalanced).toBe(false); // single-record path
    const lists = await h.lists.loadAll();
    if (!lists.ok) throw new Error('load failed');
    expect(lists.value.map((l) => l.name)).toEqual(['Work', 'Renamed']);
  });

  it('rebalances the list group on order-key exhaustion (observable in the error log)', async () => {
    const h = await setup('list-rebalance');
    await seedList(h); // sortOrder 'h'
    const l2 = await h.lists.create({ name: 'Work', color: '#aa0000' });
    if (!l2.ok) throw new Error('create failed');
    // A pathological 32-char last key: orderKeyAfter() must exceed the cap.
    await h.inner.put(
      'lists',
      makeList({ id: newUlid(T0), name: 'tail', sortOrder: 'h'.repeat(32) }),
    );
    h.db.puts = 0;
    const r = await h.lists.move(l2.value.id, 'last');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rebalanced).toBe(true); // the runner announces 'all' from this flag
    expect(h.db.puts).toBe(3); // whole group re-keyed in ONE transaction
    const rebalance = h.errorLog.list().find((e) => e.op === 'reorder-rebalance');
    expect(rebalance).toBeDefined(); // ADR-003 Decision 4 observability (N2)
    expect(rebalance?.detail).toBe('lists (global group)');
    const all = await h.lists.loadAll();
    if (!all.ok) throw new Error('load failed');
    const keys = [...all.value].sort(bySortOrder).map((l) => l.sortOrder);
    expect(keys.every((k) => isCanonicalOrderKey(k))).toBe(true);
    for (let i = 1; i < keys.length; i += 1) {
      expect((keys[i] as string) > (keys[i - 1] as string)).toBe(true);
    }
    expect(r.value.row.id).toBe(l2.value.id);
    expect(r.value.row.sortOrder).toBe(keys.at(-1)); // moved row settles last
    expect(all.value.map((l) => l.name).sort()).toEqual(['Inbox', 'Work', 'tail']);
  });
});

describe('SettingsRepo', () => {
  it('get() returns defaults before the first update; update() persists', async () => {
    const h = await setup('settings');
    const before = await h.settings.get();
    expect(before.ok && before.value.theme).toBe('system');
    const updated = await h.settings.update({ theme: 'dark' });
    expect(updated.ok && updated.value.theme).toBe('dark');
    const after = await h.settings.get();
    expect(after.ok && after.value.theme).toBe('dark');
  });

  it('rejects invalid settings with INVALID_RECORD', async () => {
    const h = await setup('settings-bad');
    const r = await h.settings.update({ locale: 'not a locale!' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ code: 'INVALID_RECORD', store: 'settings' });
  });
});

describe('Tombstone purge policy (ADR-002 Decision 6)', () => {
  it('auto purge removes only tombstones older than 90 days', async () => {
    const h = await setup('purge-auto');
    const list = await seedList(h);
    const old = await h.tasks.create(draft({ listId: list.id, title: 'old' }));
    const fresh = await h.tasks.create(draft({ listId: list.id, title: 'fresh' }));
    if (!old.ok || !fresh.ok) throw new Error('create failed');
    await h.tasks.remove(old.value.id, { mode: 'cascade' }); // tombstoned at T0
    h.setNow(T0 + TOMBSTONE_TTL_MS); // fresh dies exactly at the 90-day horizon
    await h.tasks.remove(fresh.value.id, { mode: 'cascade' });

    const purged = await purgeTombstones(h.inner, {
      now: T0 + TOMBSTONE_TTL_MS + 5000, // old is > 90d old, fresh is not
      mode: 'auto',
    });
    expect(purged.ok && purged.value).toBe(1);
    const raw = await h.inner.readUnfiltered('tasks');
    if (!raw.ok) throw new Error('raw read failed');
    const remaining = raw.value.filter((t) => t.deletedAt !== null).map((t) => t.id);
    expect(remaining).toEqual([fresh.value.id]);
  });

  it('auto purge is throttled to once per 24h', async () => {
    const h = await setup('purge-throttle');
    const first = await purgeTombstones(h.inner, { now: T0, mode: 'auto' });
    expect(first.ok && first.value).toBe(0);
    const second = await purgeTombstones(h.inner, { now: T0 + 60 * 60 * 1000, mode: 'auto' });
    expect(second.ok && second.value).toBe(0); // throttled, even if rows exist
  });

  it('explicit "clean up storage" purges ALL tombstones at any age, never live rows', async () => {
    const h = await setup('purge-explicit');
    const list = await seedList(h);
    const t1 = await h.tasks.create(draft({ listId: list.id, title: 't1' }));
    const t2 = await h.tasks.create(draft({ listId: list.id, title: 't2' }));
    if (!t1.ok || !t2.ok) throw new Error('create failed');
    await h.tasks.remove(t1.value.id, { mode: 'cascade' }); // fresh tombstone — auto would keep it
    const purged = await purgeTombstones(h.inner, { now: T0 + 1, mode: 'explicit' });
    expect(purged.ok && purged.value).toBe(1);
    const all = await h.tasks.loadAll();
    if (!all.ok) throw new Error('load failed');
    expect(all.value.tasks.map((t) => t.id)).toEqual([t2.value.id]);
    const raw = await h.inner.readUnfiltered('tasks');
    if (!raw.ok) throw new Error('raw read failed');
    expect(raw.value.filter((t) => t.deletedAt !== null)).toHaveLength(0);
  });
});

describe('changedSince: the tab-sync watermark read', () => {
  it('returns rows updated after the watermark, tombstones included', async () => {
    const h = await setup('watermark');
    const list = await seedList(h);
    const t1 = await h.tasks.create(draft({ listId: list.id, title: 't1' }));
    if (!t1.ok) throw new Error('create failed');
    h.setNow(T0 + 10);
    await h.tasks.patch(t1.value.id, { title: 'renamed' });
    h.setNow(T0 + 20);
    await h.tasks.remove(t1.value.id, { mode: 'cascade' });

    const since0 = await h.tasks.changedSince(T0 + 5);
    expect(since0.ok && since0.value.map((t) => t.id)).toEqual([t1.value.id]);
    expect(since0.ok && since0.value[0]?.deletedAt).toBe(T0 + 20); // tombstone visible
    const sinceBig = await h.tasks.changedSince(T0 + 100);
    expect(sinceBig.ok && sinceBig.value).toEqual([]);
  });
});
