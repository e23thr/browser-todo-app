/**
 * E8 sync UI — conflict-copy surfacing (S9), driven against REAL engine
 * fixtures: a seeded divergence makes `SyncEngine.runSync` materialize the
 * visible "Conflict copy of <task>" rows, and the panel must surface every one
 * with all three resolve actions:
 *
 *   keep both (bookkeeping only) · keep the copy (delete the original) ·
 *   discard the copy (delete the copy)
 *
 * The UI never re-merges (§6.2 pre-decided LWW — the engine already decided);
 * both rows are ordinary tasks, so deleting one is the tombstone path that
 * propagates. Acknowledgement happens only when EVERY conflict is resolved.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';

import { SyncPanel } from '../../src/features/sync/SyncPanel';
import { bindSyncEngineForTest } from '../../src/features/sync/syncHost';
import { resetTaskStore } from '../../src/features/tasks/store';
import { encodeBatch, SyncEngine } from '../../src/sync';
import type { ConflictSummary } from '../../src/sync';
import type { SyncStateRecord } from '../../src/storage/types';
import {
  bootDb,
  counterIds,
  DEVICE_B,
  makeFakeWebDav,
  makeTask as makeSyncTask,
  seedFile,
  stateOf,
  testUlid,
  T0,
} from '../unit/sync/fixtures';
import { envStub, regions, seed, setUpSync, tearDownSync } from './sync-harness';
import { makeList, makeTask, type TestRunner } from './fixtures';

beforeEach(() => {
  setUpSync();
});

afterEach(() => {
  tearDownSync();
});

interface ConflictRig {
  readonly engine: SyncEngine;
  readonly store: TestRunner;
  readonly summaries: readonly ConflictSummary[];
}

/**
 * Two independent divergences → two conflict copies in ONE run (the engine's
 * `listConflicts()` keeps them until `acknowledgeConflicts()`), plus a component
 * store seeded with the exact original + copy rows so every resolve action has
 * real rows to delete.
 */
async function conflictRig(): Promise<ConflictRig> {
  const db = await bootDb();
  const fake = makeFakeWebDav();
  const env = envStub();
  const engine = new SyncEngine({ db, fetch: fake.fetch, env, newId: counterIds('e8copy') });
  await stateOf(db);
  const configured = await engine.configure({
    remoteUrl: fake.baseUrl,
    user: 'u',
    password: 'p',
  });
  if (!configured.ok) throw new Error(`configure failed: ${configured.error.code}`);

  const seeds = [
    { seed: 'e8-milk', title: 'Buy milk' },
    { seed: 'e8-dog', title: 'Walk dog' },
  ];
  const shadow: SyncStateRecord['shadow'] = {};
  const records: { kind: 'task'; record: ReturnType<typeof makeSyncTask> }[] = [];
  for (const entry of seeds) {
    const id = testUlid(entry.seed);
    const base = makeSyncTask({ id, deviceId: DEVICE_B, updatedAt: T0 + 1000, title: entry.title });
    // Local diverged edit (the version the merge would displace → copy).
    await db.put(
      'tasks',
      makeSyncTask({
        id,
        deviceId: db.deviceId,
        updatedAt: T0 + 1900,
        title: entry.title,
        notes: 'local edit',
      }),
    );
    shadow[id] = {
      updatedAt: base.updatedAt,
      deviceId: base.deviceId,
      contentHash: 'f'.repeat(64),
    };
    records.push({
      kind: 'task',
      record: makeSyncTask({
        id,
        deviceId: DEVICE_B,
        updatedAt: T0 + 2000,
        title: entry.title,
        notes: 'remote wins',
      }),
    });
  }
  const syncRow = await stateOf(db);
  await db.put('sync_state', { ...syncRow, shadow });
  const { json } = await encodeBatch(records, {
    deviceId: DEVICE_B,
    seq: 1,
    createdAt: T0 + 2000,
  });
  seedFile(fake.state, `todo-sync/v1/changes/${DEVICE_B}/0000000001.json`, json);
  fake.state.collections.add(`todo-sync/v1/changes/${DEVICE_B}`);

  const run = await engine.runSync('manual');
  if (!run.ok) throw new Error(`run failed: ${run.error.code}`);
  const summaries = engine.listConflicts();
  if (summaries.length !== 2) {
    throw new Error(`expected 2 conflicts, got ${String(summaries.length)}`);
  }
  // `testUlid` hashes the seed string (32-bit FNV) — two SEED STRINGS CAN
  // COLLIDE, which would silently make a copy share its original's id. The
  // fixture guard turns that into a loud failure instead of a mystery.
  const ids = summaries.flatMap((summary) => [summary.recordId, summary.copyId]);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`fixture id collision: ${ids.join(', ')}`);
  }
  bindSyncEngineForTest(engine, db);

  const list = makeList();
  const store = await seed({
    lists: [list],
    tasks: summaries.flatMap((summary) => [
      makeTask({ id: summary.recordId, title: summary.title, listId: list.id }),
      makeTask({
        id: summary.copyId,
        title: `Conflict copy of ${summary.title}`,
        listId: list.id,
      }),
    ]),
  });
  return { engine, store, summaries };
}

/** The `<li>` that surfaces one conflict (its copy label is the anchor). */
function itemFor(title: string): HTMLElement {
  const label = screen.getByText(`Conflict copy of ${title}`, { exact: true });
  const item = label.closest('li');
  if (item === null) throw new Error(`no conflict item for ${title}`);
  return item;
}

function live(store: TestRunner, id: string): boolean {
  return store.tasks.get(id)?.deletedAt === null;
}

describe('conflict-copy surfacing + resolve actions (S9)', () => {
  it('surfaces every conflict copy with all three resolve actions — no re-merge offered', async () => {
    const rig = await conflictRig();
    render(<SyncPanel />);

    expect(screen.getByRole('heading', { level: 3, name: 'Conflicts to review (2)' })).toBeTruthy();
    expect(screen.getByText(/Nothing is merged automatically/, { exact: true })).toBeTruthy();
    expect(screen.getByText('Conflict copy of Buy milk', { exact: true })).toBeTruthy();
    expect(screen.getByText('Conflict copy of Walk dog', { exact: true })).toBeTruthy();

    for (const title of ['Buy milk', 'Walk dog']) {
      const item = itemFor(title);
      expect(within(item).getByRole('button', { name: 'Keep both' })).toBeTruthy();
      expect(within(item).getByRole('button', { name: 'Keep the copy' })).toBeTruthy();
      expect(within(item).getByRole('button', { name: 'Discard the copy' })).toBeTruthy();
    }

    const state = rig.engine.state().value;
    expect(state.status).toBe('conflicts-pending');
    // The winner rows are untouched until the user chooses.
    for (const summary of rig.summaries) {
      expect(live(rig.store, summary.recordId)).toBe(true);
      expect(live(rig.store, summary.copyId)).toBe(true);
    }
  });

  it('keep both: changes no data, acknowledges only after every conflict is handled', async () => {
    const rig = await conflictRig();
    render(<SyncPanel />);

    fireEvent.click(within(itemFor('Buy milk')).getByRole('button', { name: 'Keep both' }));

    await waitFor(() => {
      expect(screen.queryByText('Conflict copy of Buy milk', { exact: true })).toBeNull();
    });
    // One left — the sticky state must NOT clear early.
    expect(screen.getByText('Conflict copy of Walk dog', { exact: true })).toBeTruthy();
    expect(rig.engine.state().value.status).toBe('conflicts-pending');

    fireEvent.click(within(itemFor('Walk dog')).getByRole('button', { name: 'Keep both' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sync now' })).toBeTruthy();
    });
    expect(rig.engine.state().value.status).toBe('idle');
    // "Keep both" is bookkeeping only: every row is still live.
    for (const summary of rig.summaries) {
      expect(live(rig.store, summary.recordId)).toBe(true);
      expect(live(rig.store, summary.copyId)).toBe(true);
    }
    await waitFor(() => {
      expect(regions.polite?.textContent).toContain('Conflict resolved: Walk dog');
    });
  });

  it('keep the copy: deletes the original task row, keeps the copied version', async () => {
    const rig = await conflictRig();
    render(<SyncPanel />);

    for (const title of ['Buy milk', 'Walk dog']) {
      fireEvent.click(within(itemFor(title)).getByRole('button', { name: 'Keep the copy' }));
      await waitFor(() => {
        expect(screen.queryByText(`Conflict copy of ${title}`, { exact: true })).toBeNull();
      });
    }

    await waitFor(() => {
      expect(rig.engine.state().value.status).toBe('idle');
    });
    for (const summary of rig.summaries) {
      expect(rig.store.tasks.has(summary.recordId)).toBe(false); // original gone
      expect(live(rig.store, summary.copyId)).toBe(true); // copy kept
    }
  });

  it('discard the copy: deletes the copied row, keeps the original', async () => {
    const rig = await conflictRig();
    render(<SyncPanel />);

    for (const title of ['Buy milk', 'Walk dog']) {
      fireEvent.click(within(itemFor(title)).getByRole('button', { name: 'Discard the copy' }));
      await waitFor(() => {
        expect(screen.queryByText(`Conflict copy of ${title}`, { exact: true })).toBeNull();
      });
    }

    await waitFor(() => {
      expect(rig.engine.state().value.status).toBe('idle');
    });
    for (const summary of rig.summaries) {
      expect(live(rig.store, summary.recordId)).toBe(true); // original kept
      expect(rig.store.tasks.has(summary.copyId)).toBe(false); // copy gone
    }
  });

  it('a failed resolve reports loudly and leaves the conflict pending (no silent loss)', async () => {
    const rig = await conflictRig();
    render(<SyncPanel />);
    resetTaskStore(); // the task store is unavailable — deleteTask must fail

    fireEvent.click(within(itemFor('Buy milk')).getByRole('button', { name: 'Keep the copy' }));

    await waitFor(() => {
      expect(regions.assertive?.textContent).toContain('could not be resolved');
    });
    expect(screen.getByText('Conflict copy of Buy milk', { exact: true })).toBeTruthy();
    expect(rig.engine.state().value.status).toBe('conflicts-pending');
  });
});
