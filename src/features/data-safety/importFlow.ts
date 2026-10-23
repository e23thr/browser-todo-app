/**
 * Import flow (design §5.7 state machine, §8 interaction) + snapshot restore (§8.4).
 *
 * The machine is the §5.7 `ImportState` union held in a signal; the panel renders it (§10.7)
 * and the confirm step is a `SafetyDialog`. Ordering is the binding part of §8.1:
 *
 *   pick → validate (pure, ADR-004 stage 1-3) → preview → CONFIRM → snapshot + replace → done
 *
 * Nothing is written before the user confirms, and `applyImport` runs the pre-import snapshot
 * first: if that snapshot fails the import ABORTS with `recoverable: true` and copy that says
 * so (§8.1 step 5). `applyImport` is one atomic transaction, so every failure it can return
 * leaves the database untouched — which is why this machine only ever reports the
 * `recoverable: true` branch of §8.2 (the unrecoverable copy stays in the catalog for the day
 * a two-phase rollback exists).
 *
 * Restore uses the SAME confirm + replace path (§8.4): `prepareSnapshotRestore` → confirm →
 * `applyImport`. Per ADR-004 the apply takes its own pre-import snapshot ("undo of undo"),
 * which is the engine behaviour the parent handoff binds — see the deviation note in the
 * completion metadata vs §8.4's "creates NO new snapshot".
 */

import { signal } from '@preact/signals';

import { announce } from '../../app/announce';
import {
  applyImport,
  downloadTextFile,
  prepareImport,
  prepareSnapshotRestore,
} from '../../portability';
import type { ImportError, ImportPlan } from '../../portability';
import { t } from '../../i18n';
import { deriveBanners } from './derive';
import { invalidateCounts, loadCounts, refreshLastBackupAt, resolveDb } from './dbAccess';
import { openDialog, pushToast, type ToastRequest } from './notices';
import { refreshSnapshots } from './snapshots';
import { dataSafetyState, patchState } from './state';
import type { ImportPreview, SnapshotMeta } from './types';

export type ImportInvalidReason =
  'bad-json' | 'schema-unknown' | 'too-large' | 'not-our-file' | 'newer-version';

export type ImportState =
  | { readonly step: 'pick' }
  | { readonly step: 'validating' }
  | { readonly step: 'invalid'; readonly reason: ImportInvalidReason; readonly message: string }
  | { readonly step: 'preview'; readonly file: ImportPreview }
  | { readonly step: 'confirming' }
  | { readonly step: 'importing' }
  | { readonly step: 'done'; readonly undoSnapshotId: string | null }
  | { readonly step: 'failed'; readonly recoverable: boolean; readonly message: string };

export const importState = signal<ImportState>({ step: 'pick' });

/**
 * Picker request counter (§3.4 recovery screen → "Restore from a backup"): the container
 * bumps it and the panel clicks its own hidden input. Kept in its own leaf module so App can
 * bump it without importing the engine (§9.2) — re-exported here for feature-internal users.
 */
export { importPickTick, requestImportPick } from './picker';

/** Test / flow seam: back to `{ step: 'pick' }`. */
export function resetImportState(): void {
  importState.value = { step: 'pick' };
}

/* ------------------------------- preview ------------------------------- */

/** `exportedAt` from the document head (bounded read — never a full parse of untrusted input). */
export async function readExportedAt(file: File): Promise<number | null> {
  try {
    const head = await file.slice(0, 8192).text();
    const match = /"exportedAt"\s*:\s*(\d{10,14})/.exec(head);
    if (match?.[1] !== undefined) {
      const value = Number(match[1]);
      // Plausible epoch ms (2001-01-01 … 3000-01-01); anything else is display garbage.
      if (value > 978_307_200_000 && value < 32_503_680_000_000) return value;
    }
  } catch {
    // A file we cannot read head-first simply has no known export date.
  }
  return null;
}

function toPreview(plan: ImportPlan, bytes: number, exportedAt: number | null): ImportPreview {
  return {
    schemaVersion: plan.fileSummary.schemaVersion,
    counts: {
      lists: plan.accepted.lists,
      tasks: plan.accepted.tasks,
      doneTasks: plan.records.tasks.filter((task) => task.status === 'done').length,
      // ADR-004's plan does not expose the document's snapshot-metadata count and no copy
      // in §8 uses it — reported as 0 rather than invented.
      snapshots: 0,
    },
    exportedAt,
    fileSizeBytes: bytes,
  };
}

/* ------------------------------ error copy ------------------------------ */

/** Stage A failure → §5.7 `invalid(reason)` + the §7 inline copy (all static keys). */
function invalidFrom(error: ImportError): {
  readonly reason: ImportInvalidReason;
  readonly message: string;
} {
  const appName = t('app.name');
  switch (error.code) {
    case 'PARSE_ERROR':
      return { reason: 'bad-json', message: t('dataSafety.import.error.badJson') };
    case 'NOT_A_BACKUP':
      return {
        reason: 'not-our-file',
        message: t('dataSafety.import.error.notBackup', { appName }),
      };
    case 'FILE_TOO_LARGE':
      return { reason: 'too-large', message: t('dataSafety.import.error.tooLarge') };
    case 'FORMAT_TOO_NEW':
    case 'NEWER_SCHEMA':
    case 'UPGRADE_FAILED':
      return { reason: 'newer-version', message: t('dataSafety.import.error.newer', { appName }) };
    case 'MALICIOUS_SHAPE':
      return { reason: 'not-our-file', message: t('dataSafety.import.error.malicious') };
    case 'LIMIT_EXCEEDED':
      return { reason: 'too-large', message: t('dataSafety.import.error.limits') };
    case 'NOTHING_TO_IMPORT':
      return { reason: 'schema-unknown', message: t('dataSafety.import.error.nothing') };
    case 'SNAPSHOT_FAILED':
      return { reason: 'schema-unknown', message: t('dataSafety.import.failed.snapshotFirst') };
    case 'QUOTA_EXCEEDED':
      return { reason: 'schema-unknown', message: t('dataSafety.import.error.quota') };
    case 'TX_ABORTED':
    case 'UNAVAILABLE':
    case 'UNKNOWN':
      return { reason: 'schema-unknown', message: t('dataSafety.import.error.generic') };
  }
}

/** Apply-stage failure → §8.2. Atomicity means "nothing changed" is always true here. */
function failedFrom(error: ImportError): { readonly message: string } {
  switch (error.code) {
    case 'SNAPSHOT_FAILED':
      return { message: t('dataSafety.import.failed.snapshotFirst') };
    case 'QUOTA_EXCEEDED':
      return { message: t('dataSafety.import.error.quota') };
    case 'NOTHING_TO_IMPORT':
      return { message: t('dataSafety.import.error.nothing') };
    default:
      return { message: t('dataSafety.import.failed.recoverable') };
  }
}

/* --------------------------------- flows -------------------------------- */

/**
 * §8.1 steps 1–7 for a picked file: validate (zero side effects) → preview → confirm dialog →
 * snapshot + replace → done toast with the undo action.
 */
export async function chooseImportFile(file: File): Promise<void> {
  patchState({ panelState: 'import-loading' });
  importState.value = { step: 'validating' };

  const plan = await prepareImport(file);
  if (!plan.ok) {
    const invalid = invalidFrom(plan.error);
    importState.value = { step: 'invalid', ...invalid };
    announce(invalid.message, 'assertive');
    patchState({ panelState: 'idle' });
    return;
  }

  const exportedAt = await readExportedAt(file);
  const preview = toPreview(plan.value, file.size, exportedAt);
  importState.value = { step: 'preview', file: preview };

  const currentCounts = await loadCounts();
  importState.value = { step: 'confirming' };
  patchState({ panelState: 'idle' });

  const confirmed = await openDialog({
    kind: 'import-confirm',
    preview,
    currentCounts,
    quarantined: plan.value.quarantined.length,
  });
  if (!confirmed) {
    importState.value = { step: 'pick' };
    return;
  }
  await applyPlan(plan.value);
}

/** Run the confirmed plan: pre-import snapshot → atomic replace → report + undo toast. */
async function applyPlan(plan: ImportPlan): Promise<void> {
  patchState({ panelState: 'import-loading' });
  importState.value = { step: 'importing' };
  const report = await applyImport(plan);
  patchState({ panelState: 'idle' });

  if (!report.ok) {
    const failed = failedFrom(report.error);
    importState.value = { step: 'failed', recoverable: true, message: failed.message };
    announce(failed.message, 'assertive');
    pushToast({ message: failed.message, variant: 'error' });
    return;
  }

  const undo = report.value.undoSnapshot;
  importState.value = { step: 'done', undoSnapshotId: undo?.id ?? null };

  invalidateCounts();
  await loadCounts();
  await refreshSnapshots();
  await refreshLastBackupAt();
  deriveBanners();

  announce(t('dataSafety.import.done.message'));
  pushToast(undoToast(undo?.id ?? null));
  // A partial import also offers the recovery file (ADR-004 Decision 7) as its own toast.
  if (report.value.recoveryFile !== null) {
    const recovery = report.value.recoveryFile;
    pushToast({
      message: t('dataSafety.import.partial'),
      variant: 'success',
      action: {
        label: t('dataSafety.import.recoveryFile'),
        run: (): void => {
          downloadTextFile(recovery.filename, recovery.json);
        },
      },
    });
  }
}

/** §8.4 undo toast — persistent until the user interacts with it (§5.8). */
function undoToast(undoId: string | null): ToastRequest {
  const message = t('dataSafety.import.done.message');
  if (undoId === null) return { message, variant: 'success' };
  return {
    message,
    variant: 'success',
    persistent: true,
    action: {
      label: t('dataSafety.import.done.action'),
      run: (): void => {
        void restoreSnapshot(undoId);
      },
    },
  };
}

/**
 * §8.4 restore: prepare (zero side effects) → confirm dialog → same replace pipeline.
 * The undo affordance stays available as long as the snapshot exists.
 */
export async function restoreSnapshot(id: string): Promise<void> {
  const db = resolveDb();
  if (db === null) return;

  patchState({ panelState: 'import-loading' });
  const plan = await prepareSnapshotRestore(id);
  if (!plan.ok) {
    const failed = failedFrom(plan.error);
    patchState({ panelState: 'idle' });
    importState.value = { step: 'failed', recoverable: true, message: failed.message };
    pushToast({ message: failed.message, variant: 'error' });
    return;
  }

  const snapshot: SnapshotMeta | undefined = dataSafetyState.value.snapshots.find(
    (row) => row.id === id,
  );
  patchState({ panelState: 'idle' });
  if (snapshot === undefined) return;

  const currentCounts = await loadCounts(db);
  const confirmed = await openDialog({
    kind: 'restore-confirm',
    snapshot,
    currentCounts,
  });
  if (!confirmed) return;

  await applyPlan(plan.value);
}
