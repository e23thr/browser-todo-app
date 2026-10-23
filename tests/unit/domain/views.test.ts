/**
 * View-model golden tests (ADR-003 Decision 5, mirroring ux-foundation
 * §4.3–4.8): group shapes, ordering, empty-group omission, subtask nesting,
 * all-day boundaries and the midnight-rollover case.
 */
import { describe, expect, it } from 'vitest';

import { applyOptimistic, emptyState, type State } from '../../../src/domain/state';
import type { Task } from '../../../src/domain/model';
import { SearchIndex } from '../../../src/domain/search';
import { selectView, type ViewRow } from '../../../src/domain/views';
import { makeList, makeSettings, makeTask, T0 } from './fixtures';

const TODAY = '2026-10-23';

function stateWith(
  tasks: Task[],
  lists = [makeList({ id: 'L1', name: 'Inbox', sortOrder: 'h' })],
): State {
  return applyOptimistic(emptyState(), {
    tasks,
    lists,
    settings: makeSettings(),
  }).next;
}

function taskRows(rows: ViewRow[]): Task[] {
  return rows
    .filter((r): r is Extract<ViewRow, { type: 'task' }> => r.type === 'task')
    .map((r) => r.task);
}

function groupLabels(rows: ViewRow[]): string[] {
  return rows
    .filter((r): r is Extract<ViewRow, { type: 'group' }> => r.type === 'group')
    .map((r) => (r.label.kind === 'day' ? `day:${r.label.date}` : r.label.kind));
}

describe('views: Today (§4.3)', () => {
  const tasks = [
    makeTask({
      id: 'A1',
      listId: 'L1',
      title: 'overdue-old',
      dueDate: '2026-10-20',
      createdAt: T0 + 1,
    }),
    makeTask({
      id: 'A2',
      listId: 'L1',
      title: 'overdue-yesterday',
      dueDate: '2026-10-22',
      createdAt: T0,
    }),
    makeTask({ id: 'A3', listId: 'L1', title: 'due-today', dueDate: TODAY, createdAt: T0 + 5 }),
    makeTask({ id: 'A4', listId: 'L1', title: 'due-tomorrow', dueDate: '2026-10-24' }),
    makeTask({ id: 'A5', listId: 'L1', title: 'no-date' }),
    makeTask({
      id: 'A6',
      listId: 'L1',
      title: 'done-today',
      dueDate: TODAY,
      status: 'done',
      completedAt: T0,
    }),
  ];
  const result = selectView(stateWith(tasks), { kind: 'today' }, { today: TODAY });

  it('shows exactly the Overdue + Today groups with counts', () => {
    expect(groupLabels(result.rows)).toEqual(['overdue', `day:${TODAY}`]);
    expect(result.rows[0]).toMatchObject({ type: 'group', count: 2 });
    expect(result.rows[3]).toMatchObject({ type: 'group', count: 1 });
  });

  it('membership = open tasks due < today or === today; sorts (dueDate, createdAt, id)', () => {
    expect(taskRows(result.rows).map((t) => t.id)).toEqual(['A1', 'A2', 'A3']);
  });

  it('counts = N open (incl. overdue) and M overdue', () => {
    expect(result.counts).toEqual({ open: 3, overdue: 2 });
  });

  it('marks overdue rows with the overdue flag', () => {
    const rows = result.rows.filter((r) => r.type === 'task');
    expect(rows.map((r) => r.flags.overdue)).toEqual([true, true, false]);
  });

  it("midnight rollover: yesterday's due-today becomes overdue when today advances", () => {
    const one = stateWith([makeTask({ id: 'R1', listId: 'L1', dueDate: '2026-10-22' })]);
    const before = selectView(one, { kind: 'today' }, { today: '2026-10-22' });
    expect(groupLabels(before.rows)).toEqual([`day:2026-10-22`]);
    const after = selectView(one, { kind: 'today' }, { today: TODAY });
    expect(groupLabels(after.rows)).toEqual(['overdue']);
    expect(after.counts).toEqual({ open: 1, overdue: 1 });
  });

  it('renders nothing when no tasks are due', () => {
    const empty = selectView(
      stateWith([makeTask({ id: 'N1', listId: 'L1' })]),
      { kind: 'today' },
      { today: TODAY },
    );
    expect(empty.rows).toEqual([]);
  });
});

describe('views: Next 7 days (§4.4)', () => {
  const tasks = [
    makeTask({ id: 'W1', listId: 'L1', dueDate: TODAY, createdAt: T0 + 2 }),
    makeTask({ id: 'W2', listId: 'L1', dueDate: TODAY, createdAt: T0 }),
    makeTask({ id: 'W3', listId: 'L1', dueDate: '2026-10-25', createdAt: T0 }),
    makeTask({ id: 'W4', listId: 'L1', dueDate: '2026-10-29', createdAt: T0 }), // day 6 (incl.)
    makeTask({ id: 'W5', listId: 'L1', dueDate: '2026-10-30', createdAt: T0 }), // day 7 — out
    makeTask({ id: 'W6', listId: 'L1', dueDate: '2026-10-22', createdAt: T0 }), // past — out
  ];
  const result = selectView(stateWith(tasks), { kind: 'week' }, { today: TODAY });

  it('groups per day incl. today, empty day groups omitted', () => {
    expect(groupLabels(result.rows)).toEqual([`day:${TODAY}`, 'day:2026-10-25', 'day:2026-10-29']);
  });

  it('within a day sorts (createdAt, id) and boundaries are inclusive', () => {
    expect(taskRows(result.rows).map((t) => t.id)).toEqual(['W2', 'W1', 'W3', 'W4']);
    expect(result.counts).toEqual({ open: 4, overdue: 0 });
  });
});

describe('views: All open (§4.5)', () => {
  const lists = [
    makeList({ id: 'L1', name: 'Inbox', sortOrder: 'h' }),
    makeList({ id: 'L2', name: 'Work', sortOrder: 'n' }),
    makeList({ id: 'L3', name: 'Empty', sortOrder: 'z' }),
  ];
  const tasks = [
    makeTask({ id: 'T1', listId: 'L2', sortOrder: 'h' }),
    makeTask({ id: 'T2', listId: 'L1', sortOrder: 'h' }),
    makeTask({ id: 'T3', listId: 'L1', sortOrder: 'n' }),
    makeTask({ id: 'T4', listId: 'L1', sortOrder: 'j', parentTaskId: 'T2' }),
  ];
  const result = selectView(stateWith(tasks, lists), { kind: 'allOpen' }, { today: TODAY });

  it('groups by list in list order, empty list groups omitted', () => {
    expect(groupLabels(result.rows)).toEqual(['list', 'list']);
    expect(result.rows[0]).toMatchObject({
      type: 'group',
      label: { kind: 'list', listId: 'L1' },
      count: 3,
    });
  });

  it('manual (sortOrder, id) order within a list; subtask nested at depth 1', () => {
    const flat = result.rows.filter((r) => r.type === 'task');
    expect(flat.map((r) => [r.task.id, r.depth])).toEqual([
      ['T2', 0],
      ['T4', 1],
      ['T3', 0],
      ['T1', 0],
    ]);
  });
});

describe('views: List (§4.6)', () => {
  const tasks = [
    makeTask({ id: 'T1', listId: 'L1', sortOrder: 'h' }),
    makeTask({ id: 'T2', listId: 'L1', sortOrder: 'n' }),
    makeTask({ id: 'T3', listId: 'L1', sortOrder: 'j', parentTaskId: 'T1' }),
    makeTask({
      id: 'T4',
      listId: 'L1',
      sortOrder: 'k',
      parentTaskId: 'T1',
      status: 'done',
      completedAt: T0,
    }),
    makeTask({ id: 'T5', listId: 'L2', sortOrder: 'a' }),
    makeTask({ id: 'T6', listId: 'L1', sortOrder: '0', parentTaskId: 'T1' }),
  ];
  const result = selectView(stateWith(tasks), { kind: 'list', listId: 'L1' }, { today: TODAY });

  it('flat manual order with one level of nesting; done tasks excluded', () => {
    const flat = result.rows.filter((r) => r.type === 'task');
    expect(flat.map((r) => [r.task.id, r.depth])).toEqual([
      ['T1', 0],
      ['T6', 1],
      ['T3', 1],
      ['T2', 0],
    ]);
  });

  it('tasks whose list is missing are excluded from every view', () => {
    const orphan = stateWith([makeTask({ id: 'O1', listId: 'GONE', sortOrder: 'h' })], []);
    expect(selectView(orphan, { kind: 'allOpen' }, { today: TODAY }).rows).toEqual([]);
    expect(selectView(orphan, { kind: 'list', listId: 'GONE' }, { today: TODAY }).rows).toEqual([]);
    expect(selectView(orphan, { kind: 'today' }, { today: TODAY }).rows).toEqual([]);
  });
});

describe('views: Completed (§4.7)', () => {
  const tasks = [
    makeTask({ id: 'C1', listId: 'L1', status: 'done', completedAt: T0 + 100 }),
    makeTask({ id: 'C2', listId: 'L1', status: 'done', completedAt: T0 + 300 }),
    makeTask({ id: 'C3', listId: 'L1', status: 'done', completedAt: T0 + 100 }),
    makeTask({ id: 'C4', listId: 'L1' }),
  ];
  const result = selectView(stateWith(tasks), { kind: 'completed' }, { today: TODAY });

  it('is flat and sorted by completedAt desc, id desc', () => {
    expect(groupLabels(result.rows)).toEqual([]);
    expect(taskRows(result.rows).map((t) => t.id)).toEqual(['C2', 'C3', 'C1']);
  });
});

describe('views: Search (§4.8)', () => {
  const tasks = [
    makeTask({ id: 'S1', listId: 'L1', title: 'buy milk', updatedAt: T0 + 1 }),
    makeTask({ id: 'S2', listId: 'L1', title: 'buy bread', updatedAt: T0 + 5 }),
    makeTask({ id: 'S3', listId: 'L1', title: 'nothing', notes: 'buy stamps', updatedAt: T0 + 9 }),
    makeTask({ id: 'S4', listId: 'L1', title: 'nomatch', updatedAt: T0 }),
  ];
  const index = new SearchIndex();
  index.build(tasks);

  it('returns one Results group with ranked rows (rank, updatedAt desc, id desc)', () => {
    const result = selectView(
      stateWith(tasks),
      { kind: 'search', query: 'buy' },
      { today: TODAY, index },
    );
    expect(groupLabels(result.rows)).toEqual(['results']);
    expect(taskRows(result.rows).map((t) => t.id)).toEqual(['S2', 'S1', 'S3']);
    expect(result.counts.open).toBe(3);
  });

  it('falls back to the naive scanner when no index is supplied', () => {
    const result = selectView(
      stateWith(tasks),
      { kind: 'search', query: 'milk' },
      { today: TODAY },
    );
    expect(taskRows(result.rows).map((t) => t.id)).toEqual(['S1']);
  });

  it('renders no rows for a no-match query', () => {
    const result = selectView(
      stateWith(tasks),
      { kind: 'search', query: 'zzz' },
      { today: TODAY, index },
    );
    expect(result.rows).toEqual([]);
  });
});

describe('views: orphaned subtask after a parent list move (domain-api §10 note 2)', () => {
  function depths(rows: ViewRow[]): [string, number][] {
    return rows
      .filter((r): r is Extract<ViewRow, { type: 'task' }> => r.type === 'task')
      .map((r) => [r.task.id, r.depth]);
  }

  it('renders the left-behind subtask at depth 0 in the old list', () => {
    const state = stateWith(
      [
        makeTask({ id: 'P1', listId: 'L2', createdAt: T0 }),
        makeTask({ id: 'S1', listId: 'L1', parentTaskId: 'P1', createdAt: T0 + 1 }),
      ],
      [
        makeList({ id: 'L1', name: 'Inbox', sortOrder: 'h' }),
        makeList({ id: 'L2', name: 'Work', sortOrder: 'i' }),
      ],
    );
    const inOld = selectView(state, { kind: 'list', listId: 'L1' }, { today: TODAY });
    expect(depths(inOld.rows)).toEqual([['S1', 0]]); // parent is not a member of L1
    const inNew = selectView(state, { kind: 'list', listId: 'L2' }, { today: TODAY });
    expect(depths(inNew.rows)).toEqual([['P1', 0]]); // the parent moved alone
  });
});
