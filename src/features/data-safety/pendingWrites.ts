/**
 * Pending-write queue (§3.3 Flow C, §6.4) — the machinery behind "a write is NEVER silently
 * dropped".
 *
 * The data-safety card owns the QUEUE and the dialog, not the content of a failed write: a
 * writer (the composer, a settings save, an import) keeps its own record and hands us a
 * `retry` closure. We then guarantee three things:
 *   1. the quota dialog opens (T3, blocking, non-destructive),
 *   2. the pending entry survives every dismissal — there is no "OK" that discards it,
 *   3. "Try again" (and `retryPendingWrites()`) re-runs it until it lands; on success the
 *      entry leaves the queue and the T2 banner clears.
 *
 * Escape/close maps to "Try again" semantics minus the run: keep pending, close the dialog,
 * leave the app usable (§6.4) — the persistent banner keeps the state visible.
 */

import { signal } from '@preact/signals';

import { openDialog } from './notices';

export interface PendingWrite {
  readonly id: number;
  /** What the user is waiting on (drives the banner/dialog copy: "1 change is waiting…"). */
  readonly description: string;
  /** Re-runs the failed write. `true` = it landed and the entry can retire. */
  readonly retry: () => Promise<boolean>;
}

export const pendingWrites = signal<readonly PendingWrite[]>([]);

let seq = 0;
/** Blocks dialog re-entry while `retryPendingWrites()` is draining the queue. */
let retrying = false;

/** Test seam. */
export function resetPendingWrites(): void {
  pendingWrites.value = [];
  retrying = false;
}

/** Does this error carry the `QUOTA_EXCEEDED` code (§5.5's typed contract)? */
export function isQuotaExceeded(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === 'QUOTA_EXCEEDED';
}

/**
 * Record a write that failed for lack of space and open the quota dialog (unless one is
 * already being retried). Returns the pending entry's id, or `null` when `error` is not a
 * quota failure — callers keep their own error handling for everything else.
 */
export function noteWriteFailure(
  error: unknown,
  description: string,
  retry: () => Promise<boolean>,
): number | null {
  if (!isQuotaExceeded(error)) return null;
  seq += 1;
  const entry: PendingWrite = { id: seq, description, retry };
  const next = pendingWrites.value.some((write) => write.id === entry.id)
    ? pendingWrites.value
    : [...pendingWrites.value, entry];
  pendingWrites.value = next;

  if (!retrying) {
    // Fire-and-forget: the dialog queue owns presentation, the caller owns the write.
    void openDialog({ kind: 'quota-exceeded', pendingCount: next.length });
  }
  return entry.id;
}

/** Drop a pending entry (its write landed outside `retryPendingWrites`). */
export function resolvePendingWrite(id: number): void {
  pendingWrites.value = pendingWrites.value.filter((write) => write.id !== id);
}

/**
 * Re-run every pending write in order. Entries whose retry succeeds retire; entries that fail
 * again stay queued (the dialog/banner keep their state). Safe to call repeatedly.
 */
export async function retryPendingWrites(): Promise<void> {
  if (retrying || pendingWrites.value.length === 0) return;
  retrying = true;
  try {
    for (const write of [...pendingWrites.value]) {
      let landed = false;
      try {
        landed = await write.retry();
      } catch {
        landed = false;
      }
      if (landed) resolvePendingWrite(write.id);
    }
  } finally {
    retrying = false;
  }
}
