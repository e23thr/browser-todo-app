/**
 * S6 retention partition (E9) — the completed view's domain contract:
 * members = done ∪ archived, bucketed into `retention recent ≤7d` /
 * `retention older` / `archived` groups (empty groups omitted), the pinned
 * `completedAt` desc / id desc order kept INSIDE every bucket, rows flat at
 * depth 0 (the partition must never widen the virtualized DOM-row cap).
 */
import { describe, expect, it } from 'vitest';

import { todayStr } from '../../../src/domain/dates';
import { applyOptimistic, emptyState, type State } from '../../../src/domain/state';
import type { Task } from '../../../src/domain/model';
import {
  RETENTION_RECENT_DAYS,
  selectView,
  type ViewId,
  type ViewRow,
} from '../../../src/domain/views';
import { makeList, makeSettings, makeTask } from './fixtures';

const TODAY = '2026-10-23';

/** Local-noon epoch ms for a calendar day label (DST-safe in any test TZ). */
function noonOf(dateStr: string): number {
  const year = Number(dateStr.slice(0, 4));
  const month = Number(dateStr.slice(5, 7));
  const day = Number(dateStr.slice(8, 10));
  return new Date(year, month - 1, day, 12).getTime();
}

function stateWith(tasks: Task[], lists = [makeList({ id: 'L1', sortOrder: 'h' })]): State {
  return applyOptimistic(emptyState(), { tasks, lists, settings: makeSettings() }).next;
}

function completed(tasks: Task[], today = TODAY): ViewResult_ {
  return selectView(stateWith(tasks), { kind: 'completed' }, { today });
}

type ViewResult_ = ReturnType<typeof selectView>;

function labels(rows: ViewRow[]): string[] {
  return rows
    .filter((r): r is Extract<ViewRow, { type: 'group' }> => r.type === 'group')
    .map((r) => (r.label.kind === 'retention' ? `retention:${r.label.bucket}` : r.label.kind));
}

function ids(rows: ViewRow[]): string[] {
  return rows
    .filter((r): r is Extract<ViewRow, { type: 'task' }> => r.type === 'task')
    .map((r) => r.task.id);
}

describe('S6 retention partition: membership', () => {
  it('members are done ∪ archived; open and tombstoned rows never render', () => {
    const result = completed([
      makeTask({ id: 'D1', listId: 'L1', status: 'done', completedAt: noonOf(TODAY) }),
      makeTask({ id: 'A1', listId: 'L1', status: 'archived', completedAt: noonOf(TODAY) }),
      makeTask({ id: 'O1', listId: 'L1', status: 'open' }),
      makeTask({
        id: 'X1',
        listId: 'L1',
        status: 'done',
        completedAt: noonOf(TODAY),
        deletedAt: 5,
      }),
    ]);
    expect(ids(result.rows)).toEqual(['D1', 'A1']);
  });

  it('a done/archived row whose list is gone stays excluded (ADR-002 D6)', () => {
    const result = completed([
      makeTask({ id: 'O1', listId: 'GONE', status: 'done', completedAt: noonOf(TODAY) }),
    ]);
    expect(result.rows).toEqual([]);
  });
});

describe('S6 retention partition: buckets', () => {
  it('splits recent (completed within 7 days, boundary inclusive) / older / archived in that order', () => {
    expect(RETENTION_RECENT_DAYS).toBe(7);
    const recentEdge = makeTask({
      id: 'R-edge',
      listId: 'L1',
      status: 'done',
      completedAt: noonOf('2026-10-16'), // exactly today - 7 days
    });
    const olderEdge = makeTask({
      id: 'O-edge',
      listId: 'L1',
      status: 'done',
      completedAt: noonOf('2026-10-15'), // today - 8 days
    });
    const recent = makeTask({
      id: 'R1',
      listId: 'L1',
      status: 'done',
      completedAt: noonOf('2026-10-23'),
    });
    const archived = makeTask({
      id: 'A1',
      listId: 'L1',
      status: 'archived',
      completedAt: noonOf('2026-10-22'),
    });
    const result = completed([olderEdge, archived, recentEdge, recent]);
    expect(labels(result.rows)).toEqual(['retention:recent', 'retention:older', 'archived']);
    // Order inside each bucket stays completedAt desc / id desc.
    expect(ids(result.rows)).toEqual(['R1', 'R-edge', 'O-edge', 'A1']);
  });

  it('omits empty buckets (a recent-only history renders ONE group)', () => {
    const result = completed([
      makeTask({ id: 'R1', listId: 'L1', status: 'done', completedAt: noonOf(TODAY) }),
    ]);
    expect(labels(result.rows)).toEqual(['retention:recent']);
  });

  it('an archived row lands in the ARCHIVED bucket regardless of how recent it is', () => {
    const archivedToday = makeTask({
      id: 'A1',
      listId: 'L1',
      status: 'archived',
      completedAt: noonOf(TODAY),
    });
    const result = completed([archivedToday]);
    expect(labels(result.rows)).toEqual(['archived']);
    expect(ids(result.rows)).toEqual(['A1']);
  });

  it('a done row with NO completedAt sorts last inside the older bucket', () => {
    const unstamped = makeTask({ id: 'D-plain', listId: 'L1', status: 'done' });
    const stamped = makeTask({
      id: 'D-old',
      listId: 'L1',
      status: 'done',
      completedAt: noonOf('2025-01-01'),
    });
    const result = completed([unstamped, stamped]);
    expect(labels(result.rows)).toEqual(['retention:older']);
    expect(ids(result.rows)).toEqual(['D-old', 'D-plain']);
  });

  it('the bucket edge is day-granular in LOCAL time, not a UTC instant', () => {
    // A completion at 23:30 LOCAL yesterday must count as yesterday's day
    // label (older when that crosses the 7-day edge) — the same local-day rule
    // `todayStr` applies everywhere else in the domain.
    const yesterday = noonOf('2026-10-22') + 11.5 * 60 * 60 * 1000; // 23:30 local
    expect(todayStr(() => yesterday)).toBe('2026-10-22');
    const result = completed([
      makeTask({ id: 'R1', listId: 'L1', status: 'done', completedAt: yesterday }),
    ]);
    expect(labels(result.rows)).toEqual(['retention:recent']); // inside 7d either way
  });
});

describe('S6 retention partition: shape invariants', () => {
  it('rows stay flat (depth 0) and counts report no open/overdue members', () => {
    const result = completed([
      makeTask({
        id: 'C1',
        listId: 'L1',
        status: 'done',
        completedAt: noonOf(TODAY),
      }),
      makeTask({
        id: 'C2',
        listId: 'L1',
        status: 'done',
        completedAt: noonOf(TODAY),
        parentTaskId: 'C1',
      }),
      makeTask({ id: 'A1', listId: 'L1', status: 'archived', completedAt: noonOf(TODAY) }),
    ]);
    // Even a parent+child done pair renders FLAT here (retention is a
    // partition, not a tree view) — the DOM-row cap math depends on it.
    const depths = result.rows
      .filter((r): r is Extract<ViewRow, { type: 'task' }> => r.type === 'task')
      .map((r) => r.depth);
    expect(depths).toEqual([0, 0, 0]);
    expect(result.counts).toEqual({ open: 0, overdue: 0 });
  });

  it('other views are untouched: the archived row renders in none of them', () => {
    const tasks = [
      makeTask({ id: 'A1', listId: 'L1', status: 'archived', completedAt: noonOf(TODAY) }),
      makeTask({ id: 'O1', listId: 'L1', status: 'open' }),
    ];
    const state = stateWith(tasks);
    const views: ViewId[] = [
      { kind: 'today' },
      { kind: 'week' },
      { kind: 'allOpen' },
      { kind: 'list', listId: 'L1' },
    ];
    for (const view of views) {
      expect(ids(selectView(state, view, { today: TODAY }).rows)).not.toContain('A1');
    }
  });
});
