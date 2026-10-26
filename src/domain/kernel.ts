/**
 * Domain kernel: the error contract (ADR-003 Decision 1.2).
 *
 * `Result<T, E>` and `StorageError` are physically declared HERE and re-exported
 * by `src/storage/errors.ts` / `src/storage/db.ts`, so every ADR-002 import site
 * keeps compiling and the wrapper API surface is unchanged. `RuleError` is the
 * domain-rule half of `AppError`. Nothing throws across module seams: every port
 * returns `Promise<Result<T, AppError>>`.
 */

import type { StoreName } from './model';

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Exactly the ADR-002 §10.1 union (unchanged shape). */
export type StorageError =
  | { code: 'UNAVAILABLE'; cause?: unknown }
  | { code: 'BLOCKED'; message: string }
  | { code: 'QUOTA_EXCEEDED'; cause?: unknown }
  | { code: 'INVALID_RECORD'; store: StoreName; id?: string; issues: string[] }
  | { code: 'NOT_FOUND'; store: StoreName; key: string }
  | { code: 'MIGRATION_FAILED'; from: number; to: number; cause?: unknown }
  | { code: 'NEWER_SCHEMA'; found: number; supported: number }
  | { code: 'TX_ABORTED'; cause?: unknown }
  | { code: 'UNKNOWN'; cause?: unknown };

export type RuleId =
  | 'PARENT_DEPTH_EXCEEDED' // subtask of a subtask (V1 is one level)
  | 'REORDER_TARGET_NOT_IN_GROUP' // move target ids must belong to the declared group
  | 'LIST_DELETE_TARGET_MISSING' // move-disposition target list missing or identical
  | 'TASK_MISSING' // mutation on a record absent from state (stale UI)
  | 'STALE_WRITE' // optimistic at-rest CAS conflict (ADR-007 D4.6): retryable, never a lost update
  | 'TAG_INVALID' // tag rename target fails the ADR-004 §6.2 tag-name rules
  | 'TASK_STATUS_INVALID'; // S6: archive expects done, restore expects archived

export type RuleError = { code: 'RULE'; rule: RuleId; message: string };

export function ruleError(rule: RuleId, message: string): RuleError {
  return { code: 'RULE', rule, message };
}

/**
 * `INVALID_RECORD` (ADR-002) is the validation error; `RULE` is a domain-rule
 * violation. `QUOTA_EXCEEDED` flows to the §5.5 dialogs — never swallowed.
 */
export type AppError = StorageError | RuleError;

export function isRuleError(e: AppError): e is RuleError {
  return e.code === 'RULE';
}
