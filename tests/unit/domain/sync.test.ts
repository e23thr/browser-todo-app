/**
 * Concurrent-tab protocol contract (ADR-003 Decision 8): pure reconcile
 * (upsert/evict per ChangeSet, `'all'` replace, pending-skip), self-origin
 * ignore, and the structural message guard. No real channel here by design.
 */
import { describe, expect, it } from 'vitest';

import {
  isBroadcastMessage,
  isOwnMessage,
  reconcile,
  TAB_SYNC_CHANNEL,
  type BroadcastMessage,
} from '../../../src/domain/sync';
import { applyOptimistic, emptyState, withPending } from '../../../src/domain/state';
import { makeList, makeSettings, makeTask } from './fixtures';

const SELF = 'TAB-SELF';

function msg(change: BroadcastMessage['change'], origin = 'TAB-OTHER'): BroadcastMessage {
  return { v: 1, type: 'data-changed', origin, at: 123, change };
}

describe('sync: message contract', () => {
  it('pins the channel name and envelope version', () => {
    expect(TAB_SYNC_CHANNEL).toBe('local-first-todo:tabs:v1');
  });

  it('ignores own messages (receiver rule 1)', () => {
    expect(isOwnMessage(msg({ tasks: ['X'] }, SELF), SELF)).toBe(true);
    expect(isOwnMessage(msg({ tasks: ['X'] }), SELF)).toBe(false);
  });

  it('rejects malformed foreign input structurally', () => {
    expect(isBroadcastMessage(null)).toBe(false);
    expect(isBroadcastMessage('data-changed')).toBe(false);
    expect(isBroadcastMessage({ v: 2, type: 'data-changed', origin: 'X' })).toBe(false);
    expect(isBroadcastMessage({ v: 1, type: 'hello', origin: 'X' })).toBe(false);
    expect(isBroadcastMessage(msg({ tasks: ['X'] }))).toBe(true);
    expect(isBroadcastMessage(msg('all'))).toBe(true);
  });
});

describe('sync: reconcile is pure and never writes', () => {
  it('upserts live rows named in the ChangeSet', () => {
    const existing = makeTask({ id: 'T1', title: 'old' });
    const state = applyOptimistic(emptyState(), { tasks: [existing] }).next;
    const fresh = makeTask({ id: 'T1', title: 'new' });
    const update = reconcile(state, msg({ tasks: ['T1'] }), {
      tasks: new Map([['T1', fresh]]),
    });
    expect(update.tasks).toEqual([fresh]);
    expect(update.evictTasks).toBeUndefined();
  });

  it('evicts tombstoned or missing rows named in the ChangeSet', () => {
    const existing = makeTask({ id: 'T1' });
    const state = applyOptimistic(emptyState(), { tasks: [existing] }).next;
    const tombstoned = { ...makeTask({ id: 'T2' }), deletedAt: 99 };
    const update = reconcile(state, msg({ tasks: ['T1', 'T2', 'T3'] }), {
      tasks: new Map([
        ['T1', null], // hard-missing
        ['T2', tombstoned],
        // 'T3' absent from reads entirely
      ]),
    });
    expect([...(update.evictTasks ?? [])].sort()).toEqual(['T1', 'T2', 'T3']);
  });

  it("'all' replaces state: absent rows are evicted, live rows upserted", () => {
    const stale = makeTask({ id: 'OLD' });
    const staleList = makeList({ id: 'LIST-OLD' });
    const state = applyOptimistic(emptyState(), {
      tasks: [stale],
      lists: [staleList],
    }).next;
    const freshTask = makeTask({ id: 'NEW' });
    const freshList = makeList({ id: 'LIST-NEW' });
    const update = reconcile(state, msg('all'), {
      tasks: new Map([['NEW', freshTask]]),
      lists: new Map([['LIST-NEW', freshList]]),
      settings: makeSettings({ theme: 'dark' }),
    });
    expect(update.tasks).toEqual([freshTask]);
    expect(update.evictTasks).toEqual(['OLD']);
    expect(update.evictLists).toEqual(['LIST-OLD']);
    expect(update.settings).toMatchObject({ theme: 'dark' });
  });

  it('settings: true reloads the settings record', () => {
    const state = emptyState();
    const update = reconcile(state, msg({ settings: true }), {
      settings: makeSettings({ locale: 'th' }),
    });
    expect(update.settings).toMatchObject({ locale: 'th' });
  });

  it('never touches records with a pending optimistic op (their baseline is invalid)', () => {
    const pendingTask = makeTask({ id: 'T1', title: 'optimistic' });
    let state = applyOptimistic(emptyState(), { tasks: [pendingTask] }).next;
    state = withPending(state, [['T1', { opId: 'op1', kind: 'patch-task', since: 1 }]]);
    const external = makeTask({ id: 'T1', title: 'external' });
    const update = reconcile(state, msg({ tasks: ['T1'] }), {
      tasks: new Map([['T1', external]]),
    });
    expect(update.tasks).toBeUndefined();
    expect(update.evictTasks).toBeUndefined();
  });

  it('returns an empty update when nothing changed', () => {
    const state = emptyState();
    expect(reconcile(state, msg({ tasks: [] }), {})).toEqual({});
  });
});
