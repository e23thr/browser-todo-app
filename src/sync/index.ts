/**
 * Public surface of the ADR-006 sync engine (E8). The sync UI card consumes
 * ONLY this module + docs/dev/sync-engine-api.md — nothing else in `src/sync/`
 * is its contract.
 */

export { SyncEngine, AUTO_SYNC_INTERVAL_MS, BACKOFF_STEPS_MS } from './state';
export type { SyncEngineDeps, SchedulerEnv } from './state';
export { runSyncOnce, advanceContiguous, PUSH_OVERLAP_MS, BATCH_MAX_RECORDS } from './engine';
export type { RunOutcome } from './engine';
export { planMerge, conflictCopyOf, collectPushSet } from './merge';
export type { MergeInput } from './merge';
export { classifyDivergence, divergedSince, sameVersion } from './shadow';
export type { Divergence, Side, ShadowEntry, Stamp } from './shadow';
export {
  encodeBatch,
  decodeBatch,
  encodeSnapshot,
  decodeSnapshot,
  decodeArtifact,
  classifyFormat,
} from './batchCodec';
export type { DecodeOutcome, DecodeErrorKind } from './batchCodec';
export { WebDavClient, assertSecureRemote, parseMultiStatus, makeSyncError } from './webdav';
export type { WebDavConfig, WebDavDeps, FetchLike, DavEntry } from './webdav';
export { sha256Hex, sha256OfUtf8, contentHashOf, stableStringify } from './hash';
export type {
  SyncError,
  SyncErrorCode,
  SyncState,
  SyncRunSummary,
  SyncRunPhase,
  SyncNotice,
  SyncRecord,
  SyncEngineApi,
  ConflictSummary,
  ConflictCopySpec,
  MergePlan,
  BatchDoc,
  SnapshotDoc,
} from './types';
export { SYNC_FORMAT } from './types';
