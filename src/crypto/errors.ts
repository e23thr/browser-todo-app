/**
 * The C1 error contract (ADR-007 Decision 9) — `Result` + `CryptoErrorCode`,
 * nothing throws across the crypto boundary (team baseline). `LOCKED` is a
 * quiet deferral state, never an error banner (ADR-006 Decision 6).
 */

import { err, ok } from '../domain/kernel';
import type { Result } from '../domain/kernel';

export type CryptoErrorCode =
  | 'UNLOCK_FAILED'
  | 'LOCKED'
  | 'NOT_ENABLED'
  | 'ALREADY_ENABLED'
  | 'DECRYPT_FAILED'
  | 'CORRUPT_KEY'
  | 'INVALID_KEY_FILE'
  | 'WRONG_KEY_DOMAIN'
  | 'NO_BACKUP'
  | 'MIGRATION_FAILED'
  | 'QUOTA_EXCEEDED'
  | 'NEWER_ENVELOPE'
  /**
   * ADDITIVE to ADR-007 Decision 9's union (recorded for review): enable-wizard
   * policy rejections (weak passphrase, mismatched confirmation) that are not
   * failure modes of the crypto itself. Never produced by decrypt/unlock paths.
   */
  | 'POLICY';

export type CryptoError = {
  code: CryptoErrorCode;
  message: string;
  detail?: string;
};

export type CryptoResult<T> = Result<T, CryptoError>;

export function cryptoOk<T>(value: T): CryptoResult<T> {
  return ok(value);
}

export function cryptoErr<T = never>(
  code: CryptoErrorCode,
  message: string,
  detail?: string,
): CryptoResult<T> {
  return err(detail === undefined ? { code, message } : { code, message, detail });
}
