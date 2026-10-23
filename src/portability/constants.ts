/**
 * ADR-004 constants: format tokens, caps, filename conventions, module defaults.
 *
 * Every value here is normative (ADR-004 Decisions 2, 6, 7, 9) — change it only
 * through an ADR amendment.
 */

import type { Settings } from '../storage/types';

/** Backup document token (export files AND snapshot payloads). */
export const BACKUP_FORMAT = 'local-first-todo-backup';
/** Recovery document token — deliberately NOT importable (ADR-004 Decision 7). */
export const RECOVERY_FORMAT = 'local-first-todo-recovery';
export const BACKUP_FORMAT_VERSION = 1;
export const RECOVERY_FORMAT_VERSION = 1;

/** Provenance block (`app`) written into every document we produce. */
export const APP_NAME = 'local-first-todo';
export const APP_VERSION = '0.1.0';

/* ------------------------------ caps (Decision 6) ------------------------------ */

export const MAX_IMPORT_BYTES = 52_428_800; // 50 MiB (ADR-002 Decision 11's binding cap)
export const MAX_DOC_DEPTH = 8;
export const MAX_LISTS = 1_000;
export const MAX_TASKS = 100_000; // E7 ceiling
export const MAX_SNAPSHOT_ROWS = 1_000;

/** Prototype-pollution keys: ANY occurrence anywhere rejects the file (Decision 6). */
export const FORBIDDEN_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

/** Auto snapshot throttle for the `scheduled` trigger (ADR-004 §8.3). */
export const SCHEDULED_SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/* --------------------------- device-local prefs --------------------------- */

/** ADR-002 Decision 7 namespace — wiped by "Delete all data", never exported. */
export const PREFS_PREFIX = 'todo:prefs:v1:';
/** `BroadcastChannel` name for cross-tab replacement notices (ADR-004 Decision 3). */
export const DATA_REPLACED_CHANNEL = 'local-first-todo';

/**
 * Module defaults for the `settings` singleton: used when a database has no
 * settings row yet (every produced document must carry one — Decision 2.3) and
 * as the reset target of "Delete all data" (Decision 10).
 */
export const DEFAULT_SETTINGS_RECORD: Settings = {
  id: 'settings',
  theme: 'system',
  locale: 'en',
  weekStart: 0,
  defaultListId: null,
  notificationsEnabled: false,
  lastBackupAt: null,
};

/* ---------------------------- filenames (Decision 9) ---------------------------- */

/** UTC, filesystem-safe: `YYYY-MM-DDTHHmmssZ` (no colons in the time part). */
export function utcStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return (
    `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

export function backupFileName(exportedAt: number): string {
  return `local-first-todo-backup-${utcStamp(exportedAt)}.json`;
}

export function snapshotFileName(takenAt: number): string {
  return `local-first-todo-snapshot-${utcStamp(takenAt)}.json`;
}

export function recoveryFileName(createdAt: number): string {
  return `local-first-todo-recovery-${utcStamp(createdAt)}.json`;
}
