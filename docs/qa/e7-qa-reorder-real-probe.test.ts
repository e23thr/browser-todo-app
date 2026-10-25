/**
 * E7 QA probes (t_ed1fa949, h_reviewer) — subtask reorder integrity, REAL chain.
 *
 * Defect E7-D1 evidence (docs/qa/e7-organization.md §4). Polarity follows the
 * E8/E9 probe convention (docs/qa/e9-review-probe.test.ts): `it.fails` asserts
 * the DESIRED behaviour and passes only because the defect reproduces. When the
 * fix lands the test reddens — flip it to `it()` as part of the fix.
 *
 * Unlike the component fixture ports (whose `move()` spreads `current` and so
 * silently keeps `parentTaskId` — masking this defect in jsdom), this binds the
 * production `MutationRunner` + the REAL `TaskRepo` over fake-indexeddb, then
 * calls the exact store function the UI's keyboard/menu/drag reorder paths
 * call: `moveTaskTo(id, listId, position)`.
 *
 * The store ALWAYS moves with `group: { listId, parentTaskId: null }`
 * (src/features/tasks/store.ts moveTaskTo — pre-E7 code, unchanged by 6370493).
 * Real TaskRepo.move applies `#withGroup`, which DELETES parentTaskId when the
 * group is top-level, and the pipeline's optimistic layer does the same. So a
 * plain reorder gesture on a subtask row silently unparents it in production.
 *
 * Run (relative imports are written for tests/unit/storage/ depth):
 *   cp docs/qa/e7-qa-reorder-real-probe.test.ts tests/unit/storage/
 *   npx vitest run tests/unit/storage/e7-qa-reorder-real-probe.test.ts
 *   mv tests/unit/storage/e7-qa-reorder-real-probe.test.ts docs/qa/
 */
import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import type { Task } from '../../../src/domain/model';
import { MutationRunner } from '../../../src/domain/pipeline';
import { orderKeyBetween, orderKeyFirst } from '../../../src/storage/orderKey';
import { newUlid } from '../../../src/storage/id';
import { openForTests, type AppDB } from '../../../src/storage/db';
import { createErrorLog } from '../../../src/storage/errorLog';
import { TaskRepo } from '../../../src/storage/repos/taskRepo';
import { bindRunnerForTest, moveTaskTo, resetTaskStore } from '../../../src/features/tasks/store';

const L1 = '0'.repeat(26);
const T0 = 1_700_000_000_000;

function task(over: Partial<Task>): Task {
  return {
    id: over.id ?? newUlid(T0),
    listId: L1,
    title: over.title ?? 'task',
    notes: null,
    status: 'open',
    priority: 'P4',
    tags: [],
    sortOrder: over.sortOrder ?? 'h',
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    deviceId: '0'.repeat(26),
    ...over,
  };
}

async function setup(rows: Task[]): Promise<AppDB> {
  const opened = await openForTests({
    dbName: `qa-e7-reorder-${String(Date.now())}-${String(Math.random())}`,
  });
  if (!opened.ok) throw new Error('open failed');
  const db = opened.value;
  const seed = await db.tx(['tasks'], 'readwrite', async (t) => {
    for (const row of rows) await t.put('tasks', row);
    return { ok: true as const, value: undefined };
  });
  if (!seed.ok) throw new Error('seed failed');
  const repo = new TaskRepo({
    db,
    clock: () => Date.now(),
    ids: () => newUlid(),
    errorLog: createErrorLog(),
  });
  const runner = new MutationRunner({
    tasks: repo,
    lists: { loadAll: async () => ({ ok: true as const, value: { lists: [], settings: (await import('../../../src/domain/model')).DEFAULT_SETTINGS } }) },
    settings: { get: async () => ({ ok: true as const, value: (await import('../../../src/domain/model')).DEFAULT_SETTINGS }) },
    clock: () => Date.now(),
    ids: () => newUlid(),
    orderKeys: { between: orderKeyBetween, first: orderKeyFirst },
    deviceId: 'QA-DEVICE',
  });
  const loaded = await runner.load();
  if (!loaded.ok) throw new Error('load failed');
  bindRunnerForTest(runner);
  return db;
}

async function rawTask(db: AppDB, id: string): Promise<Task | undefined> {
  const read = await db.get('tasks', id);
  return read.ok ? read.value : undefined;
}

describe('QA-E7-D1: production moveTaskTo on a subtask (REAL TaskRepo)', () => {
  it.fails(
    'UI "Move down" on a subtask (anchor = top-level row) must not strip parentTaskId',
    async () => {
      const par = task({ id: 'P'.repeat(26), title: 'Parent', sortOrder: 'a' });
      const sub = task({ id: 'C'.repeat(26), title: 'Child', parentTaskId: par.id, sortOrder: 'b' });
      const top2 = task({ id: 'D'.repeat(26), title: 'Top two', sortOrder: 'c' });
      const db = await setup([par, sub, top2]);
      try {
        // Keyboard "Move down" on the subtask in flat rows [Parent, Child, Top two]
        // computes position = { afterId: Top two } and calls moveTaskTo(child, L1, …).
        const result = await moveTaskTo(sub.id, L1, { afterId: top2.id });
        const stored = await rawTask(db, sub.id);
        // eslint-disable-next-line no-console
        console.log(
          '[qa-e7-d1] move ok =',
          result.ok,
          '| DB parentTaskId =',
          String(stored?.parentTaskId),
        );
        expect(result.ok).toBe(true);
        // ORDER may change; the STRUCTURAL link must survive a reorder gesture.
        expect(stored?.parentTaskId).toBe(par.id);
      } finally {
        db.close();
        resetTaskStore();
      }
    },
  );

  it.fails('UI "Move up" (position first) on a subtask must not strip parentTaskId', async () => {
    const par = task({ id: 'P'.repeat(26), title: 'Parent', sortOrder: 'b' });
    const sub = task({ id: 'C'.repeat(26), title: 'Child', parentTaskId: par.id, sortOrder: 'c' });
    const top1 = task({ id: 'E'.repeat(26), title: 'Top one', sortOrder: 'a' });
    const db = await setup([par, sub, top1]);
    try {
      const result = await moveTaskTo(sub.id, L1, 'first');
      const stored = await rawTask(db, sub.id);
      // eslint-disable-next-line no-console
      console.log(
        '[qa-e7-d1] move ok =',
        result.ok,
        '| DB parentTaskId =',
        String(stored?.parentTaskId),
      );
      expect(result.ok).toBe(true);
      expect(stored?.parentTaskId).toBe(par.id);
    } finally {
      db.close();
      resetTaskStore();
    }
  });
});
