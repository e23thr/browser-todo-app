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
import { backupFileName, deleteAllData, downloadTextFile, exportBackup } from '../../portability';
import { pickSaveFile, supportsFsaSave, writeTextToHandle } from '../../portability/fsa';
import type { SavePickOutcome } from '../../portability/fsa';
import { t } from '../../i18n';
import { deriveBanners } from './derive';
import { markRecoveryStarted } from './flags';
import { closeDialog, openDialog, pushToast } from './notices';
import { invalidateCounts, loadCounts, resolveDb } from './dbAccess';
import { isQuotaExceeded, noteWriteFailure } from './pendingWrites';
import { invalidateSnapshots, refreshSnapshots } from './snapshots';
import { dataSafetyState, patchState } from './state';
import { refreshQuota, refreshPersistence } from './storageInfo';

/** Is a data-safety action already in flight (double-click guard for the panel)? */
export function isBusy(): boolean {
  return dataSafetyState.value.panelState !== 'idle';
}

/** A delete-all is already running (its confirm is in `busy` state — N5 double-submit guard). */
let deleteInFlight = false;

/**
 * Run an export (§4.3 "Back up now", plus every "Export a backup" crisis action).
 * Returns `true` when the file was delivered (written or downloaded).
 *
 * S10: on Chromium the SYSTEM save dialog must open inside this click gesture,
 * so `pickSaveFile` is invoked synchronously before any `await`; the backup is
 * serialized afterwards and written to the chosen handle. Everywhere else — and
 * on any picker failure or cancel — the universal anchor download delivers the
 * same bytes (a cancel is a cancel, never an error).
 */
export function runExport(): Promise<boolean> {
  if (isBusy()) return Promise.resolve(false);
  const pick: Promise<SavePickOutcome> | null = supportsFsaSave()
    ? pickSaveFile({
        suggestedName: backupFileName(Date.now()),
        extensions: ['.json'],
        description: t('app.name'),
      })
    : null;
  return runExportFlow(pick);
}

async function runExportFlow(pick: Promise<SavePickOutcome> | null): Promise<boolean> {
  patchState({ exportState: 'saving', panelState: 'export-loading' });
  try {
    // The FSA path writes the serialized document itself — skip the anchor download.
    const result = await exportBackup({ download: pick === null });
    if (!result.ok) {
      patchState({ exportState: 'error' });
      if (isQuotaExceeded(result.error)) {
        noteWriteFailure(result.error, t('dataSafety.backup.action'), runExport);
        return false;
      }
      announce(t('dataSafety.backup.error'), 'assertive');
      return false;
    }

    // §7 vs §9: the FIRST ever backup gets the longer "keep it somewhere safe" line, every
    // later one the short §9 toast — the reassurance is only needed the first time.
    const firstEver = dataSafetyState.value.lastBackupAt === null;
    patchState({ exportState: 'saved', lastBackupAt: result.value.exportedAt });
    // `warnings` (e.g. lastBackupAt could not be written back) are non-fatal for the export —
    // but they are never hidden from the local log.
    for (const warning of result.value.warnings) {
      console.warn('data-safety: export warning', warning);
    }

    // How the bytes actually reached the user (drives the honest toast copy).
    let delivery: 'fsa' | 'download' = 'download';
    if (pick !== null) {
      const outcome = await pick;
      if (outcome.status === 'dismissed') {
        // The user closed the save dialog: nothing failed, nothing was written.
        patchState({ exportState: 'idle' });
        return false;
      }
      const written =
        outcome.status === 'picked'
          ? await writeTextToHandle(outcome.value, result.value.document)
          : false;
      if (!written) {
        // Universal fallback — the backup still reaches the user as a download.
        if (outcome.status === 'error') {
          console.warn('data-safety: FSA save failed, falling back to download', outcome.message);
        }
        if (!downloadTextFile(result.value.fileName, result.value.document)) {
          patchState({ exportState: 'error' });
          announce(t('dataSafety.backup.error'), 'assertive');
          return false;
        }
        delivery = 'download';
      } else {
        delivery = 'fsa';
      }
    }

    // §7 vs §9 copy honesty: the toast names WHERE the file actually went —
    // a picker write never claims "your downloads".
    const doneMessage =
      delivery === 'fsa'
        ? t('dataSafety.backup.doneFsa')
        : t(firstEver ? 'dataSafety.backup.doneSafe' : 'dataSafety.backup.doneShort');
    announce(doneMessage);
    pushToast({ message: doneMessage, variant: 'success' });
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
 *
 * N5: the confirm dialog stays up in its `busy` state while the wipe runs (§5.6/§10.6) and is
 * released in `finally`, and a second click can never start a second wipe.
 */
export async function runDeleteAll(): Promise<boolean> {
  if (isBusy() || deleteInFlight) return false;
  deleteInFlight = true;
  try {
    const db = resolveDb();
    if (db === null) return false;
    const counts = await loadCounts(db);
    const confirmed = await openDialog({ kind: 'delete-all-confirm', dataCounts: counts });
    if (!confirmed) return false;
    return await wipeAllData();
  } finally {
    deleteInFlight = false;
    closeDialog();
  }
}

/**
 * The wipe half of `runDeleteAll` WITHOUT the confirm dialog — for surfaces
 * that confirm inline: the lost-passphrase "delete all data" escape
 * (ADR-007 Decision 6.3 / §7.4) lives on the LOCKED screen, where there is no
 * `<DataSafetyHost>` to queue a dialog on — the panel owns its own two-step
 * confirmation instead.
 */
export async function runDeleteAllWithoutDialog(): Promise<boolean> {
  if (isBusy() || deleteInFlight) return false;
  deleteInFlight = true;
  try {
    if (resolveDb() === null) return false;
    return await wipeAllData();
  } finally {
    deleteInFlight = false;
  }
}

async function wipeAllData(): Promise<boolean> {
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
