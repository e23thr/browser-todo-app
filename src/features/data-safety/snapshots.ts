/**
 * Snapshot cache for the panel (§4.3 "Snapshots"): metadata only, newest first, capped at the
 * rolling three. Refreshed at boot and after any import/restore/delete, because those are the
 * operations that create or destroy snapshot rows (ADR-004 Decision 8).
 */

import { t } from '../../i18n';
import {
  downloadSnapshot,
  downloadTextFile,
  listSnapshots,
  snapshotFileName,
} from '../../portability';
import { resolveDb } from './dbAccess';
import { pushToast } from './notices';
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

/**
 * ADR-004 Decision 5.5 (b) / §8.4: hand a snapshot to the browser as a file.
 *
 * This is the durable escape hatch for the import undo — the rolling-3 retention can evict
 * the `pre-import` snapshot, a downloaded file cannot be evicted. Never throws: a failed
 * engine read or a hardened environment without `URL.createObjectURL` surfaces as an error
 * toast and a `false` return (§9.4).
 */
export async function runDownloadSnapshot(id: string, takenAt: number): Promise<boolean> {
  const db = resolveDb();
  if (db === null) return false;
  const result = await downloadSnapshot(id, { db });
  if (!result.ok) {
    pushToast({ message: t('dataSafety.snapshots.downloadFailed'), variant: 'error' });
    return false;
  }
  const saved = downloadTextFile(snapshotFileName(takenAt), await result.value.text());
  if (!saved) {
    pushToast({ message: t('dataSafety.snapshots.downloadFailed'), variant: 'error' });
    return false;
  }
  return true;
}
