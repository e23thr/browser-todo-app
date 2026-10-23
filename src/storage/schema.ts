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
export const IDB_VERSION = 1;
/** Current logical data version (ADR-002 Decision 2). */
export const APP_SCHEMA_VERSION = 1;
export const META_KEY = 'meta';
export const SETTINGS_KEY = 'settings';

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
];
