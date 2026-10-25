/**
 * The C1 row seam (ADR-007 Decision 4 / contract 4): ONE boundary where at-rest
 * rows (possibly ciphertext) and domain rows (plaintext views) meet.
 *
 * The transform runs inside the `AppDB`/`Tx` read/write surface for the
 * `tasks`/`lists` stores ONLY, so every repo read/write is covered while raw
 * consumers (sync engine via `txRaw`/`getAllRaw`, snapshot/backup dumps via
 * `readUnfiltered`, boot validation, migrations via `txRaw`) keep seeing the
 * at-rest bytes they need. Storage owns the INTERFACE; `src/crypto` registers
 * the implementation (no storage→crypto import — dependency inversion).
 *
 * Default (`null`) = passthrough: C1 off, and every existing test.
 */

import type { Result } from '../domain/kernel';
import type { StorageError } from './errors';

/** Row transform for the two user-text stores. */
export type RowCryptoSeam = {
  /**
   * At-rest row -> domain view. Plaintext rows pass through; ciphertext rows
   * decrypt (requires the key). Decrypt failures quarantine (never dropped).
   */
  readRow(store: 'tasks' | 'lists', row: unknown): Promise<Result<unknown, StorageError>>;
  /**
   * Domain view -> at-rest row. Already-encrypted rows are written VERBATIM
   * (this is how tombstoning-while-locked works); plaintext rows encrypt when
   * C1 is on and the key is in memory; a plaintext write while locked is
   * REFUSED (`LOCKED`) — never silently stored.
   */
  writeRow(store: 'tasks' | 'lists', row: unknown): Promise<Result<unknown, StorageError>>;
};

let seam: RowCryptoSeam | null = null;

export function setRowCryptoSeam(next: RowCryptoSeam | null): void {
  seam = next;
}

export function rowCryptoSeam(): RowCryptoSeam | null {
  return seam;
}

/** Test/reset helper. */
export function resetRowCryptoSeam(): void {
  seam = null;
}
