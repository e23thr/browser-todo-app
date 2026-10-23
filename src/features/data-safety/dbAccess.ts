/**
 * Database access for the data-safety surface — the only place this feature resolves the
 * bound ADR-004 database handle.
 *
 * `resolveDb()` returns `null` when nothing is bound (boot failed, unit tests without a
 * database): every caller degrades instead of throwing, per §9.4.
 */

import { resolveDataSafetyDb } from '../../portability';
import type { AppDB, AppDBImpl } from '../../storage/db';
import { SETTINGS_KEY } from '../../storage/schema';
import { patchState } from './state';
import type { DataCounts } from './types';

/** The booted database, or `null` when the surface could not bind one. */
export function resolveDb(): AppDBImpl | null {
  const resolved = resolveDataSafetyDb();
  return resolved.ok ? resolved.value : null;
}

function isLive(row: { readonly deletedAt: number | null }): boolean {
  return row.deletedAt === null;
}

/** Exact counts (tombstones excluded). Full scan — user-triggered paths only. */
export async function readCounts(db: AppDB): Promise<DataCounts> {
  const [lists, tasks] = await Promise.all([db.getAll('lists'), db.getAll('tasks')]);
  const liveLists = lists.ok ? lists.value.filter(isLive) : [];
  const liveTasks = tasks.ok ? tasks.value.filter(isLive) : [];
  return {
    lists: liveLists.length,
    tasks: liveTasks.length,
    doneTasks: liveTasks.filter((task) => task.status === 'done').length,
    hasData: liveLists.length + liveTasks.length > 0,
  };
}

/**
 * Cheap existence check (one cursor step per store), falling back to a full scan only when
 * the head rows are tombstones — the one case where "no live row in the first page" does not
 * mean "empty". Returns `null` when the store is non-empty and no exact counts were needed.
 */
export async function probeData(db: AppDB): Promise<DataCounts | null> {
  const [lists, tasks] = await Promise.all([
    db.getAll('lists', { limit: 1 }),
    db.getAll('tasks', { limit: 1 }),
  ]);
  const head = [...(lists.ok ? lists.value : []), ...(tasks.ok ? tasks.value : [])];
  if (head.some(isLive)) return null;
  if (head.length === 0) {
    return { lists: 0, tasks: 0, doneTasks: 0, hasData: false };
  }
  return readCounts(db);
}

let countsCache: DataCounts | null = null;

/**
 * Exact counts, cached in the store after the first request (confirm dialogs, delete-all).
 * Reads the counts lazily so a big list never pays a full scan at boot.
 */
export async function loadCounts(db?: AppDB | null): Promise<DataCounts> {
  if (countsCache !== null) return countsCache;
  const target = db ?? resolveDb();
  if (target === null) {
    return { lists: 0, tasks: 0, doneTasks: 0, hasData: false };
  }
  const counts = await readCounts(target);
  countsCache = counts;
  patchState({ counts });
  return counts;
}

/** Drop the cached inventory (after import / restore / delete-all). */
export function invalidateCounts(): void {
  countsCache = null;
}

/** `settings.lastBackupAt`, or `null` when the record is missing/unreadable. */
export async function readLastBackupAt(db: AppDB): Promise<number | null> {
  const settings = await db.get('settings', SETTINGS_KEY);
  if (!settings.ok || settings.value === undefined) return null;
  return settings.value.lastBackupAt;
}

/** Re-read `settings.lastBackupAt` and publish it (after export, import, delete-all). */
export async function refreshLastBackupAt(): Promise<number | null> {
  const db = resolveDb();
  if (db === null) return null;
  const lastBackupAt = await readLastBackupAt(db);
  patchState({ lastBackupAt });
  return lastBackupAt;
}
