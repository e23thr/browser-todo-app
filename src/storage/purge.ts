/**
 * Tombstone purge policy (ADR-002 Decision 6).
 *
 * - Automatic: tombstones with `deletedAt < now - 90 days` are hard-deleted,
 *   at most once per 24h (throttled via `meta.lastPurgeAt`), one readwrite
 *   transaction per store.
 * - Explicit: "Clean up storage" purges ALL tombstones immediately (S11).
 * - Never touches live rows, never touches snapshots.
 */

import { err, ok } from './errors';
import type { Result, StorageError } from './errors';
import type { AppDBImpl } from './db';

export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const TOMBSTONE_STORES: readonly ('lists' | 'tasks')[] = ['lists', 'tasks'];

export type PurgeOptions = {
  now: number;
  mode: 'auto' | 'explicit';
};

/**
 * Returns the number of tombstoned rows hard-deleted (0 when the throttled
 * auto pass is skipped). `QUOTA_EXCEEDED`/other errors propagate typed.
 */
export async function purgeTombstones(
  db: AppDBImpl,
  options: PurgeOptions,
): Promise<Result<number, StorageError>> {
  const { now, mode } = options;

  if (mode === 'auto') {
    const meta = await db.get('meta', 'meta');
    if (!meta.ok) return err(meta.error);
    const last = meta.value?.lastPurgeAt;
    if (last !== undefined && now - last < PURGE_INTERVAL_MS) {
      return ok(0); // throttled: at most once per 24h
    }
  }

  const cutoff = now - TOMBSTONE_TTL_MS;
  let purged = 0;
  for (const store of TOMBSTONE_STORES) {
    // One readwrite transaction per store (ADR-002 Decision 6).
    const result = await db.tx([store], 'readwrite', async (t) => {
      const rows = await t.getAll(store);
      for (const row of rows) {
        if (row.deletedAt === null) continue;
        if (mode === 'explicit' || row.deletedAt < cutoff) {
          await t.delete(store, row.id);
          purged += 1;
        }
      }
      return ok(undefined);
    });
    if (!result.ok) return err(result.error);
  }

  if (mode === 'auto') {
    const stamped = await db.tx(['meta'], 'readwrite', async (t) => {
      const meta = await t.get('meta', 'meta');
      if (meta === undefined) return ok(undefined);
      await t.put('meta', { ...meta, lastPurgeAt: now });
      return ok(undefined);
    });
    if (!stamped.ok) return err(stamped.error);
  }
  return ok(purged);
}
