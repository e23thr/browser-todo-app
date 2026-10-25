/**
 * Export (ADR-004 Decision 9) and the pinned "Delete all data" factory reset
 * (Decision 10 — the restore path depends on these exact semantics).
 *
 * Export always includes tombstones and is always a full backup; it stamps
 * `settings.lastBackupAt := exportedAt` into the document AND back to the DB
 * (best-effort: that small write failing never fails the export). "Delete all
 * data" takes NO pre-wipe snapshot — a snapshot there would be exactly the
 * shadow copy §7.4 forbids.
 */

import { err, ok } from '../storage/errors';
import type { Result, StorageError } from '../storage/errors';
import type { AppDBImpl } from '../storage/db';
import type { Meta, Settings } from '../storage/types';
import { readSnapshotSource } from '../storage/snapshots';
import { buildBackupDocument, serializeBackupDoc } from './backup-document';
import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_SETTINGS_RECORD,
  PREFS_PREFIX,
  backupFileName,
} from './constants';
import { resolveDataSafetyDb } from './context';
import { downloadTextFile } from './download';
import { broadcastDataReplaced, notifyDataReplaced } from './side-effects';
import type { ExportError, ExportReport } from './types';

export type ExportBackupOptions = {
  db?: AppDBImpl;
  now?: () => number;
  /** Set `false` to serialize without triggering a browser download (tests). */
  download?: boolean;
};

function toExportError(e: StorageError): ExportError {
  switch (e.code) {
    case 'QUOTA_EXCEEDED':
    case 'TX_ABORTED':
    case 'UNAVAILABLE':
    case 'UNKNOWN':
      return e;
    default:
      return { code: 'UNKNOWN', cause: e };
  }
}

/**
 * M11: serialize the current DB state (live rows AND tombstones; snapshot
 * metadata but never payloads) and download it. `document` in the report is the
 * exact byte string of the download (and the import drill's input).
 */
export async function exportBackup(
  opts: ExportBackupOptions = {},
): Promise<Result<ExportReport, ExportError>> {
  const resolved = resolveDataSafetyDb(opts.db);
  if (!resolved.ok) return err(resolved.error);
  const db = resolved.value;
  const now = opts.now ?? Date.now;

  const source = await readSnapshotSource(db);
  if (!source.ok) return err(toExportError(source.error));

  const exportedAt = now();
  const storedSettings = source.value.stores.settings[0];
  // Decision 9.2: the document is self-consistent — its own lastBackupAt equals
  // its exportedAt. Values otherwise round-trip verbatim.
  const settings: Settings = {
    ...(storedSettings ?? DEFAULT_SETTINGS_RECORD),
    lastBackupAt: exportedAt,
  };

  const document = serializeBackupDoc(
    buildBackupDocument({
      kind: 'export',
      exportedAt,
      deviceId: db.deviceId,
      schemaVersion: source.value.schemaVersion,
      settings,
      lists: source.value.stores.lists,
      tasks: source.value.stores.tasks,
      snapshots: source.value.stores.snapshots,
      app: { name: APP_NAME, version: APP_VERSION },
    }),
  );

  const warnings: string[] = [];
  // Best-effort DB write (Decision 9.2): the download is the point.
  const stamped = await db.put('settings', settings);
  if (!stamped.ok) {
    warnings.push(
      `settings.lastBackupAt not written back (${stamped.error.code}) — the export is still complete`,
    );
  }

  const fileName = backupFileName(exportedAt);
  if (opts.download !== false) {
    downloadTextFile(fileName, document);
  }

  return ok({
    fileName,
    fileBytes: new TextEncoder().encode(document).length,
    exportedAt,
    counts: {
      lists: source.value.stores.lists.length,
      tasks: source.value.stores.tasks.length,
      snapshots: source.value.stores.snapshots.length,
    },
    document,
    warnings,
  });
}

export type DeleteAllDataOptions = {
  db?: AppDBImpl;
  /** Injectable for tests; defaults to `globalThis.localStorage`. */
  storage?: Pick<Storage, 'key' | 'removeItem'> | null;
};

function defaultStorage(): Pick<Storage, 'key' | 'removeItem'> | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** Clear every `todo:prefs:v1:*` boot-pref (Decision 10: theme mirror → default). */
export function clearPrefs(
  storage: Pick<Storage, 'key' | 'removeItem'> | null = defaultStorage(),
): void {
  if (storage === null) return;
  try {
    const doomed: string[] = [];
    for (let i = 0; ; i += 1) {
      const key = storage.key(i);
      if (key === null) break;
      if (key.startsWith(PREFS_PREFIX)) doomed.push(key);
    }
    for (const key of doomed) storage.removeItem(key);
  } catch {
    // Private mode: prefs stay, but the data wipe itself already succeeded.
  }
}

/**
 * "Delete all data" (Decision 10) — a true factory reset: hard-delete lists,
 * tasks, snapshots AND payloads; reset settings to module defaults; clear
 * `todo:prefs:v1:*`; keep `meta` (deviceId, createdAt, schemaVersion) with
 * `lastPurgeAt` cleared. NO pre-wipe snapshot.
 */
export async function deleteAllData(
  opts: DeleteAllDataOptions = {},
): Promise<Result<void, StorageError>> {
  const resolved = resolveDataSafetyDb(opts.db);
  if (!resolved.ok) return err(resolved.error);
  const db = resolved.value;

  // Collect EVERY row id first — quarantine-denylisted rows included: a factory
  // reset must not leave hidden invalid rows behind (no shadow copies, §7.4).
  const doomed: { store: 'lists' | 'tasks' | 'snapshots' | 'snapshot_payloads'; id: string }[] = [];
  for (const store of ['lists', 'tasks', 'snapshots', 'snapshot_payloads'] as const) {
    const rows = await db.readUnfiltered(store);
    if (!rows.ok) return err(rows.error);
    for (const row of rows.value) doomed.push({ store, id: row.id });
  }

  const wiped = await db.tx(
    ['lists', 'tasks', 'snapshots', 'snapshot_payloads', 'settings', 'meta'],
    'readwrite',
    async (t) => {
      for (const { store, id } of doomed) {
        await t.delete(store, id);
      }
      await t.put('settings', { ...DEFAULT_SETTINGS_RECORD });
      const meta = await t.get('meta', 'meta');
      if (meta !== undefined) {
        const kept: Meta = {
          schemaVersion: meta.schemaVersion,
          deviceId: meta.deviceId,
          createdAt: meta.createdAt,
          lastOpenedAt: meta.lastOpenedAt,
        };
        await t.put('meta', kept);
      }
      return ok(undefined);
    },
  );
  if (!wiped.ok) return err(wiped.error);

  clearPrefs(opts.storage ?? defaultStorage());
  broadcastDataReplaced();
  // A wipe is a wholesale replacement too — same UI refresh seam as import/restore
  // (t_85e19c39): the running store must show the empty state without a reload.
  notifyDataReplaced();
  return ok(undefined);
}

export type { ExportError, ExportReport };
