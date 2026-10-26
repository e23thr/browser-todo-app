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

/**
 * Per-record LAST-SYNCED version — the merge base for the shadow three-way test
 * (ADR-006 Decision 4.2).
 *
 * `base` (ADR-006 Addendum B, E8-D1 fix): the version THIS entry's version was
 * built on — its causal parent. `null` = a root version (nothing precedes it);
 * ABSENT = unknown (entries persisted before Addendum B, or artifacts from
 * pre-Addendum peers). The push path re-publishes it per record so a peer can
 * tell "supersedes my version" from "concurrent with my version" — the
 * discriminator the shadow alone cannot provide after Decision 5 step 8
 * advanced it past a merely-pushed version.
 */
export type SyncShadowEntry = {
  updatedAt: number;
  deviceId: string;
  contentHash: string;
  base?: { updatedAt: number; deviceId: string } | null;
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

/**
 * C1 key material (ADR-007 Decision 2.3). Stored ONLY wrapped — raw DMK bytes
 * never touch IndexedDB. `kdf` params live per slot so old slots keep unlocking
 * after the iteration floor rises (lazy re-wrap on unlock).
 */
export type KeyWrap = { iv: string; ct: string };

export type PassphraseSlot = {
  kind: 'passphrase';
  kdf: { v: 1; alg: 'PBKDF2-HMAC-SHA-256'; iters: number; salt: string };
  wrap: KeyWrap;
  createdAt: number;
};

export type RecoverySlot = {
  kind: 'recovery';
  kdf: { v: 1; alg: 'HKDF-SHA-256'; info: 'todo-enc/1/recovery-kek' };
  wrap: KeyWrap;
  createdAt: number;
};

export type KeySlot = PassphraseSlot | RecoverySlot;

export type KeyEntry = {
  keyId: string;
  /** Exactly one `passphrase` + 0..1 `recovery` per key (Decision 2.3). */
  slots: KeySlot[];
  createdAt: number;
};

/**
 * Singleton row under key `'crypto'` (ADR-007 Decision 2.3/2.4). LOCAL-ONLY:
 * excluded from exports, snapshot payloads and the remote like `meta`/
 * `sync_state` — the remote never sees wrapped keys (until a future
 * `todo-sync/2`).
 *
 * ADDITIVE to the ADR's sketch (recorded for review): `migration.direction`
 * distinguishes the enable sweep (`encrypt`) from the disable sweep (`decrypt`)
 * so a crash mid-sweep resumes in the right direction — the sketch's
 * `status: 'migrating'` alone cannot.
 */
export type CryptoStateRecord = {
  id: 'crypto';
  status: 'off' | 'migrating' | 'on';
  enabledAt: number | null;
  migration: {
    startedAt: number;
    done: number;
    total: number;
    direction: 'encrypt' | 'decrypt';
  } | null;
  /** Steady state: length 1 (Decision 2.3 explains the >1 mixed-key case). */
  keys: KeyEntry[];
  /** `'declined'` is derivable: enabled && no recovery slot. */
  recoveryOfferedAt: number | null;
  /** Idle re-lock (Decision 5.2): 5 | 15 | 30 | 60 — "never" is not offered. */
  lockAfterMinutes: number;
};

export type RowMap = {
  meta: Meta;
  lists: List;
  tasks: Task;
  settings: Settings;
  snapshots: Snapshot;
  snapshot_payloads: SnapshotPayload;
  sync_state: SyncStateRecord;
  crypto_state: CryptoStateRecord;
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
  'crypto_state',
] as const;

/**
 * Stores whose rows are user data covered by export/snapshot payloads (ADR-002 §3.6).
 * `sync_state` is deliberately absent: local-only (ADR-006 Decision 3 — excluded
 * from export files, snapshots and remote payloads). `crypto_state` is absent
 * for the same reason (ADR-007 Decision 2.4 — the remote never sees wrapped
 * keys).
 */
export const DATA_STORES: readonly ('lists' | 'tasks' | 'settings')[] = [
  'lists',
  'tasks',
  'settings',
] as const;
