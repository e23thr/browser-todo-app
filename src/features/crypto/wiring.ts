/**
 * C1 app wiring (ADR-007): the session vault attaches to the booted DB and the
 * row/merge seams register exactly once per tab. Called from the data-safety
 * startup path (the first place the booted `AppDBImpl` is bound app-wide).
 *
 * Lock drops (Decision 5.2) register here too: the in-memory search index is
 * decrypted content and must not outlive the unlocked session.
 *
 * Migration resume (Decision 7.1, review F1) lives here as the UI-level flow:
 * one sweep at a time (single flight over retry clicks and auto-resumes), and
 * a QUOTA_EXCEEDED pause opens the data-safety quota dialog (free space /
 * export — the reachable cleanup path) and retries the sweep once afterwards;
 * anything further stays a visible paused retry.
 */

import type { AppDBImpl } from '../../storage/db';
import type { CryptoResult } from '../../crypto/errors';
import { onLockDrop } from '../../crypto/lock';
import { resumeMigration } from '../../crypto/service';
import { initCryptoSeams, vault } from '../../crypto/vault';
import { dropSearchIndex } from '../search/searchIndexCache';
import { notifyDataReplaced } from '../../portability/side-effects';
import { openDialog } from '../data-safety/notices';

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

/** One UI-level resume at a time — a retry click and an auto-resume must never double-sweep. */
let resumeInFlight: Promise<CryptoResult<{ done: number; total: number } | null>> | null = null;

export type ResumeFlowOptions = {
  onProgress?: (progress: { done: number; total: number }) => void;
  /**
   * On a QUOTA_EXCEEDED pause: open the data-safety quota dialog (free space /
   * export), then retry the sweep once. The internal retry passes `false` so a
   * still-full store cannot loop dialogs — it stays paused for the explicit
   * Retry button.
   */
  quotaDialog?: boolean;
};

/**
 * The production resume entry point (Decision 7.1): continues a `migrating`
 * sweep when the vault is unlocked; resolves `null` when there is nothing to
 * do (not migrating / still locked — the unlock path resumes by itself).
 */
export function resumeMigrationFlow(
  db: AppDBImpl,
  options: ResumeFlowOptions = {},
): Promise<CryptoResult<{ done: number; total: number } | null>> {
  if (resumeInFlight !== null) return resumeInFlight;
  const running = runResumeFlow(db, options);
  resumeInFlight = running;
  const clear = (): void => {
    if (resumeInFlight === running) resumeInFlight = null;
  };
  running.then(clear, clear);
  return running;
}

async function runResumeFlow(
  db: AppDBImpl,
  options: ResumeFlowOptions,
): Promise<CryptoResult<{ done: number; total: number } | null>> {
  const result = await resumeMigration(db, vault, Date.now, {
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });
  if (result.ok) return result;
  if (result.error.code === 'QUOTA_EXCEEDED' && options.quotaDialog !== false) {
    // Decision 7.2's reachable retry: the quota dialog offers free-space /
    // export; whatever the verdict, try the sweep once more.
    await openDialog({ kind: 'quota-exceeded', pendingCount: 0 });
    return runResumeFlow(db, { ...options, quotaDialog: false });
  }
  return result;
}

/**
 * Post-unlock refresh (F1's data-replaced seam): the acting tab reloads its
 * state through the now-decrypted read path, and a paused migration resumes
 * (Decision 7.1 — the boot/unlock path owns the sweep until it completes).
 */
export function refreshAfterUnlock(): void {
  notifyDataReplaced();
  const db = vault.db;
  if (db !== null) void resumeMigrationFlow(db);
}
