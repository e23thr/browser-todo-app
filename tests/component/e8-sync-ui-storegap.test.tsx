/**
 * E8 sync-UI QA — production store wiring probe (t_98a1b4a5, h_reviewer).
 *
 * The impl's conflict suite seeds the task store with BOTH rows by hand
 * (`seed({ tasks: [recordId, copyId] })`), which can only prove the UI works
 * when the store already knows the copy. In PRODUCTION the sync engine
 * materializes the copy inside its own `db.tx(['lists','tasks','sync_state'])`
 * — the same shape as ADR-004's import replace (functional QA finding F1:
 * "stayed invisible until a manual page reload" when that seam was missing).
 *
 * This probe runs the REAL production wiring — `boot()` + `startTaskStore()`
 * + `wireDataReplacedRefresh()` (exactly main.tsx) over one fake IndexedDB —
 * and asks:
 *
 *  Q10 after a sync run PULLS a remote row, is it in the running store state
 *       and rendered list WITHOUT a reload?
 *  Q11 after a run materializes a "Conflict copy of <task>", is the copy in
 *       the store state / list, and do all three resolve actions succeed?
 *
 * Both are acceptance-critical: §6.2 requires conflict copies to be VISIBLE,
 * and a pull that never surfaces is indistinguishable from sync being broken.
 *
 * As FIRST written (QA card t_98a1b4a5), the open defect E8-UI-D1 was marked
 * with `it.fails`: the sync engine's
 * apply commits straight to IndexedDB and never fires notifyDataReplaced(),
 * so the running task store never learns about pulled rows or conflict
 * copies (only portability/import.ts + export.ts fire that seam today).
 * Q10 and Q11a document the violated expectation; Q11b records the RESOLVE
 * behavior under the gap (loud TASK_MISSING failure, conflict stays pending
 * — no silent loss, but resolution is blocked until a reload).
 *
 * FIXED (fix card t_2dec7c9d, ADR-006 Addendum C): the engine's apply now
 * fires the `data-replaced` seam after every committed merge + conflict-copy
 * materialization, so the running store re-reads without a reload. Q10/Q11a
 * are flipped `it.fails` → `it` with their bodies kept VERBATIM (the
 * e8-qa-probes convention — content-identical; the diff shows indent-only
 * reflow because the `it(` call shape reflows under the Prettier format gate).
 * Q11b could NOT keep its body: it recorded the
 * DEFECT's impact ("discard fails LOUD under the gap"), i.e. it asserted the
 * bug — with D1 fixed, discard-copy succeeds (acceptance: "keep-copy /
 * discard-copy resolves succeed without reload"). It is rewritten as the
 * post-fix regression guard for the same scenario, Q11c adds keep-copy and
 * Q11d keeps the old keep-both coverage. The loud failed-resolve path stays
 * covered by `sync-conflicts.test.tsx` ("failed-resolve loud+pending"), which
 * resolves a copy that is genuinely absent from the store.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import type { JSX } from 'preact';

import { wireDataReplacedRefresh } from '../../src/app/dataReplace';
import { SyncPanel } from '../../src/features/sync/SyncPanel';
import { bindSyncEngineForTest, resetSyncHost } from '../../src/features/sync/syncHost';
import { resetResolvedConflicts } from '../../src/features/sync/conflicts';
import { resetTaskStore, startTaskStore, state } from '../../src/features/tasks/store';
import { bindDataSafetyDb } from '../../src/portability';
import { boot, resetBootSingleton } from '../../src/storage/boot';
import type { AppDBImpl } from '../../src/storage/db';
import type { SyncStateRecord } from '../../src/storage/types';
import { SyncEngine } from '../../src/sync';
import { encodeBatch } from '../../src/sync/batchCodec';
import {
  DEVICE_B,
  makeFakeWebDav,
  makeList,
  makeTask as makeSyncTask,
  seedFile,
  stateOf,
  testUlid,
  T0,
} from '../unit/sync/fixtures';
import { regions, envStub, setUpSync } from './sync-harness';

const DB_NAME = 'local-first-todo';

let wired: (() => void) | null = null;

async function deleteDb(): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => {
      resolve();
    };
    request.onerror = () => {
      resolve();
    };
    request.onblocked = () => {
      resolve();
    };
  });
}

/** The production composition: real store boot over fake IDB + the F1 refresh seam. */
async function bootWorld(): Promise<AppDBImpl> {
  const booted = await boot();
  if (!booted.ok) throw new Error('boot failed');
  const db = booted.value as AppDBImpl;
  bindDataSafetyDb(db);
  await startTaskStore();
  wired = wireDataReplacedRefresh();
  return db;
}

beforeEach(async () => {
  setUpSync();
  wired?.();
  wired = null;
  resetTaskStore();
  bindDataSafetyDb(null);
  resetBootSingleton();
  await deleteDb();
});

afterEach(async () => {
  wired?.();
  wired = null;
  resetTaskStore();
  resetSyncHost();
  resetResolvedConflicts();
  bindDataSafetyDb(null);
  resetBootSingleton();
  await deleteDb();
});

/** The store's rendered view over the same signals the task list reads. */
function Titles(): JSX.Element {
  const titles = [...state.value.tasks.values()].map((task) => task.title).sort();
  return (
    <ul>
      {titles.map((title) => (
        <li key={title}>{title}</li>
      ))}
    </ul>
  );
}

describe('sync apply -> running store (production wiring, no reload)', () => {
  // Was `it.fails` while E8-UI-D1 was open; flipped to `it` by fix card
  // t_2dec7c9d (body verbatim — see the file docstring).
  it('Q10 a pulled remote row reaches the store state and the rendered list without a reload [E8-UI-D1]', async () => {
    const db = await bootWorld();
    const localList = makeList();
    const localTask = makeSyncTask({
      id: testUlid('q10-local'),
      listId: localList.id,
      title: 'Local task',
      updatedAt: T0 + 1000,
      deviceId: db.deviceId,
    });
    await db.put('lists', localList);
    await db.put('tasks', localTask);
    // The store loaded its rows during startTaskStore (rows above were put after
    // boot() but before startTaskStore completes? — put AFTER startTaskStore to
    // mirror reality: the store state must be refreshed by the sync apply, not
    // by boot order). Reload so state contains the local rows first.
    render(<Titles />);
    // Make sure the store sees the local rows: they were written after the
    // store's initial load, so mimic the pre-sync steady state via a reload seam.
    const { refreshAfterDataReplace } = await import('../../src/features/tasks/store');
    await refreshAfterDataReplace();
    await waitFor(() => {
      expect(screen.getByText('Local task', { exact: true })).toBeTruthy();
    });

    // The remote device published a brand-new task.
    const remoteTask = makeSyncTask({
      id: testUlid('q10-remote'),
      listId: localList.id,
      title: 'Remote-only task',
      updatedAt: T0 + 5000,
      deviceId: DEVICE_B,
    });
    const { json } = await encodeBatch([{ kind: 'task', record: remoteTask }], {
      deviceId: DEVICE_B,
      seq: 1,
      createdAt: T0 + 5000,
    });
    const fake = makeFakeWebDav();
    seedFile(fake.state, `todo-sync/v1/changes/${DEVICE_B}/0000000001.json`, json);
    fake.state.collections.add(`todo-sync/v1/changes/${DEVICE_B}`);

    const engine = new SyncEngine({ db, fetch: fake.fetch, env: envStub() });
    await stateOf(db); // hydration settles (same-connection FIFO)
    const configured = await engine.configure({
      remoteUrl: fake.baseUrl,
      user: 'alice',
      password: 'app-pw',
    });
    expect(configured.ok).toBe(true);
    bindSyncEngineForTest(engine, db);

    const run = await engine.runSync('manual');
    expect(run.ok, run.ok ? '' : `run failed: ${run.error.code}`).toBe(true);
    expect(engine.state().value.status).toBe('idle');

    // (a) the row DID land in IndexedDB — the engine's apply committed.
    const inDb = await db.get('tasks', remoteTask.id);
    expect(inDb.ok).toBe(true);
    const inDbRow = inDb.ok ? inDb.value : undefined;
    expect(inDbRow?.title).toBe('Remote-only task');

    // (b) THE QUESTION: is it in the running store state / rendered list?
    //     No page reload happened anywhere in this test.
    const inStore = state.value.tasks.get(remoteTask.id);
    // Give any async refresh a moment before judging.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(
      inStore?.title ?? state.value.tasks.get(remoteTask.id)?.title,
      'pulled row must be visible in the RUNNING store state without a reload',
    ).toBe('Remote-only task');
    expect(screen.getByText('Remote-only task', { exact: true })).toBeTruthy();
  });

  // Was `it.fails` while E8-UI-D1 was open; flipped to `it` by fix card
  // t_2dec7c9d (body verbatim — see the file docstring).
  it('Q11a conflict copy: visible in the running store through the panel [E8-UI-D1]', async () => {
    const db = await bootWorld();
    const localList = makeList();
    const conflictedId = testUlid('q11-milk');
    const base = makeSyncTask({
      id: conflictedId,
      listId: localList.id,
      title: 'Buy milk',
      updatedAt: T0 + 1000,
      deviceId: DEVICE_B,
      notes: null,
    });
    const localDiverged = makeSyncTask({
      id: conflictedId,
      listId: localList.id,
      title: 'Buy milk',
      updatedAt: T0 + 1900,
      deviceId: db.deviceId,
      notes: 'local edit',
    });
    await db.put('lists', localList);
    await db.put('tasks', localDiverged);

    // Fresh shadow at the BASE version (three-way test: both sides diverged).
    const syncRow = await stateOf(db);
    await db.put('sync_state', {
      ...syncRow,
      shadow: {
        [conflictedId]: {
          updatedAt: base.updatedAt,
          deviceId: base.deviceId,
          contentHash: 'f'.repeat(64),
        },
      },
    } satisfies SyncStateRecord);

    // Remote published a newer divergent version from another device.
    const remoteVersion = makeSyncTask({
      id: conflictedId,
      listId: localList.id,
      title: 'Buy milk',
      updatedAt: T0 + 2000,
      deviceId: DEVICE_B,
      notes: 'remote wins',
    });
    const { json } = await encodeBatch([{ kind: 'task', record: remoteVersion }], {
      deviceId: DEVICE_B,
      seq: 1,
      createdAt: T0 + 2000,
    });
    const fake = makeFakeWebDav();
    seedFile(fake.state, `todo-sync/v1/changes/${DEVICE_B}/0000000001.json`, json);
    fake.state.collections.add(`todo-sync/v1/changes/${DEVICE_B}`);

    const engine = new SyncEngine({ db, fetch: fake.fetch, env: envStub() });
    await stateOf(db);
    const configured = await engine.configure({
      remoteUrl: fake.baseUrl,
      user: 'alice',
      password: 'app-pw',
    });
    expect(configured.ok).toBe(true);
    bindSyncEngineForTest(engine, db);

    const run = await engine.runSync('manual');
    expect(run.ok, run.ok ? '' : `run failed: ${run.error.code}`).toBe(true);
    expect(engine.state().value.status).toBe('conflicts-pending');

    const summaries = engine.listConflicts();
    expect(summaries.length).toBe(1);
    const copyId = summaries[0]!.copyId;
    const copyTitle = `Conflict copy of ${summaries[0]!.title}`;

    // The copy row is in IndexedDB (the engine materialized it)…
    const copyInDb = await db.get('tasks', copyId);
    expect(copyInDb.ok).toBe(true);
    expect(copyInDb.ok ? copyInDb.value?.title : undefined).toBe(copyTitle);

    // …is the RUNNING store in step? (No reload anywhere.)
    await new Promise((resolve) => setTimeout(resolve, 100));
    const copyInStore = state.value.tasks.get(copyId)?.title;
    expect(copyInStore, 'conflict copy must be a VISIBLE task in the running store (§6.2)').toBe(
      copyTitle,
    );
  });

  it('Q11b discard-copy resolves WITHOUT reload (post E8-UI-D1): loud success, copy tombstoned, conflict cleared', async () => {
    const db = await bootWorld();
    const localList = makeList();
    const conflictedId = testUlid('q11b-milk');
    const base = makeSyncTask({
      id: conflictedId,
      listId: localList.id,
      title: 'Buy milk',
      updatedAt: T0 + 1000,
      deviceId: DEVICE_B,
      notes: null,
    });
    const localDiverged = makeSyncTask({
      id: conflictedId,
      listId: localList.id,
      title: 'Buy milk',
      updatedAt: T0 + 1900,
      deviceId: db.deviceId,
      notes: 'local edit',
    });
    await db.put('lists', localList);
    await db.put('tasks', localDiverged);

    const syncRow = await stateOf(db);
    await db.put('sync_state', {
      ...syncRow,
      shadow: {
        [conflictedId]: {
          updatedAt: base.updatedAt,
          deviceId: base.deviceId,
          contentHash: 'f'.repeat(64),
        },
      },
    } satisfies SyncStateRecord);

    const remoteVersion = makeSyncTask({
      id: conflictedId,
      listId: localList.id,
      title: 'Buy milk',
      updatedAt: T0 + 2000,
      deviceId: DEVICE_B,
      notes: 'remote wins',
    });
    const { json } = await encodeBatch([{ kind: 'task', record: remoteVersion }], {
      deviceId: DEVICE_B,
      seq: 1,
      createdAt: T0 + 2000,
    });
    const fake = makeFakeWebDav();
    seedFile(fake.state, `todo-sync/v1/changes/${DEVICE_B}/0000000001.json`, json);
    fake.state.collections.add(`todo-sync/v1/changes/${DEVICE_B}`);

    const engine = new SyncEngine({ db, fetch: fake.fetch, env: envStub() });
    await stateOf(db);
    const configured = await engine.configure({
      remoteUrl: fake.baseUrl,
      user: 'alice',
      password: 'app-pw',
    });
    expect(configured.ok).toBe(true);
    bindSyncEngineForTest(engine, db);

    const run = await engine.runSync('manual');
    expect(run.ok, run.ok ? '' : `run failed: ${run.error.code}`).toBe(true);
    expect(engine.state().value.status).toBe('conflicts-pending');
    const summaries = engine.listConflicts();
    expect(summaries.length).toBe(1);
    const copyId = summaries[0]!.copyId;
    const copyTitle = `Conflict copy of ${summaries[0]!.title}`;

    // The conflict surfaces from ENGINE state — and (post E8-UI-D1) the copy
    // is ALSO in the running store, so the resolve actions can reach the row
    // without a reload.
    render(<SyncPanel />);
    await waitFor(() => {
      expect(screen.getByText(copyTitle, { exact: true })).toBeTruthy();
    });
    const items = screen.getAllByText(copyTitle, { exact: true });
    const item = items[items.length - 1]!.closest('li');
    expect(item).toBeTruthy();

    // DISCARD post-fix (the store gap is gone): the running store learned
    // about the copy at the sync-apply seam, so the resolve goes through
    // WITHOUT a reload — loud success, sticky state cleared.
    fireEvent.click(within(item as HTMLElement).getByRole('button', { name: 'Discard the copy' }));
    await waitFor(() => {
      expect(regions.polite?.textContent ?? '').toContain('Conflict resolved: Buy milk');
    });
    // The old gap outcome must be GONE: no loud failure, nothing left pending.
    expect(regions.assertive?.textContent ?? '').not.toContain(
      'The conflict could not be resolved',
    );
    await waitFor(() => {
      expect(engine.state().value.status).not.toBe('conflicts-pending');
    });
    // Discard is a DELIBERATE tombstone (mode 'promote'), never a silent loss:
    // the row survives as a tombstone so the deletion propagates to peers.
    const after = await db.get('tasks', copyId);
    expect(after.ok).toBe(true);
    expect(after.ok ? (after.value?.deletedAt ?? null) : 'row-missing').not.toBeNull();
    expect(state.value.tasks.has(copyId)).toBe(false); // gone from the rendered list
  });

  it('Q11c keep-copy resolves WITHOUT reload (post E8-UI-D1): the original is tombstoned, the copy survives', async () => {
    const db = await bootWorld();
    const localList = makeList();
    const conflictedId = testUlid('q11c-milk');
    const base = makeSyncTask({
      id: conflictedId,
      listId: localList.id,
      title: 'Buy milk',
      updatedAt: T0 + 1000,
      deviceId: DEVICE_B,
      notes: null,
    });
    const localDiverged = makeSyncTask({
      id: conflictedId,
      listId: localList.id,
      title: 'Buy milk',
      updatedAt: T0 + 1900,
      deviceId: db.deviceId,
      notes: 'local edit',
    });
    await db.put('lists', localList);
    await db.put('tasks', localDiverged);

    const syncRow = await stateOf(db);
    await db.put('sync_state', {
      ...syncRow,
      shadow: {
        [conflictedId]: {
          updatedAt: base.updatedAt,
          deviceId: base.deviceId,
          contentHash: 'f'.repeat(64),
        },
      },
    } satisfies SyncStateRecord);

    const remoteVersion = makeSyncTask({
      id: conflictedId,
      listId: localList.id,
      title: 'Buy milk',
      updatedAt: T0 + 2000,
      deviceId: DEVICE_B,
      notes: 'remote wins',
    });
    const { json } = await encodeBatch([{ kind: 'task', record: remoteVersion }], {
      deviceId: DEVICE_B,
      seq: 1,
      createdAt: T0 + 2000,
    });
    const fake = makeFakeWebDav();
    seedFile(fake.state, `todo-sync/v1/changes/${DEVICE_B}/0000000001.json`, json);
    fake.state.collections.add(`todo-sync/v1/changes/${DEVICE_B}`);

    const engine = new SyncEngine({ db, fetch: fake.fetch, env: envStub() });
    await stateOf(db);
    const configured = await engine.configure({
      remoteUrl: fake.baseUrl,
      user: 'alice',
      password: 'app-pw',
    });
    expect(configured.ok).toBe(true);
    bindSyncEngineForTest(engine, db);

    const run = await engine.runSync('manual');
    expect(run.ok, run.ok ? '' : `run failed: ${run.error.code}`).toBe(true);
    expect(engine.state().value.status).toBe('conflicts-pending');
    const summaries = engine.listConflicts();
    expect(summaries.length).toBe(1);
    const copyId = summaries[0]!.copyId;
    const copyTitle = `Conflict copy of ${summaries[0]!.title}`;

    render(<SyncPanel />);
    await waitFor(() => {
      expect(screen.getByText(copyTitle, { exact: true })).toBeTruthy();
    });
    const items = screen.getAllByText(copyTitle, { exact: true });
    const item = items[items.length - 1]!.closest('li');
    expect(item).toBeTruthy();

    // KEEP THE COPY post-fix: resolves WITHOUT a reload (the store knows both
    // rows) — the ORIGINAL is tombstoned, the copy is kept live.
    fireEvent.click(within(item as HTMLElement).getByRole('button', { name: 'Keep the copy' }));
    await waitFor(() => {
      expect(regions.polite?.textContent ?? '').toContain('Conflict resolved: Buy milk');
    });
    expect(regions.assertive?.textContent ?? '').not.toContain(
      'The conflict could not be resolved',
    );
    await waitFor(() => {
      expect(engine.state().value.status).not.toBe('conflicts-pending');
    });
    const original = await db.get('tasks', conflictedId);
    expect(original.ok).toBe(true);
    expect(original.ok ? (original.value?.deletedAt ?? null) : 'row-missing').not.toBeNull();
    const copy = await db.get('tasks', copyId);
    expect(copy.ok).toBe(true);
    expect(copy.ok ? (copy.value?.deletedAt ?? null) : 'row-missing').toBeNull(); // copy stays
    expect(state.value.tasks.get(copyId)?.title, 'the kept copy stays VISIBLE').toBe(copyTitle);
  });

  it('Q11d keep-both is bookkeeping only and acks the sticky state (production wiring)', async () => {
    const db = await bootWorld();
    const localList = makeList();
    const conflictedId = testUlid('q11d-milk');
    const base = makeSyncTask({
      id: conflictedId,
      listId: localList.id,
      title: 'Buy milk',
      updatedAt: T0 + 1000,
      deviceId: DEVICE_B,
      notes: null,
    });
    const localDiverged = makeSyncTask({
      id: conflictedId,
      listId: localList.id,
      title: 'Buy milk',
      updatedAt: T0 + 1900,
      deviceId: db.deviceId,
      notes: 'local edit',
    });
    await db.put('lists', localList);
    await db.put('tasks', localDiverged);

    const syncRow = await stateOf(db);
    await db.put('sync_state', {
      ...syncRow,
      shadow: {
        [conflictedId]: {
          updatedAt: base.updatedAt,
          deviceId: base.deviceId,
          contentHash: 'f'.repeat(64),
        },
      },
    } satisfies SyncStateRecord);

    const remoteVersion = makeSyncTask({
      id: conflictedId,
      listId: localList.id,
      title: 'Buy milk',
      updatedAt: T0 + 2000,
      deviceId: DEVICE_B,
      notes: 'remote wins',
    });
    const { json } = await encodeBatch([{ kind: 'task', record: remoteVersion }], {
      deviceId: DEVICE_B,
      seq: 1,
      createdAt: T0 + 2000,
    });
    const fake = makeFakeWebDav();
    seedFile(fake.state, `todo-sync/v1/changes/${DEVICE_B}/0000000001.json`, json);
    fake.state.collections.add(`todo-sync/v1/changes/${DEVICE_B}`);

    const engine = new SyncEngine({ db, fetch: fake.fetch, env: envStub() });
    await stateOf(db);
    const configured = await engine.configure({
      remoteUrl: fake.baseUrl,
      user: 'alice',
      password: 'app-pw',
    });
    expect(configured.ok).toBe(true);
    bindSyncEngineForTest(engine, db);

    const run = await engine.runSync('manual');
    expect(run.ok, run.ok ? '' : `run failed: ${run.error.code}`).toBe(true);
    expect(engine.state().value.status).toBe('conflicts-pending');
    const summaries = engine.listConflicts();
    expect(summaries.length).toBe(1);
    const copyId = summaries[0]!.copyId;
    const copyTitle = `Conflict copy of ${summaries[0]!.title}`;

    render(<SyncPanel />);
    await waitFor(() => {
      expect(screen.getByText(copyTitle, { exact: true })).toBeTruthy();
    });
    const items = screen.getAllByText(copyTitle, { exact: true });
    const item = items[items.length - 1]!.closest('li');
    expect(item).toBeTruthy();

    // KEEP BOTH is pure bookkeeping -> succeeds and acks the sticky state.
    fireEvent.click(within(item as HTMLElement).getByRole('button', { name: 'Keep both' }));
    await waitFor(() => {
      expect(engine.state().value.status).not.toBe('conflicts-pending');
    });
    await waitFor(() => {
      expect(regions.polite?.textContent ?? '').toContain('Conflict resolved: Buy milk');
    });
    // Zero writes: both rows stay live and visible.
    const original = await db.get('tasks', conflictedId);
    expect(original.ok ? (original.value?.deletedAt ?? null) : 'row-missing').toBeNull();
    const copy = await db.get('tasks', copyId);
    expect(copy.ok ? (copy.value?.deletedAt ?? null) : 'row-missing').toBeNull();
    expect(state.value.tasks.get(copyId)?.title).toBe(copyTitle);
    expect(state.value.tasks.get(conflictedId)).toBeTruthy();
  });
});
