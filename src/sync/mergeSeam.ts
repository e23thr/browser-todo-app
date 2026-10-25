/**
 * The narrow content seam between the sync engine and the C1 crypto module
 * (ADR-007 Decision 8 / contract 2: "it never imports crypto code except behind
 * the `LOCKED` deferral hook"). `src/crypto` registers an implementation at app
 * init; tests inject fakes; with NO seam registered the plaintext path is
 * unchanged and any encrypted conflict copy defers with `LOCKED` (safe default —
 * never a fabricated copy, never a dropped merge).
 */

import type { Result } from '../domain/kernel';
import type { EncryptedTaskRecord, RowLike, Task } from '../domain/model';

export type MergeCopyError = {
  code: 'LOCKED' | 'DECRYPT_FAILED';
  message: string;
};

export type MergeCryptoSeam = {
  /** Payload content is decryptable right now (unlocked session). */
  canDecrypt(): boolean;
  /** Display title for sync-log notices/summaries (placeholder when unreadable). */
  displayTitle(row: RowLike): Promise<string>;
  /**
   * ADR-007 Decision 8.3: loser -> "Conflict copy of <title>" -> fresh id/IV
   * under the NEW identity. `DECRYPT_FAILED` means the loser's ciphertext is
   * unreadable even unlocked — the caller then preserves the raw bytes verbatim
   * under the new id (quarantined on read, recoverable — never silently lost).
   */
  conflictCopyRow(
    loser: Task | EncryptedTaskRecord,
    copyId: string,
    now: number,
    deviceId: string,
  ): Promise<Result<Task | EncryptedTaskRecord, MergeCopyError>>;
};

let seam: MergeCryptoSeam | null = null;

export function setMergeCryptoSeam(next: MergeCryptoSeam | null): void {
  seam = next;
}

export function mergeCryptoSeam(): MergeCryptoSeam | null {
  return seam;
}

export function resetMergeCryptoSeam(): void {
  seam = null;
}
