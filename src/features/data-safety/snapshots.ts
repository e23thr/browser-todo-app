/**
 * Snapshot cache for the panel (§4.3 "Snapshots"): metadata only, newest first, capped at the
 * rolling three. Refreshed at boot and after any import/restore/delete, because those are the
 * operations that create or destroy snapshot rows (ADR-004 Decision 8).
 */

import { listSnapshots } from '../../portability';
import { resolveDb } from './dbAccess';
import { patchState } from './state';
import type { SnapshotMeta } from './types';

let cache: readonly SnapshotMeta[] = [];

/** Current cached metadata (`[]` before boot). */
export function currentSnapshots(): readonly SnapshotMeta[] {
  return cache;
}

/** Re-read the snapshot rows and publish the newest three. Never throws. */
export async function refreshSnapshots(): Promise<readonly SnapshotMeta[]> {
  const db = resolveDb();
  if (db === null) return cache;
  const listed = await listSnapshots({ db });
  if (!listed.ok) return cache;
  cache = listed.value.slice(0, 3);
  patchState({ snapshots: cache });
  return cache;
}

/** Drop the cache and publish an empty list (delete-all). */
export function invalidateSnapshots(): void {
  cache = [];
  patchState({ snapshots: cache });
}
