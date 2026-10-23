/**
 * Branch-coverage top-ups for the domain core (§9.5 gate: >= 80% lines AND
 * branches on src/domain/**): defensive fallbacks (order-key mint failure),
 * the recolor/idempotent-remove paths, rollback re-anchoring of settings, and
 * the rank/eviction corners of search and views.
 */
import { describe, expect, it } from 'vitest';

import { isRuleError, ok, err, ruleError } from '../../../src/domain/kernel';
import type { Task } from '../../../src/domain/model';
import { MutationRunner } from '../../../src/domain/pipeline';
import { SearchIndex } from '../../../src/domain/search';
import { applyOptimistic, emptyState, revert } from '../../../src/domain/state';
import type { OrderKeyOps } from '../../../src/domain/ports';
import { selectView } from '../../../src/domain/views';
import {
  FakeListPort,
  FakeRecorder,
  FakeSettingsPort,
  FakeTaskPort,
  flushMicrotasks,
  makeListRow,
  makeTaskRow,
} from './fakes';
import { makeList, makeTask } from './fixtures';

const failingOrderKeys: OrderKeyOps = {
  between: () => {
    throw new Error('exhausted');
  },
  first: () => 'h',
};

function makeRunner(orderKeys: OrderKeyOps) {
  const rec = new FakeRecorder();
  let clockNow = 1000;
  let idSeq = 0;
  const tasks = new FakeTaskPort(rec);
  const runner = new MutationRunner({
    tasks,
    lists: new FakeListPort(rec),
    settings: new FakeSettingsPort(rec),
    clock: () => clockNow,
    ids: () => {
      idSeq += 1;
      return `ID${String(idSeq)}`;
    },
    orderKeys,
    deviceId: 'THIS-TAB',
  });
  return {
    rec,
    runner,
    tasks,
    tick: () => flushMicrotasks(),
    setClock: (t: number) => {
      clockNow = t;
    },
    importState: (rows: Task[], lists = [makeListRow({ id: 'L1' }), makeListRow({ id: 'L2' })]) => {
      runner.applyExternal({ tasks: rows, lists });
    },
  };
}

const draft = { listId: 'L1', title: 't', notes: null, priority: 0 as const, tags: [] };

describe('pipeline: list ops beyond rename', () => {
  it('recolorList patches only color', async () => {
    const h = makeRunner({ between: () => 'm', first: () => 'h' });
    h.importState([]);
    h.runner.applyExternal({ lists: [makeListRow({ id: 'L1', name: 'Inbox' })] });
    const p = h.runner.recolorList('L1', '#ff0000');
    expect(h.runner.getState().lists.get('L1')?.color).toBe('#ff0000');
    await h.tick();
    h.rec.succeed(makeListRow({ id: 'L1', color: '#ff0000' }));
    expect((await p).ok).toBe(true);
  });

  it('removeList on a missing list is an idempotent no-op (no write)', async () => {
    const h = makeRunner({ between: () => 'm', first: () => 'h' });
    const r = await h.runner.removeList('GONE', { mode: 'tombstone' });
    expect(r.ok).toBe(true);
    await h.tick();
    expect(h.rec.writes.length).toBe(0);
  });

  it('moveList rejects unknown reference rows and unknown lists', async () => {
    const h = makeRunner({ between: () => 'm', first: () => 'h' });
    h.runner.applyExternal({ lists: [makeListRow({ id: 'L1' })] });
    const missing = await h.runner.moveList('GONE', 'first');
    expect(missing.ok).toBe(false);
    const badRef = await h.runner.moveList('L1', { afterId: 'GONE' });
    expect(badRef.ok).toBe(false);
    if (!badRef.ok) expect(badRef.error).toMatchObject({ rule: 'REORDER_TARGET_NOT_IN_GROUP' });
  });

  it('upsertImported settles with the imported rows', async () => {
    const h = makeRunner({ between: () => 'm', first: () => 'h' });
    const rows = [makeTaskRow({ id: 'IMP1' })];
    const p = h.runner.upsertImported(rows);
    await h.tick();
    h.rec.succeed(undefined);
    expect((await p).ok).toBe(true);
    expect(h.runner.getState().tasks.has('IMP1')).toBe(true);
  });
});

describe('pipeline: order-key minting fallbacks (provisional keys are best-effort)', () => {
  it('createTask falls back to first() when between() cannot mint', async () => {
    const h = makeRunner(failingOrderKeys);
    const p = h.runner.createTask(draft);
    expect(h.runner.getState().tasks.get('ID1')?.sortOrder).toBe('h');
    await h.tick();
    h.rec.succeed(makeTaskRow({ id: 'ID1', sortOrder: 'm' }));
    expect((await p).ok).toBe(true);
  });

  it('createList falls back to first()', async () => {
    const h = makeRunner(failingOrderKeys);
    const p = h.runner.createList({ name: 'X', color: '#000000' });
    expect(h.runner.getState().lists.get('ID1')?.sortOrder).toBe('h');
    await h.tick();
    h.rec.succeed(makeListRow({ id: 'ID1' }));
    expect((await p).ok).toBe(true);
  });

  it('moveTask keeps the current key when the provisional key cannot be minted', async () => {
    const h = makeRunner(failingOrderKeys);
    h.importState([makeTaskRow({ id: 'T1', listId: 'L1', sortOrder: 'abc' })]);
    const p = h.runner.moveTask('T1', {
      group: { listId: 'L1', parentTaskId: null },
      position: 'last',
    });
    expect(h.runner.getState().tasks.get('T1')?.sortOrder).toBe('abc'); // unchanged
    await h.tick();
    h.rec.succeed(makeTaskRow({ id: 'T1', listId: 'L1', sortOrder: 'zz' }));
    expect((await p).ok).toBe(true);
    expect(h.runner.getState().tasks.get('T1')?.sortOrder).toBe('zz');
  });
});

describe('pipeline: neighbor resolution edge positions', () => {
  it('beforeId at the head and afterId at the tail resolve null neighbors', async () => {
    const h = makeRunner({ between: (a, b) => `k:${String(a)}:${String(b)}`, first: () => 'h' });
    h.importState([
      makeTaskRow({ id: 'T1', listId: 'L1', sortOrder: 'a' }),
      makeTaskRow({ id: 'T2', listId: 'L1', sortOrder: 'b' }),
    ]);
    const p1 = h.runner.moveTask('T2', {
      group: { listId: 'L1', parentTaskId: null },
      position: { beforeId: 'T1' },
    });
    expect(h.runner.getState().tasks.get('T2')?.sortOrder).toBe('k:null:a');
    await h.tick();
    h.rec.succeed(makeTaskRow({ id: 'T2', listId: 'L1', sortOrder: 'k' }));
    await p1;
    const p2 = h.runner.moveTask('T1', {
      group: { listId: 'L1', parentTaskId: null },
      position: { afterId: 'T2' },
    });
    expect(h.runner.getState().tasks.get('T1')?.sortOrder).toBe('k:k:null');
    await h.tick();
    h.rec.succeed(makeTaskRow({ id: 'T1', listId: 'L1', sortOrder: 'z' }));
    expect((await p2).ok).toBe(true);
  });

  it('accepts a create with a parentTaskId absent from state (repo validates authoritatively)', async () => {
    const h = makeRunner({ between: () => 'm', first: () => 'h' });
    const p = h.runner.createTask({ ...draft, parentTaskId: 'NOT-LOADED' });
    await h.tick();
    h.rec.succeed(makeTaskRow({ id: 'ID1', parentTaskId: 'NOT-LOADED' }));
    expect((await p).ok).toBe(true);
  });

  it('accepts moving into a group whose parent is absent from state', async () => {
    const h = makeRunner({ between: () => 'm', first: () => 'h' });
    h.importState([makeTaskRow({ id: 'T1', listId: 'L1', sortOrder: 'a' })]);
    const p = h.runner.moveTask('T1', {
      group: { listId: 'L1', parentTaskId: 'NOT-LOADED' },
      position: 'last',
    });
    await h.tick();
    h.rec.succeed(
      makeTaskRow({ id: 'T1', listId: 'L1', parentTaskId: 'NOT-LOADED', sortOrder: 'm' }),
    );
    expect((await p).ok).toBe(true);
    expect(h.runner.getState().tasks.get('T1')?.parentTaskId).toBe('NOT-LOADED');
  });
});

describe('pipeline: rollback re-anchors settings and load failures report', () => {
  it('updateSettings failure restores the committed settings record', async () => {
    const h = makeRunner({ between: () => 'm', first: () => 'h' });
    const p = h.runner.updateSettings({ theme: 'dark' });
    expect(h.runner.getState().settings?.theme).toBe('dark');
    await h.tick();
    h.rec.fail({ code: 'QUOTA_EXCEEDED' });
    expect((await p).ok).toBe(false);
    expect(h.runner.getState().settings).toBeNull(); // committed baseline (nothing persisted)
  });

  it('load() failure records to the error hook and resolves err', async () => {
    const rec = new FakeRecorder();
    const tasks = new FakeTaskPort(rec);
    tasks.loadAll = () => Promise.resolve(err({ code: 'UNAVAILABLE' }));
    const errors: unknown[] = [];
    const runner = new MutationRunner({
      tasks,
      lists: new FakeListPort(rec),
      settings: new FakeSettingsPort(rec),
      clock: () => 0,
      ids: () => 'ID',
      orderKeys: { between: () => 'm', first: () => 'h' },
      deviceId: 'D',
      onError: (i) => errors.push(i),
    });
    const r = await runner.load();
    expect(r.ok).toBe(false);
    expect(errors).toHaveLength(1);
  });
});

describe('state: settings undo corner', () => {
  it('reverting a settings change on a state without settings restores null', () => {
    const settings = {
      id: 'settings' as const,
      theme: 'dark' as const,
      locale: 'en',
      weekStart: 1 as const,
      defaultListId: null,
      notificationsEnabled: false,
      lastBackupAt: null,
    };
    const { next, undo } = applyOptimistic(emptyState(), { settings });
    expect(next.settings?.theme).toBe('dark');
    expect(revert(next, undo).settings).toBeNull();
  });
});

describe('kernel: error shape helpers', () => {
  it('isRuleError discriminates the RULE branch', () => {
    expect(isRuleError(ruleError('TASK_MISSING', 'x'))).toBe(true);
    expect(isRuleError({ code: 'UNKNOWN' })).toBe(false);
    expect(ok(1).ok).toBe(true);
    expect(err('e').ok).toBe(false);
  });
});

describe('views: remaining ordering and nesting corners', () => {
  it('a subtask whose parent is NOT in the group renders at depth 0', () => {
    const tasks = [
      makeTask({ id: 'C1', listId: 'L1', sortOrder: 'h', parentTaskId: 'MISSING' }),
      makeTask({ id: 'C2', listId: 'L1', sortOrder: 'a' }),
    ];
    const state = applyOptimistic(emptyState(), {
      tasks,
      lists: [makeList({ id: 'L1', sortOrder: 'h' })],
    }).next;
    const rows = selectView(state, { kind: 'list', listId: 'L1' }, { today: '2026-01-01' }).rows;
    const flat = rows.filter((r) => r.type === 'task');
    expect(flat.map((r) => [r.task.id, r.depth])).toEqual([
      ['C2', 0],
      ['C1', 0],
    ]);
  });

  it('two children of one parent both nest at depth 1 in view order', () => {
    const tasks = [
      makeTask({ id: 'P', listId: 'L1', sortOrder: 'a' }),
      makeTask({ id: 'K2', listId: 'L1', sortOrder: 'z', parentTaskId: 'P' }),
      makeTask({ id: 'K1', listId: 'L1', sortOrder: 'b', parentTaskId: 'P' }),
    ];
    const state = applyOptimistic(emptyState(), {
      tasks,
      lists: [makeList({ id: 'L1', sortOrder: 'h' })],
    }).next;
    const rows = selectView(state, { kind: 'list', listId: 'L1' }, { today: '2026-01-01' }).rows;
    expect(rows.filter((r) => r.type === 'task').map((r) => r.task.id)).toEqual(['P', 'K1', 'K2']);
  });

  it('completedAt-less done rows sort after stamped ones', () => {
    const tasks = [
      makeTask({ id: 'A', listId: 'L1', status: 'done' }),
      makeTask({ id: 'B', listId: 'L1', status: 'done', completedAt: 5 }),
    ];
    const state = applyOptimistic(emptyState(), {
      tasks,
      lists: [makeList({ id: 'L1', sortOrder: 'h' })],
    }).next;
    const rows = selectView(state, { kind: 'completed' }, { today: '2026-01-01' }).rows;
    expect(rows.filter((r) => r.type === 'task').map((r) => r.task.id)).toEqual(['B', 'A']);
  });
});

describe('search: maintenance corner cases', () => {
  it('upserting an existing id re-indexes without duplicate postings', () => {
    const idx = new SearchIndex();
    idx.build([{ id: 'T1', title: 'alpha beta', notes: null }]);
    idx.upsert({ id: 'T1', title: 'gamma', notes: 'beta' });
    expect(idx.search('beta').map((h) => h.id)).toEqual(['T1']);
    expect(idx.search('alpha').map((h) => h.id)).toEqual([]);
    expect(idx.search('gam').map((h) => h.id)).toEqual(['T1']);
  });

  it('dropping an indexed hit from the index removes it from narrowed results', () => {
    const idx = new SearchIndex();
    idx.build([
      { id: 'T1', title: 'shared word', notes: null },
      { id: 'T2', title: 'shared words', notes: null },
    ]);
    const first = idx.search('sh');
    expect(first).toHaveLength(2);
    idx.remove('T1');
    const narrowed = idx.search('shar', { query: 'sh', hits: first });
    expect(narrowed.map((h) => h.id)).toEqual(['T2']);
  });

  it('emptying a posting list drops the token entirely', () => {
    const idx = new SearchIndex();
    idx.build([{ id: 'T1', title: 'unique', notes: null }]);
    idx.remove('T1');
    expect(idx.search('unique')).toEqual([]);
    expect(idx.size).toBe(0);
  });
});
