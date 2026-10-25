/**
 * QA-D1 fix verification (docs/qa/e2-domain.md D1; fix card t_08fd0e7e):
 * tree-grouped views must NEVER silently drop a live row.
 *
 *   1. An imported depth-2 chain renders in List / Today / Next 7 / All open —
 *      the grandchild flattens to depth 1 (PM decision (a)'s mandatory bar).
 *   2. An export → import round-trip preserves the chain and its rendered rows
 *      end-to-end (real export bytes → Stage A/B validation → state → views).
 *   3. Interactive writes still reject depth-2 nesting with
 *      PARENT_DEPTH_EXCEEDED — the write rule is unchanged; only rendering
 *      learned to tolerate what the import path (`upsertImported` validates
 *      format, not depth) can put into state.
 *   4. The never-dropped invariant holds even for a parent-chain cycle (ADR-004
 *      quarantines cycles on import, but a cross-device merge can land one).
 */
import { describe, expect, it } from 'vitest';

import { MutationRunner } from '../../src/domain/pipeline';
import { applyOptimistic, emptyState, type State } from '../../src/domain/state';
import { selectView, type ViewRow } from '../../src/domain/views';
import { prepareImport } from '../../src/portability/import';
import { exportBackup } from '../../src/portability/export';
import { orderKeyBetween, orderKeyFirst } from '../../src/storage/orderKey';
import {
  FakeListPort,
  FakeRecorder,
  FakeSettingsPort,
  FakeTaskPort,
  flushMicrotasks,
  makeListRow,
  makeSettingsRow,
  makeTaskRow,
} from './domain/fakes';
import {
  fixtureId,
  makeList,
  makeSettings,
  makeSnapshot,
  makeTask,
  T0,
} from './portability/helpers';
import { openFixtureDb, uniqueDbName } from './storage/fixtures';

const TODAY = '2026-10-23';

function rowShape(rows: ViewRow[]): string[] {
  return rows.map((r) =>
    r.type === 'task' ? `${r.task.id}:${String(r.depth)}` : `group:${r.label.kind}`,
  );
}

function makeRunner(): { runner: MutationRunner; rec: FakeRecorder } {
  const rec = new FakeRecorder();
  let n = 0;
  const runner = new MutationRunner({
    tasks: new FakeTaskPort(rec),
    lists: new FakeListPort(rec),
    settings: new FakeSettingsPort(rec),
    clock: () => T0,
    ids: () => {
      n += 1;
      return `QAID${String(n).padStart(22, '0')}`;
    },
    orderKeys: { between: orderKeyBetween, first: orderKeyFirst },
    deviceId: 'QA-DEV',
  });
  return { runner, rec };
}

function stateWith(tasks: Parameters<typeof makeTaskRow>[0][]): State {
  return applyOptimistic(emptyState(), {
    tasks: tasks.map((t) => makeTaskRow(t)),
    lists: [makeListRow({ id: 'L1', name: 'Inbox' })],
    settings: makeSettingsRow(),
  }).next;
}

describe('QA-D1: tree-grouped views never drop a live row (import-created depth-2 chains)', () => {
  it('an imported depth-2 chain renders in List / Today / Next 7 / All open', async () => {
    const { runner, rec } = makeRunner();
    runner.applyExternal({ lists: [makeListRow({ id: 'L1', name: 'Inbox' })] });
    const chain = [
      makeTaskRow({ id: 'C1', listId: 'L1', sortOrder: 'h', dueDate: TODAY }),
      makeTaskRow({ id: 'C2', listId: 'L1', sortOrder: 'm', parentTaskId: 'C1', dueDate: TODAY }),
      makeTaskRow({ id: 'C3', listId: 'L1', sortOrder: 'n', parentTaskId: 'C2', dueDate: TODAY }),
    ];
    const p = runner.upsertImported(chain);
    await flushMicrotasks();
    rec.succeed(undefined);
    expect((await p).ok).toBe(true);
    const state = runner.getState();
    expect(state.tasks.has('C3')).toBe(true); // the import path accepts the chain (no depth rule)

    // Every tree-grouped view renders all three rows; C3 flattens to depth 1.
    expect(
      rowShape(selectView(state, { kind: 'list', listId: 'L1' }, { today: TODAY }).rows),
    ).toEqual(['C1:0', 'C2:1', 'C3:1']);
    expect(rowShape(selectView(state, { kind: 'today' }, { today: TODAY }).rows)).toEqual([
      'group:day',
      'C1:0',
      'C2:1',
      'C3:1',
    ]);
    expect(rowShape(selectView(state, { kind: 'week' }, { today: TODAY }).rows)).toEqual([
      'group:day',
      'C1:0',
      'C2:1',
      'C3:1',
    ]);
    expect(rowShape(selectView(state, { kind: 'allOpen' }, { today: TODAY }).rows)).toEqual([
      'group:list',
      'C1:0',
      'C2:1',
      'C3:1',
    ]);
  });

  it('export → import round-trip preserves the chain and its rendered rows', async () => {
    const db = await openFixtureDb(uniqueDbName('d1-roundtrip'));
    try {
      const list = makeList({ id: fixtureId(10), name: 'Inbox' });
      const t1 = makeTask({ id: fixtureId(20), listId: list.id, dueDate: TODAY, sortOrder: 'h' });
      const t2 = makeTask({
        id: fixtureId(21),
        listId: list.id,
        dueDate: TODAY,
        sortOrder: 'm',
        parentTaskId: fixtureId(20),
      });
      const t3 = makeTask({
        id: fixtureId(22),
        listId: list.id,
        dueDate: TODAY,
        sortOrder: 'n',
        parentTaskId: fixtureId(21),
      });
      await db.put('settings', makeSettings());
      await db.put('lists', list);
      for (const row of [t1, t2, t3]) await db.put('tasks', row);
      await db.put('snapshots', makeSnapshot(fixtureId(30)));

      const exported = await exportBackup({ db, now: () => T0, download: false });
      expect(exported.ok).toBe(true);
      if (!exported.ok) return;

      const prepared = await prepareImport(exported.value.document, { fileName: 'backup.json' });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      // ADR-004's parentTaskId rule is ULID + referential + acyclic — a depth-2
      // chain is ACCEPTED verbatim (this is why the fix lives in rendering, not
      // in a new import-side depth rejection).
      expect(prepared.value.accepted).toEqual({ lists: 1, tasks: 3, settings: true });
      expect(prepared.value.quarantined).toEqual([]);

      const state = applyOptimistic(emptyState(), {
        tasks: prepared.value.records.tasks,
        lists: prepared.value.records.lists,
        settings: prepared.value.records.settings,
      }).next;
      const restored = selectView(state, { kind: 'list', listId: list.id }, { today: TODAY });
      expect(rowShape(restored.rows)).toEqual([
        `${fixtureId(20)}:0`,
        `${fixtureId(21)}:1`,
        `${fixtureId(22)}:1`,
      ]);
      expect(restored.counts).toEqual({ open: 3, overdue: 0 });
    } finally {
      db.close();
    }
  });

  it('interactive writes still reject depth-2 nesting (PARENT_DEPTH_EXCEEDED unchanged)', async () => {
    const { runner, rec } = makeRunner();
    runner.applyExternal({
      lists: [makeListRow({ id: 'L1', name: 'Inbox' })],
      tasks: [
        makeTaskRow({ id: 'P1', listId: 'L1' }),
        makeTaskRow({ id: 'S1', listId: 'L1', parentTaskId: 'P1' }),
      ],
    });
    const r = await runner.createTask({
      listId: 'L1',
      title: 'grandchild',
      notes: null,
      priority: 'P3',
      tags: [],
      parentTaskId: 'S1',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toMatchObject({ code: 'RULE', rule: 'PARENT_DEPTH_EXCEEDED' });
    expect(rec.writes).toHaveLength(0); // rejected synchronously, no port write
  });

  it('a parent-chain cycle still renders every row (never-dropped invariant)', () => {
    // X ↔ Y closes a cycle; W hangs off X; Z is a plain root. No root reaches
    // X/Y/W — all four rows must still render, exactly once each.
    const state = stateWith([
      { id: 'W', listId: 'L1', sortOrder: 'a', parentTaskId: 'X' },
      { id: 'Z', listId: 'L1', sortOrder: 'b' },
      { id: 'X', listId: 'L1', sortOrder: 'c', parentTaskId: 'Y' },
      { id: 'Y', listId: 'L1', sortOrder: 'd', parentTaskId: 'X' },
    ]);
    const v = selectView(state, { kind: 'list', listId: 'L1' }, { today: TODAY });
    expect(rowShape(v.rows)).toEqual(['Z:0', 'W:0', 'X:0', 'Y:1']);
  });
});
