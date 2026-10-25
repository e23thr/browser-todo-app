/**
 * E7 domain contracts — S1 tag sweeps, S2 subtask disposition, S3 sorting:
 *
 * - `MutationRunner.renameTag` / `deleteTag`: bulk optimistic rewrite over the
 *   denormalized `tags: string[]` model (announces `'all'`), authoritative swap
 *   on success, exact committed-baseline rollback on failure, `TAG_INVALID`
 *   rule rejection for bad names.
 * - `MutationRunner.removeTask(id, disposition)`: `cascade` vs `promote`
 *   (S2: subtasks move up to the list's top level), incl. rollback restore.
 * - `selectView`: the S1 tag filter (never drops an orphaned-but-matching
 *   subtask) and the S3 `sortBy: 'priority'` level ordering (`P1` first).
 */
import { describe, expect, it } from 'vitest';

import { ruleError, type AppError } from '../../../src/domain/kernel';
import { compareByPriority, type Priority, type Task } from '../../../src/domain/model';
import { MutationRunner } from '../../../src/domain/pipeline';
import { orderKeyBetween, orderKeyFirst } from '../../../src/storage/orderKey';
import type { ChangeAnnouncement } from '../../../src/domain/sync';
import type { ChangeEvent } from '../../../src/domain/state';
import { emptyState, type State } from '../../../src/domain/state';
import { selectView } from '../../../src/domain/views';
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
  });
  runner.subscribe((ev) => events.push(ev));
  return {
    rec,
    runner,
    events,
    committed,
    tasks,
    tick: () => flushMicrotasks(),
    setClock: (t: number) => {
      clockNow = t;
    },
    baselined: async (rows: Task[]) => {
      tasks.loaded = {
        tasks: rows,
        lists: [makeListRow({ id: 'L1', name: 'Inbox' })],
        settings: makeSettingsRow(),
      };
      await runner.load();
    },
  };
}

describe('MutationRunner.renameTag / deleteTag (S1)', () => {
  it('rewrites optimistically, swaps to authoritative rows, announces `all`', async () => {
    const h = makeRunner();
    const a = makeTaskRow({ id: 'A', tags: ['work'] });
    const b = makeTaskRow({ id: 'B', tags: ['work', 'home'] });
    await h.baselined([a, b]);

    const pending = h.runner.renameTag('work', 'office');
    // Optimistic: visible synchronously, BEFORE any I/O settles.
    expect(h.runner.getState().tasks.get('A')?.tags).toEqual(['office']);
    expect(h.runner.getState().tasks.get('B')?.tags).toEqual(['office', 'home']);

    const rewritten = [
      { ...a, tags: ['office'], updatedAt: 1000, deviceId: 'REPO-DEVICE' },
      { ...b, tags: ['office', 'home'], updatedAt: 1000, deviceId: 'REPO-DEVICE' },
    ];
    await h.tick(); // the serialized write reaches the port on the microtask queue
    h.rec.succeed(rewritten);
    const result = await pending;
    expect(result.ok).toBe(true);
    // Authoritative swap: repo stamps win.
    expect(h.runner.getState().tasks.get('A')?.deviceId).toBe('REPO-DEVICE');
    // Bulk op announces 'all' (ADR-003 Decision 8.1 sender rule 2).
    expect(h.committed).toEqual(['all']);
    await h.tick();
  });

  it('rolls back to the committed baseline when the sweep write fails', async () => {
    const h = makeRunner();
    const a = makeTaskRow({ id: 'A', tags: ['work'], updatedAt: 7 });
    await h.baselined([a]);

    const pending = h.runner.renameTag('work', 'office');
    expect(h.runner.getState().tasks.get('A')?.tags).toEqual(['office']);

    const failure: AppError = { code: 'TX_ABORTED', cause: new Error('boom') };
    await h.tick();
    h.rec.fail(failure);
    const result = await pending;
    expect(result.ok).toBe(false);
    // Exact committed image restored — never a provisional one.
    expect(h.runner.getState().tasks.get('A')?.tags).toEqual(['work']);
    expect(h.runner.getState().tasks.get('A')?.updatedAt).toBe(7);
    expect(h.events.some((ev) => ev.kind === 'write-failed')).toBe(true);
    expect(h.committed).toEqual([]);
    await h.tick();
  });

  it('deleteTag removes the name everywhere', async () => {
    const h = makeRunner();
    await h.baselined([
      makeTaskRow({ id: 'A', tags: ['work', 'home'] }),
      makeTaskRow({ id: 'B', tags: ['work'] }),
    ]);
    const pending = h.runner.deleteTag('work');
    expect(h.runner.getState().tasks.get('A')?.tags).toEqual(['home']);
    expect(h.runner.getState().tasks.get('B')?.tags).toEqual([]);
    await h.tick();
    h.rec.succeed([
      { ...makeTaskRow({ id: 'A', tags: ['home'] }) },
      { ...makeTaskRow({ id: 'B', tags: [] }) },
    ]);
    expect((await pending).ok).toBe(true);
    await h.tick();
  });

  it('rejects invalid tag names with RULE TAG_INVALID and never writes', async () => {
    const h = makeRunner();
    await h.baselined([makeTaskRow({ id: 'A', tags: ['work'] })]);
    const empty = await h.runner.renameTag('work', '   ');
    expect(empty).toEqual({
      ok: false,
      error: ruleError('TAG_INVALID', 'tag names are 1..100 chars'),
    });
    const oversized = await h.runner.renameTag('x'.repeat(101), 'y');
    expect(oversized.ok).toBe(false);
    // No write was ever issued.
    expect(h.rec.writes).toEqual([]);
    await h.tick();
  });
});

describe('MutationRunner.removeTask — S2 disposition', () => {
  it('cascade evicts the task and its direct subtasks together', async () => {
    const h = makeRunner();
    const parent = makeTaskRow({ id: 'P', title: 'parent' });
    const child = makeTaskRow({ id: 'C', parentTaskId: 'P' });
    await h.baselined([parent, child]);

    const pending = h.runner.removeTask('P', { mode: 'cascade' });
    expect(h.runner.getState().tasks.has('P')).toBe(false);
    expect(h.runner.getState().tasks.has('C')).toBe(false);

    await h.tick();
    h.rec.succeed({
      tombstoned: [
        { ...parent, deletedAt: 1000 },
        { ...child, deletedAt: 1000 },
      ],
      promoted: [],
    });
    expect((await pending).ok).toBe(true);
    expect(h.committed).toEqual([{ tasks: ['P', 'C'] }]);
    await h.tick();
  });

  it('promote re-parents subtasks to the list top level (optimistic + authoritative)', async () => {
    const h = makeRunner();
    const parent = makeTaskRow({ id: 'P', title: 'parent' });
    const child = makeTaskRow({ id: 'C', parentTaskId: 'P', sortOrder: 'h' });
    await h.baselined([parent, child]);

    const pending = h.runner.removeTask('P', { mode: 'promote' });
    const optimisticChild = h.runner.getState().tasks.get('C');
    expect(optimisticChild?.parentTaskId).toBeUndefined();
    expect(optimisticChild?.deviceId).toBe('THIS-TAB');
    expect(h.runner.getState().tasks.has('P')).toBe(false);

    const authoritativeChild: Task = {
      ...child,
      updatedAt: 1000,
      deviceId: 'REPO-DEVICE',
    };
    delete (authoritativeChild as { parentTaskId?: string }).parentTaskId;
    await h.tick();
    h.rec.succeed({
      tombstoned: [{ ...parent, deletedAt: 1000 }],
      promoted: [authoritativeChild],
    });
    expect((await pending).ok).toBe(true);
    const settledChild = h.runner.getState().tasks.get('C');
    expect(settledChild?.parentTaskId).toBeUndefined();
    expect(settledChild?.deviceId).toBe('REPO-DEVICE');
    await h.tick();
  });

  it('rolls a failed promote back to the parented committed image', async () => {
    const h = makeRunner();
    const parent = makeTaskRow({ id: 'P' });
    const child = makeTaskRow({ id: 'C', parentTaskId: 'P', sortOrder: 'h' });
    await h.baselined([parent, child]);

    const pending = h.runner.removeTask('P', { mode: 'promote' });
    await h.tick();
    h.rec.fail({ code: 'TX_ABORTED', cause: new Error('boom') });
    expect((await pending).ok).toBe(false);
    expect(h.runner.getState().tasks.get('P')?.title).toBe(parent.title);
    expect(h.runner.getState().tasks.get('C')?.parentTaskId).toBe('P');
    await h.tick();
  });
});

describe('selectView — S1 tag filter', () => {
  function stateOf(tasks: Task[]): State {
    const base = emptyState();
    return {
      ...base,
      tasks: new Map(tasks.map((t) => [t.id, t])),
      lists: new Map([['L1', makeListRow({ id: 'L1' })]]),
    };
  }

  it('keeps only tasks carrying the tag', () => {
    const state = stateOf([
      makeTaskRow({ id: 'A', listId: 'L1', tags: ['work'] }),
      makeTaskRow({ id: 'B', listId: 'L1', tags: ['home'] }),
    ]);
    const rows = selectView(
      state,
      { kind: 'list', listId: 'L1' },
      { today: '2026-10-26', tag: 'work' },
    );
    const ids = rows.rows.flatMap((r) => (r.type === 'task' ? [r.task.id] : []));
    expect(ids).toEqual(['A']);
  });

  it('renders a matching subtask whose parent is filtered out at depth 0 (never dropped)', () => {
    const state = stateOf([
      makeTaskRow({ id: 'P', listId: 'L1', tags: ['home'], sortOrder: 'h' }),
      makeTaskRow({ id: 'C', listId: 'L1', tags: ['work'], parentTaskId: 'P', sortOrder: 'i' }),
    ]);
    const rows = selectView(
      state,
      { kind: 'list', listId: 'L1' },
      { today: '2026-10-26', tag: 'work' },
    );
    const taskRows = rows.rows.flatMap((r) => (r.type === 'task' ? [r] : []));
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0]?.task.id).toBe('C');
    expect(taskRows[0]?.depth).toBe(0);
  });
});

describe('selectView — S3 sorting per priority level', () => {
  function stateOf(tasks: Task[]): State {
    const base = emptyState();
    return {
      ...base,
      tasks: new Map(tasks.map((t) => [t.id, t])),
      lists: new Map([['L1', makeListRow({ id: 'L1' })]]),
    };
  }

  it('compareByPriority orders P1 first … P4 last', () => {
    const levels: Priority[] = ['P3', 'P1', 'P4', 'P2'];
    expect([...levels].sort(compareByPriority)).toEqual(['P1', 'P2', 'P3', 'P4']);
  });

  it('sortBy: priority is the PRIMARY key inside a group; default keeps manual order', () => {
    const tasks = [
      makeTaskRow({ id: 'A', listId: 'L1', priority: 'P4', sortOrder: 'h' }),
      makeTaskRow({ id: 'B', listId: 'L1', priority: 'P1', sortOrder: 'i' }),
      makeTaskRow({ id: 'C', listId: 'L1', priority: 'P2', sortOrder: 'j' }),
    ];
    const state = stateOf(tasks);

    const manual = selectView(state, { kind: 'list', listId: 'L1' }, { today: '2026-10-26' });
    expect(manual.rows.flatMap((r) => (r.type === 'task' ? [r.task.id] : []))).toEqual([
      'A',
      'B',
      'C',
    ]);

    const sorted = selectView(
      state,
      { kind: 'list', listId: 'L1' },
      { today: '2026-10-26', sortBy: 'priority' },
    );
    expect(sorted.rows.flatMap((r) => (r.type === 'task' ? [r.task.id] : []))).toEqual([
      'B',
      'C',
      'A',
    ]);
  });

  it('keeps subtasks nested under their parent under priority sort', () => {
    const state = stateOf([
      makeTaskRow({ id: 'P', listId: 'L1', priority: 'P4', sortOrder: 'h' }),
      makeTaskRow({
        id: 'C',
        listId: 'L1',
        priority: 'P1',
        parentTaskId: 'P',
        sortOrder: 'i',
      }),
      makeTaskRow({ id: 'X', listId: 'L1', priority: 'P2', sortOrder: 'j' }),
    ]);
    const rows = selectView(
      state,
      { kind: 'list', listId: 'L1' },
      { today: '2026-10-26', sortBy: 'priority' },
    );
    const taskRows = rows.rows.flatMap((r) => (r.type === 'task' ? [r] : []));
    // X (P2) sorts before the P4 parent, and C renders at depth 1 under P.
    expect(taskRows.map((r) => [r.task.id, r.depth])).toEqual([
      ['X', 0],
      ['P', 0],
      ['C', 1],
    ]);
  });
});
