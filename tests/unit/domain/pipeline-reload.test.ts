/**
 * `MutationRunner.load()` as the wholesale-replace refresh (fix card t_85e19c39).
 *
 * `load()`'s contract is "replace state wholesale from the repos (committed truth)",
 * and a bulk data replacement (import / snapshot restore / wipe) is exactly when that
 * matters: the database no longer HAS the pre-import rows, so a merge-only apply would
 * leave them on screen until a manual page reload (functional QA finding F1). The
 * eviction half must obey reconcile rule 2: a record with an in-flight optimistic op
 * is not committed truth yet and must survive the re-read.
 */
import { describe, expect, it } from 'vitest';

import { MutationRunner } from '../../../src/domain/pipeline';
import { orderKeyBetween, orderKeyFirst } from '../../../src/storage/orderKey';
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
  const tasks = new FakeTaskPort(rec);
  let seq = 0;
  const runner = new MutationRunner({
    tasks,
    lists: new FakeListPort(rec),
    settings: new FakeSettingsPort(rec),
    clock: () => 1000,
    ids: () => {
      seq += 1;
      return `ID${String(seq)}`;
    },
    orderKeys: { between: orderKeyBetween, first: orderKeyFirst },
    deviceId: 'THIS-TAB',
  });
  return { rec, tasks, runner };
}

describe('load() wholesale replace (post-import refresh primitive)', () => {
  it('evicts rows the fresh read no longer returns (the dataset was replaced)', async () => {
    const { tasks, runner } = makeRunner();
    const kept = makeTaskRow({ id: 'KEEP', title: 'kept' });
    const gone = makeTaskRow({ id: 'GONE', title: 'pre-import row' });
    const list = makeListRow({ id: 'L1' });
    tasks.loaded = { tasks: [kept, gone], lists: [list], settings: makeSettingsRow() };
    await runner.load();
    expect([...runner.getState().tasks.keys()].sort()).toEqual(['GONE', 'KEEP']);

    // A bulk replace hard-deleted `GONE` and put `NEW` verbatim (import shape).
    const imported = makeTaskRow({ id: 'NEW', title: 'restored row' });
    tasks.loaded = { tasks: [kept, imported], lists: [list], settings: makeSettingsRow() };
    await runner.load();

    expect([...runner.getState().tasks.keys()].sort()).toEqual(['KEEP', 'NEW']);
    expect(runner.getState().tasks.get('NEW')?.title).toBe('restored row');
    expect(runner.getState().tasks.has('GONE')).toBe(false);
  });

  it('replaces the settings record wholesale alongside the rows', async () => {
    const { tasks, runner } = makeRunner();
    tasks.loaded = {
      tasks: [],
      lists: [],
      settings: makeSettingsRow({ theme: 'light', weekStart: 1 }),
    };
    await runner.load();
    expect(runner.getState().settings?.theme).toBe('light');

    tasks.loaded = {
      tasks: [],
      lists: [],
      settings: makeSettingsRow({ theme: 'dark', weekStart: 0 }),
    };
    await runner.load();
    expect(runner.getState().settings?.theme).toBe('dark');
    expect(runner.getState().settings?.weekStart).toBe(0);
  });

  it('never evicts a record with an in-flight optimistic op (reconcile rule 2)', async () => {
    const { rec, tasks, runner } = makeRunner();
    tasks.loaded = { tasks: [], lists: [], settings: makeSettingsRow() };
    await runner.load();

    const pending = runner.createTask({
      listId: 'L1',
      title: 'optimistic, not committed yet',
      notes: null,
      priority: 'P3',
      tags: [],
    });
    await flushMicrotasks();
    expect(runner.getState().tasks.has('ID1')).toBe(true);

    // The re-read cannot see the uncommitted row — but it must not evict it either.
    await runner.load();
    expect(runner.getState().tasks.has('ID1')).toBe(true);

    rec.succeed(makeTaskRow({ id: 'ID1', listId: 'L1', title: 'optimistic, not committed yet' }));
    await pending;
  });
});
