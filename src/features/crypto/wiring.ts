/**
 * C1 app wiring (ADR-007): the session vault attaches to the booted DB and the
 * row/merge seams register exactly once per tab. Called from the data-safety
 * startup path (the first place the booted `AppDBImpl` is bound app-wide).
 *
 * Lock drops (Decision 5.2) register here too: the in-memory search index is
 * decrypted content and must not outlive the unlocked session.
 */

import type { AppDBImpl } from '../../storage/db';
import { onLockDrop } from '../../crypto/lock';
import { initCryptoSeams, vault } from '../../crypto/vault';
import { dropSearchIndex } from '../search/searchIndexCache';
import { notifyDataReplaced } from '../../portability/side-effects';

let wired = false;

export async function initCryptoForApp(db: AppDBImpl): Promise<void> {
  if (!wired) {
    wired = true;
    initCryptoSeams();
    onLockDrop(() => {
      dropSearchIndex();
    });
  }
  await vault.attach(db);
}

/**
 * Post-unlock refresh (F1's data-replaced seam): the acting tab reloads its
 * state through the now-decrypted read path.
 */
export function refreshAfterUnlock(): void {
  notifyDataReplaced();
}
