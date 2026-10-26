/**
 * S6 archive/restore actions (E9) — the `set-archived` pipeline contract:
 * synchronous optimistic flip (done→archived preserving `completedAt`,
 * archived→done backfilling it), the serialized `setArchived` port write,
 * the authoritative settle swap, and the `TASK_STATUS_INVALID` guard that
 * makes an archive gesture incapable of silently reopening a task.
 */
import { describe, expect, it } from 'vitest';

import type { Task } from '../../../src/domain/model';
import { MutationRunner } from '../../../src/domain/pipeline';
import { orderKeyBetween, orderKeyFirst } from '../../../src/storage/orderKey';
import type { ChangeEvent } from '../../../src/domain/state';
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
  let clockNow = 1000;
  const tasks = new FakeTaskPort(rec);
  const runner = new MutationRunner({
    tasks,
    lists: new FakeListPort(rec),
    settings: new FakeSettingsPort(rec),
    clock: () => clockNow,
    ids: () => 'ID1',
    orderKeys: { between: orderKeyBetween, first: orderKeyFirst },
    deviceId: 'THIS-TAB',
  });
  runner.subscribe((ev) => events.push(ev));
  return {
    rec,
    runner,
    events,
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

const doneRow = (over: Partial<Task> = {}): Task =>
  makeTaskRow({ id: 'T1', listId: 'L1', status: 'done', completedAt: 777, ...over });

describe('MutationRunner.setArchived: done → archived', () => {
  it('flips optimistically (status archived, completedAt verbatim) before the write settles', async () => {
    const h = makeRunner();
    await h.baselined([doneRow()]);

    const promise = h.runner.setArchived('T1', true);
    // Steps 1-2: the state already shows archived, synchronously.
    const optimistic = h.runner.getState().tasks.get('T1') as Task;
    expect(optimistic.status).toBe('archived');
    expect(optimistic.completedAt).toBe(777);
    expect(optimistic.updatedAt).toBe(1000);
    expect(h.runner.getState().pending.has('T1')).toBe(true);

    await h.tick();
    expect(h.rec.writes).toHaveLength(1);
    expect(h.rec.writes[0]?.op).toBe('setArchived');
    expect(h.rec.writes[0]?.args).toEqual(['T1', true]);

    // Step 4a: the authoritative row replaces the provisional one.
    h.rec.succeed(doneRow({ status: 'archived', updatedAt: 999_999 }));
    const result = await promise;
    expect(result.ok).toBe(true);
    const settled = h.runner.getState().tasks.get('T1') as Task;
    expect(settled.status).toBe('archived');
    expect(settled.completedAt).toBe(777);
    expect(h.runner.getState().pending.has('T1')).toBe(false);
  });

  it('rolls back to the committed DONE image when the write fails', async () => {
    const h = makeRunner();
    await h.baselined([doneRow()]);

    const promise = h.runner.setArchived('T1', true);
    await h.tick();
    h.rec.fail({ code: 'TX_ABORTED' });
    const result = await promise;
    expect(result.ok).toBe(false);
    const reverted = h.runner.getState().tasks.get('T1') as Task;
    expect(reverted.status).toBe('done'); // never left archived after a failed write
    expect(reverted.completedAt).toBe(777);
    expect(h.runner.getState().pending.has('T1')).toBe(false);
    expect(h.events.some((ev) => ev.kind === 'write-failed')).toBe(true);
  });
});

describe('MutationRunner.setArchived: archived → done (restore)', () => {
  it('backfills a MISSING completedAt so retention never sorts it as unstamped', async () => {
    const h = makeRunner();
    await h.baselined([makeTaskRow({ id: 'T1', listId: 'L1', status: 'archived' })]);

    const promise = h.runner.setArchived('T1', false);
    const optimistic = h.runner.getState().tasks.get('T1') as Task;
    expect(optimistic.status).toBe('done');
    expect(optimistic.completedAt).toBe(1000); // backfilled to the clock

    await h.tick();
    expect(h.rec.writes[0]?.args).toEqual(['T1', false]);
    h.rec.succeed(doneRow({ status: 'done', completedAt: 1000 }));
    const result = await promise;
    expect(result.ok).toBe(true);
    expect((h.runner.getState().tasks.get('T1') as Task).completedAt).toBe(1000);
  });

  it('keeps an EXISTING completedAt through the restore', async () => {
    const h = makeRunner();
    await h.baselined([doneRow({ status: 'archived', completedAt: 42 })]);

    const promise = h.runner.setArchived('T1', false);
    expect((h.runner.getState().tasks.get('T1') as Task).completedAt).toBe(42);
    await h.tick();
    h.rec.succeed(doneRow({ status: 'done', completedAt: 42 }));
    expect((await promise).ok).toBe(true);
    expect((h.runner.getState().tasks.get('T1') as Task).completedAt).toBe(42);
  });
});

describe('MutationRunner.setArchived: the legal-pair guard', () => {
  it('rejects archive of an OPEN task with TASK_STATUS_INVALID and writes nothing', async () => {
    const h = makeRunner();
    await h.baselined([makeTaskRow({ id: 'T1', listId: 'L1', status: 'open' })]);

    const result = await h.runner.setArchived('T1', true);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toMatchObject({ code: 'RULE', rule: 'TASK_STATUS_INVALID' });
    expect(h.rec.writes).toHaveLength(0); // rejected BEFORE any I/O
    expect((h.runner.getState().tasks.get('T1') as Task).status).toBe('open');
  });

  it('rejects RESTORE of a done task (never a silent uncomplete) and of an absent task', async () => {
    const h = makeRunner();
    await h.baselined([doneRow()]);

    const restoreDone = await h.runner.setArchived('T1', false);
    expect(restoreDone.ok).toBe(false);
    if (!restoreDone.ok) expect(restoreDone.error).toMatchObject({ rule: 'TASK_STATUS_INVALID' });
    expect((h.runner.getState().tasks.get('T1') as Task).status).toBe('done');

    const missing = await h.runner.setArchived('GONE', true);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatchObject({ code: 'RULE', rule: 'TASK_MISSING' });
    expect(h.rec.writes).toHaveLength(0);
  });
});
