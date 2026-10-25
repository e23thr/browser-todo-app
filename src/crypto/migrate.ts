/**
 * The plaintext ↔ encrypted migration sweeps (ADR-007 Decision 7) — forward-
 * only content shaping through batched atomic transactions.
 *
 * Mechanics (Decision 7.2, normative):
 * - ≤ 200 records per `readwrite` transaction over ['tasks','lists',
 *   'snapshot_payloads']; batch atomicity means no half-encrypted record.
 * - Every migrated record is STAMPED (`updatedAt = now`, `deviceId` = this
 *   device) — a deliberate version bump so the ciphertext wins LWW everywhere
 *   instead of eternally byte-diverging at equal `(updatedAt, deviceId)`.
 * - Idempotent + crash-safe: rows already in the target mode are skipped; a
 *   crash leaves a mixed store the app fully supports (mixed stores are legal,
 *   Decision 7.1); resume recomputes progress from a scan.
 * - Tombstoned rows are swept too (they hold user text in `payload`), keeping
 *   their `deletedAt` — a newer tombstone is still a tombstone.
 * - `QUOTA_EXCEEDED` pauses the sweep resumably (ADR-002 §5.5 dialog) — never
 *   a silent partial state.
 *
 * The sweep writes AT-REST shapes through `txRaw` — it IS the transform, so the
 * app-surface seam must not run over it (the decrypt direction would otherwise
 * re-encrypt on write).
 */

import { isEncryptedRecord, rowKindOf } from '../domain/model';
import type {
  EncryptedListRecord,
  EncryptedTaskRecord,
  List,
  ListRowLike,
  Task,
  TaskRowLike,
} from '../domain/model';
import type { AppDBImpl } from '../storage/db';
import type { StoreRows } from '../storage/types';
import { cryptoErr, cryptoOk } from './errors';
import type { CryptoResult } from './errors';
import type { CryptoVault } from './vault';

export type SweepDirection = 'encrypt' | 'decrypt';

export type SweepOptions = {
  db: AppDBImpl;
  vault: CryptoVault;
  direction: SweepDirection;
  now: () => number;
  deviceId: string;
  /** Decision 7.2: batched transactions — ≤ 200 records per tx. */
  batchSize?: number;
  onProgress?: (progress: { done: number; total: number }) => void;
};

export type SweepOutcome = {
  done: number;
  total: number;
  /** Rows skipped as already-in-target-mode (idempotent resume). */
  skipped: number;
};

const MAX_BATCH = 200;

type WorkRow = { store: 'tasks' | 'lists' | 'snapshot_payloads'; id: string; row: unknown };

/** `true` when the row is already in the sweep's target mode. */
function alreadyTarget(direction: SweepDirection, row: unknown): boolean {
  return direction === 'encrypt' ? isEncryptedRecord(row) : !isEncryptedRecord(row);
}

/** Collect every row needing work (quarantined rows included — nothing is lost). */
async function collectWork(
  db: AppDBImpl,
  direction: SweepDirection,
): Promise<{ work: WorkRow[]; total: number; error?: string }> {
  const out: WorkRow[] = [];
  let total = 0;
  for (const store of ['tasks', 'lists'] as const) {
    const rows = await db.readUnfiltered(store);
    if (!rows.ok) return { work: [], total: 0, error: `failed to read ${store}` };
    for (const row of rows.value) {
      total += 1;
      if (!alreadyTarget(direction, row)) out.push({ store, id: row.id, row });
    }
  }
  const payloads = await db.readUnfiltered('snapshot_payloads');
  if (!payloads.ok) return { work: [], total: 0, error: 'failed to read snapshot_payloads' };
  for (const row of payloads.value) {
    total += 1;
    const wrapped = isWrappedPayload(row.payload);
    if (direction === 'encrypt' ? !wrapped : wrapped) {
      out.push({ store: 'snapshot_payloads', id: row.id, row });
    }
  }
  return { work: out, total };
}

function isWrappedPayload(payload: string): boolean {
  try {
    const parsed: unknown = JSON.parse(payload);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { format?: unknown }).format === 'todo-enc/1'
    );
  } catch {
    return false;
  }
}

/** One row toward the target mode (fresh IV + stamp), or `null` when unreadable. */
async function transformRow(
  vault: CryptoVault,
  direction: SweepDirection,
  deviceId: string,
  now: number,
  item: WorkRow,
): Promise<{ store: WorkRow['store']; row: unknown } | 'unreadable' | null> {
  if (item.store === 'snapshot_payloads') {
    const row = item.row as { id: string; payload: string };
    if (direction === 'encrypt') {
      const wrapped = await vault.wrapSnapshotPayload(row.id, row.payload);
      if (!wrapped.ok) return null; // locked / no key — caller reports
      return {
        store: 'snapshot_payloads',
        row: { id: row.id, payload: wrapped.value },
      };
    }
    const plain = await vault.unwrapSnapshotPayload(row.id, row.payload);
    if (!plain.ok) return null;
    return { store: 'snapshot_payloads', row: { id: row.id, payload: plain.value } };
  }

  const row = item.row as TaskRowLike & ListRowLike;
  if (direction === 'encrypt') {
    const sealed = await vault.encryptRecord(item.store, row);
    if (!sealed.ok) return null;
    return {
      store: item.store,
      row: { ...sealed.value, updatedAt: now, deviceId },
    };
  }
  const view = await vault.decryptRecord(
    item.store,
    row as EncryptedTaskRecord | EncryptedListRecord,
  );
  if (!view.ok || view.value === undefined) return 'unreadable';
  return {
    store: item.store,
    row: { ...view.value, updatedAt: now, deviceId },
  };
}

/**
 * Run one sweep to completion (or the first resumable pause). `MIGRATION_FAILED`
 * / `QUOTA_EXCEEDED` leave the store mixed with progress persisted — the next
 * unlock resumes (Decision 7.1/7.2).
 */
export async function runSweep(options: SweepOptions): Promise<CryptoResult<SweepOutcome>> {
  const { db, vault, direction, now, deviceId } = options;
  const batchSize = Math.min(options.batchSize ?? MAX_BATCH, MAX_BATCH);
  const collected = await collectWork(db, direction);
  if (collected.error !== undefined) {
    return cryptoErr('MIGRATION_FAILED', collected.error);
  }
  const { work, total } = collected;
  if (total === 0 && work.length === 0) {
    return cryptoOk({ done: 0, total: 0, skipped: 0 });
  }
  if (!vault.isUnlocked) {
    return cryptoErr('LOCKED', 'unlock to run the migration sweep');
  }

  let done = total - work.length; // already-in-target rows
  const skipped = done;
  options.onProgress?.({ done, total });

  for (let at = 0; at < work.length; at += batchSize) {
    const batch = work.slice(at, at + batchSize);
    const transformed: { store: WorkRow['store']; row: unknown }[] = [];
    for (const item of batch) {
      const next = await transformRow(vault, direction, deviceId, now(), item);
      if (next === 'unreadable') {
        // Decision 7.2's disable direction cannot complete over unreadable
        // ciphertext: aborting keeps every byte; wiping keys would not.
        return cryptoErr(
          'MIGRATION_FAILED',
          'some records cannot be decrypted — keep encryption on and download the recovery file first',
        );
      }
      if (next === null) {
        return cryptoErr('MIGRATION_FAILED', 'row transform failed — sweep paused');
      }
      transformed.push(next);
    }
    const applied = await db.txRaw(
      ['tasks', 'lists', 'snapshot_payloads'],
      'readwrite',
      async (t) => {
        for (const next of transformed) {
          if (next.store === 'snapshot_payloads') {
            await t.put('snapshot_payloads', next.row as StoreRows['snapshot_payloads'][number]);
          } else if (next.store === 'tasks') {
            await t.put('tasks', next.row as Task);
          } else {
            await t.put('lists', next.row as List);
          }
        }
        return { ok: true as const, value: undefined };
      },
    );
    if (!applied.ok) {
      // QUOTA_EXCEEDED / TX_ABORTED: progress persists; resume is a fresh scan.
      return applied.error.code === 'QUOTA_EXCEEDED'
        ? cryptoErr('QUOTA_EXCEEDED', 'storage full — free space or export, then resume')
        : cryptoErr(
            'MIGRATION_FAILED',
            'sweep batch failed — nothing was half-written',
            applied.error.code,
          );
    }
    done += batch.length;
    options.onProgress?.({ done, total });
    await vault.saveState({
      migration: { startedAt: now(), done, total, direction },
    });
  }
  return cryptoOk({ done, total, skipped });
}

/** Rows the sweep would touch right now (progress UI + resume reporting). */
export async function sweepRemaining(db: AppDBImpl, direction: SweepDirection): Promise<number> {
  const { work } = await collectWork(db, direction);
  return work.length;
}

/** Convenience for the store kind of an at-rest row (sweep logging). */
export { rowKindOf };
