/**
 * Result type + typed storage error contract (ADR-002 §10.1/§10.4).
 *
 * Nothing throws across the storage API boundary: every public entry point
 * returns `Promise<Result<T, StorageError>>`. `QuotaExceededError` is always
 * surfaced as `QUOTA_EXCEEDED`, never swallowed, never a silent write drop.
 */

import type { StoreName } from './types';

// `Result`/`StorageError` are physically declared in the domain kernel
// (ADR-003 Decision 1.2) and re-exported here — the ADR-002 API surface is
// unchanged. `ok`/`err` come along so this module stays the one import site.
export type { Result, StorageError } from '../domain/kernel';
export { err, ok } from '../domain/kernel';

import type { StorageError } from '../domain/kernel';

export function unavailable(cause?: unknown): StorageError {
  return cause === undefined ? { code: 'UNAVAILABLE' } : { code: 'UNAVAILABLE', cause };
}

export function blocked(message: string): StorageError {
  return { code: 'BLOCKED', message };
}

export function quotaExceeded(cause?: unknown): StorageError {
  return cause === undefined ? { code: 'QUOTA_EXCEEDED' } : { code: 'QUOTA_EXCEEDED', cause };
}

export function invalidRecord(
  store: StoreName,
  issues: string[],
  id?: string,
): StorageError {
  return id === undefined
    ? { code: 'INVALID_RECORD', store, issues }
    : { code: 'INVALID_RECORD', store, id, issues };
}

export function notFound(store: StoreName, key: string): StorageError {
  return { code: 'NOT_FOUND', store, key };
}

export function migrationFailed(from: number, to: number, cause?: unknown): StorageError {
  return cause === undefined
    ? { code: 'MIGRATION_FAILED', from, to }
    : { code: 'MIGRATION_FAILED', from, to, cause };
}

export function newerSchema(found: number, supported: number): StorageError {
  return { code: 'NEWER_SCHEMA', found, supported };
}

export function txAborted(cause?: unknown): StorageError {
  return cause === undefined ? { code: 'TX_ABORTED' } : { code: 'TX_ABORTED', cause };
}

export function unknownError(cause?: unknown): StorageError {
  return cause === undefined ? { code: 'UNKNOWN' } : { code: 'UNKNOWN', cause };
}

function hasDomExceptionShape(e: unknown): e is { name: string; code?: number } {
  return typeof e === 'object' && e !== null && 'name' in e;
}

/**
 * Map anything thrown below the API boundary to a typed `StorageError`.
 *
 * `QuotaExceededError` (modern `name`, or legacy `code === 22`) always maps to
 * `QUOTA_EXCEEDED` — the §5.5 dialog contract depends on this and no caller may
 * lose it.
 */
export function classifyUnknown(e: unknown): StorageError {
  if (hasDomExceptionShape(e)) {
    const name = e.name;
    if (name === 'QuotaExceededError' || e.code === 22) return quotaExceeded(e);
    if (name === 'AbortError') return txAborted(e);
    if (name === 'VersionError') {
      // Native idbVersion conflict: a newer build holds this DB open. found: -1
      // marks "actual version not retrievable" — the open was refused pre-upgrade.
      return newerSchema(-1, -1);
    }
    if (name === 'SecurityError' || name === 'InvalidStateError') return unavailable(e);
    if (name === 'ConstraintError' || name === 'DataError' || name === 'DataCloneError') {
      return invalidRecordUnknownCause(e);
    }
    return unknownError(e);
  }
  return unknownError(e);
}

function invalidRecordUnknownCause(cause: unknown): StorageError {
  return { code: 'INVALID_RECORD', store: 'meta', issues: [String(cause)] };
}
