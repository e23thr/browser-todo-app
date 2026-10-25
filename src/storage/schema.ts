/**
 * Structural schema definition (ADR-002 Decision 3) — the single source used by
 * `onupgradeneeded` and by anything that needs the store/index inventory.
 * Keeping it as data prevents drift between the upgrade path and the ADR.
 *
 * idbVersion 1 stores: meta, lists, tasks, settings, snapshots, snapshot_payloads.
 * `tags` is reserved (ADR-002 §3.7) — no code may use it until a migration adds it.
 */

import type { StoreName } from './types.ts';

export const DB_NAME = 'local-first-todo';
/**
 * idbVersion 3 = the additive `crypto_state` store (ADR-007 Decision 2.4).
 * idbVersion 2 = the additive `sync_state` store (ADR-006 Decision 3). idbVersion
 * 1 stores: meta, lists, tasks, settings, snapshots, snapshot_payloads. `tags`
 * is reserved (ADR-002 §3.7) — no code may use it until a migration adds it.
 */
export const IDB_VERSION = 3;
/**
 * Current logical data version (ADR-002 Decision 2). Chain map: v1 = ADR-002
 * baseline; v2 = the `sync_state` store (ADR-006 Decision 3, t_00d7f17b); v3 =
 * E7 organization schema (`P1..P4` priority model, reserved recurrence format)
 * in `src/storage/migrations.ts`; v4 = the `crypto_state` store (ADR-007
 * Decision 2.4).
 *
 * NOTE (ADR-007 conformance, recorded for review): the ADR pins the crypto
 * store at "idbVersion 3 / schemaVersion 3", but its own numbering rule ("steps
 * are numbered in canonical decision order and never renumbered… any further
 * migration appends at to: 4+") governs when reality diverges — E7's
 * organization step already took schemaVersion 3, so `crypto_state` lands at
 * schemaVersion 4 (idbVersion 3 matches the ADR exactly).
 */
export const APP_SCHEMA_VERSION = 4;
export const META_KEY = 'meta';
export const SETTINGS_KEY = 'settings';
/** Singleton key of the `sync_state` store (ADR-006 Decision 3). */
export const SYNC_KEY = 'sync';
/** Singleton key of the `crypto_state` store (ADR-007 Decision 2.3). */
export const CRYPTO_KEY = 'crypto';

export type IndexDef = {
  name: string;
  keyPath: string | string[];
  unique?: boolean;
  multiEntry?: boolean;
};

export type StoreDef = {
  name: StoreName;
  /** null = out-of-line keys (only `meta`). */
  keyPath: string | null;
  indexes: IndexDef[];
};

export const STORE_DEFS: readonly StoreDef[] = [
  { name: 'meta', keyPath: null, indexes: [] },
  { name: 'lists', keyPath: 'id', indexes: [{ name: 'by_updatedAt', keyPath: 'updatedAt' }] },
  {
    name: 'tasks',
    keyPath: 'id',
    indexes: [
      { name: 'by_listId', keyPath: 'listId' },
      { name: 'by_status', keyPath: 'status' },
      // by_dueDate and by_parent are auto-sparse: rows without the key are absent.
      { name: 'by_dueDate', keyPath: 'dueDate' },
      { name: 'by_updatedAt', keyPath: 'updatedAt' },
      { name: 'by_list_sort', keyPath: ['listId', 'sortOrder'] },
      { name: 'by_parent', keyPath: 'parentTaskId' },
    ],
  },
  { name: 'settings', keyPath: 'id', indexes: [] },
  { name: 'snapshots', keyPath: 'id', indexes: [{ name: 'by_takenAt', keyPath: 'takenAt' }] },
  { name: 'snapshot_payloads', keyPath: 'id', indexes: [] },
  // ADR-006 Decision 3: singleton under key 'sync', local-only (never exported,
  // snapshotted or synced). No indexes: it is read/written as one row.
  { name: 'sync_state', keyPath: 'id', indexes: [] },
  // ADR-007 Decision 2.3/2.4: singleton under key 'crypto', local-only — the
  // key ring (wrapped DMKs) + migration status. No indexes.
  { name: 'crypto_state', keyPath: 'id', indexes: [] },
];
