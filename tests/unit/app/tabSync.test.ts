/**
 * Concurrent-tab protocol E2E (ADR-003 Decision 8) — the acceptance "two-tab
 * concurrency scenario": TWO MutationRunners with their own repo instances over
 * ONE shared fake IndexedDB (exactly like two browser tabs), connected by a
 * fake BroadcastChannel bus. Convergence, self-origin ignore, no-writes-on-
 * receipt, tombstone propagation and the watermark-sweep backstop (messages
 * lost) are all scripted here.
 */
import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import {
  createTabSync,
  type BroadcastChannelLike,
  type TabSyncReads,
} from '../../../src/app/tabSync';
import type { ChangeAnnouncement } from '../../../src/domain/sync';
import type { Task } from '../../../src/domain/model';
import { MutationRunner } from '../../../src/domain/pipeline';
import { readRows, type RepoDeps } from '../../../src/storage/repos/support';
import { ListRepo } from '../../../src/storage/repos/listRepo';
import { SettingsRepo } from '../../../src/storage/repos/settingsRepo';
import { TaskRepo } from '../../../src/storage/repos/taskRepo';
import type { AppDB } from '../../../src/storage/db';
import { openForTests } from '../../../src/storage/db';
import { newUlid } from '../../../src/storage/id';
import { orderKeyBetween, orderKeyFirst } from '../../../src/storage/orderKey';
import { makeList, makeTask, T0, uniqueDbName } from '../storage/fixtures';

/** Test double for BroadcastChannel: one shared bus, per-tab endpoints. */
class FakeBus {
  endpoints: FakeChannel[] = [];
  delivered = 0;
  dropAll = false; // simulate lost messages for the watermark-sweep backstop

  create(name: string): BroadcastChannelLike {
    const channel = new FakeChannel(this, name);
    this.endpoints.push(channel);
    return channel;
  }
}

class FakeChannel implements BroadcastChannelLike {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  closed = false;
  readonly bus: FakeBus;
  readonly name: string;

  constructor(bus: FakeBus, name: string) {
    this.bus = bus;
    this.name = name;
  }

  postMessage(data: unknown): void {
    if (this.bus.dropAll) return;
    for (const endpoint of this.bus.endpoints) {
      if (endpoint === this || endpoint.closed || endpoint.name !== this.name) continue;
      this.bus.delivered += 1;
      endpoint.onmessage?.({ data });
    }
  }

  close(): void {
    this.closed = true;
  }
}

async function flush(rounds = 3): Promise<void> {
  // The receive path performs REAL IndexedDB reads (macrotasks under
  // fake-indexeddb) — microtask ticks alone cannot flush them.
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    await Promise.resolve();
  }
}

type Tab = {
  id: string;
  runner: MutationRunner;
  writes: number;
  committed: ChangeAnnouncement[];
  reads: TabSyncReads;
  sync: ReturnType<typeof createTabSync>;
};

async function makeTab(
  db: AppDB,
  bus: FakeBus,
  now: () => number,
  tabId: string,
  useChannel: boolean,
): Promise<Tab> {
  const ids = (): string => newUlid(now());
  const deps: RepoDeps = { db, clock: now, ids };
  const tasksRepo = new TaskRepo(deps);
  const listsRepo = new ListRepo(deps);
  const settingsRepo = new SettingsRepo(deps);
  let writes = 0;
  // Count writes by wrapping create/patch/etc. — receiving tabs must never call them.
  const countingTasks: TaskRepo = new Proxy(tasksRepo, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (
        prop === 'create' ||
        prop === 'patch' ||
        prop === 'setDone' ||
        prop === 'move' ||
        prop === 'remove' ||
        prop === 'upsertImported'
      ) {
        return (...args: unknown[]) => {
          writes += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });

  const committed: ChangeAnnouncement[] = [];
  const syncRef: { current: ReturnType<typeof createTabSync> | null } = { current: null };
  const runner = new MutationRunner({
    tasks: countingTasks,
    lists: listsRepo,
    settings: settingsRepo,
    clock: now,
    ids,
    orderKeys: { between: orderKeyBetween, first: orderKeyFirst },
    deviceId: ids(),
    onCommitted: (change) => {
      committed.push(change);
      syncRef.current?.announce(change);
    },
  });
  const reads: TabSyncReads = {
    loadAll: () => tasksRepo.loadAll(),
    getSettings: () => settingsRepo.get(),
    readRows: (taskIds, listIds) => readRows(db, taskIds, listIds),
    tasksChangedSince: (since) => tasksRepo.changedSince(since),
    listsChangedSince: (since) => listsRepo.changedSince(since),
  };
  const tabSync = createTabSync({
    runner,
    reads,
    clock: now,
    tabId,
    ...(useChannel ? { channelFactory: (name: string) => bus.create(name) } : {}),
  });
  syncRef.current = tabSync;
  tabSync.start();
  await runner.load();
  return {
    id: tabId,
    runner,
    get writes() {
      return writes;
    },
    committed,
    reads,
    sync: tabSync,
  };
}

async function setup(prefix: string) {
  const opened = await openForTests({ dbName: uniqueDbName(prefix) });
  if (!opened.ok) throw new Error('open failed');
  let now = T0;
  const bus = new FakeBus();
  const tabA = await makeTab(opened.value, bus, () => now, 'TAB-A', true);
  const tabB = await makeTab(opened.value, bus, () => now, 'TAB-B', true);
  return {
    inner: opened.value,
    bus,
    tabA,
    tabB,
    setNow: (t: number) => {
      now = t;
    },
    seed: async () => {
      const list = await tabA.runner.createList({ name: 'Inbox', color: '#336699' });
      await flush();
      if (!list.ok) throw new Error('seed failed');
      return list.value;
    },
  };
}

function draft(listId: string, title: string) {
  return { listId, title, notes: null, priority: 0 as const, tags: [] };
}

describe('two-tab concurrency (acceptance scenario)', () => {
  it("A's committed write converges in B via data-changed broadcast", async () => {
    const h = await setup('tabs-converge');
    const list = await h.seed();
    expect(h.tabB.runner.getState().lists.has(list.id)).toBe(true); // seeded via broadcast too

    const created = await h.tabA.runner.createTask(draft(list.id, 'from tab A'));
    await flush();
    if (!created.ok) throw new Error('create failed');
    expect(h.tabA.runner.getState().tasks.has(created.value.id)).toBe(true);
    // B re-read from IDB (never trusts the message payload) and applied it:
    const inB = h.tabB.runner.getState().tasks.get(created.value.id) as Task;
    expect(inB.title).toBe('from tab A');
    expect(inB.deviceId).toBe(h.tabA.runner.getState().tasks.get(created.value.id)?.deviceId);
  });

  it('ignores own broadcasts (receiver rule 1) and never writes on receipt (rule 3)', async () => {
    const h = await setup('tabs-self');
    const list = await h.seed();
    const writesBefore = h.tabB.writes;
    const created = await h.tabA.runner.createTask(draft(list.id, 'x'));
    await flush();
    if (!created.ok) throw new Error('create failed');
    expect(h.tabB.writes).toBe(writesBefore); // receiving tab performs ZERO writes
    // A received its own message structurally but applied nothing twice:
    expect(h.tabA.runner.getState().tasks.size).toBe(1);
  });

  it('tombstones propagate: A deletes, B evicts', async () => {
    const h = await setup('tabs-tomb');
    const list = await h.seed();
    const created = await h.tabA.runner.createTask(draft(list.id, 'doomed'));
    await flush();
    if (!created.ok) throw new Error('create failed');
    expect(h.tabB.runner.getState().tasks.has(created.value.id)).toBe(true);

    await h.tabA.runner.removeTask(created.value.id);
    await flush();
    expect(h.tabB.runner.getState().tasks.has(created.value.id)).toBe(false);
  });

  it("settings: true triggers B's targeted settings reload", async () => {
    const h = await setup('tabs-settings');
    await h.tabA.runner.updateSettings({ theme: 'dark' });
    await flush();
    expect(h.tabB.runner.getState().settings?.theme).toBe('dark');
  });

  it('watermark sweep converges tabs even when EVERY broadcast is lost', async () => {
    const h = await setup('tabs-sweep');
    const list = await h.seed();
    h.bus.dropAll = true; // every message from here on is lost
    h.setNow(T0 + 100); // the write must be newer than B's watermark
    const created = await h.tabA.runner.createTask(draft(list.id, 'never broadcast'));
    await flush();
    if (!created.ok) throw new Error('create failed');
    expect(h.tabB.runner.getState().tasks.has(created.value.id)).toBe(false); // still stale

    const tabSync = createTabSync({
      runner: h.tabB.runner,
      reads: h.tabB.reads,
      clock: () => T0,
      tabId: 'TAB-B',
      channelFactory: () => new FakeChannel(h.bus, 'unused'),
    });
    tabSync.start();
    await tabSync.sweep(); // visibilitychange backstop
    expect(h.tabB.runner.getState().tasks.has(created.value.id)).toBe(true);
  });

  it("'all' messages force a full reload (import / purge / rebalance shaped ops)", async () => {
    const h = await setup('tabs-all');
    const list = await h.seed();
    const created = await h.tabA.runner.createTask(draft(list.id, 'visible'));
    await flush();
    if (!created.ok) throw new Error('create failed');
    // Simulate a bulk op whose rows land in IDB (import / purge / rebalance
    // shape) and whose announcement is change: 'all'.
    await h.inner.put(
      'tasks',
      makeTask({ id: created.value.id, listId: list.id, title: 'renamed-bulk' }),
    );
    // A bulk op in ANOTHER context announces change: 'all' to the channel:
    const foreign = h.bus.create('local-first-todo:tabs:v1');
    foreign.postMessage({
      v: 1,
      type: 'data-changed',
      origin: 'TAB-A',
      at: T0,
      change: 'all',
    });
    await flush();
    const inB = h.tabB.runner.getState().tasks.get(created.value.id);
    expect(inB?.title).toBe('renamed-bulk');
  });

  it("replaceAll(): a bulk replacement (import shape) refreshes the acting tab and announces 'all' to peers", async () => {
    const h = await setup('tabs-replace-all');
    const list = await h.seed();
    const created = await h.tabA.runner.createTask(draft(list.id, 'pre-import row'));
    await flush();
    if (!created.ok) throw new Error('create failed');
    // A standalone observer for B's watermark (D4 assertions below).
    const syncB = createTabSync({
      runner: h.tabB.runner,
      reads: h.tabB.reads,
      clock: () => T0,
      tabId: 'TAB-B',
      channelFactory: (name) => new FakeChannel(h.bus, name),
    });
    syncB.start();
    const watermarkA = h.tabA.sync.watermark;
    const watermarkB = syncB.watermark;

    // Import-shaped bulk replace (applyImport's transaction): hard-delete every old
    // row, put the restored rows verbatim with their ORIGINAL updatedAt stamps.
    await h.inner.delete('tasks', created.value.id);
    await h.inner.delete('lists', list.id);
    const importedList = makeList({
      id: '01ARZ3NDEKTSV4RRFFQ6000091',
      name: 'Imported',
      updatedAt: T0 - 5000,
    });
    const importedTask = makeTask({
      id: '01ARZ3NDEKTSV4RRFFQ6000092',
      listId: importedList.id,
      title: 'restored row',
      updatedAt: T0 - 5000,
    });
    expect((await h.inner.put('lists', importedList)).ok).toBe(true);
    expect((await h.inner.put('tasks', importedTask)).ok).toBe(true);

    await h.tabA.sync.replaceAll();

    // 1. the acting tab reflects the replacement WITHOUT a page reload: new rows in,
    //    replaced rows evicted.
    expect(h.tabA.runner.getState().tasks.get(importedTask.id)?.title).toBe('restored row');
    expect(h.tabA.runner.getState().tasks.has(created.value.id)).toBe(false);
    expect(h.tabA.runner.getState().lists.has(list.id)).toBe(false);
    expect(h.tabA.runner.getState().lists.has(importedList.id)).toBe(true);

    // 2. the peer converges through the documented 'all' refresh path…
    await flush();
    expect(h.tabB.runner.getState().tasks.get(importedTask.id)?.title).toBe('restored row');
    expect(h.tabB.runner.getState().tasks.has(created.value.id)).toBe(false);
    expect(h.tabB.runner.getState().lists.has(list.id)).toBe(false);

    // 3. D4 watermark semantics are untouched: a replace is not a sweep, and neither
    //    is its receipt — the imported rows carry updatedAt BELOW both watermarks and
    //    must not have leapfrogged anything.
    expect(h.tabA.sync.watermark).toBe(watermarkA);
    expect(syncB.watermark).toBe(watermarkB);
  });
});

describe('watermark discipline (review finding D4)', () => {
  it('advances ONLY on a sweep — own commits and receives must not leapfrog', async () => {
    const h = await setup('tabs-watermark');
    const list = await h.seed();
    await flush();
    const tabSync = createTabSync({
      runner: h.tabB.runner,
      reads: h.tabB.reads,
      clock: () => T0,
      tabId: 'TAB-B',
      channelFactory: (name) => new FakeChannel(h.bus, name),
    });
    tabSync.start();
    const start = tabSync.watermark;
    expect(start).toBe(T0);

    // 1. own commit (announce) must NOT move it
    tabSync.announce({ tasks: ['GHOST'] });
    expect(tabSync.watermark).toBe(start);

    // 2. a received targeted message must NOT move it either
    const foreign = h.bus.create('local-first-todo:tabs:v1');
    foreign.postMessage({
      v: 1,
      type: 'data-changed',
      origin: 'TAB-X',
      at: T0,
      change: { tasks: [list.id] },
    });
    await flush();
    expect(tabSync.watermark).toBe(start);

    // 3. a peer write lands at t=T0+100 and its broadcast is received — still no bump
    h.setNow(T0 + 100);
    const created = await h.tabA.runner.createTask(draft(list.id, 'peer row'));
    await flush();
    if (!created.ok) throw new Error('create failed');
    expect(h.tabB.runner.getState().tasks.has(created.value.id)).toBe(true);
    expect(tabSync.watermark).toBe(start);

    // 4. the sweep observes it and advances to the max updatedAt it actually saw
    await tabSync.sweep();
    expect(tabSync.watermark).toBe(T0 + 100);
    tabSync.stop();
  });
});
