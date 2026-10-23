/**
 * Snapshot engine surface (ADR-004 Decisions 8–9): the ADR-004 document codec
 * plugged into the E1 snapshot mechanics, plus the M12 trigger surface —
 * `takeSnapshot` / `listSnapshots` / `deleteSnapshot` / `downloadSnapshot` /
 * `restoreSnapshot` and the throttled `scheduled` auto trigger.
 *
 * The binding signatures take no database argument (the app binds its booted DB
 * via `bindDataSafetyDb`); every function also accepts `{ db }` for tests.
 *
 * `exportedAt == Snapshot.takenAt` (§8.1) without framework changes: this layer
 * freezes `takenAt` up front and hands the framework `now: () => takenAt`, so
 * the id, the metadata row and the document envelope agree exactly.
 */

import { err, invalidRecord, ok, unknownError } from '../storage/errors';
import type { Result, StorageError } from '../storage/errors';
import type { AppDBImpl } from '../storage/db';
import { newUlid } from '../storage/id';
import { validateRow } from '../storage/validate';
import {
  deleteSnapshot as frameworkDeleteSnapshot,
  getSnapshotPayload,
  listSnapshots as frameworkListSnapshots,
  takeSnapshot as frameworkTakeSnapshot,
} from '../storage/snapshots';
import type { SnapshotCodec } from '../storage/snapshots';
import type {
  List,
  Settings,
  Snapshot,
  SnapshotKind,
  SnapshotReason,
  StoreName,
  Task,
} from '../storage/types';
import {
  buildBackupDocument,
  canonicalizeRecord,
  parseBackupDocument,
  serializeBackupDoc,
} from './backup-document';
import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_SETTINGS_RECORD,
  SCHEDULED_SNAPSHOT_INTERVAL_MS,
  snapshotFileName,
} from './constants';
import { resolveDataSafetyDb } from './context';

export type DataSafetyDbOptions = {
  db?: AppDBImpl;
  now?: () => number;
};

export type Adr004CodecOptions = {
  /** Provenance fallback when the payload source carries no `meta` row. */
  deviceId?: string;
  /** `exportedAt` fallback when the source carries no `takenAt`. */
  now?: () => number;
};

/** The row's `id` when it carries one — only used to name a rejected record. */
function recordId(record: unknown): string | undefined {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return undefined;
  const id = (record as Record<string, unknown>)['id'];
  return typeof id === 'string' ? id : undefined;
}

/**
 * ADR-004's serializer as a `SnapshotCodec` (the E1 format hook): snapshot
 * payloads are backup documents (`kind: "snapshot"`), which is exactly what
 * makes "rollback = import the snapshot" true (Decision 1).
 */
export function makeAdr004Codec(opts: Adr004CodecOptions = {}): SnapshotCodec {
  return {
    name: 'adr-004-json',
    serialize(source) {
      const takenAt = source.takenAt ?? (opts.now ?? Date.now)();
      // Defensive read: `readSnapshotSource` leaves `meta` unpopulated at runtime
      // (the type says `Meta[]`), so narrow before indexing.
      const stores = source.stores as unknown as {
        meta?: { deviceId: string }[];
        settings?: Settings[];
        lists?: List[];
        tasks?: Task[];
        snapshots?: Snapshot[];
      };
      const meta = stores.meta?.[0];
      const settings = stores.settings?.[0] ?? DEFAULT_SETTINGS_RECORD;
      const doc = buildBackupDocument({
        kind: 'snapshot',
        exportedAt: takenAt,
        deviceId: meta?.deviceId ?? opts.deviceId ?? newUlid(takenAt),
        schemaVersion: source.schemaVersion,
        settings,
        lists: stores.lists ?? [],
        tasks: stores.tasks ?? [],
        snapshots: stores.snapshots ?? [],
        app: { name: APP_NAME, version: APP_VERSION },
      });
      return serializeBackupDoc(doc);
    },
    deserialize(payload) {
      const parsed = parseBackupDocument(payload, { targetSchemaVersion: Number.MAX_SAFE_INTEGER });
      if (!parsed.ok) return err(unknownError(parsed.error));
      const raw = parsed.value;
      // Rollback-side Stage B (review finding 4): boot's `validateSnapshotPayload`
      // only checks "payload is a JSON object", so a corrupted-but-parseable stored
      // payload reaches here. EVERY record is therefore validated before the
      // whitelist rebuild, and one invalid row refuses the WHOLE payload with zero
      // side effects — never a silent row drop (no-silent-loss beats partial
      // restore). The E3 restore path is unaffected: it routes through
      // `prepareImport` and quarantines per record there.
      const sections: [StoreName, unknown[]][] = [
        ['settings', [raw.settings]],
        ['lists', raw.lists],
        ['tasks', raw.tasks],
        ['snapshots', raw.snapshots],
      ];
      for (const [store, records] of sections) {
        for (const record of records) {
          const checked = validateRow(store, record);
          if (!checked.ok) return err(invalidRecord(store, checked.issues, recordId(record)));
        }
      }
      const toRows = <T>(
        section: 'settings' | 'lists' | 'tasks' | 'snapshots',
        items: unknown[],
      ): T[] => items.map((item) => canonicalizeRecord(section, item) as unknown as T);
      return ok({
        schemaVersion: raw.schemaVersion,
        stores: {
          meta: [],
          settings: toRows('settings', [raw.settings]),
          lists: toRows('lists', raw.lists),
          tasks: toRows('tasks', raw.tasks),
          snapshots: toRows('snapshots', raw.snapshots),
          snapshot_payloads: [],
        },
      });
    },
  };
}

/** The default codec instance (fresh `now`, no deviceId fallback override). */
export const adr004Codec: SnapshotCodec = makeAdr004Codec();

/** M12 API: take a snapshot. `manual` keeps it forever; the rest roll at 3. */
export async function takeSnapshot(
  reason: SnapshotReason,
  opts: DataSafetyDbOptions = {},
): Promise<Result<{ id: string; takenAt: number }, StorageError>> {
  const resolved = resolveDataSafetyDb(opts.db);
  if (!resolved.ok) return err(resolved.error);
  const db = resolved.value;
  const takenAt = (opts.now ?? Date.now)();
  const kind: SnapshotKind = reason === 'manual' ? 'manual' : 'auto';
  const snap = await frameworkTakeSnapshot(db, {
    kind,
    reason,
    // Frozen clock: the document's `exportedAt` must equal `Snapshot.takenAt`
    // exactly (§8.1) — the codec's `now` is the same instant the row carries.
    codec: makeAdr004Codec({ deviceId: db.deviceId, now: () => takenAt }),
    now: () => takenAt,
  });
  if (!snap.ok) return err(snap.error);
  return ok({ id: snap.value.id, takenAt: snap.value.takenAt });
}

/** Newest first, metadata only (payloads are device-local). */
export async function listSnapshots(
  opts: DataSafetyDbOptions = {},
): Promise<Result<Snapshot[], StorageError>> {
  const resolved = resolveDataSafetyDb(opts.db);
  if (!resolved.ok) return err(resolved.error);
  return frameworkListSnapshots(resolved.value);
}

/** Any kind, explicit user action only (ADR-004 §8.2). */
export async function deleteSnapshot(
  id: string,
  opts: DataSafetyDbOptions = {},
): Promise<Result<void, StorageError>> {
  const resolved = resolveDataSafetyDb(opts.db);
  if (!resolved.ok) return err(resolved.error);
  return frameworkDeleteSnapshot(resolved.value, id);
}

/** The stored `kind: "snapshot"` document as a downloadable Blob. */
export async function downloadSnapshot(
  id: string,
  opts: DataSafetyDbOptions = {},
): Promise<Result<Blob, StorageError>> {
  const resolved = resolveDataSafetyDb(opts.db);
  if (!resolved.ok) return err(resolved.error);
  const payload = await getSnapshotPayload(resolved.value, id);
  if (!payload.ok) return err(payload.error);
  if (payload.value === undefined) {
    return err({ code: 'NOT_FOUND', store: 'snapshot_payloads', key: id });
  }
  return ok(new Blob([payload.value], { type: 'application/json' }));
}

/** Filename for a snapshot download (ADR-004 Decision 9). */
export function snapshotDownloadName(snapshot: Snapshot): string {
  return snapshotFileName(snapshot.takenAt);
}

/**
 * The `scheduled` auto trigger (§8.3): at boot after migration + boot
 * validation, at most once per 24h (compared against the newest `takenAt`;
 * no change-detection gate). `ok(null)` = throttled. Failure is the caller's to
 * record (boot continues — "warn in local error log").
 */
export async function maybeScheduledSnapshot(
  opts: DataSafetyDbOptions = {},
): Promise<Result<{ id: string; takenAt: number } | null, StorageError>> {
  const resolved = resolveDataSafetyDb(opts.db);
  if (!resolved.ok) return err(resolved.error);
  const db = resolved.value;
  const now = opts.now ?? Date.now;
  const listed = await frameworkListSnapshots(db);
  if (!listed.ok) return err(listed.error);
  const newest = listed.value[0];
  if (newest !== undefined && now() - newest.takenAt < SCHEDULED_SNAPSHOT_INTERVAL_MS) {
    return ok(null);
  }
  return takeSnapshot('scheduled', { db, now });
}

export { SCHEDULED_SNAPSHOT_INTERVAL_MS };
