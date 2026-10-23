/**
 * Optimistic write pipeline (ADR-003 Decision 3) — the normative order is
 * pinned here: synchronous optimistic apply + notify BEFORE any I/O, serialized
 * writes, authoritative swap on success, exact committed-baseline rollback +
 * queued-op cancellation on failure. "Rollback can never resurrect stale data
 * under a newer optimistic edit" is asserted directly.
 */
import { describe, expect, it } from 'vitest';

import { ruleError, type AppError } from '../../../src/domain/kernel';
import type { Task } from '../../../src/domain/model';
import { MutationRunner, type PipelineErrorInfo } from '../../../src/domain/pipeline';
import { orderKeyBetween, orderKeyFirst } from '../../../src/storage/orderKey';
import type { ChangeEvent } from '../../../src/domain/state';
import type { ChangeAnnouncement } from '../../../src/domain/sync';
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

function makeRunner() {
  const rec = new FakeRecorder();
  const events: ChangeEvent[] = [];
  const committed: ChangeAnnouncement[] = [];
  const errors: PipelineErrorInfo[] = [];
  let clockNow = 1000;
  let idSeq = 0;
  const tasks = new FakeTaskPort(rec);
  const runner = new MutationRunner({
    tasks,
    lists: new FakeListPort(rec),
    settings: new FakeSettingsPort(rec),
    clock: () => clockNow,
    ids: () => {
      idSeq += 1;
      return `ID${String(idSeq)}`;
    },
    orderKeys: { between: orderKeyBetween, first: orderKeyFirst },
    deviceId: 'THIS-TAB',
    onCommitted: (c) => committed.push(c),
    onError: (i) => errors.push(i),
  });
  runner.subscribe((ev) => events.push(ev));
  return {
    rec,
    runner,
    events,
    committed,
    errors,
    tasks,
    tick: () => flushMicrotasks(),
    setClock: (t: number) => {
      clockNow = t;
    },
    baselined: async (rows: { tasks?: Task[] } = {}) => {
      tasks.loaded = {
        tasks: rows.tasks ?? [],
        lists: [makeListRow({ id: 'L1', name: 'Inbox' }), makeListRow({ id: 'L2', name: 'Work' })],
        settings: makeSettingsRow(),
      };
      await runner.load();
    },
  };
}

const draft = { listId: 'L1', title: 'Buy milk', notes: null, priority: 0 as const, tags: [] };

describe('pipeline: optimistic apply (steps 1-2)', () => {
  it('state is updated SYNCHRONOUSLY, before any write resolves', async () => {
    const h = makeRunner();
    void h.runner.createTask(draft);
    const state = h.runner.getState();
    expect(state.tasks.size).toBe(1);
    const task = [...state.tasks.values()][0] as Task;
    expect(task.id).toBe('ID1'); // final ULID minted up front — no id churn
    expect(task.deviceId).toBe('THIS-TAB'); // provisional stamp
    expect(state.pending.has('ID1')).toBe(true);
    expect(h.events[0]).toMatchObject({ kind: 'records', taskIds: ['ID1'] });
    await h.tick();
    expect(h.rec.writes.length).toBe(1); // the write is queued, not resolved
  });

  it('settling swaps in the authoritative record and notifies records + settled', async () => {
    const h = makeRunner();
    const p = h.runner.createTask(draft);
    await h.tick();
    h.rec.succeed(
      makeTaskRow({
        id: 'ID1',
        title: 'Buy milk',
        updatedAt: 999_999,
        deviceId: 'REPO-DEVICE',
        sortOrder: 'm',
      }),
    );
    const res = await p;
    expect(res.ok).toBe(true);
    const task = h.runner.getState().tasks.get('ID1') as Task;
    expect(task.deviceId).toBe('REPO-DEVICE'); // stamps authoritative from the repo
    expect(task.sortOrder).toBe('m'); // provisional order key replaced
    expect(h.runner.getState().pending.size).toBe(0);
    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toContain('settled');
    expect(kinds.indexOf('settled')).toBeGreaterThan(0);
  });

  it('onCommitted fires only after a successful commit, with the change set', async () => {
    const h = makeRunner();
    const p = h.runner.createTask(draft);
    await h.tick();
    expect(h.committed).toEqual([]); // nothing committed yet
    h.rec.succeed(makeTaskRow({ id: 'ID1' }));
    await p;
    expect(h.committed).toEqual([{ tasks: ['ID1'] }]);
  });

  it('provisional stamps are visible pre-write and never persisted (swap replaces them)', async () => {
    const h = makeRunner();
    h.setClock(1234);
    const rejected = await h.runner.patchTask('ID1', { title: 'x' });
    expect(rejected.ok).toBe(false); // no such task yet — rule error, no write
    await h.baselined({ tasks: [makeTaskRow({ id: 'T1', title: 'old' })] });
    const p2 = h.runner.patchTask('T1', { title: 'new' });
    expect(h.runner.getState().tasks.get('T1')?.title).toBe('new');
    expect(h.runner.getState().tasks.get('T1')?.updatedAt).toBe(1234);
    await h.tick();
    h.rec.succeed(makeTaskRow({ id: 'T1', title: 'new', updatedAt: 999_999 }));
    await p2;
    expect(h.runner.getState().tasks.get('T1')?.updatedAt).toBe(999_999);
  });
});

describe('pipeline: failure rollback (step 4b)', () => {
  it('rolls back to the committed baseline EXACTLY', async () => {
    const h = makeRunner();
    await h.baselined({ tasks: [makeTaskRow({ id: 'T1', title: 'baseline', sortOrder: 'h' })] });
    const p = h.runner.patchTask('T1', { title: 'optimistic' });
    expect(h.runner.getState().tasks.get('T1')?.title).toBe('optimistic');
    await h.tick();
    h.rec.fail({ code: 'QUOTA_EXCEEDED' });
    const res = await p;
    expect(res.ok).toBe(false);
    expect(h.runner.getState().tasks.get('T1')?.title).toBe('baseline');
    expect(h.runner.getState().pending.size).toBe(0);
    const failed = h.events.find((e) => e.kind === 'write-failed');
    expect(failed).toMatchObject({ kind: 'write-failed', error: { code: 'QUOTA_EXCEEDED' } });
    expect(h.errors.length).toBe(1);
  });

  it('cancels queued ops sharing the failed ids and rolls them back in reverse order', async () => {
    const h = makeRunner();
    await h.baselined({ tasks: [makeTaskRow({ id: 'T1', title: 'baseline' })] });
    const p1 = h.runner.patchTask('T1', { title: 'first' });
    const p2 = h.runner.patchTask('T1', { notes: 'second' }); // queued behind p1
    await h.tick();
    expect(h.rec.writes.length).toBe(1); // serialized: only p1's write is in flight
    h.rec.fail({ code: 'TX_ABORTED' }); // p1's write fails
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false); // cancelled: baseline is now invalid
    expect(h.rec.writes.length).toBe(1); // p2's write never ran
    const state = h.runner.getState();
    expect(state.tasks.get('T1')?.title).toBe('baseline');
    expect(state.tasks.get('T1')?.notes).toBeNull();
    const failures = h.events.filter((e) => e.kind === 'write-failed');
    expect(failures.length).toBe(2); // one per rolled-back op
    expect(state.pending.size).toBe(0);
  });

  it('a failure only cancels ops that share ids — unrelated ops proceed', async () => {
    const h = makeRunner();
    await h.baselined({
      tasks: [makeTaskRow({ id: 'T1', title: 'one' }), makeTaskRow({ id: 'T2', title: 'two' })],
    });
    const p1 = h.runner.patchTask('T1', { title: 'x' });
    const p2 = h.runner.patchTask('T2', { title: 'y' });
    await h.tick();
    h.rec.fail({ code: 'UNKNOWN' }); // p1 fails
    expect((await p1).ok).toBe(false);
    await h.tick();
    h.rec.succeed(makeTaskRow({ id: 'T2', title: 'y', updatedAt: 999_999 }));
    expect((await p2).ok).toBe(true);
    expect(h.runner.getState().tasks.get('T2')?.title).toBe('y');
    expect(h.runner.getState().tasks.get('T1')?.title).toBe('one');
  });

  it('rollback re-anchors to the LAST COMMITTED image, never a provisional one', async () => {
    const h = makeRunner();
    await h.baselined({ tasks: [makeTaskRow({ id: 'T1', title: 'base', updatedAt: 1 })] });
    const p1 = h.runner.patchTask('T1', { title: 'edit1' });
    const p2 = h.runner.patchTask('T1', { title: 'edit2' }); // optimistic on top
    await h.tick();
    h.rec.succeed(
      makeTaskRow({ id: 'T1', title: 'edit1', updatedAt: 777, deviceId: 'REPO-DEVICE' }),
    );
    await p1; // authoritative swap happens while p2 is still live
    expect(h.runner.getState().tasks.get('T1')?.updatedAt).toBe(777);
    await h.tick();
    h.rec.fail({ code: 'TX_ABORTED' }); // p2 fails -> rollback must restore edit1@777
    await p2;
    const t = h.runner.getState().tasks.get('T1') as Task;
    expect(t.title).toBe('edit1');
    expect(t.updatedAt).toBe(777); // committed stamps, not the provisional 1000
    expect(t.deviceId).toBe('REPO-DEVICE');
  });

  it('multi-record rollback (list-delete disposition) restores every touched record', async () => {
    const h = makeRunner();
    await h.baselined({
      tasks: [makeTaskRow({ id: 'T1', listId: 'L1' }), makeTaskRow({ id: 'T2', listId: 'L1' })],
    });
    const p = h.runner.removeList('L1', { mode: 'move', targetListId: 'L2' });
    expect(h.runner.getState().tasks.get('T1')?.listId).toBe('L2'); // optimistic move
    expect(h.runner.getState().lists.has('L1')).toBe(false); // optimistic evict
    await h.tick();
    h.rec.fail({ code: 'QUOTA_EXCEEDED' });
    expect((await p).ok).toBe(false);
    const state = h.runner.getState();
    expect(state.tasks.get('T1')?.listId).toBe('L1');
    expect(state.tasks.get('T2')?.listId).toBe('L1');
    expect(state.lists.get('L1')?.name).toBe('Inbox');
  });
});

describe('pipeline: rule errors are rejections without state change', () => {
  it('TASK_MISSING on stale ids', async () => {
    const h = makeRunner();
    const r = await h.runner.setDone('GONE', true);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toMatchObject({ code: 'RULE', rule: 'TASK_MISSING' });
    await h.tick();
    expect(h.rec.writes.length).toBe(0);
    expect(h.events.length).toBe(0);
  });

  it('PARENT_DEPTH_EXCEEDED on subtask-of-subtask', async () => {
    const h = makeRunner();
    await h.baselined({
      tasks: [makeTaskRow({ id: 'P1' }), makeTaskRow({ id: 'S1', parentTaskId: 'P1' })],
    });
    const r = await h.runner.createTask({ ...draft, parentTaskId: 'S1' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toMatchObject({ code: 'RULE', rule: 'PARENT_DEPTH_EXCEEDED' });
  });

  it('REORDER_TARGET_NOT_IN_GROUP when the reference row is outside the declared group', async () => {
    const h = makeRunner();
    await h.baselined({ tasks: [makeTaskRow({ id: 'T1', listId: 'L1' })] });
    h.runner.applyExternal({ tasks: [makeTaskRow({ id: 'OTHER', listId: 'L9', sortOrder: 'h' })] });
    const r = await h.runner.moveTask('T1', {
      group: { listId: 'L1', parentTaskId: null },
      position: { afterId: 'OTHER' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toMatchObject({ code: 'RULE', rule: 'REORDER_TARGET_NOT_IN_GROUP' });
  });

  it('LIST_DELETE_TARGET_MISSING when the disposition target is bad', async () => {
    const h = makeRunner();
    await h.baselined();
    const r = await h.runner.removeList('L1', { mode: 'move', targetListId: 'MISSING' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toMatchObject({ code: 'RULE', rule: 'LIST_DELETE_TARGET_MISSING' });
  });

  it('rule rejections are recorded in the error log hook', async () => {
    const h = makeRunner();
    await h.runner.patchTask('NOPE', { title: 'x' });
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toMatchObject({ op: 'patch-task', rolledBack: [] });
  });
});

describe('pipeline: move / remove / setDone specifics', () => {
  it('moveTask mints a provisional key in the declared group and swaps on settle', async () => {
    const h = makeRunner();
    await h.baselined({
      tasks: [
        makeTaskRow({ id: 'T1', listId: 'L1', sortOrder: 'h' }),
        makeTaskRow({ id: 'T2', listId: 'L1', sortOrder: 'n' }),
      ],
    });
    const p = h.runner.moveTask('T2', {
      group: { listId: 'L1', parentTaskId: null },
      position: 'first',
    });
    const provisional = h.runner.getState().tasks.get('T2') as Task;
    expect(provisional.sortOrder < 'h').toBe(true); // strictly before T1
    await h.tick();
    h.rec.succeed({
      row: makeTaskRow({ id: 'T2', listId: 'L1', sortOrder: 'a' }),
      rebalanced: false,
    });
    await p;
    expect(h.runner.getState().tasks.get('T2')?.sortOrder).toBe('a');
  });

  it('removeTask optimistically tombstones the task AND its direct subtasks', async () => {
    const h = makeRunner();
    await h.baselined({
      tasks: [
        makeTaskRow({ id: 'P1' }),
        makeTaskRow({ id: 'S1', parentTaskId: 'P1' }),
        makeTaskRow({ id: 'S2', parentTaskId: 'P1' }),
        makeTaskRow({ id: 'T9' }),
      ],
    });
    const p = h.runner.removeTask('P1');
    expect(h.runner.getState().tasks.has('P1')).toBe(false);
    expect(h.runner.getState().tasks.has('S1')).toBe(false);
    expect(h.runner.getState().tasks.has('S2')).toBe(false);
    expect(h.runner.getState().tasks.has('T9')).toBe(true);
    await h.tick();
    h.rec.succeed(undefined);
    expect((await p).ok).toBe(true);
  });

  it('setDone stamps completedAt provisionally; uncomplete clears it', async () => {
    const h = makeRunner();
    await h.baselined({ tasks: [makeTaskRow({ id: 'T1' })] });
    h.setClock(5000);
    const p1 = h.runner.setDone('T1', true);
    expect(h.runner.getState().tasks.get('T1')?.completedAt).toBe(5000);
    await h.tick();
    h.rec.succeed(makeTaskRow({ id: 'T1', status: 'done', completedAt: 999_999 }));
    await p1;
    const p2 = h.runner.setDone('T1', false);
    const t = h.runner.getState().tasks.get('T1') as Task;
    expect(t.status).toBe('open');
    expect(t.completedAt).toBeUndefined();
    await h.tick();
    h.rec.succeed(makeTaskRow({ id: 'T1', status: 'open' }));
    await p2;
    expect(h.runner.getState().tasks.get('T1')?.completedAt).toBeUndefined();
  });

  it('two rapid patches on one record settle in order and both edits survive', async () => {
    const h = makeRunner();
    await h.baselined({ tasks: [makeTaskRow({ id: 'T1', title: 'base', notes: 'n' })] });
    const p1 = h.runner.patchTask('T1', { title: 'edited' });
    const p2 = h.runner.patchTask('T1', { notes: 'also' });
    await h.tick();
    h.rec.succeed(makeTaskRow({ id: 'T1', title: 'edited', notes: 'n', updatedAt: 111 }));
    await p1;
    await h.tick();
    h.rec.succeed(makeTaskRow({ id: 'T1', title: 'edited', notes: 'also', updatedAt: 222 }));
    await p2;
    const t = h.runner.getState().tasks.get('T1') as Task;
    expect(t.title).toBe('edited');
    expect(t.notes).toBe('also');
    expect(t.updatedAt).toBe(222);
  });
});

describe('pipeline: external refresh never writes or broadcasts', () => {
  it('applyExternal updates state, emits records, and fires no onCommitted', async () => {
    const h = makeRunner();
    h.runner.applyExternal({ tasks: [makeTaskRow({ id: 'X1' })] });
    expect(h.runner.getState().tasks.has('X1')).toBe(true);
    expect(h.committed).toEqual([]);
    expect(h.events.at(-1)).toMatchObject({ kind: 'records', taskIds: ['X1'] });
    h.runner.applyExternal({ evictTasks: ['X1'] });
    expect(h.runner.getState().tasks.has('X1')).toBe(false);
    expect(h.committed).toEqual([]);
    await flushMicrotasks();
    expect(h.rec.writes.length).toBe(0);
  });

  it('updateSettings swaps the singleton and reports settings: true', async () => {
    const h = makeRunner();
    const p = h.runner.updateSettings({ theme: 'dark' });
    expect(h.runner.getState().settings?.theme).toBe('dark');
    await h.tick();
    h.rec.succeed(makeSettingsRow({ theme: 'dark' }));
    await p;
    expect(h.committed).toEqual([{ settings: true }]);
    expect(h.runner.getState().settings?.theme).toBe('dark');
  });
});

describe('pipeline: error hook receives every failure with rolled-back ids', () => {
  it('write failures carry the op and affected ids', async () => {
    const h = makeRunner();
    await h.baselined({ tasks: [makeTaskRow({ id: 'T1' })] });
    const p = h.runner.patchTask('T1', { title: 'x' });
    await h.tick();
    const error: AppError = ruleError('TASK_MISSING', 'gone');
    h.rec.fail(error);
    await p;
    expect(h.errors.at(-1)).toMatchObject({ op: 'patch-task', rolledBack: ['T1'] });
  });
});

describe('pipeline: E2 review rework pins (D1/D2/D3 + N3)', () => {
  it("a rebalance-hatch move announces 'all' (ADR-003 Decision 8.1 rule 2)", async () => {
    const h = makeRunner();
    await h.baselined({ tasks: [makeTaskRow({ id: 'T1', listId: 'L1', sortOrder: 'h' })] });
    const plain = h.runner.moveTask('T1', {
      group: { listId: 'L1', parentTaskId: null },
      position: 'last',
    });
    await h.tick();
    h.rec.succeed({
      row: makeTaskRow({ id: 'T1', listId: 'L1', sortOrder: 'm' }),
      rebalanced: false,
    });
    await plain;
    expect(h.committed.at(-1)).toEqual({ tasks: ['T1'] }); // single-record op: id list

    const hatch = h.runner.moveTask('T1', {
      group: { listId: 'L1', parentTaskId: null },
      position: 'first',
    });
    await h.tick();
    h.rec.succeed({
      row: makeTaskRow({ id: 'T1', listId: 'L1', sortOrder: 'a' }),
      rebalanced: true,
    });
    await hatch;
    expect(h.committed.at(-1)).toBe('all'); // the whole group was rewritten
  });

  it('removeList(move) settle adopts the repo-stamped rows (step 4a authority)', async () => {
    const h = makeRunner();
    await h.baselined({
      tasks: [makeTaskRow({ id: 'T1', listId: 'L1', title: 'old', updatedAt: 1 })],
    });
    const p = h.runner.removeList('L1', { mode: 'move', targetListId: 'L2' });
    await h.tick();
    h.rec.succeed({
      moved: [
        makeTaskRow({
          id: 'T1',
          listId: 'L2',
          title: 'old',
          updatedAt: 5555,
          deviceId: 'REPO-DEVICE',
        }),
      ],
      tombstoned: [],
    });
    expect((await p).ok).toBe(true);
    const settled = h.runner.getState().tasks.get('T1');
    expect(settled?.listId).toBe('L2');
    expect(settled?.updatedAt).toBe(5555); // repo stamp, not the provisional one
    expect(settled?.deviceId).toBe('REPO-DEVICE');

    // ... and the committed baseline is THAT image: a later failure re-anchors to it.
    h.setClock(900);
    const p2 = h.runner.patchTask('T1', { title: 'new' });
    await h.tick();
    h.rec.fail({ code: 'QUOTA_EXCEEDED' });
    expect((await p2).ok).toBe(false);
    const after = h.runner.getState().tasks.get('T1');
    expect(after?.listId).toBe('L2'); // never the pre-move image
    expect(after?.updatedAt).toBe(5555);
    expect(after?.title).toBe('old');
  });

  it('removeList(tombstone) evicts the deleted rows from the committed baseline (D2)', async () => {
    const h = makeRunner();
    await h.baselined({ tasks: [makeTaskRow({ id: 'T1', listId: 'L1' })] });
    const p = h.runner.removeList('L1', { mode: 'tombstone' });
    await h.tick();
    h.rec.succeed({
      moved: [],
      tombstoned: [makeTaskRow({ id: 'T1', listId: 'L1', deletedAt: 500, updatedAt: 500 })],
    });
    expect((await p).ok).toBe(true);
    expect(h.runner.getState().tasks.has('T1')).toBe(false);

    // A later FAILED import of the deleted id must not resurrect the ghost.
    const p2 = h.runner.upsertImported([makeTaskRow({ id: 'T1', listId: 'L1', title: 'ghost' })]);
    await h.tick();
    h.rec.fail({ code: 'QUOTA_EXCEEDED' });
    expect((await p2).ok).toBe(false);
    expect(h.runner.getState().tasks.has('T1')).toBe(false);
  });

  it('moving a parent to another list leaves its subtasks behind (domain-api §10 note 2)', async () => {
    const h = makeRunner();
    await h.baselined({
      tasks: [
        makeTaskRow({ id: 'P1', listId: 'L1' }),
        makeTaskRow({ id: 'S1', listId: 'L1', parentTaskId: 'P1' }),
      ],
    });
    const p = h.runner.moveTask('P1', {
      group: { listId: 'L2', parentTaskId: null },
      position: 'last',
    });
    // Single-write reorder: only the parent row moves; the subtask is NOT rewritten.
    expect(h.runner.getState().tasks.get('P1')?.listId).toBe('L2');
    expect(h.runner.getState().tasks.get('S1')?.listId).toBe('L1');
    expect(h.runner.getState().tasks.get('S1')?.parentTaskId).toBe('P1');
    await h.tick();
    h.rec.succeed({
      row: makeTaskRow({ id: 'P1', listId: 'L2', sortOrder: 'm' }),
      rebalanced: false,
    });
    expect((await p).ok).toBe(true);
    expect(h.runner.getState().tasks.get('S1')?.listId).toBe('L1'); // stays orphaned in L1
  });
});
