/** Pure state transitions: apply/revert round-trips are the rollback primitive. */
import { describe, expect, it } from 'vitest';

import {
  applyOptimistic,
  emptyState,
  recordsEvent,
  revert,
  touchedIds,
  withPending,
} from '../../../src/domain/state';
import { makeList, makeSettings, makeTask } from './fixtures';

describe('state: applyOptimistic / revert', () => {
  it('starts empty with version 0', () => {
    const s = emptyState();
    expect(s.version).toBe(0);
    expect(s.tasks.size).toBe(0);
    expect(s.settings).toBeNull();
  });

  it('upserts tasks/lists and replaces settings; version bumps per batch', () => {
    const task = makeTask();
    const list = makeList();
    const settings = makeSettings({ theme: 'dark' });
    const { next } = applyOptimistic(emptyState(), {
      tasks: [task],
      lists: [list],
      settings,
    });
    expect(next.tasks.get(task.id)).toEqual(task);
    expect(next.lists.get(list.id)).toEqual(list);
    expect(next.settings).toEqual(settings);
    expect(next.version).toBe(1);
  });

  it('revert restores before-images EXACTLY (incl. absence)', () => {
    const task = makeTask({ title: 'before' });
    const s0 = applyOptimistic(emptyState(), { tasks: [task] }).next;
    const edited = { ...task, title: 'after' };
    const { next, undo } = applyOptimistic(s0, { tasks: [edited] });
    expect(next.tasks.get(task.id)?.title).toBe('after');
    const restored = revert(next, undo);
    expect(restored.tasks.get(task.id)?.title).toBe('before');

    const create = makeTask();
    const { next: n2, undo: u2 } = applyOptimistic(restored, { tasks: [create] });
    expect(n2.tasks.has(create.id)).toBe(true);
    expect(revert(n2, u2).tasks.has(create.id)).toBe(false);
  });

  it('evict removes records and revert brings them back', () => {
    const task = makeTask();
    const list = makeList();
    const s = applyOptimistic(emptyState(), { tasks: [task], lists: [list] }).next;
    const { next, undo } = applyOptimistic(s, { evictTasks: [task.id], evictLists: [list.id] });
    expect(next.tasks.size).toBe(0);
    expect(next.lists.size).toBe(0);
    const back = revert(next, undo);
    expect(back.tasks.get(task.id)).toEqual(task);
    expect(back.lists.get(list.id)).toEqual(list);
  });

  it('revert is record-scoped: other records in the same batch survive', () => {
    const a = makeTask({ title: 'a' });
    const b = makeTask({ title: 'b' });
    const s = applyOptimistic(emptyState(), { tasks: [a] }).next;
    const { next, undo } = applyOptimistic(s, { tasks: [a, b] });
    const rolled = revert(next, undo);
    expect(rolled.tasks.has(b.id)).toBe(false);
    expect(rolled.tasks.get(a.id)?.title).toBe('a');
  });

  it('recordsEvent/touchedIds expose the batch footprint', () => {
    const task = makeTask();
    const list = makeList();
    const update = { tasks: [task], evictTasks: ['X'], lists: [list], settings: null };
    const ev = recordsEvent(update);
    expect(ev.kind).toBe('records');
    if (ev.kind !== 'records') throw new Error('unreachable');
    expect(ev.taskIds).toEqual([task.id, 'X']);
    expect(ev.listIds).toEqual([list.id]);
    expect(ev.settings).toBe(true);
    expect(touchedIds(update)).toEqual([task.id, list.id, 'X']);
  });

  it('withPending sets and clears per-record in-flight ops', () => {
    const s = emptyState();
    const withOp = withPending(s, [['r1', { opId: 'op1', kind: 'patch-task', since: 1 }]]);
    expect(withOp.pending.get('r1')?.opId).toBe('op1');
    const cleared = withPending(withOp, [['r1', null]]);
    expect(cleared.pending.size).toBe(0);
    expect(cleared.version).toBeGreaterThan(withOp.version - 1);
  });
});
