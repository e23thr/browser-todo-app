/**
 * RECORDED MERGE TEST MATRIX (ADR-006 "Offline-first test plan" item 1 —
 * normative for impl/test cards). Table-driven over the exact scenarios of the
 * §6.2 worked example and Decision 4.2's case table. Every row is a promise the
 * binding conflict policy makes; changing an expectation means changing the
 * PRE-DECIDED policy — which is forbidden.
 */

import { describe, expect, it } from 'vitest';

import { compareLww, conflictCopyTitle } from '../../../src/domain/merge';
import type { Task } from '../../../src/domain/model';
import { planMerge } from '../../../src/sync/merge';
import type { MergeInput } from '../../../src/sync/merge';
import { classifyDivergence, divergedSince } from '../../../src/sync/shadow';
import { contentHashOf } from '../../../src/sync/hash';
import type { SyncRecord } from '../../../src/sync/types';
import { DEVICE_A, DEVICE_B, LIST_1, makeList, makeTask, testUlid } from './fixtures';

const TASK_ID = testUlid('task-1');
const SHADOW_ID = testUlid('shadow-task');

async function hash(row: Task | ReturnType<typeof makeList>): Promise<string> {
  return contentHashOf(row);
}

let copyCounter = 0;
function newId(): string {
  copyCounter += 1;
  return testUlid(`copy-${String(copyCounter)}`);
}

async function plan(
  partial: Partial<MergeInput> & Pick<MergeInput, 'localTasks'>,
): Promise<Awaited<ReturnType<typeof planMerge>>> {
  return planMerge({
    localLists: [],
    fetched: [],
    shadow: {},
    deviceId: DEVICE_A,
    now: 9000,
    newId,
    ...partial,
  });
}

describe('merge matrix (recorded — ADR-006 test plan item 1)', () => {
  it('M1: LWW — greater updatedAt wins; the winner keeps its stamps byte-for-byte', async () => {
    // §6.2 worked example 1 verbatim: A renames to "Buy oat milk" at 2000;
    // B, offline, adds notes at 1900 keeping the title "Buy milk".
    const local = makeTask({
      id: TASK_ID,
      updatedAt: 1900,
      deviceId: DEVICE_B,
      title: 'Buy milk',
      notes: 'soy',
    });
    const remote = makeTask({
      id: TASK_ID,
      updatedAt: 2000,
      deviceId: DEVICE_A,
      title: 'Buy oat milk',
    });
    const result = await plan({
      localTasks: [local],
      fetched: [{ kind: 'task', record: remote }],
      shadow: {
        [TASK_ID]: {
          updatedAt: 1000,
          deviceId: DEVICE_A,
          contentHash: await hash(makeTask({ id: TASK_ID })),
        },
      },
      deviceId: DEVICE_B,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Worked example 1: B pulls A's rename — R (2000) wins the id with A's
    // stamps preserved; B's 1900 edit is displaced → materialized as the copy.
    expect(result.value.puts).toHaveLength(1);
    const winner = result.value.puts[0] as Task;
    expect(winner.title).toBe('Buy oat milk');
    expect(winner.updatedAt).toBe(2000);
    expect(winner.deviceId).toBe(DEVICE_A);
    expect(result.value.copies).toHaveLength(1);
    const copy = result.value.copies[0]!;
    expect(copy.row.title).toBe('Conflict copy of Buy milk');
    expect(copy.row.notes).toBe('soy'); // carrying B's notes
    expect(copy.row.deletedAt).toBeNull();
    expect(copy.row.deviceId).toBe(DEVICE_B); // stamped with the copying device
    expect(copy.summary.lostTo).toEqual({ updatedAt: 2000, deviceId: DEVICE_A });
  });

  it('M2: LWW tie-break — equal updatedAt → greater deviceId lexicographically', () => {
    const a = { updatedAt: 2000, deviceId: DEVICE_A };
    const b = { updatedAt: 2000, deviceId: DEVICE_B };
    expect(compareLww(b, a)).toBeGreaterThan(0);
    expect(compareLww(a, b)).toBeLessThan(0);
    expect(compareLww(a, a)).toBe(0);
  });

  it('M3: worked example 2 — tie at updatedAt 2000 flips the copy to the losing device', async () => {
    // §6.2 worked example 2 verbatim: same scenario as M1 but BOTH edits land
    // at updatedAt 2000 — A renamed (kept locally), B added notes (remote).
    const local = makeTask({
      id: TASK_ID,
      updatedAt: 2000,
      deviceId: DEVICE_A,
      title: 'Buy oat milk',
    });
    const remote = makeTask({
      id: TASK_ID,
      updatedAt: 2000,
      deviceId: DEVICE_B,
      title: 'Buy milk',
      notes: 'soy',
    });
    const result = await plan({
      localTasks: [local],
      fetched: [{ kind: 'task', record: remote }],
      shadow: {
        [TASK_ID]: {
          updatedAt: 1000,
          deviceId: DEVICE_A,
          contentHash: await hash(makeTask({ id: TASK_ID })),
        },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // DEVICE_B > DEVICE_A lexicographically → the REMOTE wins; local A is the
    // loser and A materializes its own copy of the rename.
    const winner = result.value.puts[0] as Task;
    expect(winner.deviceId).toBe(DEVICE_B);
    expect(result.value.copies).toHaveLength(1);
    expect(result.value.copies[0]!.row.title).toBe(conflictCopyTitle('Buy oat milk'));
  });

  it('M4: delete-vs-edit (worked example 3) — tombstone wins the id; the edit survives as a copy', async () => {
    const tombstone = makeTask({
      id: TASK_ID,
      updatedAt: 2500,
      deviceId: DEVICE_A,
      title: 'Buy oat milk',
      deletedAt: 2500,
    });
    const edit = makeTask({
      id: TASK_ID,
      updatedAt: 2400,
      deviceId: DEVICE_B,
      title: 'Buy oat milk',
      notes: 'soy',
    });
    const result = await plan({
      localTasks: [edit], // B holds the edit
      fetched: [{ kind: 'task', record: tombstone }],
      shadow: {
        [TASK_ID]: {
          updatedAt: 1000,
          deviceId: DEVICE_A,
          contentHash: await hash(makeTask({ id: TASK_ID })),
        },
      },
      deviceId: DEVICE_B,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const winner = result.value.puts[0] as Task;
    expect(winner.deletedAt).toBe(2500); // tombstone outcome follows LWW on the id
    expect(result.value.copies).toHaveLength(1);
    const copy = result.value.copies[0]!.row;
    expect(copy.title).toBe(conflictCopyTitle('Buy oat milk'));
    expect(copy.notes).toBe('soy'); // the edit is never lost
    expect(copy.deletedAt).toBeNull();
  });

  it('M5: delete-vs-edit case (b) — newer edit wins the id; the displaced delete is a visible notice, never a row copy', async () => {
    const tombstone = makeTask({
      id: TASK_ID,
      updatedAt: 2400,
      deviceId: DEVICE_A,
      deletedAt: 2400,
    });
    const edit = makeTask({
      id: TASK_ID,
      updatedAt: 2500,
      deviceId: DEVICE_B,
      title: 'still needed',
    });
    const result = await plan({
      localTasks: [tombstone], // A holds the delete and loses
      fetched: [{ kind: 'task', record: edit }],
      shadow: {
        [TASK_ID]: {
          updatedAt: 1000,
          deviceId: DEVICE_A,
          contentHash: await hash(makeTask({ id: TASK_ID })),
        },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const winner = result.value.puts[0] as Task;
    expect(winner.deletedAt).toBeNull();
    expect(winner.title).toBe('still needed');
    // Decision 4.3: "a tombstone is never copied into a visible row".
    expect(result.value.copies).toHaveLength(0);
    expect(result.value.notices).toHaveLength(1);
    expect(result.value.notices[0]!.kind).toBe('delete-lost');
    expect(result.value.notices[0]!.lostTo).toEqual({ updatedAt: 2500, deviceId: DEVICE_B });
  });

  it('M6: delete-vs-delete — newer tombstone wins, no copy, no notice (nothing diverged)', async () => {
    const older = makeTask({ id: TASK_ID, updatedAt: 2500, deviceId: DEVICE_A, deletedAt: 2500 });
    const newer = makeTask({ id: TASK_ID, updatedAt: 2600, deviceId: DEVICE_B, deletedAt: 2600 });
    const result = await plan({
      localTasks: [older],
      fetched: [{ kind: 'task', record: newer }],
      shadow: {
        [TASK_ID]: {
          updatedAt: 1000,
          deviceId: DEVICE_A,
          contentHash: await hash(makeTask({ id: TASK_ID })),
        },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value.puts[0] as Task).deletedAt).toBe(2600);
    expect(result.value.copies).toHaveLength(0);
    expect(result.value.notices).toHaveLength(0);
  });

  it('M7: identical-change demotion — same content under different stamps is "same change", no copy', async () => {
    const base = makeTask({ id: TASK_ID });
    const local = makeTask({ id: TASK_ID, updatedAt: 1900, deviceId: DEVICE_B });
    const remote = makeTask({ id: TASK_ID, updatedAt: 2000, deviceId: DEVICE_A });
    const result = await plan({
      localTasks: [local],
      fetched: [{ kind: 'task', record: remote }],
      shadow: { [TASK_ID]: { updatedAt: 1000, deviceId: DEVICE_A, contentHash: await hash(base) } },
      deviceId: DEVICE_B,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.copies).toHaveLength(0);
    expect(result.value.notices).toHaveLength(0);
  });

  it('M8: missing shadow — differing versions are treated as concurrent (conservative, copy is the safe direction)', async () => {
    const local = makeTask({ id: TASK_ID, updatedAt: 1900, deviceId: DEVICE_B, notes: 'b' });
    const remote = makeTask({ id: TASK_ID, updatedAt: 2000, deviceId: DEVICE_A, notes: 'a' });
    const result = await plan({
      localTasks: [local],
      fetched: [{ kind: 'task', record: remote }],
      shadow: {},
      deviceId: DEVICE_B,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.copies).toHaveLength(1); // visible copy, never silent loss
  });

  it('M9: list conflict — LWW decides + visible notice, NEVER a row copy (membership safety)', async () => {
    const local = makeList({ id: LIST_1, name: 'Groceries', updatedAt: 1900, deviceId: DEVICE_B });
    const remote = makeList({ id: LIST_1, name: 'Shopping', updatedAt: 2000, deviceId: DEVICE_A });
    const result = await plan({
      localLists: [local],
      localTasks: [],
      fetched: [{ kind: 'list', record: remote }],
      shadow: {
        [LIST_1]: {
          updatedAt: 1000,
          deviceId: DEVICE_A,
          contentHash: await hash(makeList({ id: LIST_1 })),
        },
      },
      deviceId: DEVICE_B,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value.puts[0] as ReturnType<typeof makeList>).name).toBe('Shopping');
    expect(result.value.copies).toHaveLength(0);
    expect(result.value.notices).toHaveLength(1);
    expect(result.value.notices[0]!.kind).toBe('list-conflict');
    expect(result.value.notices[0]!.title).toBe('Groceries');
  });

  it('M10: tombstone propagation — only-remote-changed applies the tombstone locally', async () => {
    const local = makeTask({ id: TASK_ID, updatedAt: 1000 });
    const tombstone = makeTask({
      id: TASK_ID,
      updatedAt: 2500,
      deviceId: DEVICE_B,
      deletedAt: 2500,
    });
    const result = await plan({
      localTasks: [local],
      fetched: [{ kind: 'task', record: tombstone }],
      shadow: {
        [TASK_ID]: { updatedAt: 1000, deviceId: DEVICE_A, contentHash: await hash(local) },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value.puts[0] as Task).deletedAt).toBe(2500);
    expect(result.value.copies).toHaveLength(0);
  });

  it('M11: only-local-changed — nothing to apply; the row is pushed later (fold keeps L)', async () => {
    const local = makeTask({ id: TASK_ID, updatedAt: 1900, deviceId: DEVICE_B, notes: 'mine' });
    const remote = makeTask({ id: TASK_ID, updatedAt: 1000, deviceId: DEVICE_A });
    const result = await plan({
      localTasks: [local],
      fetched: [{ kind: 'task', record: remote }],
      shadow: {
        [TASK_ID]: { updatedAt: 1000, deviceId: DEVICE_A, contentHash: await hash(remote) },
      },
      deviceId: DEVICE_B,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.puts).toHaveLength(0);
    expect(result.value.copies).toHaveLength(0);
  });

  it('M12: stale echo never regresses the record and never forces a copy', async () => {
    const local = makeTask({ id: TASK_ID, updatedAt: 2000, deviceId: DEVICE_A, title: 'current' });
    const stale = makeTask({ id: TASK_ID, updatedAt: 1900, deviceId: DEVICE_B, title: 'old edit' });
    const result = await plan({
      localTasks: [local],
      fetched: [{ kind: 'task', record: stale }],
      shadow: {
        [TASK_ID]: { updatedAt: 2000, deviceId: DEVICE_A, contentHash: await hash(local) },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.puts).toHaveLength(0); // fold = LWW max = local
    expect(result.value.copies).toHaveLength(0);
  });

  it('M13: two-device convergence (both orders) — same winner, exactly ONE copy across the fleet', async () => {
    const base = makeTask({ id: TASK_ID });
    const aEdit = makeTask({
      id: TASK_ID,
      updatedAt: 2000,
      deviceId: DEVICE_A,
      title: 'Buy oat milk',
    });
    const bEdit = makeTask({ id: TASK_ID, updatedAt: 1900, deviceId: DEVICE_B, notes: 'soy' });
    const shadowOf = {
      [TASK_ID]: { updatedAt: 1000, deviceId: DEVICE_A, contentHash: await hash(base) },
    };

    // B pulls A's version (the worked example direction).
    const onB = await plan({
      localTasks: [bEdit],
      fetched: [{ kind: 'task', record: aEdit }],
      shadow: shadowOf,
      deviceId: DEVICE_B,
    });
    // A pulls B's version (the other order).
    const onA = await plan({
      localTasks: [aEdit],
      fetched: [{ kind: 'task', record: bEdit }],
      shadow: shadowOf,
      deviceId: DEVICE_A,
    });
    expect(onB.ok && onA.ok).toBe(true);
    if (!onB.ok || !onA.ok) return;
    // Both orders converge on the same record state: B applies A's winning
    // version; A already holds it (nothing to apply there).
    expect(onB.value.puts).toHaveLength(1);
    expect(onB.value.puts[0]).toMatchObject({
      updatedAt: 2000,
      deviceId: DEVICE_A,
      title: 'Buy oat milk',
    });
    expect(onA.value.puts).toHaveLength(0);
    // Exactly one copy exists fleet-wide: created by the device whose local
    // version is displaced (B). The winner side (A) duplicates nothing — this
    // is what keeps "concurrent edit → exactly one visible Conflict copy" true
    // after the copy syncs out (Decision 5 test plan).
    expect(onB.value.copies).toHaveLength(1);
    expect(onA.value.copies).toHaveLength(0);
  });

  it('M14: conflict copy rows are plain tasks — they validate and sync out like any create', async () => {
    const local = makeTask({ id: TASK_ID, updatedAt: 1900, deviceId: DEVICE_B, notes: 'b' });
    const remote = makeTask({ id: TASK_ID, updatedAt: 2000, deviceId: DEVICE_A, notes: 'a' });
    const result = await plan({
      localTasks: [local],
      fetched: [{ kind: 'task', record: remote }],
      shadow: {},
      deviceId: DEVICE_B,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const copy = result.value.copies[0]!;
    // The copy carries the loser's content minus the LWW key, with fresh identity.
    expect(copy.row.id).toBe(copy.copyId);
    expect(copy.row.id).not.toBe(TASK_ID);
    expect(copy.row.notes).toBe('b');
    expect(copy.row.updatedAt).toBe(9000);
  });
});

describe('shadow three-way test (Decision 4.2 case table)', () => {
  it('divergedSince is strictly-newer AND content-different (stale/identical echoes do not diverge)', async () => {
    const base = makeTask({ id: SHADOW_ID });
    const shadow = { updatedAt: 1000, deviceId: DEVICE_A, contentHash: await hash(base) };
    const newer = makeTask({
      id: SHADOW_ID,
      updatedAt: 2000,
      deviceId: DEVICE_A,
      title: 'changed',
    });
    const restamp = makeTask({ id: SHADOW_ID, updatedAt: 1500, deviceId: DEVICE_A });
    const stale = makeTask({ id: SHADOW_ID, updatedAt: 900, deviceId: DEVICE_B, title: 'older' });
    expect(
      divergedSince(
        {
          stamp: { updatedAt: 2000, deviceId: DEVICE_A },
          contentHash: await hash(newer),
          tombstone: false,
        },
        shadow,
      ),
    ).toBe(true);
    expect(
      divergedSince(
        {
          stamp: { updatedAt: 1500, deviceId: DEVICE_A },
          contentHash: await hash(restamp),
          tombstone: false,
        },
        shadow,
      ),
    ).toBe(false);
    expect(
      divergedSince(
        {
          stamp: { updatedAt: 900, deviceId: DEVICE_B },
          contentHash: await hash(stale),
          tombstone: false,
        },
        shadow,
      ),
    ).toBe(false);
  });

  it('missing shadow → conservative: every differing version counts as changed', () => {
    expect(
      classifyDivergence(
        { stamp: { updatedAt: 1, deviceId: DEVICE_A }, contentHash: 'h1', tombstone: false },
        { stamp: { updatedAt: 2, deviceId: DEVICE_B }, contentHash: 'h2', tombstone: false },
        null,
      ),
    ).toBe('concurrent-edit');
  });

  it('case table: same change / one-sided / delete pairs route exactly as Decision 4.2 says', async () => {
    const base = makeTask({ id: SHADOW_ID });
    const shadow = { updatedAt: 1000, deviceId: DEVICE_A, contentHash: await hash(base) };
    const live = {
      stamp: { updatedAt: 2000, deviceId: DEVICE_A },
      contentHash: 'live-hash',
      tombstone: false,
    };
    const dead = {
      stamp: { updatedAt: 2500, deviceId: DEVICE_B },
      contentHash: 'dead-hash',
      tombstone: true,
    };
    const same = {
      stamp: { updatedAt: 1000, deviceId: DEVICE_A },
      contentHash: shadow.contentHash,
      tombstone: false,
    };
    expect(classifyDivergence(live, same, shadow)).toBe('only-local-changed');
    expect(classifyDivergence(same, live, shadow)).toBe('only-remote-changed');
    expect(classifyDivergence(live, live, shadow)).toBe('same-change');
    expect(classifyDivergence(dead, live, shadow)).toBe('delete-vs-edit');
    expect(classifyDivergence(live, dead, shadow)).toBe('delete-vs-edit');
    expect(
      classifyDivergence(
        dead,
        { ...dead, stamp: { updatedAt: 2600, deviceId: DEVICE_A }, contentHash: 'dead2' },
        shadow,
      ),
    ).toBe('delete-vs-delete');
    expect(classifyDivergence(null, live, shadow)).toBe('only-remote-changed');
    expect(classifyDivergence(live, null, shadow)).toBe('only-local-changed');
    expect(classifyDivergence(null, null, shadow)).toBe('nothing');
  });
});

describe('push set (Decision 5 step 7 overlap)', () => {
  it('collectPushSet includes rows inside the overlap window (scan-commit race guard)', async () => {
    const rows = [
      makeTask({ id: testUlid('p1'), updatedAt: 1000 }),
      makeTask({ id: testUlid('p2'), updatedAt: 5000 }),
      makeTask({ id: testUlid('p3'), updatedAt: 9000 }),
    ];
    const { collectPushSet } = await import('../../../src/sync/merge');
    const picked = collectPushSet(rows, 10_000, 5 * 60_000);
    expect(picked).toHaveLength(3); // everything within overlap of the watermark
    const tight = collectPushSet(rows, 6000, 0);
    expect(tight.map((r) => r.updatedAt)).toEqual([9000]);
  });
});

export { TASK_ID };
export type { SyncRecord };
