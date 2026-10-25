/**
 * Snapshot framework (ADR-002 Decision 9): automatic pre-migration snapshots,
 * rolling last-3 `auto` retention + all `manual` snapshots, payloads in the
 * `snapshot_payloads` store.
 *
 * FORMAT HOOK (binding): the payload format is ADR-004's decision (the M11
 * export file format, one shared serializer for export/snapshot/import). This
 * module owns only the mechanics and a `SnapshotCodec` seam. `fallbackRawCodec`
 * is a framework placeholder so migration rollback is self-contained before E3
 * plugs ADR-004's serializer — it is NOT the export file format.
 */

import { err, ok, unknownError } from './errors';
import type { Result, StorageError } from './errors';
import { newUlid } from './id';
import type { AppDBImpl } from './db';
import {
  DATA_STORES,
  type Snapshot,
  type SnapshotKind,
  type SnapshotReason,
  type StoreRows,
} from './types';

export type SnapshotSource = {
  schemaVersion: number;
  stores: StoreRows;
  /**
   * Capture time (ADR-004 §8.1: the document's `exportedAt` == `Snapshot.takenAt`).
   * Set by `takeSnapshot` right before `serialize`; codecs may fall back to now.
   */
  takenAt?: number;
};

export type SnapshotCodec = {
  /** Identifies the format in handoffs/logs (e.g. 'adr-004-json'). */
  readonly name: string;
  serialize(source: SnapshotSource): string;
  deserialize(payload: string): Result<SnapshotSource, StorageError>;
};

export const fallbackRawCodec: SnapshotCodec = {
  name: 'fallback-raw-rows',
  serialize(source) {
    return JSON.stringify({ schemaVersion: source.schemaVersion, stores: source.stores });
  },
  deserialize(payload) {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (typeof parsed !== 'object' || parsed === null) {
        return err(unknownError(new Error('snapshot payload is not an object')));
      }
      const rec = parsed as { schemaVersion?: unknown; stores?: unknown };
      if (typeof rec.schemaVersion !== 'number' || !Number.isInteger(rec.schemaVersion)) {
        return err(unknownError(new Error('snapshot payload lacks schemaVersion')));
      }
      const stores = (rec.stores ?? {}) as Partial<StoreRows>;
      return ok({
        schemaVersion: rec.schemaVersion,
        stores: {
          meta: stores.meta ?? [],
          lists: stores.lists ?? [],
          tasks: stores.tasks ?? [],
          settings: stores.settings ?? [],
          snapshots: stores.snapshots ?? [],
          snapshot_payloads: stores.snapshot_payloads ?? [],
          sync_state: [],
        },
      });
    } catch (e) {
      return err(unknownError(e));
    }
  },
};

/** Unfiltered on purpose: backups must never lose rows (quarantine is non-destructive). */
export async function readSnapshotSource(
  db: AppDBImpl,
): Promise<Result<SnapshotSource, StorageError>> {
  const stores = {} as StoreRows;
  for (const name of DATA_STORES) {
    const rows = await db.readUnfiltered(name);
    if (!rows.ok) return err(rows.error);
    stores[name] = rows.value as never;
  }
  // Snapshot METADATA rides the document for provenance (ADR-004 §2.3); payloads
  // stay out of scope and `snapshot_payloads` remains empty on this substrate.
  const snapshotRows = await db.readUnfiltered('snapshots');
  if (!snapshotRows.ok) return err(snapshotRows.error);
  stores.snapshots = snapshotRows.value;
  stores.snapshot_payloads = [];
  // ADR-006 Decision 3: `sync_state` is local-only — NEVER captured here, so it
  // cannot leak into snapshots, exports or the remote. The key stays empty.
  stores.sync_state = [];
  const meta = await db.get('meta', 'meta');
  if (!meta.ok) return err(meta.error);
  return ok({ schemaVersion: meta.value?.schemaVersion ?? 1, stores });
}

export type TakeSnapshotOptions = {
  kind: SnapshotKind;
  reason: SnapshotReason;
  codec?: SnapshotCodec;
  now?: () => number;
};

/**
 * Serialize → prune retention victims → put payload + metadata, per ADR-002 §9
 * and ADR-004 Decision 8.2 (normative): EVICT-THEN-PUT. Payload + metadata +
 * pruning land in ONE readwrite transaction.
 */
export async function takeSnapshot(
  db: AppDBImpl,
  options: TakeSnapshotOptions,
): Promise<Result<Snapshot, StorageError>> {
  const codec = options.codec ?? fallbackRawCodec;
  const now = options.now ?? Date.now;
  const source = await readSnapshotSource(db);
  if (!source.ok) return err(source.error);

  let payload: string;
  try {
    payload = codec.serialize(source.value);
  } catch (e) {
    return err(unknownError(e));
  }
  const id = newUlid(now());
  const snapshot: Snapshot = {
    id,
    takenAt: now(),
    kind: options.kind,
    reason: options.reason,
    sizeBytes: new TextEncoder().encode(payload).length,
    schemaVersion: source.value.schemaVersion,
    payloadRef: id,
  };

  const written = await db.tx(['snapshot_payloads', 'snapshots'], 'readwrite', async (t) => {
    // ADR-004 Decision 8.2 (normative): victims are deleted FIRST, then the new
    // payload + metadata rows are put — same transaction, strict order. Deleting
    // first is what buys quota headroom: the store never transiently holds
    // retention+1 payloads, so a near-quota user succeeds where put-first fails.
    if (snapshot.kind === 'auto') {
      const existing = await t.getAll('snapshots');
      // Victim set = autos ordered (takenAt, id) DESC, newest first — with the row being
      // written included in the ordering (8.2 step 1).
      const autos = [...existing.filter((s) => s.kind === 'auto'), snapshot].sort(
        (a, b) => b.takenAt - a.takenAt || (a.id < b.id ? 1 : -1),
      );
      // Design §8.4: a recent `pre-import` snapshot (the undo of an import) is protected
      // from the rolling purge for seven days, at most MAX_PROTECTED_SNAPSHOTS of them.
      // Protected rows hold their own slots inside the rolling three — so the list never
      // grows past AUTO_RETENTION (§4.3/§4.4 "more than three is impossible") — and a third
      // protected snapshot pushes the OLDEST protected one out ("the oldest protected
      // snapshot expires … when a newer protected one needs the slot").
      const nowMs = now();
      const isProtected = (row: Snapshot): boolean =>
        row.reason === 'pre-import' && nowMs - row.takenAt < PRE_IMPORT_PROTECTION_MS;
      const protectedRows = autos.filter(isProtected);
      const rollingRows = autos.filter((row) => !isProtected(row));
      const keptProtected = protectedRows.slice(0, MAX_PROTECTED_SNAPSHOTS);
      const victims = [
        ...protectedRows.slice(MAX_PROTECTED_SNAPSHOTS),
        ...rollingRows.slice(Math.max(0, AUTO_RETENTION - keptProtected.length)),
      ];
      for (const stale of victims) {
        // 8.2 step 2 puts the new rows unconditionally — never evict them here.
        if (stale.id === id) continue;
        await t.delete('snapshots', stale.id);
        await t.delete('snapshot_payloads', stale.payloadRef);
      }
    }
    await t.put('snapshot_payloads', { id, payload });
    await t.put('snapshots', snapshot);
    return ok(undefined);
  });
  if (!written.ok) return err(written.error);
  return ok(snapshot);
}

/** Rolling last-3 `auto` snapshots; all `manual` snapshots persist (Decision 9). */
export const AUTO_RETENTION = 3;

/**
 * Design §8.4: `pre-import` snapshots are exempt from the rolling purge for seven days,
 * at most two of them. The UI quotes the same constant for its retention note
 * (`dataSafety.snapshots.protected`), so the promise and the behaviour cannot drift.
 */
export const PRE_IMPORT_PROTECTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Design §8.4 "max 2 protected". */
export const MAX_PROTECTED_SNAPSHOTS = 2;

export async function listSnapshots(db: AppDBImpl): Promise<Result<Snapshot[], StorageError>> {
  const all = await db.query('snapshots', { index: 'by_takenAt', direction: 'prev' });
  if (!all.ok) return err(all.error);
  return ok(all.value);
}

export async function getSnapshotPayload(
  db: AppDBImpl,
  id: string,
): Promise<Result<string | undefined, StorageError>> {
  const row = await db.get('snapshot_payloads', id);
  if (!row.ok) return err(row.error);
  return ok(row.value?.payload);
}

export async function deleteSnapshot(
  db: AppDBImpl,
  id: string,
): Promise<Result<void, StorageError>> {
  return db.tx(['snapshots', 'snapshot_payloads'], 'readwrite', async (t) => {
    await t.delete('snapshots', id);
    await t.delete('snapshot_payloads', id);
    return ok(undefined);
  });
}

/**
 * Replace data stores with the snapshot payload and reset `meta.schemaVersion`
 * to the payload's — all in ONE transaction. This is the migration rollback
 * path and the hook E3's "restore snapshot" builds on (its import pipeline may
 * wrap the same codec). `meta.deviceId` is deliberately NOT restored: device
 * identity stays with the browser profile (ADR-002 Decision 3.1).
 */
export async function restoreSnapshot(
  db: AppDBImpl,
  id: string,
  codec: SnapshotCodec = fallbackRawCodec,
): Promise<Result<void, StorageError>> {
  const payload = await getSnapshotPayload(db, id);
  if (!payload.ok) return err(payload.error);
  if (payload.value === undefined) {
    return err(unknownError(new Error(`snapshot payload ${id} not found`)));
  }
  const source = codec.deserialize(payload.value);
  if (!source.ok) return err(source.error);

  const restored = await db.tx(['lists', 'tasks', 'settings', 'meta'], 'readwrite', async (t) => {
    for (const name of DATA_STORES) {
      const existing = await t.getAll(name);
      for (const row of existing) {
        await t.delete(name, row.id);
      }
      for (const row of source.value.stores[name]) {
        await t.put(name, row);
      }
    }
    const meta = await t.get('meta', 'meta');
    if (meta !== undefined) {
      await t.put('meta', { ...meta, schemaVersion: source.value.schemaVersion });
    }
    return ok(undefined);
  });
  if (!restored.ok) return err(restored.error);
  db.setSchemaVersion(source.value.schemaVersion);
  return ok(undefined);
}

/** Store-name-agnostic row inventory type re-export for downstream consumers. */
export type { StoreRows };
