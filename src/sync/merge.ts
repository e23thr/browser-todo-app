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
 * Wire (ADR-006 Decision 10 / ADR-007): `SyncRecord.record` is the AT-REST row
 * — plaintext `List | Task` or the self-describing encrypted shape. Envelope
 * fields drive LWW/tombstones/shadow without keys; the content seam
 * (`mergeSeam.ts`) is the ONLY crypto contact, and a plan needing conflict
 * copies while locked DEFERS with `LOCKED` (ADR-007 Decision 8.4 — no partial
 * apply, no fabricated copy).
 */

import { compareLww, conflictCopyTitle } from '../domain/merge';
import type {
  EncryptedListRecord,
  EncryptedTaskRecord,
  List,
  RowLike,
  Task,
} from '../domain/model';
import { isEncryptedRecord, rowKindOf } from '../domain/model';
import { err, ok } from '../domain/kernel';
import type { Result } from '../domain/kernel';
import { contentHashOf } from './hash';
import { classifyDivergence, descendsFrom, sameVersion } from './shadow';
import type { ShadowEntry, Side, Stamp } from './shadow';
import { mergeCryptoSeam } from './mergeSeam';
import type { ConflictCopySpec, MergePlan, SyncError, SyncRecord } from './types';

export type MergeInput = {
  localLists: (List | EncryptedListRecord)[];
  localTasks: (Task | EncryptedTaskRecord)[];
  /** Every fetched record version (snapshots + batches) — folded per id below. */
  fetched: SyncRecord[];
  shadow: Record<string, ShadowEntry>;
  /** This device: conflict copies are stamped with it (Decision 4.3). */
  deviceId: string;
  /** Injected clock + id factory (ADR-002 Decision 5 determinism in tests). */
  now: number;
  newId: () => string;
};

type EitherRow = RowLike;

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
 * ADR-007 Decision 8.3 materialization for an ENCRYPTED loser: decrypt ->
 * "Conflict copy of <title>" -> fresh id/IV under the new identity. Returns
 * `null` signals via the Result: `LOCKED` defers the whole run (Decision 8.4);
 * `DECRYPT_FAILED` means the ciphertext is unreadable even unlocked — the
 * caller then preserves the raw bytes verbatim under the new id (quarantine
 * keeps them recoverable — never a silent drop).
 */
async function materializeCopy(
  loser: Task | EncryptedTaskRecord,
  copyId: string,
  now: number,
  deviceId: string,
): Promise<Result<Task | EncryptedTaskRecord, SyncError>> {
  if (!isEncryptedRecord(loser)) {
    return ok(conflictCopyOf(loser, copyId, now, deviceId));
  }
  const seam = mergeCryptoSeam();
  if (seam === null || !seam.canDecrypt()) {
    return err({
      code: 'LOCKED',
      message: 'conflict copies require the key — run deferred until unlock (ADR-007 Decision 8.4)',
      retryable: true,
    });
  }
  const built = await seam.conflictCopyRow(loser, copyId, now, deviceId);
  if (built.ok) return ok(built.value);
  if (built.error.code === 'LOCKED') {
    return err({ code: 'LOCKED', message: built.error.message, retryable: true });
  }
  // Undecryptable loser: PRESERVE the bytes (envelope + payload copied verbatim
  // under the new id — deliberately undecryptable by AAD binding, quarantined on
  // read and downloadable via the recovery file; ADR-007 Decision 9's "never
  // silently dropped" beats D1.3's copyability rule here, recorded for review).
  return ok({
    ...loser,
    id: copyId,
    createdAt: now,
    updatedAt: now,
    deviceId,
    deletedAt: null,
    kind: 'task',
  });
}

async function titleOf(row: EitherRow): Promise<string> {
  if (!isEncryptedRecord(row)) return 'title' in row ? row.title : row.name;
  const seam = mergeCryptoSeam();
  if (seam === null || !seam.canDecrypt()) return '(encrypted)';
  return seam.displayTitle(row);
}

/**
 * Plan the merge. `Result`-typed like every seam: a remote artifact that mixes
 * kinds for one id is corruption — planning refuses and NOTHING is applied.
 * A plan that needs ≥1 conflict copy while locked defers with `LOCKED`
 * (ADR-007 Decision 8.4) — again: nothing is applied.
 */
export async function planMerge(input: MergeInput): Promise<Result<MergePlan, SyncError>> {
  const { shadow, deviceId, now, newId } = input;

  type RemoteVersion = { row: EitherRow; base: Stamp | null | undefined };
  type Entry = { kind: 'list' | 'task'; local: EitherRow | null; remoteVersions: RemoteVersion[] };
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
      entries.set(sr.record.id, {
        kind: sr.kind,
        local: null,
        remoteVersions: [{ row: sr.record, base: sr.base }],
      });
    } else {
      if (entry.kind !== sr.kind) {
        return err({
          code: 'CORRUPT_REMOTE',
          message: `remote mixes kinds for record ${sr.record.id}`,
          retryable: false,
        });
      }
      entry.remoteVersions.push({ row: sr.record, base: sr.base });
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
      entry.local === null
        ? entry.remoteVersions.map((v) => v.row)
        : [entry.local, ...entry.remoteVersions.map((v) => v.row)];
    const winner = foldLww(versions);
    const local = entry.local;
    const remoteBest =
      entry.remoteVersions.length === 0 ? null : foldLww(entry.remoteVersions.map((v) => v.row));

    // The winner's causal parent (Addendum B): the version its producer built
    // it on. Several same-version artifacts may carry it (a re-push echoes the
    // original claim) — an explicit claim anywhere wins; all-unknown stays
    // unknown (pre-Addendum artifacts keep the pre-Addendum behaviour).
    const winnerBases = entry.remoteVersions
      .filter((v) => sameVersion(stampOf(v.row), stampOf(winner)))
      .map((v) => v.base);
    const winnerBase = winnerBases.find((b) => b !== undefined);

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

      // Addendum B (E8-D1 trigger): this device's OWN version displaced by a
      // winner that is NOT built on it. Decision 5 step 8 has already advanced
      // the shadow to the merely-pushed version, so the three-way test reads
      // `only-remote-changed` and the block above cannot fire — the reverse
      // delivery order would silently drop the loser. The winner's recorded
      // parent separates the two indistinguishable cases: built ON our version
      // (a follow-up edit supersedes it — nothing is lost) vs built on anything
      // else (a concurrent winner — OUR version is the loser and, being its
      // only holder, this device materializes it exactly once fleet-wide).
      const displacedOwn =
        divergence === 'only-remote-changed' &&
        local.deviceId === deviceId &&
        !sameVersion(stampOf(local), stampOf(winner)) &&
        (await hashOf(local)) !== (await hashOf(winner)) &&
        !(isTombstone(local) && isTombstone(winner)) &&
        winnerBase !== undefined &&
        !winnerBases.some((b) => descendsFrom(b, stampOf(local)));

      if (localLoses || displacedOwn) {
        const lostTo = { updatedAt: winner.updatedAt, deviceId: winner.deviceId };
        if (isTombstone(local)) {
          // Decision 4.3: "a tombstone is never copied into a visible row" —
          // the displaced delete surfaces as a visible sync-log notice instead.
          plan.notices.push({
            kind: 'delete-lost',
            recordId: id,
            title: await titleOf(local),
            lostTo,
          });
        } else if (entry.kind === 'task') {
          const copyId = newId();
          const built = await materializeCopy(
            local as Task | EncryptedTaskRecord,
            copyId,
            now,
            deviceId,
          );
          if (!built.ok) return built;
          const row = built.value;
          const spec: ConflictCopySpec = {
            copyId,
            row,
            summary: { recordId: id, title: await titleOf(local), copyId, lostTo },
          };
          plan.copies.push(spec);
          plan.shadowUpserts[copyId] = {
            updatedAt: row.updatedAt,
            deviceId: row.deviceId,
            contentHash: await hashOf(row),
            base: null,
          };
        } else {
          // List conflicts: LWW + visible notice, never a row copy (membership
          // safety — a duplicated list would scatter task membership).
          plan.notices.push({
            kind: 'list-conflict',
            recordId: id,
            title: await titleOf(local),
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

    // Shadow outcome (Decision 5 step 8, amended by Addendum B): the entry
    // carries the winner's CAUSAL PARENT so a later fold can still tell a
    // follow-up edit from a concurrent one even though the entry advanced past
    // a merely-pushed version. Fetched winners keep the parent their producer
    // recorded (absent = legacy unknown); our own versions inherit the previous
    // entry's stamp (our edit descends from the last reconciled version), and a
    // version new to this shadow is a root (`null`).
    const prev = shadow[id];
    let base: Stamp | null | undefined;
    if (winnerBase !== undefined) {
      base = winnerBase;
    } else if (local !== null && sameVersion(stampOf(local), stampOf(winner))) {
      if (prev === undefined) base = null;
      else if (sameVersion({ updatedAt: prev.updatedAt, deviceId: prev.deviceId }, stampOf(winner)))
        base = prev.base;
      else base = { updatedAt: prev.updatedAt, deviceId: prev.deviceId };
    } else {
      base = undefined;
    }
    plan.shadowUpserts[id] = {
      updatedAt: winner.updatedAt,
      deviceId: winner.deviceId,
      contentHash: await hashOf(winner),
      ...(base === undefined ? {} : { base }),
    };
  }

  return ok(plan);
}

/**
 * Build the push set: local rows changed since the push watermark (with the
 * Decision 5 step 7 OVERLAP guard — re-pushing a version is idempotent).
 */
export function collectPushSet(rows: RowLike[], pushedUpTo: number, overlapMs: number): RowLike[] {
  return rows.filter((r) => r.updatedAt >= pushedUpTo - overlapMs);
}

export { rowKindOf };
