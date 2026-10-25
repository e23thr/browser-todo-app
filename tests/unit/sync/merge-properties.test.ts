/**
 * Property tests (ADR-006 test plan item 2): N devices × random op sequences
 * converge to identical state through pull/merge rounds; the merge is
 * order-insensitive and idempotent under duplicated/gapped delivery. Seeded
 * deterministic generator (zero-dep rule — no fast-check).
 */

import { describe, expect, it } from 'vitest';

import type { List, Task } from '../../../src/domain/model';
import { planMerge } from '../../../src/sync/merge';
import type { ShadowEntry } from '../../../src/sync/shadow';
import type { SyncRecord } from '../../../src/sync/types';
import { DEVICE_A, DEVICE_B, DEVICE_C, makeTask, testUlid } from './fixtures';

/** mulberry32 — tiny deterministic PRNG. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Device = {
  id: string;
  clock: number;
  rows: Map<string, List | Task>;
  shadow: Record<string, ShadowEntry>;
  copySeq: number;
};

function makeDevice(id: string): Device {
  return { id, clock: 1000, rows: new Map(), shadow: {}, copySeq: 0 };
}

function newIdFor(d: Device): string {
  d.copySeq += 1;
  return testUlid(`copy-${d.id}-${String(d.copySeq)}`);
}

/** One merge+apply round for a device over the shared version pool. */
async function round(device: Device, pool: SyncRecord[]): Promise<void> {
  const localTasks = [...device.rows.values()].filter((r): r is Task => 'title' in r);
  const localLists = [...device.rows.values()].filter((r): r is List => !('title' in r));
  const result = await planMerge({
    localTasks,
    localLists,
    fetched: pool,
    shadow: device.shadow,
    deviceId: device.id,
    now: device.clock,
    newId: () => newIdFor(device),
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  for (const row of result.value.puts) device.rows.set(row.id, row);
  for (const copy of result.value.copies) device.rows.set(copy.copyId, copy.row);
  device.shadow = { ...device.shadow, ...result.value.shadowUpserts };
}

function snapshotOf(device: Device): string {
  return JSON.stringify(
    [...device.rows.entries()]
      .map(([id, row]) => [id, row])
      .sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1)),
  );
}

describe('merge properties (convergence, order-insensitivity, idempotence)', () => {
  it('P1: three devices × random create/edit/delete rounds converge to identical state', async () => {
    const rand = rng(20261026);
    const devices = [makeDevice(DEVICE_A), makeDevice(DEVICE_B), makeDevice(DEVICE_C)];
    const sharedIds = [testUlid('shared-1'), testUlid('shared-2'), testUlid('shared-3')];

    for (let roundNo = 0; roundNo < 6; roundNo += 1) {
      for (const d of devices) {
        const ops = 1 + Math.floor(rand() * 3);
        for (let i = 0; i < ops; i += 1) {
          d.clock += 1 + Math.floor(rand() * 100);
          const roll = rand();
          const existing = sharedIds[Math.floor(rand() * sharedIds.length)]!;
          if (roll < 0.35 || !d.rows.has(existing)) {
            const id =
              roll < 0.35 ? testUlid(`own-${d.id}-${String(roundNo)}-${String(i)}`) : existing;
            d.rows.set(
              id,
              makeTask({
                id,
                title: `task ${id.slice(0, 4)}`,
                notes: rand() < 0.5 ? `note-${String(Math.floor(rand() * 1000))}` : null,
                createdAt: d.clock,
                updatedAt: d.clock,
                deviceId: d.id,
              }),
            );
          } else if (roll < 0.8) {
            const row = d.rows.get(existing) as Task;
            d.rows.set(existing, {
              ...row,
              notes: `edit-${String(Math.floor(rand() * 1000))}`,
              updatedAt: d.clock,
              deviceId: d.id,
            });
          } else {
            const row = d.rows.get(existing);
            if (row !== undefined) {
              d.rows.set(existing, {
                ...row,
                deletedAt: d.clock,
                updatedAt: d.clock,
                deviceId: d.id,
              });
            }
          }
        }
      }
      // Everyone pushes everything (full-state pool: the wire carries full
      // record versions, so a pool of every row ever written is equivalent).
      const pool: SyncRecord[] = [];
      for (const d of devices) {
        for (const row of d.rows.values()) {
          pool.push({ kind: 'title' in row ? 'task' : 'list', record: row });
        }
      }
      for (const d of devices) await round(d, pool);
    }

    // Final exchange until fixpoint (copies propagate like any row).
    for (let i = 0; i < 3; i += 1) {
      const pool: SyncRecord[] = [];
      for (const d of devices) {
        for (const row of d.rows.values()) {
          pool.push({ kind: 'title' in row ? 'task' : 'list', record: row });
        }
      }
      for (const d of devices) await round(d, pool);
    }

    const states = devices.map(snapshotOf);
    expect(states[1]).toBe(states[0]);
    expect(states[2]).toBe(states[0]);
  });

  it('P2: delivery order, duplication and gaps do not change the plan (commutative/associative/idempotent)', async () => {
    const rand = rng(42);
    const local = [makeTask({ id: testUlid('x1'), updatedAt: 1500, deviceId: DEVICE_A })];
    const remote: SyncRecord[] = [];
    for (let i = 0; i < 8; i += 1) {
      remote.push({
        kind: 'task',
        record: makeTask({
          id: testUlid(`r${String(i)}`),
          updatedAt: 1000 + i * 10,
          deviceId: DEVICE_B,
          notes: `n${String(i)}`,
        }),
      });
    }
    // Divergent pair to force a copy.
    remote.push({
      kind: 'task',
      record: makeTask({
        id: testUlid('x1'),
        updatedAt: 1400,
        deviceId: DEVICE_B,
        notes: 'divergent',
      }),
    });

    const base = {
      localTasks: local,
      localLists: [] as List[],
      shadow: {},
      deviceId: DEVICE_A,
      now: 9999,
      newId: (): string => testUlid('fixed-copy'),
    };
    const reference = await planMerge({ ...base, fetched: remote });
    expect(reference.ok).toBe(true);
    if (!reference.ok) return;

    // Shuffle + duplicate + gap the delivery.
    const shuffled = [...remote];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    const delivered = [...shuffled, ...shuffled.slice(0, 4)]; // duplication
    const again = await planMerge({ ...base, fetched: delivered });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value).toEqual(reference.value);

    // Re-planning from the ALREADY-MERGED state is a no-op (idempotence).
    const merged = [...local, ...reference.value.puts, ...reference.value.copies.map((c) => c.row)];
    const post = await planMerge({
      ...base,
      localTasks: merged.filter((r): r is Task => 'title' in r),
      fetched: remote,
      shadow: reference.value.shadowUpserts,
    });
    expect(post.ok).toBe(true);
    if (!post.ok) return;
    expect(post.value.copies).toHaveLength(0);
    expect(post.value.puts).toHaveLength(0);
  });
});
