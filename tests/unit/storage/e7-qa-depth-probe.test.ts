/**
 * E7 QA probe (t_ed1fa949, h_reviewer) — depth-guard coverage on the MOVE path.
 *
 * Existing suites cover `create` (repos.test / pipeline.test / e2-qa-d1-fix) but
 * no test exercises `move` INTO a subtask's group. Probe both layers (pipeline
 * optimistic + real repo) plus the self-parent edge `#checkParent` skips when
 * `parentTaskId === selfId`.
 */
import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import type { List, Task } from '../../../src/domain/model';
import { MutationRunner } from '../../../src/domain/pipeline';
import { orderKeyBetween, orderKeyFirst } from '../../../src/storage/orderKey';
import { newUlid } from '../../../src/storage/id';
import { openForTests, type AppDB } from '../../../src/storage/db';
import { createErrorLog } from '../../../src/storage/errorLog';
import { TaskRepo } from '../../../src/storage/repos/taskRepo';

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

async function setup(rows: Task[]): Promise<{ db: AppDB; tasks: TaskRepo }> {
  const opened = await openForTests({
    dbName: `qa-e7-depth-${String(Date.now())}-${String(Math.random())}`,
  });
  if (!opened.ok) throw new Error('open failed');
  const db = opened.value;
  const seed = await db.tx(['tasks'], 'readwrite', async (t) => {
    for (const row of rows) await t.put('tasks', row);
    return { ok: true as const, value: undefined };
  });
  if (!seed.ok) throw new Error('seed failed');
  const tasks = new TaskRepo({
    db,
    clock: () => T0,
    ids: () => newUlid(T0),
    errorLog: createErrorLog(),
  });
  return { db, tasks };
}

const PAR = task({ id: 'P'.repeat(26), title: 'Parent', sortOrder: 'a' });
const SUB = task({ id: 'C'.repeat(26), title: 'Sub', parentTaskId: PAR.id, sortOrder: 'b' });
const TOP = task({ id: 'D'.repeat(26), title: 'Top', sortOrder: 'c' });

describe('QA-E7-G1: MOVE-path depth guard (repo)', () => {
  it('moving a top-level task INTO a subtask group is rejected PARENT_DEPTH_EXCEEDED', async () => {
    const h = await setup([PAR, SUB, TOP]);
    try {
      const r = await h.tasks.move(TOP.id, {
        group: { listId: L1, parentTaskId: SUB.id },
        position: 'last',
      });
      // eslint-disable-next-line no-console
      console.log(
        '[qa-e7-g1] move-under-subtask →',
        r.ok ? 'OK (GUARD MISSING!)' : JSON.stringify(r.error),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatchObject({ code: 'RULE', rule: 'PARENT_DEPTH_EXCEEDED' });
      // Nothing was written.
      const after = await h.db.get('tasks', TOP.id);
      expect(after.ok && after.value?.parentTaskId).toBeUndefined();
    } finally {
      h.db.close();
    }
  });

  it('moving a parent UNDER its own child (cycle) is rejected', async () => {
    const h = await setup([PAR, SUB, TOP]);
    try {
      const r = await h.tasks.move(PAR.id, {
        group: { listId: L1, parentTaskId: SUB.id },
        position: 'last',
      });
      // eslint-disable-next-line no-console
      console.log(
        '[qa-e7-g2] move-parent-under-child →',
        r.ok ? 'OK (GUARD MISSING!)' : JSON.stringify(r.error),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatchObject({ code: 'RULE', rule: 'PARENT_DEPTH_EXCEEDED' });
    } finally {
      h.db.close();
    }
  });

  it('EDGE: moving a task into ITSELF as parent (parentTaskId === selfId)', async () => {
    const h = await setup([PAR, SUB, TOP]);
    try {
      const r = await h.tasks.move(TOP.id, {
        group: { listId: L1, parentTaskId: TOP.id },
        position: 'last',
      });
      // Document ACTUAL behavior: #checkParent early-returns ok on selfId.
      // eslint-disable-next-line no-console
      console.log(
        '[qa-e7-g3] move-self-as-parent →',
        r.ok ? 'OK (self-parent written)' : JSON.stringify(r.error),
      );
      if (r.ok) {
        expect(r.value.row.parentTaskId).toBe(TOP.id); // self-loop — record, do not mask
      } else {
        expect(r.error).toMatchObject({ code: 'RULE', rule: 'PARENT_DEPTH_EXCEEDED' });
      }
    } finally {
      h.db.close();
    }
  });
});

describe('QA-E7-G2: MOVE-path depth guard (pipeline optimistic layer)', () => {
  it('moveTask into a subtask group rejects BEFORE any port write', async () => {
    const rec: string[] = [];
    const h = await setup([PAR, SUB, TOP]);
    try {
      const repo = new TaskRepo({
        db: h.db,
        clock: () => T0,
        ids: () => newUlid(T0),
        errorLog: createErrorLog(),
      });
      const runner = new MutationRunner({
        tasks: new Proxy(repo, {
          get(target, prop, recv) {
            const value = Reflect.get(target, prop, recv);
            if (typeof value === 'function') {
              return (...args: unknown[]) => {
                if (prop === 'move') rec.push('move');
                return (value as (...a: unknown[]) => unknown).apply(target, args);
              };
            }
            return value;
          },
        }),
        lists: {
          loadAll: async () => ({
            ok: true as const,
            value: {
              lists: [] as List[],
              settings: (await import('../../../src/domain/model')).DEFAULT_SETTINGS,
            },
          }),
        } as never,
        settings: {
          get: async () => ({
            ok: true as const,
            value: (await import('../../../src/domain/model')).DEFAULT_SETTINGS,
          }),
          update: () => Promise.reject(new Error('unused')),
        },
        clock: () => T0,
        ids: () => newUlid(T0),
        orderKeys: { between: orderKeyBetween, first: orderKeyFirst },
        deviceId: 'QA-DEVICE',
      });
      const loaded = await runner.load();
      if (!loaded.ok) throw new Error('load failed');
      const r = await runner.moveTask(TOP.id, {
        group: { listId: L1, parentTaskId: SUB.id },
        position: 'last',
      });
      // eslint-disable-next-line no-console
      console.log(
        '[qa-e7-g4] pipeline move-under-subtask →',
        r.ok ? 'OK (GUARD MISSING!)' : JSON.stringify(r.error),
        '| port move calls:',
        String(rec.length),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatchObject({ code: 'RULE', rule: 'PARENT_DEPTH_EXCEEDED' });
      expect(rec).toHaveLength(0); // rejected synchronously, no port write
    } finally {
      h.db.close();
    }
  });
});
