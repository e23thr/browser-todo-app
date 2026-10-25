/**
 * Singleton `sync_state` row helpers (ADR-006 Decision 3).
 *
 * The row is LOCAL-ONLY: excluded from exports, snapshots and remote payloads
 * (ADR-002 Decision 5's exclusion list) — credentials and cursors never leave
 * the browser profile. Reads/writes go through `AppDB` like every other store.
 */

import type { AppDB } from './db';
import { err, ok } from './errors';
import type { Result, StorageError } from './errors';
import { SYNC_KEY } from './schema';
import type { SyncStateRecord } from './types';

/**
 * The default row: sync disabled until explicit setup (§6.2 opt-in boundary —
 * nothing leaves the device before the user configures a remote).
 */
export function defaultSyncStateRow(deviceId: string): SyncStateRecord {
  return {
    id: 'sync',
    enabled: false,
    remoteUrl: '',
    remoteUser: '',
    remotePassword: '',
    autoSync: true,
    deviceId,
    cursor: {
      pull: {},
      snapshotKey: null,
      pushedUpTo: 0,
      pushedSeq: 0,
      remoteCoveredUpTo: null,
    },
    shadow: {},
    lastSyncAt: null,
    lastError: null,
  };
}

/** Read the singleton row (undefined when never seeded). */
export async function readSyncState(
  db: AppDB,
): Promise<Result<SyncStateRecord | undefined, StorageError>> {
  const row = await db.get('sync_state', SYNC_KEY);
  if (!row.ok) return err(row.error);
  return ok(row.value);
}

/**
 * Read-or-seed the singleton row. This is the lazy fallback the engine uses on
 * every access: a database whose migration step was rolled back (or a store
 * created purely structurally) still gets a working sync_state row.
 */
export async function ensureSyncState(
  db: AppDB,
  deviceId: string,
): Promise<Result<SyncStateRecord, StorageError>> {
  const existing = await readSyncState(db);
  if (!existing.ok) return err(existing.error);
  if (existing.value !== undefined) return ok(existing.value);
  const seeded = defaultSyncStateRow(deviceId);
  const written = await db.put('sync_state', seeded);
  if (!written.ok) return err(written.error);
  return ok(seeded);
}
