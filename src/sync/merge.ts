/**
 * Merge planner (ADR-006 Decision 4) — pure: given local rows, fetched
 * versions and the shadow, produce the apply plan. Side effects happen only in
 * the engine's single atomic apply transaction (Decision 4.4).
 *
 * BINDING conflict policy (PROJECT_ANALYSIS §6.2, PRE-DECIDED — implemented
 * exactly, never re-designed): per-record last-write-wins keyed on
 * `(updatedAt, deviceId)`; deletions propagate via tombstones; an unmergeable
 * conflict materializes as a visible "Conflict copy of <task>" — never a silent
 * overwrite. CRDTs are out.
 *
 * Wire caveat (ADR-007 Decision 10): `SyncRecord.record` is the plaintext
 * `todo-sync/1` shape (List | Task). The encrypted envelope variant is an
 * ADR-007 extension of the same slots — its card adapts `recordOf`/stamps.
 */

import { compareLww, conflictCopyTitle } from '../domain/merge';
import type { List, Task } from '../domain/model';
import { err, ok } from '../domain/kernel';
import type { Result } from '../domain/kernel';
import { contentHashOf } from './hash';
import { classifyDivergence, sameVersion } from './shadow';
import type { ShadowEntry, Side, Stamp } from './shadow';
import type { ConflictCopySpec, MergePlan, SyncError, SyncRecord } from './types';

export type MergeInput = {
  localLists: List[];
  localTasks: Task[];
  /** Every fetched record version (snapshots + batches) — folded per id below. */
  fetched: SyncRecord[];
  shadow: Record<string, ShadowEntry>;
  /** This device: conflict copies are stamped with it (Decision 4.3). */
  deviceId: string;
  /** Injected clock + id factory (ADR-002 Decision 5 determinism in tests). */
  now: number;
  newId: () => string;
};

type EitherRow = List | Task;

function isTombstone(row: EitherRow): boolean {
  return row.deletedAt !== null;
}

function stampOf(row: EitherRow): Stamp {
  return { updatedAt: row.updatedAt, deviceId: row.deviceId };
}

/** LWW fold over versions of one id (Decision 4.1) — total, deterministic. */
function foldLww(versions: EitherRow[]): EitherRow {
  return versions.reduce((best, v) =>
    compareLww(stampOf(v), stampOf(best)) > 0
      ? v
      : compareLww(stampOf(v), stampOf(best)) < 0
        ? best
        : // Same (updatedAt, deviceId) with different bytes: not a decision LWW
          // can make — pick a stable representative so every device agrees.
          stableKey(v) >= stableKey(best)
          ? v
          : best,
  );
}

function stableKey(row: EitherRow): string {
  return JSON.stringify(row);
}

/** The displaced local version becomes a visible task copy (Decision 4.3). */
export function conflictCopyOf(loser: Task, id: string, now: number, deviceId: string): Task {
  return {
    ...loser,
    id,
    title: conflictCopyTitle(loser.title),
    createdAt: now,
    updatedAt: now,
    deviceId,
    deletedAt: null,
  };
}

/**
 * Plan the merge. `Result`-typed like every seam: a remote artifact that mixes
 * kinds for one id is corruption — planning refuses and NOTHING is applied.
 */
export async function planMerge(input: MergeInput): Promise<Result<MergePlan, SyncError>> {
  const { shadow, deviceId, now, newId } = input;

  type Entry = { kind: 'list' | 'task'; local: EitherRow | null; remoteVersions: EitherRow[] };
  const entries = new Map<string, Entry>();

  const put = (id: string, kind: 'list' | 'task', local: EitherRow): void => {
    const existing = entries.get(id);
    if (existing === undefined) {
      entries.set(id, { kind, local, remoteVersions: [] });
    } else {
      existing.local = local;
    }
  };

  for (const row of input.localLists) put(row.id, 'list', row);
  for (const row of input.localTasks) put(row.id, 'task', row);
  for (const sr of input.fetched) {
    const entry = entries.get(sr.record.id);
    if (entry === undefined) {
      entries.set(sr.record.id, { kind: sr.kind, local: null, remoteVersions: [sr.record] });
    } else {
      if (entry.kind !== sr.kind) {
        return err({
          code: 'CORRUPT_REMOTE',
          message: `remote mixes kinds for record ${sr.record.id}`,
          retryable: false,
        });
      }
      entry.remoteVersions.push(sr.record);
    }
  }

  const plan: MergePlan = { puts: [], copies: [], notices: [], shadowUpserts: {} };
  const hashes = new Map<EitherRow, string>();
  const hashOf = async (row: EitherRow): Promise<string> => {
    const cached = hashes.get(row);
    if (cached !== undefined) return cached;
    const h = await contentHashOf(row);
    hashes.set(row, h);
    return h;
  };

  for (const [id, entry] of [...entries.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const versions: EitherRow[] =
      entry.local === null ? [...entry.remoteVersions] : [entry.local, ...entry.remoteVersions];
    const winner = foldLww(versions);
    const local = entry.local;
    const remoteBest = entry.remoteVersions.length === 0 ? null : foldLww(entry.remoteVersions);

    // Preserve-before-overwrite: nothing is displaced, nothing is duplicated.
    if (local !== null && remoteBest !== null) {
      const localSide: Side = {
        stamp: stampOf(local),
        contentHash: await hashOf(local),
        tombstone: isTombstone(local),
      };
      const remoteSide: Side = {
        stamp: stampOf(remoteBest),
        contentHash: await hashOf(remoteBest),
        tombstone: isTombstone(remoteBest),
      };
      const divergence = classifyDivergence(localSide, remoteSide, shadow[id] ?? null);
      const localLoses =
        (divergence === 'concurrent-edit' || divergence === 'delete-vs-edit') &&
        !sameVersion(stampOf(local), stampOf(winner)) &&
        compareLww(stampOf(local), stampOf(winner)) < 0;

      if (localLoses) {
        const lostTo = { updatedAt: remoteBest.updatedAt, deviceId: remoteBest.deviceId };
        if (isTombstone(local)) {
          // Decision 4.3: "a tombstone is never copied into a visible row" —
          // the displaced delete surfaces as a visible sync-log notice instead.
          plan.notices.push({
            kind: 'delete-lost',
            recordId: id,
            title: titleOf(local),
            lostTo,
          });
        } else if (entry.kind === 'task') {
          const copyId = newId();
          const row = conflictCopyOf(local as Task, copyId, now, deviceId);
          const spec: ConflictCopySpec = {
            copyId,
            row,
            summary: { recordId: id, title: titleOf(local), copyId, lostTo },
          };
          plan.copies.push(spec);
          plan.shadowUpserts[copyId] = {
            updatedAt: row.updatedAt,
            deviceId: row.deviceId,
            contentHash: await hashOf(row),
          };
        } else {
          // List conflicts: LWW + visible notice, never a row copy (membership
          // safety — a duplicated list would scatter task membership).
          plan.notices.push({
            kind: 'list-conflict',
            recordId: id,
            title: titleOf(local),
            lostTo,
          });
        }
      }
    }

    // Record outcome: the LWW fold. Remote stamps travel byte-for-byte
    // (Decision 3 — merge-applied rows never pass through repo stamping).
    const changed =
      local === null ||
      !sameVersion(stampOf(local), stampOf(winner)) ||
      (await hashOf(local)) !== (await hashOf(winner));
    if (changed) plan.puts.push(winner);

    plan.shadowUpserts[id] = {
      updatedAt: winner.updatedAt,
      deviceId: winner.deviceId,
      contentHash: await hashOf(winner),
    };
  }

  return ok(plan);
}

function titleOf(row: EitherRow): string {
  return 'title' in row ? row.title : row.name;
}

/**
 * Build the push set: local rows changed since the push watermark (with the
 * Decision 5 step 7 OVERLAP guard — re-pushing a version is idempotent).
 */
export function collectPushSet(
  rows: (List | Task)[],
  pushedUpTo: number,
  overlapMs: number,
): (List | Task)[] {
  return rows.filter((r) => r.updatedAt >= pushedUpTo - overlapMs);
}
