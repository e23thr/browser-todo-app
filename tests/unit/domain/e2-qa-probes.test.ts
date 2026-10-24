/**
 * E2 domain-core QA probes (test card t_7080a238) — INDEPENDENT re-verification
 * of the binding behaviors, written from the acceptance criteria in
 * PROJECT_ANALYSIS §5.2/§6.2/§9.1/§10 rather than from the implementation's own
 * test narratives. Includes the recorded benchmarks (search@10k, domain
 * boot@10k, add→visible perceived latency) consumed by docs/qa/e2-domain.md.
 *
 * Characterization note: `DEFECT D1` below documents observed (buggy) behavior
 * on purpose — see docs/qa/e2-domain.md. When D1 is fixed that probe flips.
 */
import { describe, expect, it } from 'vitest';

import { compareLww, conflictCopyTitle, CONFLICT_COPY_PREFIX } from '../../../src/domain/merge';
import {
  addDays,
  isOverdue,
  isWithinNext7,
  msUntilNextLocalMidnight,
  todayStr,
} from '../../../src/domain/dates';
import { MutationRunner } from '../../../src/domain/pipeline';
import { SearchIndex, type SearchableTask } from '../../../src/domain/search';
import { applyOptimistic, emptyState, type State } from '../../../src/domain/state';
import type { Task } from '../../../src/domain/model';
import { selectView, type ViewRow } from '../../../src/domain/views';
import {
  FakeListPort,
  FakeRecorder,
  FakeSettingsPort,
  FakeTaskPort,
  flushMicrotasks,
  makeTaskRow,
} from './fakes';
import { makeList, makeSettings, makeTask, T0 } from './fixtures';
import { orderKeyBetween, orderKeyFirst } from '../../../src/storage/orderKey';

const TODAY = '2026-10-23';

function stateWith(
  tasks: Task[],
  lists = [makeList({ id: 'L1', name: 'Inbox', sortOrder: 'h' })],
): State {
  return applyOptimistic(emptyState(), { tasks, lists, settings: makeSettings() }).next;
}

function taskRows(rows: ViewRow[]): Task[] {
  return rows
    .filter((r): r is Extract<ViewRow, { type: 'task' }> => r.type === 'task')
    .map((r) => r.task);
}

function rowShape(rows: ViewRow[]): string[] {
  return rows.map((r) =>
    r.type === 'task' ? `${r.task.id}:${String(r.depth)}` : `group:${r.label.kind}`,
  );
}

/* ------------------------------------------------------------------ */
/* LWW (§6.2: per-record last-write-wins keyed on (updatedAt, deviceId)) */
/* ------------------------------------------------------------------ */

describe('QA: LWW conflict policy (§6.2)', () => {
  it('greater updatedAt beats ANY deviceId; ties break on lexicographic deviceId', () => {
    // updatedAt dominance over a "winning" deviceId.
    expect(
      compareLww({ updatedAt: T0 + 1, deviceId: 'aaa' }, { updatedAt: T0, deviceId: 'zzz' }),
    ).toBeGreaterThan(0);
    // Tie-break: greater deviceId wins, case-sensitive lexicographic.
    expect(
      compareLww({ updatedAt: T0, deviceId: 'dev-b' }, { updatedAt: T0, deviceId: 'dev-a' }),
    ).toBeGreaterThan(0);
    expect(
      compareLww({ updatedAt: T0, deviceId: 'Dev-Z' }, { updatedAt: T0, deviceId: 'dev-a' }),
    ).toBeLessThan(0);
  });

  it('sorting a device set is a deterministic total order (same result either direction)', () => {
    const stamps = [
      { updatedAt: T0, deviceId: 'dev-b' },
      { updatedAt: T0 + 5, deviceId: 'dev-a' },
      { updatedAt: T0, deviceId: 'dev-a' },
      { updatedAt: T0 + 5, deviceId: 'dev-b' },
      { updatedAt: T0 - 1, deviceId: 'zzz' },
    ];
    const fwd = [...stamps].sort((a, b) => compareLww(a, b));
    const rev = [...stamps].reverse().sort((a, b) => compareLww(a, b));
    expect(fwd.map((s) => [s.updatedAt, s.deviceId])).toEqual(
      rev.map((s) => [s.updatedAt, s.deviceId]),
    );
    // Winner = greatest (updatedAt, deviceId).
    expect(fwd[fwd.length - 1]).toEqual({ updatedAt: T0 + 5, deviceId: 'dev-b' });
  });

  it('conflict-copy title keeps the §6.2 wording and caps at 1000 chars', () => {
    expect(conflictCopyTitle('Buy milk')).toBe(`${CONFLICT_COPY_PREFIX}Buy milk`);
    const capped = conflictCopyTitle('x'.repeat(2000));
    expect(capped.length).toBe(1000);
    expect(capped.startsWith(CONFLICT_COPY_PREFIX)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* View models: Today / Next 7 / All open / per-list / Completed       */
/* ------------------------------------------------------------------ */

describe('QA: view-model boundary dates (§4.3–4.7)', () => {
  it('Today: overdue|due-today only; tomorrow, no-date, done and archived are absent', () => {
    const tasks = [
      makeTask({ id: 'T1', listId: 'L1', dueDate: '2026-10-22', createdAt: T0 + 1 }), // yesterday -> overdue
      makeTask({ id: 'T2', listId: 'L1', dueDate: TODAY, createdAt: T0 }), // today
      makeTask({ id: 'T3', listId: 'L1', dueDate: '2026-10-24', createdAt: T0 + 2 }), // tomorrow
      makeTask({ id: 'T4', listId: 'L1', createdAt: T0 + 3 }), // no date
      makeTask({ id: 'T5', listId: 'L1', dueDate: TODAY, status: 'done', completedAt: T0 }), // done today
      makeTask({ id: 'T6', listId: 'L1', dueDate: TODAY, status: 'archived' }), // archived
    ];
    const v = selectView(stateWith(tasks), { kind: 'today' }, { today: TODAY });
    expect(taskRows(v.rows).map((t) => t.id)).toEqual(['T1', 'T2']);
    expect(v.counts).toEqual({ open: 2, overdue: 1 });
    expect(rowShape(v.rows)[0]).toBe('group:overdue');
  });

  it('Next 7: window is [today, today+6] inclusive at BOTH edges, across a year boundary', () => {
    const today = '2026-12-29'; // window: 2026-12-29 .. 2027-01-04
    const tasks = [
      makeTask({ id: 'W1', listId: 'L1', dueDate: '2026-12-28' }), // before window
      makeTask({ id: 'W2', listId: 'L1', dueDate: '2026-12-29' }), // first day
      makeTask({ id: 'W3', listId: 'L1', dueDate: '2027-01-04' }), // last day
      makeTask({ id: 'W4', listId: 'L1', dueDate: '2027-01-05' }), // past window
    ];
    const v = selectView(stateWith(tasks), { kind: 'week' }, { today });
    expect(taskRows(v.rows).map((t) => t.id)).toEqual(['W2', 'W3']);
    const groups = v.rows.filter(
      (r): r is Extract<ViewRow, { type: 'group' }> => r.type === 'group',
    );
    // Empty day groups are omitted — only the two days with tasks have headers.
    expect(groups.map((g) => (g.label.kind === 'day' ? g.label.date : ''))).toEqual([
      '2026-12-29',
      '2027-01-04',
    ]);
  });

  it('Next 7 across a leap-year February: 2028-02-28 + 1 day is 2028-02-29', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    const today = '2028-02-26'; // window .. 2028-03-03
    const tasks = [
      makeTask({ id: 'L1x', listId: 'L1', dueDate: '2028-03-03' }), // inside (leap span)
      makeTask({ id: 'L2x', listId: 'L1', dueDate: '2028-03-04' }), // outside
    ];
    const v = selectView(stateWith(tasks), { kind: 'week' }, { today });
    expect(taskRows(v.rows).map((t) => t.id)).toEqual(['L1x']);
  });

  it('All open: grouped per live list in manual (sortOrder, id) order; done/archived/tombstoned excluded', () => {
    const lists = [
      makeList({ id: 'L1', name: 'Work', sortOrder: 'h' }),
      makeList({ id: 'L2', name: 'Home', sortOrder: 'm' }),
    ];
    const tasks = [
      makeTask({ id: 'A1', listId: 'L1', sortOrder: 'm' }),
      makeTask({ id: 'A2', listId: 'L1', sortOrder: 'h' }),
      makeTask({ id: 'A3', listId: 'L2', sortOrder: 'h' }),
      makeTask({ id: 'A4', listId: 'L1', sortOrder: 'a', status: 'done', completedAt: T0 }),
      makeTask({ id: 'A5', listId: 'L1', sortOrder: 'b', status: 'archived' }),
      makeTask({ id: 'A6', listId: 'L1', sortOrder: 'c', deletedAt: T0 }),
    ];
    const v = selectView(stateWith(tasks, lists), { kind: 'allOpen' }, { today: TODAY });
    expect(rowShape(v.rows)).toEqual(['group:list', 'A2:0', 'A1:0', 'group:list', 'A3:0']);
  });

  it('per-list: manual order, one nesting level; Completed: completedAt desc with id tiebreak', () => {
    const tasks = [
      makeTask({ id: 'P1', listId: 'L1', sortOrder: 'm' }),
      makeTask({ id: 'P2', listId: 'L1', sortOrder: 'h', parentTaskId: 'P1' }),
      makeTask({ id: 'P3', listId: 'L1', sortOrder: 'a' }),
    ];
    const list = selectView(stateWith(tasks), { kind: 'list', listId: 'L1' }, { today: TODAY });
    expect(rowShape(list.rows)).toEqual(['P3:0', 'P1:0', 'P2:1']);

    const done = [
      makeTask({ id: 'D1', listId: 'L1', status: 'done', completedAt: T0 + 10 }),
      makeTask({ id: 'D2', listId: 'L1', status: 'done', completedAt: T0 + 20 }),
      makeTask({ id: 'D3', listId: 'L1', status: 'done', completedAt: T0 + 20 }),
      makeTask({ id: 'D4', listId: 'L1', status: 'done' }), // done but completedAt missing
    ];
    const comp = selectView(stateWith(done), { kind: 'completed' }, { today: TODAY });
    // completedAt desc, then id DESC as tiebreak (D3 > D2), missing completedAt sorts last.
    expect(taskRows(comp.rows).map((t) => t.id)).toEqual(['D3', 'D2', 'D1', 'D4']);
  });

  it('subtask renders depth 1 only when its parent is in the SAME group (uniform rule)', () => {
    // Parent overdue (Overdue group), child due today (day group) -> child is depth 0.
    const tasks = [
      makeTask({ id: 'G1', listId: 'L1', dueDate: '2026-10-20', createdAt: T0 }),
      makeTask({ id: 'G2', listId: 'L1', dueDate: TODAY, parentTaskId: 'G1', createdAt: T0 + 1 }),
    ];
    const v = selectView(stateWith(tasks), { kind: 'today' }, { today: TODAY });
    expect(rowShape(v.rows)).toEqual(['group:overdue', 'G1:0', 'group:day', 'G2:0']);
  });

  it('DEFECT D1 (characterization): a depth-2 chain grandchild is silently DROPPED from tree-grouped views', () => {
    // Reachable via TaskPort.upsertImported (validateTask checks parentTaskId is
    // a ULID only — no depth rule), so a crafted/hostile import file can create
    // chains treeRows() never renders. The row survives in state and in Search
    // and Completed views, which are flat. See docs/qa/e2-domain.md D1.
    const tasks = [
      makeTask({ id: 'C1', listId: 'L1', sortOrder: 'h', createdAt: T0 }),
      makeTask({ id: 'C2', listId: 'L1', sortOrder: 'm', parentTaskId: 'C1', createdAt: T0 + 1 }),
      makeTask({ id: 'C3', listId: 'L1', sortOrder: 'n', parentTaskId: 'C2', createdAt: T0 + 2 }),
    ];
    const state = stateWith(tasks);
    const v = selectView(state, { kind: 'list', listId: 'L1' }, { today: TODAY });
    expect(rowShape(v.rows)).toEqual(['C1:0', 'C2:1']); // C3 missing — CURRENT (buggy) behavior
    // The same task IS visible in the flat views:
    const comp = selectView(
      applyOptimistic(emptyState(), {
        tasks: tasks.map((t) => ({ ...t, status: 'done' as const, completedAt: T0 })),
        lists: [makeList({ id: 'L1', sortOrder: 'h' })],
        settings: makeSettings(),
      }).next,
      { kind: 'completed' },
      { today: TODAY },
    );
    expect(taskRows(comp.rows).map((t) => t.id)).toContain('C3');
    expect(state.tasks.has('C3')).toBe(true); // never lost — just unrenderable in tree views
  });
});

/* ------------------------------------------------------------------ */
/* All-day dueDate semantics (§5.2/§10 E6: local label, no TZ math)    */
/* ------------------------------------------------------------------ */

describe('QA: all-day dueDate / timezone semantics (§10 E6)', () => {
  it('todayStr is the LOCAL calendar-day label — never the UTC label of toISOString', () => {
    // Two instants on either side of UTC midnight; at least one of them must
    // land on a different LOCAL day than its UTC day whenever the run timezone
    // is not UTC (this dev host runs UTC+07).
    const earlyUtc = Date.UTC(2026, 0, 15, 3, 0, 0);
    const lateUtc = Date.UTC(2026, 0, 15, 20, 0, 0);
    for (const instant of [earlyUtc, lateUtc]) {
      const local = new Date(instant);
      const expectedLocal = `${String(local.getFullYear()).padStart(4, '0')}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
      expect(todayStr(() => instant)).toBe(expectedLocal);
    }
    const utcLabel = (t: number): string => new Date(t).toISOString().slice(0, 10);
    const straddles = [earlyUtc, lateUtc].filter((t) => todayStr(() => t) !== utcLabel(t));
    // Regression guard for the E6 bug (toISOString flips "today" at UTC midnight):
    if (new Date(lateUtc).getTimezoneOffset() !== 0) {
      expect(straddles.length).toBeGreaterThan(0);
    }
  });

  it('day-rollover timer + label advance agree: todayStr(now + msUntilNextLocalMidnight) is tomorrow', () => {
    const instant = Date.UTC(2026, 5, 15, 9, 30, 0);
    const ms = msUntilNextLocalMidnight(() => instant);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    expect(todayStr(() => instant + ms)).toBe(
      addDays(
        todayStr(() => instant),
        1,
      ),
    );
  });

  it('overdue / next-7 are pure label comparisons at both boundaries', () => {
    const t = (due: string, status: 'open' | 'done' = 'open'): Task =>
      makeTask({ dueDate: due, status });
    expect(isOverdue(t('2026-10-22'), TODAY)).toBe(true);
    expect(isOverdue(t('2026-10-23'), TODAY)).toBe(false); // due today is NOT overdue
    expect(isOverdue(t('2026-10-22', 'done'), TODAY)).toBe(false); // done is never overdue
    expect(isWithinNext7(t(TODAY), TODAY)).toBe(true); // inclusive first edge
    expect(isWithinNext7(t(addDays(TODAY, 6)), TODAY)).toBe(true); // inclusive last edge
    expect(isWithinNext7(t(addDays(TODAY, 7)), TODAY)).toBe(false); // one past
    expect(isWithinNext7(t('2026-10-22'), TODAY)).toBe(false); // yesterday
  });
});

/* ------------------------------------------------------------------ */
/* Optimistic pipeline rollback (§6.1 / ADR-003 Decision 3)            */
/* ------------------------------------------------------------------ */

describe('QA: optimistic pipeline rollback on write failure', () => {
  function runner(): { runner: MutationRunner; rec: FakeRecorder; events: string[] } {
    const rec = new FakeRecorder();
    const events: string[] = [];
    const r = new MutationRunner({
      tasks: new FakeTaskPort(rec),
      lists: new FakeListPort(rec),
      settings: new FakeSettingsPort(rec),
      clock: () => T0,
      ids: (() => {
        let n = 0;
        return () => {
          n += 1;
          return `QAID${String(n).padStart(22, '0')}`;
        };
      })(),
      orderKeys: { between: orderKeyBetween, first: orderKeyFirst },
      deviceId: 'QA-DEV',
      onError: (info) => events.push(`failed:${info.op}:${info.rolledBack.join(',')}`),
    });
    return { runner: r, rec, events };
  }

  it('a failing FIRST write cancels the queued chain and restores the baseline exactly', async () => {
    const { runner: r, rec, events } = runner();
    // Committed baseline: one task.
    const seeded = applyOptimistic(emptyState(), {
      tasks: [makeTaskRow({ id: 'T1', listId: 'L1', title: 'committed' })],
      lists: [],
      settings: null,
    }).next;
    r.applyExternal({
      tasks: [...seeded.tasks.values()],
      lists: [],
      settings: seeded.settings,
    });
    const before = r.getState().tasks.get('T1');

    // Three rapid ops on ONE record; the chain's first write fails.
    const p1 = r.patchTask('T1', { title: 'edit-1' });
    const p2 = r.patchTask('T1', { notes: 'edit-2' });
    const p3 = r.setDone('T1', true);
    expect(r.getState().tasks.get('T1')?.title).toBe('edit-1'); // visible BEFORE any write resolves
    expect(r.getState().pending.size).toBe(1); // pending is keyed by RECORD id
    expect(r.getState().pending.has('T1')).toBe(true);

    await flushMicrotasks(); // let the serialized writes reach the port
    rec.fail({ code: 'QUOTA_EXCEEDED' });
    const results = await Promise.all([p1, p2, p3]);
    expect(results.map((x) => x.ok)).toEqual([false, false, false]);
    // State restored to the LAST COMMITTED image — exactly.
    expect(r.getState().tasks.get('T1')).toEqual(before);
    expect(r.getState().pending.size).toBe(0);
    // Rollback reports each rolled-back op in REVERSE order (p3, p2, p1):
    expect(events).toEqual(['failed:set-done:T1', 'failed:patch-task:T1', 'failed:patch-task:T1']);
  });
});

/* ------------------------------------------------------------------ */
/* Benchmarks — numbers recorded in docs/qa/e2-domain.md (§9.1)        */
/* ------------------------------------------------------------------ */

const WORDS = [
  'alpha',
  'beta',
  'gamma',
  'delta',
  'epsilon',
  'zeta',
  'eta',
  'theta',
  'กาแฟ',
  'บ้าน',
];

function corpus10k(): SearchableTask[] {
  const out: SearchableTask[] = [];
  for (let i = 0; i < 10_000; i += 1) {
    const title = `${WORDS[i % 10] ?? ''} ${WORDS[(i >> 3) % 10] ?? ''} task ${String(i)}`;
    const notes =
      i % 5 < 3
        ? `notes ${WORDS[(i >> 6) % 10] ?? ''} ${WORDS[(i >> 9) % 10] ?? ''} detail ${String(i)}`
        : null;
    out.push({ id: `id-${String(i).padStart(6, '0')}`, title, notes });
  }
  return out;
}

describe('QA benchmarks (§9.1: search < 50ms @10k; boot-to-first-data-paint < 500ms)', () => {
  it('search@10k: build / cold / keystroke-narrowed / naive — measured and budgeted', () => {
    const tasks = corpus10k();
    const idx = new SearchIndex();

    const buildStart = performance.now();
    idx.build(tasks);
    const buildMs = performance.now() - buildStart;

    const t0 = performance.now();
    const cold = idx.search('gam');
    const coldMs = performance.now() - t0;

    const t1 = performance.now();
    const cold2 = idx.search('alpha bet');
    const cold2Ms = performance.now() - t1;

    const t2 = performance.now();
    const narrowed = idx.search('gamma', { query: 'gam', hits: cold });
    const narrowMs = performance.now() - t2;

    const t3 = performance.now();
    const naive = SearchIndex.naive(tasks, 'alpha bet');
    const naiveMs = performance.now() - t3;

    const t4 = performance.now();
    const thai = idx.search('กาแฟ');
    const thaiMs = performance.now() - t4;

    console.warn(
      `[qa-bench] search@10k: build ${buildMs.toFixed(1)}ms | cold(1 token) ${coldMs.toFixed(2)}ms | ` +
        `cold(2 tokens) ${cold2Ms.toFixed(2)}ms | narrowed ${narrowMs.toFixed(2)}ms | ` +
        `naive ${naiveMs.toFixed(1)}ms | thai ${thaiMs.toFixed(2)}ms | matches ${String(cold.length)}/${String(cold2.length)}/${String(narrowed.length)}/${String(naive.length)}/${String(thai.length)}`,
    );

    expect(cold.length).toBeGreaterThan(0);
    expect(thai.length).toBeGreaterThan(0); // NFKC + non-Latin tokens index correctly
    expect(narrowed.length).toBeLessThanOrEqual(cold.length);
    expect(coldMs).toBeLessThan(50);
    expect(cold2Ms).toBeLessThan(50);
    expect(narrowMs).toBeLessThan(50);
    expect(thaiMs).toBeLessThan(50);
    expect(idx.size).toBe(10_000);
  });

  it('domain boot@10k: state build + index build + first view selects — measured and budgeted', () => {
    const lists = Array.from({ length: 20 }, (_, i) =>
      makeList({ id: `BL${String(i).padStart(2, '0')}`, sortOrder: String.fromCharCode(104 + i) }),
    );
    const tasks: Task[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      const due =
        i % 3 === 0 ? addDays('2026-10-23', i % 7) : i % 3 === 1 ? '2026-10-20' : undefined;
      tasks.push(
        makeTask({
          id: `BT${String(i).padStart(6, '0')}`,
          title: `${WORDS[i % 10] ?? ''} ${WORDS[(i >> 3) % 10] ?? ''} task ${String(i)}`,
          notes: i % 5 < 3 ? `notes ${WORDS[(i >> 6) % 10] ?? ''} detail ${String(i)}` : null,
          listId: `BL${String(i % 20).padStart(2, '0')}`,
          sortOrder: String(i).padStart(8, '0'),
          createdAt: T0 + i,
          status: i % 11 === 0 ? ('done' as const) : ('open' as const),
          ...(i % 11 === 0 ? { completedAt: T0 + i } : {}),
          ...(due !== undefined ? { dueDate: due } : {}),
        }),
      );
    }

    const stateStart = performance.now();
    const state = applyOptimistic(emptyState(), { tasks, lists, settings: makeSettings() }).next;
    const stateMs = performance.now() - stateStart;

    const indexStart = performance.now();
    const idx = new SearchIndex();
    idx.build(tasks);
    const indexMs = performance.now() - indexStart;

    const viewStart = performance.now();
    const allOpen = selectView(state, { kind: 'allOpen' }, { today: '2026-10-23', index: idx });
    const viewMs = performance.now() - viewStart;

    const t1 = performance.now();
    const today = selectView(state, { kind: 'today' }, { today: '2026-10-23', index: idx });
    const todayMs = performance.now() - t1;

    const t2 = performance.now();
    const completed = selectView(state, { kind: 'completed' }, { today: '2026-10-23', index: idx });
    const completedMs = performance.now() - t2;

    const t3 = performance.now();
    const search = selectView(
      state,
      { kind: 'search', query: 'alpha bet' },
      { today: '2026-10-23', index: idx },
    );
    const searchViewMs = performance.now() - t3;

    const totalMs = stateMs + indexMs + viewMs;
    console.warn(
      `[qa-bench] domain-boot@10k: state ${stateMs.toFixed(1)}ms | index ${indexMs.toFixed(1)}ms | ` +
        `first view (allOpen) ${viewMs.toFixed(1)}ms | today ${todayMs.toFixed(1)}ms | ` +
        `completed ${completedMs.toFixed(1)}ms | search view ${searchViewMs.toFixed(1)}ms | ` +
        `state+index+first-view ${totalMs.toFixed(1)}ms`,
    );

    expect(allOpen.rows.length).toBeGreaterThan(10_000 / 2);
    expect(today.rows.length).toBeGreaterThan(0);
    expect(completed.rows.length).toBeGreaterThan(0);
    expect(search.rows.length).toBeGreaterThan(0);
    // §9.1 boot budget is 500ms to first data paint at 10k — the domain-side
    // computation is a subset of that path and must fit with headroom. The view
    // select has no separate budget; gate it loosely (regression tripwire only —
    // a loaded CI host legitimately runs it in 50-60ms).
    expect(totalMs).toBeLessThan(500);
    expect(viewMs).toBeLessThan(200);
  });

  it('add → visible perceived latency: state update is synchronous (< 100ms budget, measured)', async () => {
    const rec = new FakeRecorder();
    const r = new MutationRunner({
      tasks: new FakeTaskPort(rec),
      lists: new FakeListPort(rec),
      settings: new FakeSettingsPort(rec),
      clock: () => T0,
      ids: () => 'QA-NEW-000000000000000001',
      orderKeys: { between: orderKeyBetween, first: orderKeyFirst },
      deviceId: 'QA-DEV',
    });
    const start = performance.now();
    const p = r.createTask({
      listId: 'L1',
      title: 'quick add',
      notes: null,
      priority: 0,
      tags: [],
    });
    const visibleMs = performance.now() - start;
    console.warn(`[qa-bench] add->visible (perceived): ${visibleMs.toFixed(2)}ms`);
    expect(r.getState().tasks.has('QA-NEW-000000000000000001')).toBe(true); // visible before write resolves
    expect(visibleMs).toBeLessThan(100);
    await flushMicrotasks(); // the serialized write reaches the port after the sync notify
    rec.succeed(makeTaskRow({ id: 'QA-NEW-000000000000000001', listId: 'L1', title: 'quick add' }));
    const settled = await p;
    expect(settled.ok).toBe(true);
  });
});
