/**
 * Sync engine integration (ADR-006 Decision 5) — real `runSyncOnce` runs over
 * the in-memory WebDAV fake and fake IndexedDB. Covers: two-device convergence
 * through full pull→merge→apply→push runs, the §6.2 conflict flows end-to-end
 * ("exactly one visible Conflict copy"), cursor mechanics (contiguity, gaps,
 * overlap, retry-reuses-seq), compaction (snapshot-before-prune + tombstone
 * retention) and the SYNC_FORMAT_NEWER hard stop.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { Task } from '../../../src/domain/model';
import { resetBootSingleton } from '../../../src/storage/boot';
import { encodeBatch } from '../../../src/sync/batchCodec';
import { COMPACT_BATCH_THRESHOLD } from '../../../src/sync/engine';
import { WebDavClient } from '../../../src/sync/webdav';
import {
  bootDb,
  counterIds,
  makeFakeWebDav,
  makeList,
  makeTask,
  runEngine,
  seedFile,
  stateOf,
  T0,
  testUlid,
  DEVICE_A,
} from './fixtures';

afterEach(() => {
  resetBootSingleton();
});

function clientFor(fake: ReturnType<typeof makeFakeWebDav>): WebDavClient {
  return new WebDavClient(
    { baseUrl: fake.baseUrl, user: 'u', password: 'p' },
    { fetch: fake.fetch },
  );
}

const TASK_ID = testUlid('engine-task');

describe('runSyncOnce — full runs', () => {
  it('E1: first sync pushes local rows as a verified batch and advances cursors', async () => {
    const db = await bootDb();
    const fake = makeFakeWebDav();
    const client = clientFor(fake);
    await db.put('tasks', makeTask({ id: TASK_ID, deviceId: db.deviceId }));

    const run = await runEngine(db, client);
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.value.summary.pushed).toEqual({ batches: 1, records: 1 });
    const state = await stateOf(db);
    expect(state.cursor.pushedSeq).toBe(1);
    expect(state.cursor.pull[db.deviceId]).toBe(1);
    expect(state.lastSyncAt).not.toBeNull();
    expect(fake.state.files.has(`todo-sync/v1/changes/${db.deviceId}/0000000001.json`)).toBe(true);
  });

  it('E2: two-device convergence — create on A, pull on B; edit on B, pull on A (stamps byte-for-byte)', async () => {
    const dbA = await bootDb();
    const dbB = await bootDb();
    const fake = makeFakeWebDav();
    const clientA = clientFor(fake);
    const clientB = clientFor(fake);

    await dbA.put('tasks', makeTask({ id: TASK_ID, deviceId: dbA.deviceId, updatedAt: T0 + 2000 }));
    expect((await runEngine(dbA, clientA)).ok).toBe(true);

    // B pulls A's creation.
    const runB = await runEngine(dbB, clientB);
    expect(runB.ok).toBe(true);
    if (!runB.ok) return;
    expect(runB.value.summary.pulled.batches).toBe(1);
    const onB = await dbB.get('tasks', TASK_ID);
    expect(onB.ok && onB.value?.deviceId).toBe(dbA.deviceId); // stamps preserved
    expect(onB.ok && onB.value?.updatedAt).toBe(T0 + 2000);

    // B edits at 3000 and syncs; A pulls the edit.
    await dbB.put('tasks', {
      ...(onB.ok ? onB.value! : makeTask({ id: TASK_ID })),
      notes: 'from B',
      updatedAt: T0 + 3000,
      deviceId: dbB.deviceId,
    });
    expect((await runEngine(dbB, clientB)).ok).toBe(true);
    const runA2 = await runEngine(dbA, clientA);
    expect(runA2.ok).toBe(true);
    const onA = await dbA.get('tasks', TASK_ID);
    expect(onA.ok && onA.value?.notes).toBe('from B');
    expect(onA.ok && onA.value?.updatedAt).toBe(T0 + 3000);
    expect(onA.ok && onA.value?.deviceId).toBe(dbB.deviceId);
  });

  it('E3: concurrent edit end-to-end — exactly ONE visible "Conflict copy of …" across the fleet', async () => {
    const dbA = await bootDb();
    const dbB = await bootDb();
    const fake = makeFakeWebDav();
    const clientA = clientFor(fake);
    const clientB = clientFor(fake);

    // Common ancestor: created on A and seen by B.
    await dbA.put('tasks', makeTask({ id: TASK_ID, deviceId: dbA.deviceId, updatedAt: T0 + 1000 }));
    expect((await runEngine(dbA, clientA)).ok).toBe(true);
    expect((await runEngine(dbB, clientB)).ok).toBe(true);

    // Concurrent edits (worked example 1): A renames at 2000, B adds notes at 1900.
    await dbA.put(
      'tasks',
      makeTask({
        id: TASK_ID,
        deviceId: dbA.deviceId,
        updatedAt: T0 + 2000,
        title: 'Buy oat milk',
      }),
    );
    await dbB.put(
      'tasks',
      makeTask({ id: TASK_ID, deviceId: dbB.deviceId, updatedAt: T0 + 1900, notes: 'soy' }),
    );
    expect((await runEngine(dbA, clientA)).ok).toBe(true);
    const onB = await runEngine(dbB, clientB, { newId: counterIds('copy-B') });
    expect(onB.ok).toBe(true);
    if (!onB.ok) return;
    expect(onB.value.conflicts).toHaveLength(1); // B's edit displaced → copy

    // A pulls B's copy — no copy created on A.
    const onA2 = await runEngine(dbA, clientA, { newId: counterIds('copy-A') });
    expect(onA2.ok).toBe(true);
    if (!onA2.ok) return;
    expect(onA2.value.conflicts).toHaveLength(0);

    // Fleet-wide: the record id carries A's rename; exactly one copy row exists.
    const tasksA = await dbA.getAll('tasks');
    const tasksB = await dbB.getAll('tasks');
    const copiesA = tasksA.ok
      ? tasksA.value.filter((t) => t.title.startsWith('Conflict copy of '))
      : [];
    const copiesB = tasksB.ok
      ? tasksB.value.filter((t) => t.title.startsWith('Conflict copy of '))
      : [];
    expect(copiesA).toHaveLength(1);
    expect(copiesB).toHaveLength(1);
    expect(copiesA[0]!.id).toBe(copiesB[0]!.id); // the same copy, converged
    expect(copiesA[0]!.title).toBe('Conflict copy of Buy milk');
    expect(copiesA[0]!.notes).toBe('soy'); // B's work is never lost
    const mainA = tasksA.ok ? tasksA.value.find((t) => t.id === TASK_ID) : undefined;
    expect(mainA?.title).toBe('Buy oat milk');
  });

  it('E4: delete-vs-edit end-to-end — the edit survives as a visible copy', async () => {
    const dbA = await bootDb();
    const dbB = await bootDb();
    const fake = makeFakeWebDav();
    const clientA = clientFor(fake);
    const clientB = clientFor(fake);

    await dbA.put('tasks', makeTask({ id: TASK_ID, deviceId: dbA.deviceId, updatedAt: T0 + 1000 }));
    expect((await runEngine(dbA, clientA)).ok).toBe(true);
    expect((await runEngine(dbB, clientB)).ok).toBe(true);

    // A deletes at 2500; B edits at 2400 (worked example 3).
    await dbA.put(
      'tasks',
      makeTask({ id: TASK_ID, deviceId: dbA.deviceId, updatedAt: T0 + 2500, deletedAt: T0 + 2500 }),
    );
    await dbB.put(
      'tasks',
      makeTask({ id: TASK_ID, deviceId: dbB.deviceId, updatedAt: T0 + 2400, notes: 'soy' }),
    );
    expect((await runEngine(dbA, clientA)).ok).toBe(true);
    const onB = await runEngine(dbB, clientB, { newId: counterIds('copy') });
    expect(onB.ok).toBe(true);
    if (!onB.ok) return;
    expect(onB.value.conflicts).toHaveLength(1);

    const tasksB = await dbB.getAll('tasks');
    const rows = tasksB.ok ? tasksB.value : [];
    const main = rows.find((t) => t.id === TASK_ID);
    expect(main?.deletedAt).toBe(T0 + 2500); // tombstone outcome follows LWW on the id
    const copy = rows.find((t) => t.title.startsWith('Conflict copy of '));
    expect(copy?.notes).toBe('soy');
    expect(copy?.deletedAt).toBeNull();
  });

  it('E5: seq gaps are tolerated (contiguous cursor) and healed once the gap fills', async () => {
    const db = await bootDb();
    const fake = makeFakeWebDav();
    const client = clientFor(fake);
    const other = testUlid('gap-device');
    const { json } = await encodeBatch(
      [
        {
          kind: 'task',
          record: makeTask({ id: testUlid('g2'), deviceId: other, updatedAt: T0 + 2000 }),
        },
      ],
      { deviceId: other, seq: 2, createdAt: 2000 },
    );
    seedFile(fake.state, `todo-sync/v1/changes/${other}/0000000002.json`, json);
    fake.state.collections.add(`todo-sync/v1/changes/${other}`);

    const run1 = await runEngine(db, client);
    expect(run1.ok).toBe(true);
    let state = await stateOf(db);
    expect(state.cursor.pull[other]).toBe(0); // gap at seq 1 blocks contiguity

    const { json: json1 } = await encodeBatch(
      [
        {
          kind: 'task',
          record: makeTask({ id: testUlid('g1'), deviceId: other, updatedAt: T0 + 1500 }),
        },
      ],
      { deviceId: other, seq: 1, createdAt: 1500 },
    );
    seedFile(fake.state, `todo-sync/v1/changes/${other}/0000000001.json`, json1);
    const run2 = await runEngine(db, client);
    expect(run2.ok).toBe(true);
    state = await stateOf(db);
    expect(state.cursor.pull[other]).toBe(2); // healed
  });

  it('E6: a failed upload keeps pushedSeq — the retry reuses the SAME seq (Decision 2)', async () => {
    const db = await bootDb();
    const fake = makeFakeWebDav();
    const client = clientFor(fake);
    await db.put('tasks', makeTask({ id: TASK_ID, deviceId: db.deviceId }));

    fake.faults.tornPut = true;
    const failed = await runEngine(db, client);
    expect(failed.ok).toBe(false);
    let state = await stateOf(db);
    expect(state.cursor.pushedSeq).toBe(0); // never advanced

    fake.faults.tornPut = false;
    const retry = await runEngine(db, client);
    expect(retry.ok).toBe(true);
    state = await stateOf(db);
    expect(state.cursor.pushedSeq).toBe(1);
    expect(fake.state.files.has(`todo-sync/v1/changes/${db.deviceId}/0000000001.json`)).toBe(true);
  });

  it('E7: compaction writes a covering snapshot, prunes covered batches and retains tombstones', async () => {
    const db = await bootDb();
    const fake = makeFakeWebDav();
    const client = clientFor(fake);
    const other = testUlid('compact-device');
    for (let seq = 1; seq <= COMPACT_BATCH_THRESHOLD; seq += 1) {
      const { json } = await encodeBatch(
        [
          {
            kind: 'task',
            record: makeTask({
              id: testUlid(`c${String(seq)}`),
              deviceId: other,
              updatedAt: T0 + 1000 + seq,
              deletedAt: seq % 2 === 0 ? T0 + 1000 + seq : null,
            }),
          },
        ],
        { deviceId: other, seq, createdAt: 1000 + seq },
      );
      seedFile(
        fake.state,
        `todo-sync/v1/changes/${other}/${String(seq).padStart(10, '0')}.json`,
        json,
      );
    }
    fake.state.collections.add(`todo-sync/v1/changes/${other}`);
    // Local tombstone that must survive compaction in the snapshot's state.
    const localDeadId = testUlid('local-dead');
    await db.put(
      'tasks',
      makeTask({
        id: localDeadId,
        deviceId: db.deviceId,
        deletedAt: T0 + 7777,
        updatedAt: T0 + 7777,
      }),
    );

    const run = await runEngine(db, client);
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.value.summary.compacted).toBe(true);

    const snapshots = [...fake.state.files.keys()].filter((k) =>
      k.startsWith('todo-sync/v1/snapshots/'),
    );
    expect(snapshots).toHaveLength(1);
    const snapBody = fake.state.files.get(snapshots[0]!)!;
    expect(snapBody).toContain(localDeadId); // tombstone retained in state (Decision 8 rule 2)
    // All covered batches pruned (Decision 8 rule 2: snapshot BEFORE prune).
    for (let seq = 1; seq <= COMPACT_BATCH_THRESHOLD; seq += 1) {
      expect(
        fake.state.files.has(`todo-sync/v1/changes/${other}/${String(seq).padStart(10, '0')}.json`),
      ).toBe(false);
    }
    const state = await stateOf(db);
    expect(state.cursor.remoteCoveredUpTo).not.toBeNull();
  });

  it('E8: SYNC_FORMAT_NEWER hard-stops the run; local rows are untouched', async () => {
    const db = await bootDb();
    const fake = makeFakeWebDav();
    const client = clientFor(fake);
    await db.put('tasks', makeTask({ id: TASK_ID, deviceId: db.deviceId }));
    const other = testUlid('future-device');
    seedFile(
      fake.state,
      `todo-sync/v1/changes/${other}/0000000001.json`,
      JSON.stringify({
        format: 'todo-sync/2',
        kind: 'batch',
        deviceId: other,
        seq: 1,
        createdAt: 1,
        recordsHash: 'x',
        records: '[]',
      }),
    );
    fake.state.collections.add(`todo-sync/v1/changes/${other}`);

    const run = await runEngine(db, client);
    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.error.code).toBe('SYNC_FORMAT_NEWER');
    expect(run.error.retryable).toBe(false);
  });

  it('E9: the push scan honours the 5-minute overlap (scan-commit races never drop rows)', async () => {
    const db = await bootDb();
    const fake = makeFakeWebDav();
    const client = clientFor(fake);
    const state0 = await stateOf(db);
    expect(state0.cursor.pushedUpTo).toBe(0);

    await db.put('tasks', makeTask({ id: TASK_ID, deviceId: db.deviceId, updatedAt: T0 + 50_000 }));
    const run = await runEngine(db, client);
    expect(run.ok).toBe(true);
    const state = await stateOf(db);
    // Watermark = scanStarted - OVERLAP: rows just before the scan still qualify.
    expect(state.cursor.pushedUpTo).toBeGreaterThan(T0 - 2 * 300_000);
    expect(state.cursor.pushedUpTo).toBeLessThan(T0);
  });

  it('E10: merged rows never pass through repo stamping (remote updatedAt/deviceId survive byte-for-byte)', async () => {
    const dbA = await bootDb();
    const dbB = await bootDb();
    const fake = makeFakeWebDav();
    const remote = makeTask({
      id: TASK_ID,
      deviceId: DEVICE_A,
      updatedAt: T0 + 1234,
      notes: 'remote',
    });
    await dbA.put('tasks', remote);
    expect((await runEngine(dbA, clientFor(fake))).ok).toBe(true);
    expect((await runEngine(dbB, clientFor(fake))).ok).toBe(true);
    const got = await dbB.get('tasks', TASK_ID);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value).toEqual(remote); // exactly the pushed bytes
  });

  it('E11: sync_state never reaches the remote (credentials/cursors are local-only)', async () => {
    const db = await bootDb();
    const fake = makeFakeWebDav();
    const client = clientFor(fake);
    const state = await stateOf(db);
    await db.put('sync_state', { ...state, remotePassword: 'super-secret', enabled: true });
    await db.put('tasks', makeTask({ id: TASK_ID, deviceId: db.deviceId }));
    expect((await runEngine(db, client)).ok).toBe(true);
    for (const body of fake.state.files.values()) {
      expect(body).not.toContain('super-secret');
      expect(body).not.toContain('remotePassword');
    }
  });

  it('E12: a remote mixing kinds for one id is corruption — the run refuses before apply', async () => {
    const db = await bootDb();
    const fake = makeFakeWebDav();
    const client = clientFor(fake);
    const other = testUlid('mixed-device');
    await db.put('lists', makeList({ id: TASK_ID, deviceId: db.deviceId, updatedAt: T0 + 1000 }));
    const { json } = await encodeBatch(
      [{ kind: 'task', record: makeTask({ id: TASK_ID, deviceId: other, updatedAt: T0 + 2000 }) }],
      { deviceId: other, seq: 1, createdAt: T0 + 2000 },
    );
    seedFile(fake.state, `todo-sync/v1/changes/${other}/0000000001.json`, json);
    fake.state.collections.add(`todo-sync/v1/changes/${other}`);
    const before = await db.getAll('lists');

    const run = await runEngine(db, client);
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.error.code).toBe('CORRUPT_REMOTE');
    const after = await db.getAll('lists');
    expect(after.ok && after.value).toEqual(before.ok ? before.value : null);
  });
});

export type { Task };
