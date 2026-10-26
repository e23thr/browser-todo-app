/**
 * ADR-006 sync protocol types (wire + engine API).
 *
 * The persisted `sync_state` row lives in `src/storage/types.ts` (it is a store
 * row — storage stays self-contained); everything here is protocol/engine
 * surface. The conflict policy is PRE-DECIDED (PROJECT_ANALYSIS §6.2) and is
 * implemented in `merge.ts` — never redesigned here.
 */

import type { EncryptedTaskRecord, RowLike, Task } from '../domain/model';
import type { Result } from '../domain/kernel';
import type { SyncErrorCode, SyncShadowEntry } from '../storage/types';
import type { Stamp } from './shadow';

export type { SyncErrorCode, SyncShadowEntry, SyncCursor, SyncStateRecord } from '../storage/types';

/** ADR-006 Decision 6: the UI-facing error contract. `Result` + this shape — nothing throws. */
export type SyncError = {
  code: SyncErrorCode;
  message: string;
  retryable: boolean;
  detail?: string;
};

/* ------------------------------ wire (Decision 2) ------------------------------ */

export const SYNC_FORMAT = 'todo-sync/1';

/** Full-record state versions (not field diffs) — merge is order-insensitive and idempotent. */
export type SyncRecord = {
  kind: 'list' | 'task';
  /** At-rest row (ADR-007: encrypted rows ride the wire verbatim — Decision 8.1). */
  record: RowLike;
  /**
   * ADR-006 Addendum B (E8-D1): the causal parent of `record` — the version it
   * was built on. `null` = root version; ABSENT = unknown (pre-Addendum peers
   * and artifacts). Lets the holder of a displaced own version tell "superseded
   * by a follow-up edit" from "discarded by a concurrent winner" without which
   * the reverse delivery order silently drops the loser.
   */
  base?: Stamp | null;
};

/** `changes/<deviceId>/<seq>.json` — immutable per-device change batch (§2.1). */
export type BatchDoc = {
  format: string;
  kind: 'batch';
  deviceId: string;
  seq: number;
  createdAt: number;
  recordsHash: string;
  /** JSON string of `SyncRecord[]` (string + hash makes integrity unambiguous). */
  records: string;
};

/** `snapshots/<takenAtMs>-<deviceId>.json` — immutable uniquely-named snapshot (§2.2). */
export type SnapshotDoc = {
  format: string;
  kind: 'snapshot';
  takenAt: number;
  byDeviceId: string;
  /** Per-device watermark: `state` covers every batch with `seq <= covers[d]`. */
  covers: Record<string, number>;
  stateHash: string;
  /** JSON string of `SyncRecord[]` — the LWW-merged state, tombstones included. */
  state: string;
};

export type RemoteArtifact = BatchDoc | SnapshotDoc;

/** Decoded artifacts that failed are never applied (Decision 6); they are reported. */
export type ArtifactRef =
  | { kind: 'batch'; deviceId: string; seq: number; href: string }
  | { kind: 'snapshot'; name: string; href: string };

/* --------------------------- merge plan (Decision 4) --------------------------- */

export type ConflictCopySpec = {
  /** Fresh ULID for the new Task row (copies are new records that sync out normally). */
  copyId: string;
  /** The materialized row, already stamped with now/this-device (`deletedAt: null`). */
  row: Task | EncryptedTaskRecord;
  /** Summary for `conflicts-pending` (Decision 9.2). */
  summary: ConflictSummary;
};

/** Visible sync-log notice — the "never silent" channel for LWW losses without a row copy. */
export type SyncNotice = {
  kind: 'list-conflict' | 'delete-lost';
  recordId: string;
  title: string;
  lostTo: { updatedAt: number; deviceId: string };
};

export type MergePlan = {
  /** Record outcomes (LWW fold winners) — raw rows, remote stamps preserved byte-for-byte. */
  puts: RowLike[];
  copies: ConflictCopySpec[];
  notices: SyncNotice[];
  /** Shadow entries to upsert (keyed by record id — copies included). */
  shadowUpserts: Record<string, SyncShadowEntry>;
};

/* ------------------------ engine API (Decision 9.2) ------------------------ */

export type ConflictSummary = {
  recordId: string;
  title: string;
  copyId: string;
  lostTo: { updatedAt: number; deviceId: string };
};

export type SyncRunPhase = 'probe' | 'pull' | 'merge' | 'apply' | 'push' | 'compact';

export type SyncRunSummary = {
  startedAt: number;
  finishedAt: number;
  trigger: 'manual' | 'auto';
  pulled: { snapshots: number; batches: number; records: number };
  pushed: { batches: number; records: number };
  applied: number;
  conflictsCreated: number;
  compacted: boolean;
  /**
   * ADDITIVE to ADR-006 Decision 9.2's sketch: the visible sync-log notices
   * Decision 4.3 mandates ("never silent") need a transport. Everything else is
   * verbatim from the ADR.
   */
  notices: SyncNotice[];
};

/**
 * The four UI states — verbatim Decision 9.2 (this union is named `SyncState`
 * there; the persisted row is `SyncStateRecord` to keep both usable in one
 * program).
 */
export type SyncState =
  | {
      status: 'idle';
      configured: boolean;
      autoSync: boolean;
      lastSyncAt: number | null;
      lastRun: SyncRunSummary | null;
    }
  | { status: 'syncing'; phase: SyncRunPhase; startedAt: number }
  | { status: 'error'; error: SyncError; lastSyncAt: number | null; retryAt: number | null }
  | {
      status: 'conflicts-pending';
      conflicts: ConflictSummary[];
      lastSyncAt: number | null;
      lastRun: SyncRunSummary;
    };

/** Decision 9.2's interface, plus `probe()` (additive — the wizard's connection test). */
export interface SyncEngineApi {
  configure(cfg: {
    remoteUrl: string;
    user: string;
    password: string;
    /** Additive: false keeps the password in memory only (Decision 7's supported mode). */
    remember?: boolean;
  }): Promise<Result<void, SyncError>>;
  /** Additive: OPTIONS/PROPFIND-only capability probe — zero local writes, for the setup wizard. */
  probe(): Promise<Result<void, SyncError>>;
  runSync(trigger: 'manual' | 'auto'): Promise<Result<SyncRunSummary, SyncError>>;
  state(): import('@preact/signals').Signal<SyncState>;
  listConflicts(): ConflictSummary[];
  acknowledgeConflicts(): void;
  setAutoSync(on: boolean): void;
  forgetCredentials(): Promise<Result<void, SyncError>>;
}

/** In-memory view the engine keeps of the persisted row (memory-only password mode). */
export type SyncConfig = {
  remoteUrl: string;
  user: string;
  password: string;
  remember: boolean;
};
