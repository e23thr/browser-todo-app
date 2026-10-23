/**
 * Data-safety actions (§3.2, §4.3, §6.8) — the effects the panel and the banners trigger.
 *
 * Every action is fire-and-forget safe (`void runExport()` in a click handler): failures land
 * as state + copy + a live-region announcement, never as an unhandled rejection. A quota
 * failure during export is routed through the pending-write queue — §5.5 hangs the
 * export/cleanup dialog off `QUOTA_EXCEEDED`, and a write is never silently dropped.
 *
 * `runExport()` resolves to `true` only when the download was handed to the browser, which is
 * what makes it usable as the queue's `retry` closure.
 */

import { announce } from '../../app/announce';
import { deleteAllData, exportBackup } from '../../portability';
import { t } from '../../i18n';
import { deriveBanners } from './derive';
import { markRecoveryStarted } from './flags';
import { openDialog, pushToast } from './notices';
import { invalidateCounts, loadCounts, resolveDb } from './dbAccess';
import { isQuotaExceeded, noteWriteFailure } from './pendingWrites';
import { invalidateSnapshots, refreshSnapshots } from './snapshots';
import { dataSafetyState, patchState } from './state';
import { refreshQuota, refreshPersistence } from './storageInfo';

/** Is a data-safety action already in flight (double-click guard for the panel)? */
export function isBusy(): boolean {
  return dataSafetyState.value.panelState !== 'idle';
}

/**
 * Run an export (§4.3 "Back up now", plus every "Export a backup" crisis action).
 * Returns `true` when the file was handed to the browser.
 */
export async function runExport(): Promise<boolean> {
  if (isBusy()) return false;
  patchState({ exportState: 'saving', panelState: 'export-loading' });
  try {
    const result = await exportBackup({ download: true });
    if (!result.ok) {
      patchState({ exportState: 'error' });
      if (isQuotaExceeded(result.error)) {
        noteWriteFailure(result.error, t('dataSafety.backup.action'), runExport);
        return false;
      }
      announce(t('dataSafety.backup.error'), 'assertive');
      return false;
    }

    patchState({ exportState: 'saved', lastBackupAt: result.value.exportedAt });
    // `warnings` (e.g. lastBackupAt could not be written back) are non-fatal for the export —
    // but they are never hidden from the local log.
    for (const warning of result.value.warnings) {
      console.warn('data-safety: export warning', warning);
    }
    announce(t('dataSafety.backup.doneSafe'));
    pushToast({ message: t('dataSafety.backup.doneSafe'), variant: 'success' });
    await refreshQuota();
    await refreshSnapshots();
    deriveBanners();
    return true;
  } finally {
    patchState({ panelState: 'idle' });
  }
}

/** "Ask again" lives in `persistGate.ts` (engine-free) so the banner host stays light. */

/**
 * "Delete all data" (§6.8): confirm first — focus starts on "Export a backup first" — then the
 * real wipe. On success the wipe is acknowledged so the NEXT boot does not misread a
 * deliberate deletion as an eviction (§3.4). The acknowledgement is written AFTER
 * `deleteAllData()` clears `todo:prefs:v1:*`, so it survives.
 */
export async function runDeleteAll(): Promise<boolean> {
  const db = resolveDb();
  if (db === null) return false;
  const counts = await loadCounts(db);
  const confirmed = await openDialog({ kind: 'delete-all-confirm', dataCounts: counts });
  if (!confirmed) return false;

  const wiped = await deleteAllData();
  if (!wiped.ok) {
    announce(t('dataSafety.deleteAll.failed'), 'assertive');
    pushToast({ message: t('dataSafety.deleteAll.failed'), variant: 'error' });
    return false;
  }

  markRecoveryStarted();
  invalidateCounts();
  invalidateSnapshots();
  patchState({
    counts: null,
    hasData: false,
    snapshots: [],
    lastBackupAt: null,
    classification: { kind: 'normal' },
    onboarding: false,
    exportState: 'idle',
    panelState: 'idle',
  });
  announce(t('dataSafety.deleteAll.done'));
  pushToast({ message: t('dataSafety.deleteAll.done'), variant: 'success' });
  await refreshQuota();
  await refreshPersistence();
  deriveBanners();
  return true;
}
