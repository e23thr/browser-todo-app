/**
 * Database binding for the portability layer.
 *
 * The ADR-004 API signatures (`exportBackup()`, `prepareImport(input)`, …) take
 * no database argument — the app binds its booted `AppDBImpl` once. Every
 * function additionally accepts `{ db }` in its options as a test/explicit
 * override so the engine stays injectable.
 */

import { err, ok } from '../storage/errors';
import type { Result } from '../storage/errors';
import type { AppDBImpl } from '../storage/db';

let boundDb: AppDBImpl | null = null;

/** The typed failure shape — assignable to both `StorageError` and `ImportError`. */
export type UnboundDbError = { code: 'UNAVAILABLE'; cause?: unknown };

/** Bind (or unbind with `null`) the database the portability functions use. */
export function bindDataSafetyDb(db: AppDBImpl | null): void {
  boundDb = db;
}

export function resolveDataSafetyDb(override?: AppDBImpl): Result<AppDBImpl, UnboundDbError> {
  const db = override ?? boundDb;
  if (db === null) {
    return err({
      code: 'UNAVAILABLE',
      cause: new Error('no data-safety database bound — call bindDataSafetyDb(db) or pass { db }'),
    });
  }
  return ok(db);
}
