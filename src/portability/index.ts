/**
 * Public data-safety surface (ADR-004) — what the data-safety UX card (and the
 * settings panel) imports. Binding signatures live in ADR-004 "API surface";
 * every function additionally accepts `{ db }` (tests/explicit) after binding
 * the app DB once via `bindDataSafetyDb(db)`.
 *
 * Layering: this module composes `src/storage` (framework) + `src/app/theme`
 * (theme mirror). Nothing here talks to IndexedDB directly.
 */

/* ---- document format (Decisions 1–2, 6) ---- */
export {
  canonicalizeRecord,
  buildBackupDocument,
  serializeBackupDoc,
  parseBackupDocument,
  readImportText,
  inputByteSize,
} from './backup-document';
export type { BuildBackupInput, ParseFileInput, RawBackup, SectionName } from './backup-document';

/* ---- recovery document (Decision 7 — the ONLY writer) ---- */
export {
  buildRecoveryDocumentFile,
  recoveryFileName,
  serializeRecoveryDoc,
} from './recovery-document';
export type {
  RecoveryEntry,
  RecoveryEntryInput,
  RecoveryFile,
  RecoveryMeta,
  RecoverySource,
  RecoveryStore,
} from './recovery-document';

/* ---- import pipeline (Decision 5) ---- */
export { applyImport, prepareImport, prepareSnapshotRestore, restoreSnapshot } from './import';
export type { ApplyImportOptions, PrepareImportOptions } from './import';
export { validateRecords } from './records';
export type { Anchored, StageBInput, StageBOutput } from './records';
export { upgradeRawBackup } from './upgrade';
export type { UpgradedSections } from './upgrade';

/* ---- export + wipe (Decisions 9–10) ---- */
export { clearPrefs, deleteAllData, exportBackup } from './export';
export type { DeleteAllDataOptions, ExportBackupOptions } from './export';

/* ---- snapshot engine (Decision 8) ---- */
export {
  adr004Codec,
  deleteSnapshot,
  downloadSnapshot,
  listSnapshots,
  makeAdr004Codec,
  maybeScheduledSnapshot,
  snapshotDownloadName,
  takeSnapshot,
} from './snapshots-api';
export type { Adr004CodecOptions, DataSafetyDbOptions } from './snapshots-api';

/* ---- cross-cutting ---- */
export { bindDataSafetyDb, resolveDataSafetyDb } from './context';
export type { UnboundDbError } from './context';
export { downloadTextFile } from './download';
export { broadcastDataReplaced, mirrorTheme } from './side-effects';
export {
  APP_NAME,
  APP_VERSION,
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  DATA_REPLACED_CHANNEL,
  DEFAULT_SETTINGS_RECORD,
  FORBIDDEN_KEYS,
  MAX_IMPORT_BYTES,
  MAX_LISTS,
  MAX_SNAPSHOT_ROWS,
  MAX_TASKS,
  MAX_DOC_DEPTH,
  PREFS_PREFIX,
  RECOVERY_FORMAT,
  RECOVERY_FORMAT_VERSION,
  backupFileName,
  snapshotFileName,
  utcStamp,
} from './constants';
export type {
  BackupData,
  BackupDocument,
  BackupEnvelope,
  BackupKind,
  ExportError,
  ExportReport,
  ImportError,
  ImportPlan,
  ImportReport,
} from './types';
