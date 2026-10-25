/**
 * E2 two-tab concurrency QA scenario (test card t_7080a238) — an INDEPENDENT
 * script of the E5 acceptance scenario ("two tabs writing simultaneously"),
 * written from PROJECT_ANALYSIS §6.2/§9.3/§10 E5 rather than reusing the
 * implementer's scenario. Two MutationRunners with their own repo instances
 * over ONE shared fake IndexedDB, connected by a fake BroadcastChannel bus:
 *
 *   1. seed converges across tabs via data-changed
 *   2. SIMULTANEOUS bidirectional edits to the SAME record converge to one
 *      merged record in both tabs (disjoint fields all survive)
 *   3. receiving tabs never write (rule 3) and ignore their own origin (rule 1)
 *   4. delete propagates as a tombstone eviction
 *   5. watermark sweep converges when every broadcast is lost
 *
 * Evidence for docs/qa/e2-domain.md.
 */
import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import {
  createTabSync,
  type BroadcastChannelLike,
  type TabSyncReads,
} from '../../../src/app/tabSync';
import { MutationRunner } from '../../../src/domain/pipeline';
import type { ChangeAnnouncement } from '../../../src/domain/sync';
import type { AppDB } from '../../../src/storage/db';
import { openForTests } from '../../../src/storage/db';
import { newUlid } from '../../../src/storage/id';
import { orderKeyBetween, orderKeyFirst } from '../../../src/storage/orderKey';
import { ListRepo } from '../../../src/storage/repos/listRepo';
import { SettingsRepo } from '../../../src/storage/repos/settingsRepo';
import { TaskRepo } from '../../../src/storage/repos/taskRepo';
import { readRows, type RepoDeps } from '../../../src/storage/repos/support';
import { T0, uniqueDbName } from '../storage/fixtures';

class FakeBus {
  endpoints: FakeChannel[] = [];
  dropAll = false;
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
      endpoint.onmessage?.({ data });
    }
  }
  close(): void {
    this.closed = true;
  }
}

async function flush(rounds = 4): Promise<void> {
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
  writes: () => number;
  reads: TabSyncReads;
  sweep: () => Promise<void>;
};

async function makeTab(db: AppDB, bus: FakeBus, now: () => number, tabId: string): Promise<Tab> {
  const ids = (): string => newUlid(now());
  const deps: RepoDeps = { db, clock: now, ids };
  const tasksRepo = new TaskRepo(deps);
  const listsRepo = new ListRepo(deps);
  const settingsRepo = new SettingsRepo(deps);
  let writes = 0;
  const countingTasks = new Proxy(tasksRepo, {
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
  const syncRef: { current: ReturnType<typeof createTabSync> | null } = { current: null };
  const runner = new MutationRunner({
    tasks: countingTasks,
    lists: listsRepo,
    settings: settingsRepo,
    clock: now,
    ids,
    orderKeys: { between: orderKeyBetween, first: orderKeyFirst },
    deviceId: ids(),
    onCommitted: (change: ChangeAnnouncement) => {
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
    channelFactory: (n) => bus.create(n),
  });
  syncRef.current = tabSync;
  tabSync.start();
  await runner.load();
  return {
    id: tabId,
    runner,
    writes: () => writes,
    reads,
    sweep: () => tabSync.sweep(),
  };
}

async function setup(prefix: string) {
  const opened = await openForTests({ dbName: uniqueDbName(prefix) });
  if (!opened.ok) throw new Error('open failed');
  let now = T0;
  const clock = (): number => now;
  const bus = new FakeBus();
  const tabA = await makeTab(opened.value, bus, clock, 'QA-A');
  const tabB = await makeTab(opened.value, bus, clock, 'QA-B');
  return {
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
  return { listId, title, notes: null, priority: 'P3' as const, tags: [] };
}

describe('QA: two-tab concurrency (§10 E5 acceptance script)', () => {
  it('simultaneous bidirectional edits to ONE record converge to a merged record in BOTH tabs', async () => {
    const h = await setup('qa-tabs-interleave');
    const list = await h.seed();
    const created = await h.tabA.runner.createTask(draft(list.id, 'shared'));
    await flush();
    if (!created.ok) throw new Error('create failed');
    const id = created.value.id;
    expect(h.tabB.runner.getState().tasks.has(id)).toBe(true);

    const writesB = h.tabB.writes();
    // Fire BOTH tabs' edits WITHOUT awaiting either — the writes interleave in
    // the shared IndexedDB exactly as two live tabs would.
    const pA = h.tabA.runner.patchTask(id, { title: 'title-from-A' });
    const pB = h.tabB.runner.patchTask(id, { notes: 'notes-from-B' });
    const pB2 = h.tabB.runner.setDone(id, true);
    const [rA, rB, rB2] = await Promise.all([pA, pB, pB2]);
    expect([rA.ok, rB.ok, rB2.ok]).toEqual([true, true, true]);
    await flush();

    // Disjoint fields all survive (patch merges read-modify-write), in both tabs:
    for (const tab of [h.tabA, h.tabB]) {
      const row = tab.runner.getState().tasks.get(id);
      expect(row?.title).toBe('title-from-A');
      expect(row?.notes).toBe('notes-from-B');
      expect(row?.status).toBe('done');
      expect(row?.completedAt).toBeGreaterThan(0);
    }
    // Both tabs hold byte-identical authoritative rows:
    expect(h.tabA.runner.getState().tasks.get(id)).toEqual(h.tabB.runner.getState().tasks.get(id));
    // Tab B's RECEIPT path never wrote:
    expect(h.tabB.writes()).toBe(writesB + 2); // only its own two mutations
  });

  it('each tab ignores its own broadcasts and applies the peer exactly once', async () => {
    const h = await setup('qa-tabs-origin');
    const list = await h.seed();
    const created = await h.tabA.runner.createTask(draft(list.id, 'once'));
    await flush();
    if (!created.ok) throw new Error('create failed');
    expect(h.tabA.runner.getState().tasks.size).toBe(1); // no self-double-apply
    expect(h.tabB.runner.getState().tasks.size).toBe(1);
  });

  it('delete propagates as tombstone eviction to the peer tab', async () => {
    const h = await setup('qa-tabs-delete');
    const list = await h.seed();
    const created = await h.tabA.runner.createTask(draft(list.id, 'doomed'));
    await flush();
    if (!created.ok) throw new Error('create failed');
    expect(h.tabB.runner.getState().tasks.has(created.value.id)).toBe(true);
    await h.tabA.runner.removeTask(created.value.id, { mode: 'cascade' });
    await flush();
    expect(h.tabB.runner.getState().tasks.has(created.value.id)).toBe(false);
    expect(h.tabA.runner.getState().tasks.has(created.value.id)).toBe(false);
  });

  it('watermark sweep converges the peer when EVERY broadcast is lost', async () => {
    const h = await setup('qa-tabs-sweep');
    const list = await h.seed();
    h.bus.dropAll = true;
    h.setNow(T0 + 100);
    const created = await h.tabA.runner.createTask(draft(list.id, 'never broadcast'));
    await flush();
    if (!created.ok) throw new Error('create failed');
    expect(h.tabB.runner.getState().tasks.has(created.value.id)).toBe(false); // stale

    await h.tabB.sweep(); // visibilitychange backstop (by_updatedAt watermark)
    expect(h.tabB.runner.getState().tasks.has(created.value.id)).toBe(true);
  });
});
