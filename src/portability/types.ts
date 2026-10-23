/**
 * ADR-004 public types: backup document, import/export plans and reports, and
 * the typed error contract (Decision 5.4). Nothing throws across this boundary —
 * every entry point returns `Result<T, ImportError>` / `Result<T, StorageError>`.
 */

import type { List, Settings, Snapshot, Task } from '../storage/types';
import type { RecoveryEntry, RecoveryFile } from './recovery-document';

export type BackupKind = 'export' | 'snapshot';

/** Envelope (ADR-004 §2.2) — fixed key order is produced by the serializer. */
export type BackupEnvelope = {
  format: 'local-first-todo-backup';
  formatVersion: number;
  schemaVersion: number;
  kind: BackupKind;
  exportedAt: number;
  deviceId: string;
  app?: { name: string; version: string };
  counts: { lists: number; tasks: number; snapshots: number };
};

/** `data` sections (ADR-004 §2.3) — complete: tombstones included. */
export type BackupData = {
  settings: Settings;
  lists: List[];
  tasks: Task[];
  snapshots: Snapshot[];
};

export type BackupDocument = BackupEnvelope & { data: BackupData };

/* ------------------------------ import pipeline ------------------------------ */

export type ImportError =
  | { code: 'FILE_TOO_LARGE'; bytes: number; cap: number }
  | { code: 'PARSE_ERROR'; message: string }
  | { code: 'NOT_A_BACKUP'; message: string }
  | { code: 'FORMAT_TOO_NEW'; found: number; supported: number }
  | { code: 'NEWER_SCHEMA'; found: number; supported: number }
  | { code: 'UPGRADE_FAILED'; from: number; to: number; cause?: unknown }
  | { code: 'MALICIOUS_SHAPE'; message: string }
  | { code: 'LIMIT_EXCEEDED'; limit: string; found: number; cap: number }
  | { code: 'NOTHING_TO_IMPORT'; quarantined: number }
  | { code: 'SNAPSHOT_FAILED'; cause?: unknown }
  | { code: 'QUOTA_EXCEEDED'; cause?: unknown }
  | { code: 'TX_ABORTED'; cause?: unknown }
  | { code: 'UNAVAILABLE'; cause?: unknown }
  | { code: 'UNKNOWN'; cause?: unknown };

/**
 * Export failures. ADR-004 binds `exportBackup` to `Result<ExportReport,
 * ExportError>` without enumerating the union; this is the minimal honest set
 * (export is read-mostly — `settings.lastBackupAt` is best-effort and never
 * fails the export).
 */
export type ExportError =
  | { code: 'QUOTA_EXCEEDED'; cause?: unknown }
  | { code: 'TX_ABORTED'; cause?: unknown }
  | { code: 'UNAVAILABLE'; cause?: unknown }
  | { code: 'UNKNOWN'; cause?: unknown };

export type ImportPlan = {
  fileSummary: {
    fileName: string;
    fileBytes: number;
    formatVersion: number;
    schemaVersion: number;
    upgradedTo: number;
    kind: BackupKind;
  };
  /** `settings: true` when the settings record was accepted (see `records.settings`). */
  accepted: { lists: number; tasks: number; settings: boolean };
  /** Preview of the recovery entries (full document in `recovery`). */
  quarantined: RecoveryEntry[];
  warnings: string[];
  /** Internal: whitelist-rebuilt records `applyImport` writes verbatim. Not for display. */
  records: { settings: Settings | null; lists: List[]; tasks: Task[] };
  /** Internal: the downloadable recovery document for `quarantined` (Decision 7). */
  recovery: RecoveryFile | null;
};

export type ImportReport = {
  /** `'partial'` = applied with `quarantined > 0`. */
  outcome: 'applied' | 'partial';
  accepted: { lists: number; tasks: number; settings: boolean };
  quarantined: number;
  /** Present iff `quarantined > 0` (download offered — repair the source file). */
  recoveryFileName: string | null;
  /** The recovery file content for the download (never persisted). */
  recoveryFile: RecoveryFile | null;
  /** The pre-import snapshot — the ONE undo for this import (Decision 8.4). */
  undoSnapshot: { id: string; takenAt: number } | null;
  warnings: string[];
};

export type ExportReport = {
  fileName: string;
  fileBytes: number;
  exportedAt: number;
  counts: { lists: number; tasks: number; snapshots: number };
  /** The serialized backup document — the exact bytes the download carries. */
  document: string;
  /** Non-fatal notes (e.g. `settings.lastBackupAt` write failed — export still delivered). */
  warnings: string[];
};
