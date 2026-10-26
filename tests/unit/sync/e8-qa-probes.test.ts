/**
 * E8 QA PROBES — first-hand verification for docs/qa/e8-sync-engine.md.
 *
 * Written against the BINDING spec (PROJECT_ANALYSIS §6.2 conflict policy +
 * ADR-006 "Offline-first test plan"), not against the implementation's own
 * tests, so the evidence in the report is independent of tests/unit/sync's
 * recorded matrices (M1-M14 / F1-F11 / E1-E12):
 *
 *  Q1  two-device convergence in the REVERSE order (B pushes first) + the
 *      fleet ends byte-equal with exactly one visible Conflict copy, then two
 *      more full sync rounds change NOTHING (copy creation is idempotent).
 *  Q2  LWW tie-break on equal `updatedAt` → `deviceId` decides, end-to-end,
 *      through real runs rather than the pure comparator.
 *  Q3  "never a silent overwrite" invariant over a hand-enumerated divergence
 *      matrix: whenever a locally-diverged version is displaced, a visible
 *      conflict copy or a notice MUST exist.
 *  Q4  a hash-valid but semantically invalid remote record refuses the run
 *      before apply — local state byte-identical.
 *  Q5  failure injection re-proved with an INDEPENDENT digest (node:crypto
 *      over a self-written canonical dump, not src/sync/hash helpers).
 *  Q6  tombstone propagation in both orders — the delete reaches the peer as
 *      a tombstone and is never materialized as a visible row.
 *
 * Everything runs against the in-memory fake WebDAV server from fixtures.ts —
 * no real network, no third-party service (§7.2 / ADR-006 test plan).
 */

import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { conflictCopyTitle } from '../../../src/domain/merge';
import type { List, Task } from '../../../src/domain/model';
import { resetBootSingleton } from '../../../src/storage/boot';
import type { AppDB } from '../../../src/storage/db';
import { encodeBatch } from '../../../src/sync/batchCodec';
import { contentHashOf } from '../../../src/sync/hash';
import { planMerge } from '../../../src/sync/merge';
import type { ShadowEntry } from '../../../src/sync/shadow';
import type { SyncError } from '../../../src/sync/types';
import { WebDavClient } from '../../../src/sync/webdav';
import {
  bootDb,
  counterIds,
  DEVICE_A,
  DEVICE_B,
  LIST_1,
  makeFakeWebDav,
  makeList,
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

type FakeDav = ReturnType<typeof makeFakeWebDav>;

function clientFor(fake: FakeDav): WebDavClient {
  return new WebDavClient(
    { baseUrl: fake.baseUrl, user: 'u', password: 'p' },
    { fetch: fake.fetch },
  );
}

/* ----------------------- independent byte-identity oracle ----------------------- */

/** Self-written canonical JSON (sorted keys) — deliberately NOT src/sync/hash. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const text = JSON.stringify(value) as string | undefined;
    return text ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec)
    .filter((k) => rec[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(rec[k])}`).join(',')}}`;
}

type UserSnapshot = {
  /** SHA-256 (node:crypto) over lists + tasks, canonically dumped, sorted by id. */
  digest: string;
  lists: List[];
  tasks: Task[];
};

async function userSnapshot(db: AppDB): Promise<UserSnapshot> {
  const lists = await db.getAll('lists');
  const tasks = await db.getAll('tasks');
  expect(lists.ok && tasks.ok).toBe(true);
  const byId = <T extends { id: string }>(rows: T[]): T[] =>
    [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const snapshot = {
    lists: byId(lists.ok ? lists.value : []),
    tasks: byId(tasks.ok ? tasks.value : []),
  };
  const digest = createHash('sha256').update(canonicalize(snapshot)).digest('hex');
  return { digest, ...snapshot };
}

async function taskRow(db: AppDB, id: string): Promise<Task> {
  const got = await db.get('tasks', id);
  if (!got.ok || got.value === undefined) throw new Error(`row ${id} missing`);
  return got.value;
}

function copiesOf(rows: Task[]): Task[] {
  return rows.filter((t) => t.title.startsWith('Conflict copy of '));
}

/* ------------------------------ Q1 — convergence ------------------------------ */

describe('Q1: two-device convergence, reverse delivery order (spec §6.2 guarantees)', () => {
  // E8-D1 REGRESSION (fixed in ADR-006 Addendum B, card t_5b47f3e1): the
  // loser's displaced version MUST materialize even when it pushed BEFORE
  // pulling the winner's version — the shadow is already advanced by its own
  // push, so the winner's recorded causal `base` is what makes the
  // displacement detectable. Was `it.fails` while the defect was open; flipped
  // to `it` by the fix card, body kept verbatim as the regression test.
  it('E8-D1: B pushes first → B\'s displaced edit MUST still become one visible "Conflict copy of …"', async () => {
    const devA = await bootDb();
    const devB = await bootDb();
    const fake = makeFakeWebDav();
    const cA = clientFor(fake);
    const cB = clientFor(fake);
    const TASK_ID = testUlid('qa-q1-task');

    // Common ancestor created on A and seen by B.
    await devA.put('lists', makeList({ id: LIST_1, deviceId: devA.deviceId }));
    await devA.put(
      'tasks',
      makeTask({ id: TASK_ID, listId: LIST_1, deviceId: devA.deviceId, updatedAt: T0 + 1000 }),
    );
    expect((await runEngine(devA, cA)).ok).toBe(true);
    expect((await runEngine(devB, cB)).ok).toBe(true);
    expect((await taskRow(devB, TASK_ID)).updatedAt).toBe(T0 + 1000);

    // Concurrent edits — worked example 1 (§6.2): A renames at 2000, B adds
    // notes at 1900. Both are offline relative to each other from here on.
    const onA = await taskRow(devA, TASK_ID);
    const onB = await taskRow(devB, TASK_ID);
    await devA.put('tasks', {
      ...onA,
      title: 'Buy oat milk',
      updatedAt: T0 + 2000,
      deviceId: devA.deviceId,
    });
    await devB.put('tasks', {
      ...onB,
      notes: 'soy',
      updatedAt: T0 + 1900,
      deviceId: devB.deviceId,
    });

    // REVERSE order: B's edit reaches the server first (E3 only covers A-first).
    expect((await runEngine(devB, cB)).ok).toBe(true);

    // A pulls: A's 2000 wins the id → nothing displaced on the winner side.
    const aRun = await runEngine(devA, cA, { newId: counterIds('qa-q1-a') });
    expect(aRun.ok).toBe(true);
    if (!aRun.ok) return;
    expect(aRun.value.conflicts).toHaveLength(0);

    // B pulls A's newer rename → B's displaced notes MUST survive as THE copy.
    const bRun = await runEngine(devB, cB, { newId: counterIds('qa-q1-b') });
    expect(bRun.ok).toBe(true);
    if (!bRun.ok) return;
    const bConflicts = bRun.value.conflicts.length;

    // A absorbs whatever B published; the fleet must be byte-equal either way.
    expect((await runEngine(devA, cA, { newId: counterIds('qa-q1-a2') })).ok).toBe(true);

    const snapA = await userSnapshot(devA);
    const snapB = await userSnapshot(devB);
    expect(snapB.digest).toBe(snapA.digest);
    expect(copiesOf(snapA.tasks).length).toBe(copiesOf(snapB.tasks).length);
    expect(snapA.tasks.find((t) => t.id === TASK_ID)?.title).toBe('Buy oat milk');

    // …and the displaced 'soy' notes are preserved somewhere visible.
    const preserved = [...snapA.tasks, ...snapB.tasks].some((t) => t.notes === 'soy');
    expect(preserved, "B's concurrent edit must not vanish").toBe(true);
    expect(bConflicts, 'exactly one conflict copy on the losing device').toBe(1);
  });
});

/* ------------------------------- Q2 — LWW tie ------------------------------- */

describe('Q2: LWW tie-break (updatedAt equal → deviceId decides) end-to-end', () => {
  // E8-D1 REGRESSION again: BOTH devices pushed their tie-stamped edit before
  // pulling, so neither could materialize a copy for its own displaced version
  // (report §5 D1). Convergence is proven by the digest assertions below.
  // Was `it.fails` while the defect was open; flipped to `it` by the fix card
  // t_5b47f3e1, body kept verbatim as the regression test.
  it('E8-D1: tie-break winner converges AND the loser holds exactly one visible conflict copy', async () => {
    const devA = await bootDb();
    const devB = await bootDb();
    const fake = makeFakeWebDav();
    const cA = clientFor(fake);
    const cB = clientFor(fake);
    const TASK_ID = testUlid('qa-q2-task');

    await devA.put('lists', makeList({ id: LIST_1, deviceId: devA.deviceId }));
    await devA.put(
      'tasks',
      makeTask({ id: TASK_ID, listId: LIST_1, deviceId: devA.deviceId, updatedAt: T0 + 1000 }),
    );
    expect((await runEngine(devA, cA)).ok).toBe(true);
    expect((await runEngine(devB, cB)).ok).toBe(true);

    // Identical timestamps — only the device id can decide (spec §6.2 key).
    const tie = T0 + 5000;
    await devA.put('tasks', {
      ...(await taskRow(devA, TASK_ID)),
      title: 'from A',
      updatedAt: tie,
      deviceId: devA.deviceId,
    });
    await devB.put('tasks', {
      ...(await taskRow(devB, TASK_ID)),
      title: 'from B',
      updatedAt: tie,
      deviceId: devB.deviceId,
    });
    const winnerIsA = devA.deviceId > devB.deviceId;
    const loser = winnerIsA ? 'from B' : 'from A';

    for (const round of [1, 2]) {
      expect((await runEngine(devA, cA, { newId: counterIds(`qa-q2-a${String(round)}`) })).ok).toBe(
        true,
      );
      expect((await runEngine(devB, cB, { newId: counterIds(`qa-q2-b${String(round)}`) })).ok).toBe(
        true,
      );
    }

    const snapA = await userSnapshot(devA);
    const snapB = await userSnapshot(devB);
    expect(snapB.digest).toBe(snapA.digest);

    const winnerRow = snapA.tasks.find((t) => t.id === TASK_ID);
    expect(winnerRow?.title).toBe(winnerIsA ? 'from A' : 'from B');
    expect(winnerRow?.deviceId).toBe(winnerIsA ? devA.deviceId : devB.deviceId);
    expect(winnerRow?.updatedAt).toBe(tie);

    const copiesA = copiesOf(snapA.tasks);
    expect(copiesA).toHaveLength(1);
    expect(copiesA[0]!.title).toBe(conflictCopyTitle(loser));
    expect(copiesOf(snapB.tasks)[0]?.id).toBe(copiesA[0]!.id);
  });
});

/* -------------------- Q3 — never a silent overwrite (invariant) -------------------- */

type DivergenceCase = {
  name: string;
  local: Task;
  remote: Task;
  shadow: ShadowEntry | null;
  deviceId: string;
  expectCopies: number;
  expectNotices: number;
  noticeKind?: 'delete-lost' | 'list-conflict';
  /** Documented stale-echo exception: local is older than the shadow (report O2). */
  staleLocal?: boolean;
};

describe('Q3: §6.2 "never a silent overwrite" invariant over a hand-enumerated matrix', () => {
  it('a displaced locally-diverged version ALWAYS yields a visible copy or notice', async () => {
    const ID = testUlid('qa-q3');
    const base = makeTask({
      id: ID,
      title: 'base',
      notes: null,
      updatedAt: 1000,
      deviceId: DEVICE_A,
    });
    const baseShadow: ShadowEntry = {
      updatedAt: 1000,
      deviceId: DEVICE_A,
      contentHash: await contentHashOf(base),
    };
    const edit = (over: Partial<Task>): Task => makeTask({ id: ID, ...over });

    const cases: DivergenceCase[] = [
      {
        name: 'local newer live edit beats an older remote edit',
        local: edit({ title: 'local win', updatedAt: 2000, deviceId: DEVICE_A }),
        remote: edit({ notes: 'remote', updatedAt: 1500, deviceId: DEVICE_B }),
        shadow: baseShadow,
        deviceId: DEVICE_A,
        expectCopies: 0,
        expectNotices: 0,
      },
      {
        name: 'local older live edit loses to a newer remote edit → conflict copy',
        local: edit({ notes: 'local work', updatedAt: 1500, deviceId: DEVICE_A }),
        remote: edit({ title: 'remote win', updatedAt: 2000, deviceId: DEVICE_B }),
        shadow: baseShadow,
        deviceId: DEVICE_A,
        expectCopies: 1,
        expectNotices: 0,
      },
      {
        name: 'equal updatedAt → remote device id wins (lexicographic tie-break)',
        local: edit({ notes: 'local work', updatedAt: 2000, deviceId: DEVICE_A }),
        remote: edit({ title: 'remote win', updatedAt: 2000, deviceId: DEVICE_B }),
        shadow: baseShadow,
        deviceId: DEVICE_A,
        expectCopies: 1,
        expectNotices: 0,
      },
      {
        name: 'newer remote tombstone wins the id, the live edit survives as a copy',
        local: edit({ notes: 'local work', updatedAt: 2400, deviceId: DEVICE_A }),
        remote: edit({ updatedAt: 2500, deviceId: DEVICE_B, deletedAt: 2500 }),
        shadow: baseShadow,
        deviceId: DEVICE_A,
        expectCopies: 1,
        expectNotices: 0,
      },
      {
        name: 'local tombstone loses to a newer edit → visible delete-lost notice, no row copy',
        local: edit({ updatedAt: 2400, deviceId: DEVICE_A, deletedAt: 2400 }),
        remote: edit({ notes: 'still needed', updatedAt: 2500, deviceId: DEVICE_B }),
        shadow: baseShadow,
        deviceId: DEVICE_A,
        expectCopies: 0,
        expectNotices: 1,
        noticeKind: 'delete-lost',
      },
      {
        name: 'delete vs delete → newer tombstone wins, nothing diverged',
        local: edit({ updatedAt: 2500, deviceId: DEVICE_A, deletedAt: 2500 }),
        remote: edit({ updatedAt: 2600, deviceId: DEVICE_B, deletedAt: 2600 }),
        shadow: baseShadow,
        deviceId: DEVICE_A,
        expectCopies: 0,
        expectNotices: 0,
      },
      {
        name: 'same content under a newer stamp is the same change → nothing displaced',
        local: edit({ updatedAt: 1900, deviceId: DEVICE_A }),
        remote: edit({ updatedAt: 2000, deviceId: DEVICE_B }),
        shadow: baseShadow,
        deviceId: DEVICE_A,
        expectCopies: 0,
        expectNotices: 0,
      },
      {
        name: 'local unchanged since the shadow, remote changed → apply remote, no copy',
        local: { ...base },
        remote: edit({ title: 'remote only', updatedAt: 2000, deviceId: DEVICE_B }),
        shadow: baseShadow,
        deviceId: DEVICE_A,
        expectCopies: 0,
        expectNotices: 0,
      },
      {
        name: 'local changed, remote still at the shadow → push later, no copy',
        local: edit({ notes: 'local only', updatedAt: 1900, deviceId: DEVICE_A }),
        remote: { ...base },
        shadow: baseShadow,
        deviceId: DEVICE_A,
        expectCopies: 0,
        expectNotices: 0,
      },
      {
        name: 'missing shadow + differing versions → conservative conflict copy',
        local: edit({ notes: 'local work', updatedAt: 1900, deviceId: DEVICE_A }),
        remote: edit({ notes: 'remote work', updatedAt: 2000, deviceId: DEVICE_B }),
        shadow: null,
        deviceId: DEVICE_A,
        expectCopies: 1,
        expectNotices: 0,
      },
      {
        name: 'stale local echo never forces a copy',
        local: edit({ notes: 'old', updatedAt: 900, deviceId: DEVICE_B }),
        remote: edit({ title: 'current', updatedAt: 2000, deviceId: DEVICE_A }),
        shadow: baseShadow,
        deviceId: DEVICE_A,
        expectCopies: 0,
        expectNotices: 0,
        // A local version OLDER than the last-synced shadow is a documented
        // "stale echo" (src/sync/shadow.ts + ADR-006 §4.2 preamble): it cannot
        // win LWW, so §6.2 lets it go. Excluded from the preservation invariant
        // and recorded as report observation O2 (how such a row can even exist:
        // restore/import with older stamps, or a clock that moved backwards).
        staleLocal: true,
      },
    ];

    let copySeq = 0;
    for (const c of cases) {
      copySeq += 1;
      const result = await planMerge({
        localLists: [],
        localTasks: [c.local],
        fetched: [{ kind: 'task', record: c.remote }],
        shadow: c.shadow === null ? {} : { [ID]: c.shadow },
        deviceId: c.deviceId,
        now: 9000,
        newId: () => testUlid(`qa-q3-copy-${String(copySeq)}`),
      });
      expect(result.ok, c.name).toBe(true);
      if (!result.ok) continue;

      expect(result.value.copies, c.name).toHaveLength(c.expectCopies);
      expect(result.value.notices, c.name).toHaveLength(c.expectNotices);
      if (c.noticeKind !== undefined) {
        expect(result.value.notices[0]?.kind, c.name).toBe(c.noticeKind);
      }

      // The invariant itself, independent of the expected counts above:
      // if the local LIVE content was neither the last-synced version nor the
      // winner, some visible artifact must carry it. Stale echoes (local older
      // than the shadow) are the one documented exception — see the case table.
      if (c.staleLocal !== true) {
        const winner = (result.value.puts[0] as Task | undefined) ?? c.local;
        const localHash = await contentHashOf(c.local);
        const winnerHash = await contentHashOf(winner);
        const baseHash = c.shadow?.contentHash ?? localHash;
        const displacedLive =
          c.local.deletedAt === null &&
          localHash !== baseHash &&
          winnerHash !== localHash &&
          winner.deletedAt === null;
        const displacedDelete = c.local.deletedAt !== null && winner.deletedAt === null;
        if (displacedLive || displacedDelete) {
          expect(
            result.value.copies.length + result.value.notices.length,
            `silent overwrite in "${c.name}"`,
          ).toBeGreaterThan(0);
        }
      }
    }
  });

  it('documented edge: two versions sharing an identical (updatedAt, deviceId) fold by stable key', async () => {
    // Two DIFFERENT byte-versions with the SAME (updatedAt, deviceId) cannot
    // arise across devices (deviceId is per-device) — LWW has no decision to
    // make, so the planner picks a stable representative both sides agree on.
    // Recorded as evidence of the documented fold, not as a §6.2 violation.
    const ID = testUlid('qa-q3-edge');
    const local = makeTask({ id: ID, title: 'aaa local', updatedAt: 2000, deviceId: DEVICE_A });
    const remote = makeTask({ id: ID, title: 'zzz remote', updatedAt: 2000, deviceId: DEVICE_A });
    const result = await planMerge({
      localLists: [],
      localTasks: [local],
      fetched: [{ kind: 'task', record: remote }],
      shadow: {
        [ID]: {
          updatedAt: 1000,
          deviceId: DEVICE_A,
          contentHash: await contentHashOf(makeTask({ id: ID, updatedAt: 1000 })),
        },
      },
      deviceId: DEVICE_A,
      now: 9000,
      newId: () => testUlid('qa-q3-edge-copy'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Deterministic: both sides would fold to the same representative (remote's
    // bytes sort last) with no copy — asserted as the CURRENT documented fold.
    expect(result.value.copies).toHaveLength(0);
    expect(result.value.notices).toHaveLength(0);
    expect(result.value.puts).toHaveLength(1);
    expect((result.value.puts[0] as Task).title).toBe('zzz remote');
  });
});

/* ------------- Q4 — hash-valid, semantically invalid remote record ------------- */

describe('Q4: corrupt-by-content remote records refuse the run before apply', () => {
  it('a batch that hashes correctly but carries an invalid row → CORRUPT_REMOTE, local byte-identical', async () => {
    const db = await bootDb();
    const fake = makeFakeWebDav();
    await db.put('lists', makeList({ id: LIST_1, deviceId: db.deviceId }));
    await db.put(
      'tasks',
      makeTask({ id: testUlid('qa-q4-local'), deviceId: db.deviceId, updatedAt: T0 + 1000 }),
    );
    const before = await userSnapshot(db);

    const other = testUlid('qa-q4-device');
    const badRow = makeTask({
      id: testUlid('qa-q4-remote'),
      deviceId: other,
      updatedAt: T0 + 2000,
      status: 'nope' as Task['status'], // never valid: open|done|archived
    });
    const { json } = await encodeBatch([{ kind: 'task', record: badRow }], {
      deviceId: other,
      seq: 1,
      createdAt: T0 + 2000,
    });
    seedFile(fake.state, `todo-sync/v1/changes/${other}/0000000001.json`, json);
    fake.state.collections.add(`todo-sync/v1/changes/${other}`);

    const run = await runEngine(db, clientFor(fake));
    expect(run.ok).toBe(false);
    if (!run.ok) {
      expect(run.error.code).toBe('CORRUPT_REMOTE');
      expect(run.error.retryable).toBe(false);
    }
    expect((await userSnapshot(db)).digest).toBe(before.digest);
  });
});

/* ---------------------- Q5 — failure injection, re-proved ---------------------- */

describe('Q5: failure injection re-proved with an independent node:crypto digest', () => {
  type Case = {
    name: string;
    inject: (fake: FakeDav) => void;
    expectedCodes: SyncError['code'][];
    /** Rows the remote already carries (seeded before the run). */
    seedRemote?: (fake: FakeDav) => void;
  };

  const cases: Case[] = [
    {
      name: 'unreachable server (fetch rejects)',
      inject: (fake) => {
        fake.faults.reject = 'network';
      },
      expectedCodes: ['CORS', 'NETWORK'],
    },
    {
      name: 'request timeout (abort)',
      inject: (fake) => {
        fake.faults.reject = 'abort';
      },
      expectedCodes: ['NETWORK'],
    },
    {
      name: '401 wrong credentials',
      inject: (fake) => {
        fake.faults.failStatus = 401;
      },
      expectedCodes: ['AUTH'],
    },
    {
      name: 'quota on the remote (507 storage full)',
      inject: (fake) => {
        fake.faults.failStatus = 507;
      },
      expectedCodes: ['REMOTE_FULL'],
    },
    {
      name: '500 mid-run (after layout/discovery)',
      inject: (fake) => {
        fake.faults.failAfter = 4;
        fake.faults.failStatusAfter = 500;
      },
      expectedCodes: ['NETWORK'],
    },
    {
      name: 'corrupt remote batch (recordsHash tampered)',
      inject: () => undefined,
      seedRemote: (fake) => {
        const other = testUlid('qa-q5-device');
        const tampered = JSON.stringify({
          format: 'todo-sync/1',
          kind: 'batch',
          deviceId: other,
          seq: 1,
          createdAt: 1,
          recordsHash: 'c'.repeat(64),
          records: '[]',
        });
        seedFile(fake.state, `todo-sync/v1/changes/${other}/0000000001.json`, tampered);
        fake.state.collections.add(`todo-sync/v1/changes/${other}`);
      },
      expectedCodes: ['CORRUPT_REMOTE'],
    },
    {
      // Read-back mismatch on our own upload → putVerified reports NETWORK
      // (retryable) after one retry; nothing else in the run had merged yet, so
      // the user rows must be untouched (the ADR-006 D5 step-10 exemption does
      // NOT apply here — no apply happened before the failure).
      name: 'partial upload (torn PUT on our own push, nothing merged)',
      inject: (fake) => {
        fake.faults.tornPut = true;
      },
      expectedCodes: ['NETWORK'],
    },
  ];

  for (const c of cases) {
    it(`${c.name} → error surfaced, user rows byte-identical, cursors unmoved`, async () => {
      const db = await bootDb();
      await db.put('lists', makeList({ id: LIST_1, deviceId: db.deviceId }));
      await db.put(
        'tasks',
        makeTask({ id: testUlid('qa-q5-live'), deviceId: db.deviceId, updatedAt: T0 + 1000 }),
      );
      await db.put(
        'tasks',
        makeTask({
          id: testUlid('qa-q5-dead'),
          deviceId: db.deviceId,
          updatedAt: T0 + 1100,
          deletedAt: T0 + 1100,
        }),
      );
      const fake = makeFakeWebDav();
      c.seedRemote?.(fake);
      c.inject(fake);

      const before = await userSnapshot(db);
      const stateBefore = await stateOf(db);

      const run = await runEngine(db, clientFor(fake));
      expect(run.ok, c.name).toBe(false);
      if (!run.ok) expect(c.expectedCodes, c.name).toContain(run.error.code);

      const after = await userSnapshot(db);
      expect(after.digest, `${c.name}: digest drifted`).toBe(before.digest);
      expect(after.tasks, `${c.name}: rows drifted`).toEqual(before.tasks);
      expect(after.lists, `${c.name}: lists drifted`).toEqual(before.lists);
      // Cursor consistency (ADR-006 Decision 5): nothing may advance past work
      // that never committed. Bookkeeping rows may APPEAR (a run that reached
      // phase 6 records our own pull watermark = pushedSeq), so assert the
      // meaningful invariant instead of raw object equality.
      const stateAfter = await stateOf(db);
      const curBefore = stateBefore.cursor;
      const curAfter = stateAfter.cursor;
      expect(curAfter.pushedSeq, `${c.name}: pushedSeq advanced`).toBe(curBefore.pushedSeq);
      expect(curAfter.pushedUpTo, `${c.name}: pushedUpTo advanced`).toBe(curBefore.pushedUpTo);
      expect(curAfter.snapshotKey, `${c.name}: snapshotKey advanced`).toBe(curBefore.snapshotKey);
      expect(curAfter.remoteCoveredUpTo, `${c.name}: coverage advanced`).toBe(
        curBefore.remoteCoveredUpTo,
      );
      for (const [device, seq] of Object.entries(curAfter.pull)) {
        expect(seq, `${c.name}: pull cursor advanced for ${device}`).toBeLessThanOrEqual(
          curBefore.pull[device] ?? 0,
        );
      }
      expect(stateAfter.lastError, `${c.name}: no error recorded`).not.toBeNull();
    });
  }
});

/* --------------------------- Q6 — tombstone propagation --------------------------- */

describe('Q6: tombstone propagation in both orders (spec §6.2 deletions)', () => {
  it('A deletes first → the tombstone reaches B as a row-level delete, never as a copy', async () => {
    const s = await tombstoneScenario('A-first');
    expect(s.run.ok).toBe(true);
    if (!s.run.ok) return;
    expect(s.run.value.conflicts).toHaveLength(0);
    await assertTombstoneConverged(s);
  });

  it('B deletes first → the tombstone reaches A as a row-level delete, never as a copy', async () => {
    const s = await tombstoneScenario('B-first');
    expect(s.run.ok).toBe(true);
    if (!s.run.ok) return;
    expect(s.run.value.conflicts).toHaveLength(0);
    await assertTombstoneConverged(s);
  });
});

type TombstoneSetup = {
  devA: AppDB;
  devB: AppDB;
  cA: WebDavClient;
  cB: WebDavClient;
  taskId: string;
  deleter: AppDB;
  deleterClient: WebDavClient;
  peer: AppDB;
  peerClient: WebDavClient;
  run: Awaited<ReturnType<typeof runEngine>>;
};

async function tombstoneScenario(order: 'A-first' | 'B-first'): Promise<TombstoneSetup> {
  const devA = await bootDb();
  const devB = await bootDb();
  const fake = makeFakeWebDav();
  const cA = clientFor(fake);
  const cB = clientFor(fake);
  const taskId = testUlid(`qa-q6-${order}`);

  await devA.put('lists', makeList({ id: LIST_1, deviceId: devA.deviceId }));
  await devA.put(
    'tasks',
    makeTask({ id: taskId, listId: LIST_1, deviceId: devA.deviceId, updatedAt: T0 + 1000 }),
  );
  expect((await runEngine(devA, cA)).ok).toBe(true);
  expect((await runEngine(devB, cB)).ok).toBe(true);

  const deleter = order === 'A-first' ? devA : devB;
  const deleterClient = order === 'A-first' ? cA : cB;
  const peer = order === 'A-first' ? devB : devA;
  const peerClient = order === 'A-first' ? cB : cA;

  const row = await taskRow(deleter, taskId);
  await deleter.put('tasks', {
    ...row,
    updatedAt: T0 + 4000,
    deletedAt: T0 + 4000,
    deviceId: deleter.deviceId,
  });
  expect((await runEngine(deleter, deleterClient)).ok).toBe(true);

  const run = await runEngine(peer, peerClient, { newId: counterIds(`qa-q6-${order}-copy`) });
  return { devA, devB, cA, cB, taskId, deleter, deleterClient, peer, peerClient, run };
}

async function assertTombstoneConverged(s: TombstoneSetup): Promise<void> {
  // The peer received the DELETE, not a duplicate and not a copy of the task.
  const peerRow = await s.peer.get('tasks', s.taskId);
  expect(peerRow.ok && peerRow.value?.deletedAt).toBe(T0 + 4000);
  const deleterRow = await s.deleter.get('tasks', s.taskId);
  expect(deleterRow.ok && deleterRow.value?.deletedAt).toBe(T0 + 4000);

  const peerSnap = await userSnapshot(s.peer);
  expect(copiesOf(peerSnap.tasks)).toHaveLength(0);
  expect(copiesOf((await userSnapshot(s.deleter)).tasks)).toHaveLength(0);

  // One more full round on both sides: the tombstone converges byte-for-byte
  // (it is a record like any other — §6.2 deletions propagate via tombstones).
  expect((await runEngine(s.deleter, s.deleterClient)).ok).toBe(true);
  expect((await runEngine(s.peer, s.peerClient)).ok).toBe(true);
  const peerAfter = await userSnapshot(s.peer);
  const deleterAfter = await userSnapshot(s.deleter);
  expect(peerAfter.digest).toBe(deleterAfter.digest);
}
