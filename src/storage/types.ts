/**
 * Record types for the local-first todo database.
 *
 * BINDING: these shapes are ADR-002 §3 verbatim. `Task`/`List`/`Settings` (and
 * their field unions) now live in `src/domain/model.ts` — their canonical TS home
 * per ADR-003 Decision 1.2 — and are re-exported here so every ADR-002 import
 * site keeps compiling. Changing any field is an ADR amendment plus a
 * `meta.schemaVersion` migration step — never an in-place edit.
 */

export type {
  List,
  Priority,
  Recurrence,
  Settings,
  StoreName,
  Task,
  TaskStatus,
} from '../domain/model';

import type { List, Settings, StoreName, Task } from '../domain/model';

/** Singleton under out-of-line key `'meta'` (ADR-002 §3.1). */
export type Meta = {
  schemaVersion: number;
  deviceId: string;
  createdAt: number;
  lastOpenedAt: number;
  lastPurgeAt?: number;
};

export type SnapshotKind = 'auto' | 'manual';
export type SnapshotReason = 'scheduled' | 'pre-migration' | 'pre-import' | 'manual';

export type Snapshot = {
  id: string;
  takenAt: number;
  kind: SnapshotKind;
  reason: SnapshotReason;
  sizeBytes: number;
  schemaVersion: number;
  payloadRef: string;
};

export type SnapshotPayload = {
  id: string;
  payload: string;
};

/**
 * Persisted sync error codes (ADR-006 Decision 6 taxonomy — the full table is
 * the engine's `SyncError`; the row keeps only the code).
 */
export type SyncErrorCode =
  | 'CONFIG'
  | 'AUTH'
  | 'CORS'
  | 'NETWORK'
  | 'REMOTE_MISSING'
  | 'CONFLICT_WRITE'
  | 'CORRUPT_REMOTE'
  | 'SYNC_FORMAT_UNKNOWN'
  | 'SYNC_FORMAT_NEWER'
  | 'REMOTE_FULL'
  | 'LOCAL_STORAGE'
  | 'LOCKED'
  | 'ABORTED';

/** Per-record LAST-SYNCED version — the merge base for the shadow three-way test (ADR-006 Decision 4.2). */
export type SyncShadowEntry = {
  updatedAt: number;
  deviceId: string;
  contentHash: string;
};

/**
 * Sync cursors (ADR-006 Decision 3). `pushedSeq` and `remoteCoveredUpTo` are
 * additive to the ADR's sketch and required by its own mechanics: Decision 2
 * ("a device knows its own next `seq` from its local cursor") and Decision 8
 * rule 3 (purge gate needs verified-snapshot coverage). The rest is verbatim.
 */
export type SyncCursor = {
  /** deviceId -> highest CONTIGUOUS batch seq fetched+merged (Decision 5 step 4). */
  pull: Record<string, number>;
  /** Newest snapshot filename merged (''/null = none). */
  snapshotKey: string | null;
  /** Epoch ms watermark for push scans (Decision 5 step 7). */
  pushedUpTo: number;
  /** Last change-batch seq this device wrote (Decision 2). */
  pushedSeq: number;
  /**
   * Epoch ms: every tombstone with `deletedAt <= remoteCoveredUpTo` is retained
   * in a remote snapshot this device verified (Decision 8 rule 3).
   */
  remoteCoveredUpTo: number | null;
};

/**
 * Singleton row under key `'sync'` (ADR-006 Decision 3). LOCAL-ONLY: excluded
 * from exports, snapshots and remote payloads — the remote never sees our
 * credentials or cursors (ADR-002 Decision 5's exclusion list).
 */
export type SyncStateRecord = {
  id: 'sync';
  enabled: boolean;
  remoteUrl: string;
  remoteUser: string;
  remotePassword: string;
  autoSync: boolean;
  deviceId: string;
  cursor: SyncCursor;
  shadow: Record<string, SyncShadowEntry>;
  lastSyncAt: number | null;
  lastError: SyncErrorCode | null;
};

export type RowMap = {
  meta: Meta;
  lists: List;
  tasks: Task;
  settings: Settings;
  snapshots: Snapshot;
  snapshot_payloads: SnapshotPayload;
  sync_state: SyncStateRecord;
};

export type Row<K extends StoreName> = RowMap[K];

/** Per-store row inventory — the unit snapshot payloads and export upgrades move. */
export type StoreRows = { [K in StoreName]: Row<K>[] };

/** All stores, in a stable order (snapshot dumps, full scans). */
export const STORE_NAMES: readonly StoreName[] = [
  'meta',
  'lists',
  'tasks',
  'settings',
  'snapshots',
  'snapshot_payloads',
  'sync_state',
] as const;

/**
 * Stores whose rows are user data covered by export/snapshot payloads (ADR-002 §3.6).
 * `sync_state` is deliberately absent: local-only (ADR-006 Decision 3 — excluded
 * from export files, snapshots and remote payloads).
 */
export const DATA_STORES: readonly ('lists' | 'tasks' | 'settings')[] = [
  'lists',
  'tasks',
  'settings',
] as const;
