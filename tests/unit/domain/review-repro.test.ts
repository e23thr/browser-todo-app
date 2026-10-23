/**
 * REVIEW REPRO (h_reviewer, t_371b966c) — expected-behavior assertions for
 * suspected defects. A FAILING test here is evidence of the defect.
 */
import { describe, expect, it } from 'vitest';
import { ok } from '../../../src/domain/kernel';
import { MutationRunner } from '../../../src/domain/pipeline';
import type { ChangeAnnouncement } from '../../../src/domain/sync';
import { createTabSync, type TabSyncReads } from '../../../src/app/tabSync';
import {
  FakeListPort,
  FakeRecorder,
  FakeSettingsPort,
  FakeTaskPort,
  flushMicrotasks,
  makeListRow,
  makeSettingsRow,
  makeTaskRow,
} from './fakes';

function makeRunner(rec: FakeRecorder, committed: ChangeAnnouncement[] = []) {
  const tasks = new FakeTaskPort(rec);
  const lists = new FakeListPort(rec);
  const settings = new FakeSettingsPort(rec);
  let now = 100;
  let n = 0;
  const runner = new MutationRunner({
    tasks,
    lists,
    settings,
    clock: () => now,
    ids: () => `ID${String((n += 1))}`,
    orderKeys: { between: () => 'm', first: () => 'h' },
    deviceId: 'TAB-A',
    onCommitted: (c) => committed.push(c),
  });
  return {
    runner,
    tasks,
    lists,
    bump: (t: number) => {
      now = t;
    },
  };
}

const L1 = makeListRow({ id: 'L1', name: 'One', sortOrder: 'h' });
const L2 = makeListRow({ id: 'L2', name: 'Two', sortOrder: 'i' });
const X = makeTaskRow({ id: 'X', listId: 'L1', sortOrder: 'h', title: 'old', updatedAt: 50 });

describe('review repro A: settled removeList(move) keeps the store as rollback baseline', () => {
  it('a later failed write must NOT roll the moved task back to the pre-move list', async () => {
    const rec = new FakeRecorder();
    const committed: ChangeAnnouncement[] = [];
    const { runner, tasks, bump } = makeRunner(rec, committed);
    tasks.loaded = { tasks: [X], lists: [L1, L2], settings: makeSettingsRow() };
    await runner.load();

    // Delete list L1 with disposition move -> L2 (one repo transaction).
    const p = runner.removeList('L1', { mode: 'move', targetListId: 'L2' });
    await flushMicrotasks();
    rec.succeed(undefined); // repo committed: X.listId = 'L2', stamped
    await p;

    // Store truth after commit: X lives in L2.
    expect(runner.getState().tasks.get('X')?.listId).toBe('L2');

    // Now a failing write on X (e.g. QUOTA_EXCEEDED).
    bump(200);
    const p2 = runner.patchTask('X', { title: 'new' });
    await flushMicrotasks();
    rec.fail({ code: 'QUOTA_EXCEEDED' });
    await p2;

    // INVARIANT (task AC: "no silent divergence between UI state and store"):
    // rollback re-anchors to the LAST COMMITTED image = X in L2.
    const after = runner.getState().tasks.get('X');
    expect(after?.listId).toBe('L2');
    expect(after?.title).toBe('old');
  });
});

describe('review repro A2: ghost committed images must not resurrect deleted rows', () => {
  it('a failed import of a previously deleted task must not resurrect it', async () => {
    const rec = new FakeRecorder();
    const { runner, tasks, bump } = makeRunner(rec);
    tasks.loaded = { tasks: [X], lists: [L1, L2], settings: makeSettingsRow() };
    await runner.load();

    // Delete X (succeeds -> tombstoned in the store).
    const p = runner.removeTask('X');
    await flushMicrotasks();
    rec.succeed(undefined);
    await p;
    expect(runner.getState().tasks.has('X')).toBe(false);

    // Import a file containing a row with id X (stale export) — write FAILS.
    bump(300);
    const p2 = runner.upsertImported([
      makeTaskRow({ id: 'X', listId: 'L1', title: 'imported', updatedAt: 40 }),
    ]);
    await flushMicrotasks();
    rec.fail({ code: 'QUOTA_EXCEEDED' });
    await p2;

    // X is tombstoned in the store; it must not reappear in state.
    expect(runner.getState().tasks.has('X')).toBe(false);
  });
});

describe('review repro B: bulk ops broadcast (ADR-003 Decision 8.1 rule 2)', () => {
  it("remove-list disposition must announce 'all'", async () => {
    const rec = new FakeRecorder();
    const committed: ChangeAnnouncement[] = [];
    const { runner, tasks } = makeRunner(rec, committed);
    tasks.loaded = { tasks: [X], lists: [L1, L2], settings: makeSettingsRow() };
    await runner.load();
    const p = runner.removeList('L1', { mode: 'move', targetListId: 'L2' });
    await flushMicrotasks();
    rec.succeed(undefined);
    await p;
    expect(committed.at(-1)).toBe('all');
  });

  it("import must announce 'all'", async () => {
    const rec = new FakeRecorder();
    const committed: ChangeAnnouncement[] = [];
    const { runner, tasks } = makeRunner(rec, committed);
    tasks.loaded = { tasks: [], lists: [L1], settings: makeSettingsRow() };
    await runner.load();
    const p = runner.upsertImported([
      makeTaskRow({ id: 'A', listId: 'L1' }),
      makeTaskRow({ id: 'B', listId: 'L1' }),
      makeTaskRow({ id: 'C', listId: 'L1' }),
    ]);
    await flushMicrotasks();
    rec.succeed(undefined);
    await p;
    expect(committed.at(-1)).toBe('all');
  });
});

describe('review repro D: pending affordance survives until the LAST in-flight op settles', () => {
  it('settling the first of two queued ops on one record keeps it pending', async () => {
    const rec = new FakeRecorder();
    const { runner, tasks, bump } = makeRunner(rec);
    tasks.loaded = { tasks: [X], lists: [L1], settings: makeSettingsRow() };
    await runner.load();
    const p1 = runner.patchTask('X', { title: 'one' });
    bump(150);
    const p2 = runner.patchTask('X', { title: 'two' });
    await flushMicrotasks();
    rec.succeed(makeTaskRow({ id: 'X', listId: 'L1', title: 'one', updatedAt: 100 }));
    await p1;
    await flushMicrotasks();
    expect(runner.getState().pending.has('X')).toBe(true); // op2 still in flight
    rec.succeed(makeTaskRow({ id: 'X', listId: 'L1', title: 'two', updatedAt: 150 }));
    await p2;
    expect(runner.getState().pending.has('X')).toBe(false);
  });
});

describe('review repro C: watermark sweep must not leapfrog unobserved rows', () => {
  it("a lost-broadcast row written before this tab's own commit is still swept", async () => {
    const rec = new FakeRecorder();
    const { runner, tasks, bump } = makeRunner(rec);
    tasks.loaded = { tasks: [], lists: [L1], settings: makeSettingsRow() };
    await runner.load();

    // Fake "store" the sweep reads from. Tab B wrote X at t=110 (broadcast lost).
    const store = [makeTaskRow({ id: 'X', listId: 'L1', title: 'from B', updatedAt: 110 })];
    let now = 100;
    const reads: TabSyncReads = {
      loadAll: () => Promise.resolve(ok({ tasks: [], lists: [], settings: makeSettingsRow() })),
      getSettings: () => Promise.resolve(ok(makeSettingsRow())),
      readRows: () => Promise.resolve(ok({ tasks: new Map(), lists: new Map() })),
      tasksChangedSince: (since: number) =>
        Promise.resolve(ok(store.filter((t) => t.updatedAt > since))),
      listsChangedSince: () => Promise.resolve(ok([])),
    };
    const tabSync = createTabSync({
      runner,
      reads,
      clock: () => now,
      tabId: 'TAB-A',
      channelFactory: () => ({ postMessage: () => {}, onmessage: null, close: () => {} }),
    });
    tabSync.start();

    // Tab A's own commit at t=120 (announce bumps the watermark past 110).
    now = 120;
    bump(120);
    const p = runner.patchTask('A1', { title: 'x' }); // nonexistent -> rejected; announce directly
    void p;
    tabSync.announce({ tasks: ['A1'] });

    // Tab focus sweep at t=130 must converge X even though its broadcast was lost.
    now = 130;
    await tabSync.sweep();
    await flushMicrotasks();
    expect(runner.getState().tasks.has('X')).toBe(true);
    tabSync.stop();
  });

  it('control: without the interleaved announce the sweep DOES converge', async () => {
    const rec = new FakeRecorder();
    const { runner, tasks } = makeRunner(rec);
    tasks.loaded = { tasks: [], lists: [L1], settings: makeSettingsRow() };
    await runner.load();
    const store = [makeTaskRow({ id: 'X', listId: 'L1', title: 'from B', updatedAt: 110 })];
    let now = 100;
    const reads: TabSyncReads = {
      loadAll: () => Promise.resolve(ok({ tasks: [], lists: [], settings: makeSettingsRow() })),
      getSettings: () => Promise.resolve(ok(makeSettingsRow())),
      readRows: () => Promise.resolve(ok({ tasks: new Map(), lists: new Map() })),
      tasksChangedSince: (since: number) =>
        Promise.resolve(ok(store.filter((t) => t.updatedAt > since))),
      listsChangedSince: () => Promise.resolve(ok([])),
    };
    const tabSync = createTabSync({
      runner,
      reads,
      clock: () => now,
      tabId: 'TAB-A',
      channelFactory: () => ({ postMessage: () => {}, onmessage: null, close: () => {} }),
    });
    tabSync.start();
    now = 130; // no own commit in between
    await tabSync.sweep();
    await flushMicrotasks();
    expect(runner.getState().tasks.has('X')).toBe(true);
    tabSync.stop();
  });
});

describe('sanity: failure path plumbing works', () => {
  it('a plain failed patch rolls back and reports write-failed', async () => {
    const rec = new FakeRecorder();
    const { runner, tasks } = makeRunner(rec);
    tasks.loaded = { tasks: [X], lists: [L1], settings: makeSettingsRow() };
    await runner.load();
    const p = runner.patchTask('X', { title: 'new' });
    expect(runner.getState().tasks.get('X')?.title).toBe('new'); // optimistic
    await flushMicrotasks();
    rec.fail({ code: 'QUOTA_EXCEEDED' });
    const r = await p;
    expect(r.ok).toBe(false);
    expect(runner.getState().tasks.get('X')?.title).toBe('old');
  });
});
