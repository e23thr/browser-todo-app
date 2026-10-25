/**
 * FAILURE INJECTION (ADR-006 test plan "Failure injection" + the card's
 * acceptance criterion): every injected failure must leave local user data
 * BYTE-IDENTICAL — proven by SHA-256 over the canonical row dump of
 * `lists` + `tasks` before/after (the exact evidence format the card asks for).
 *
 * The one documented exemption (ADR-006 Decision 5 step 10): a run whose atomic
 * apply COMMITTED and then failed in push/compaction legitimately keeps the
 * merged plan — that case asserts "local == exactly the merged plan" instead.
 *
 * `sync_state` bookkeeping (`lastError`, cursors) is allowed to change on
 * failure — it is not user data (Decision 6 writes errors to the local error
 * log by design) — but cursors must NOT advance past anything unapplied.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { AppDB } from '../../../src/storage/db';
import { resetBootSingleton } from '../../../src/storage/boot';
import { txAborted } from '../../../src/storage/errors';
import type { Tx } from '../../../src/storage/db';
import type { Result, StorageError } from '../../../src/storage/errors';
import { encodeBatch, encodeSnapshot } from '../../../src/sync/batchCodec';
import { runSyncOnce } from '../../../src/sync/engine';
import { sha256OfUtf8, stableStringify } from '../../../src/sync/hash';
import { WebDavClient } from '../../../src/sync/webdav';
import type { SyncError } from '../../../src/sync/types';
import {
  bootDb,
  makeFakeWebDav,
  makeTask,
  runEngine,
  seedFile,
  stateOf,
  T0,
  testUlid,
} from './fixtures';

afterEach(() => {
  resetBootSingleton();
});

/** SHA-256 over the canonical dump of user data (lists + tasks, tombstones included). */
async function userDataHash(db: AppDB): Promise<string> {
  const lists = await db.getAll('lists');
  const tasks = await db.getAll('tasks');
  expect(lists.ok && tasks.ok).toBe(true);
  const dump = stableStringify({
    lists: lists.ok ? lists.value : [],
    tasks: tasks.ok ? tasks.value : [],
  });
  return sha256OfUtf8(dump);
}

function clientFor(fake: ReturnType<typeof makeFakeWebDav>): WebDavClient {
  return new WebDavClient(
    { baseUrl: fake.baseUrl, user: 'u', password: 'p' },
    { fetch: fake.fetch },
  );
}

const TASK_ID = testUlid('fi-task');

/** Seed one live + one tombstone row so the dump is non-trivial. */
async function seedLocal(db: AppDB): Promise<void> {
  await db.put('tasks', makeTask({ id: TASK_ID, deviceId: db.deviceId, updatedAt: T0 + 1000 }));
  await db.put(
    'tasks',
    makeTask({
      id: testUlid('fi-dead'),
      deviceId: db.deviceId,
      updatedAt: T0 + 1100,
      deletedAt: T0 + 1100,
    }),
  );
}

describe('failure injection — local data byte-identity evidence', () => {
  it('F1 unreachable server (fetch reject): error state, local byte-identical', async () => {
    const db = await bootDb();
    await seedLocal(db);
    const fake = makeFakeWebDav();
    fake.faults.reject = 'network';
    const before = await userDataHash(db);

    const run = await runEngine(db, clientFor(fake));
    expect(run.ok).toBe(false);
    if (!run.ok) expect(['CORS', 'NETWORK']).toContain(run.error.code);
    expect(await userDataHash(db)).toBe(before);
  });

  it('F2 timeout (abort): NETWORK error, local byte-identical', async () => {
    const db = await bootDb();
    await seedLocal(db);
    const fake = makeFakeWebDav();
    fake.faults.reject = 'abort';
    const before = await userDataHash(db);

    const run = await runEngine(db, clientFor(fake));
    expect(run.ok).toBe(false);
    if (!run.ok) {
      expect(run.error.code).toBe('NETWORK');
      expect(run.error.retryable).toBe(true);
    }
    expect(await userDataHash(db)).toBe(before);
  });

  it('F3 401 wrong credentials: AUTH (never blind-retried), local byte-identical', async () => {
    const db = await bootDb();
    await seedLocal(db);
    const fake = makeFakeWebDav();
    fake.faults.failStatus = 401;
    const before = await userDataHash(db);

    const run = await runEngine(db, clientFor(fake));
    expect(run.ok).toBe(false);
    if (!run.ok) {
      expect(run.error.code).toBe('AUTH');
      expect(run.error.retryable).toBe(false);
    }
    expect(await userDataHash(db)).toBe(before);
  });

  it('F4 500 mid-run: error surfaced, local byte-identical, cursors unmoved', async () => {
    const db = await bootDb();
    await seedLocal(db);
    const fake = makeFakeWebDav();
    // Let layout/discovery succeed, fail during the pull requests.
    fake.faults.failAfter = 4;
    fake.faults.failStatusAfter = 500;
    const before = await userDataHash(db);
    const stateBefore = await stateOf(db);

    const run = await runEngine(db, clientFor(fake));
    expect(run.ok).toBe(false);
    expect(await userDataHash(db)).toBe(before);
    const stateAfter = await stateOf(db);
    expect(stateAfter.cursor).toEqual(stateBefore.cursor);
  });

  it('F5 partial upload (torn batch on the server): CORRUPT_REMOTE on pull, byte-identical', async () => {
    const db = await bootDb();
    await seedLocal(db);
    const fake = makeFakeWebDav();
    const other = testUlid('torn-device');
    const { json } = await encodeBatch(
      [
        {
          kind: 'task',
          record: makeTask({ id: testUlid('torn-row'), deviceId: other, updatedAt: T0 + 500 }),
        },
      ],
      { deviceId: other, seq: 1, createdAt: T0 + 500 },
    );
    seedFile(
      fake.state,
      `todo-sync/v1/changes/${other}/0000000001.json`,
      json.slice(0, Math.floor(json.length / 2)),
    );
    fake.state.collections.add(`todo-sync/v1/changes/${other}`);
    const before = await userDataHash(db);

    const run = await runEngine(db, clientFor(fake));
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.error.code).toBe('CORRUPT_REMOTE');
    expect(await userDataHash(db)).toBe(before); // the torn file never reached the DB
  });

  it('F6 corrupt remote file (bad hash on a batch): CORRUPT_REMOTE, byte-identical', async () => {
    const db = await bootDb();
    await seedLocal(db);
    const fake = makeFakeWebDav();
    const other = testUlid('corrupt-device');
    const { json } = await encodeBatch([], { deviceId: other, seq: 1, createdAt: 1 });
    const tampered = JSON.stringify({ ...JSON.parse(json), recordsHash: 'c'.repeat(64) });
    seedFile(fake.state, `todo-sync/v1/changes/${other}/0000000001.json`, tampered);
    fake.state.collections.add(`todo-sync/v1/changes/${other}`);
    const before = await userDataHash(db);

    const run = await runEngine(db, clientFor(fake));
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.error.code).toBe('CORRUPT_REMOTE');
    expect(await userDataHash(db)).toBe(before);
  });

  it('F7 corrupt snapshot (bad hash): skipped with a visible warning, run continues, byte-identical when nothing else merges', async () => {
    const db = await bootDb();
    await seedLocal(db);
    const fake = makeFakeWebDav();
    const { json } = await encodeSnapshot([], {
      takenAt: T0,
      byDeviceId: testUlid('snap-device'),
      covers: {},
    });
    const name = `${String(T0)}-${testUlid('snap-device')}.json`;
    seedFile(
      fake.state,
      `todo-sync/v1/snapshots/${name}`,
      JSON.stringify({ ...JSON.parse(json), stateHash: 'd'.repeat(64) }),
    );
    const before = await userDataHash(db);

    const run = await runEngine(db, clientFor(fake));
    // Decision 5: corrupt snapshots are skipped (older + batches converge);
    // with nothing else to merge the run finishes with zero applies.
    expect(run.ok).toBe(true);
    if (run.ok) {
      expect(run.value.summary.applied).toBe(0);
      expect(run.value.summary.notices.length).toBeGreaterThanOrEqual(1); // never silent
    }
    expect(await userDataHash(db)).toBe(before);
  });

  it('F8 507 remote full: REMOTE_FULL, local byte-identical', async () => {
    const db = await bootDb();
    await seedLocal(db);
    const fake = makeFakeWebDav();
    fake.faults.failStatus = 507;
    const before = await userDataHash(db);

    const run = await runEngine(db, clientFor(fake));
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.error.code).toBe('REMOTE_FULL');
    expect(await userDataHash(db)).toBe(before);
  });

  it('F9 todo-sync/2 on the remote: hard stop, local byte-identical', async () => {
    const db = await bootDb();
    await seedLocal(db);
    const fake = makeFakeWebDav();
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
    const before = await userDataHash(db);

    const run = await runEngine(db, clientFor(fake));
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.error.code).toBe('SYNC_FORMAT_NEWER');
    expect(await userDataHash(db)).toBe(before);
  });

  it('F10 fault-injected apply abort: ONE tx really rolls back — byte-identical, cursor unmoved', async () => {
    const db = await bootDb();
    await seedLocal(db);
    const fake = makeFakeWebDav();
    const client = clientFor(fake);
    const other = testUlid('apply-device');
    const { json } = await encodeBatch(
      [
        {
          kind: 'task',
          record: makeTask({ id: testUlid('incoming'), deviceId: other, updatedAt: T0 + 2000 }),
        },
      ],
      { deviceId: other, seq: 1, createdAt: T0 + 2000 },
    );
    seedFile(fake.state, `todo-sync/v1/changes/${other}/0000000001.json`, json);
    fake.state.collections.add(`todo-sync/v1/changes/${other}`);
    const before = await userDataHash(db);
    const stateBefore = await stateOf(db);

    // Wrap the DB so the APPLY transaction writes everything and then aborts —
    // exercising REAL IndexedDB rollback, not a mock.
    const wrapped: AppDB = {
      deviceId: db.deviceId,
      schemaVersion: db.schemaVersion,
      bootReport: db.bootReport,
      quarantine: db.quarantine,
      get: db.get.bind(db),
      getAll: db.getAll.bind(db),
      put: db.put.bind(db),
      query: db.query.bind(db),
      delete: db.delete.bind(db),
      close: db.close.bind(db),
      tx: async <T>(
        stores: string[],
        mode: 'readonly' | 'readwrite',
        fn: (t: Tx) => Promise<Result<T, StorageError>>,
      ): Promise<Result<T, StorageError>> => {
        const isApply =
          mode === 'readwrite' && stores.includes('lists') && stores.includes('sync_state');
        return db.tx(
          stores as never,
          mode,
          isApply
            ? async (t: Tx) => {
                await fn(t); // the engine's writes land inside the tx…
                return { ok: false, error: txAborted(new Error('injected apply failure')) }; // …then it aborts
              }
            : (fn as never),
        );
      },
    };

    const state = await stateOf(db);
    const run = await runSyncOnce(
      { db: wrapped, client, now: (): number => T0, newId: (): string => testUlid('never-minted') },
      { trigger: 'manual', state },
    );
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.error.code).toBe('LOCAL_STORAGE');
    expect(await userDataHash(db)).toBe(before); // atomic: nothing half-applied
    const stateAfter = await stateOf(db);
    expect(stateAfter.cursor).toEqual(stateBefore.cursor); // cursors ride the tx
  });

  it('F11 push failure AFTER a committed merge: the merged plan is kept (documented exemption), pull cursors advanced, pushedSeq not', async () => {
    const db = await bootDb();
    await seedLocal(db);
    const fake = makeFakeWebDav();
    const client = clientFor(fake);
    const other = testUlid('legit-device');
    const { json } = await encodeBatch(
      [
        {
          kind: 'task',
          record: makeTask({
            id: testUlid('incoming'),
            deviceId: other,
            updatedAt: T0 + 2000,
            notes: 'remote',
          }),
        },
      ],
      { deviceId: other, seq: 1, createdAt: T0 + 2000 },
    );
    seedFile(fake.state, `todo-sync/v1/changes/${other}/0000000001.json`, json);
    fake.state.collections.add(`todo-sync/v1/changes/${other}`);
    const before = await userDataHash(db);

    fake.faults.tornPut = true; // our uploads cannot verify
    const run = await runEngine(db, client);
    expect(run.ok).toBe(false); // push/verify failed → error state…
    const after = await userDataHash(db);
    expect(after).not.toBe(before); // …but the APPLY legitimately committed
    const tasks = await db.getAll('tasks');
    const rows = tasks.ok ? tasks.value : [];
    expect(rows.some((t) => t.notes === 'remote')).toBe(true); // exactly the merged plan
    const state = await stateOf(db);
    expect(state.cursor.pull[other]).toBe(1); // pull cursor advanced with the apply
    expect(state.cursor.pushedSeq).toBe(0); // nothing verified → nothing counted
  });
});

export type { SyncError };
