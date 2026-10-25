/**
 * Forward-only `meta.schemaVersion` migration chain (ADR-002 Decision 8).
 *
 * - One atomic IDB transaction per step; the version bump for the step is
 *   written INSIDE that same transaction (a step is all-or-nothing and the
 *   version can never run ahead of its data).
 * - Automatic pre-migration snapshot FIRST; if the snapshot fails the migration
 *   is aborted with no data touched; if a step fails mid-chain the chain rolls
 *   back by restoring the pre-migration snapshot.
 * - The same registry upgrades old export payloads (`migrateRows`), so imports
 *   and boot migrations share one chain (ADR-002 §8, export/import hook for
 *   ADR-004's E3 card).
 */

import { err, migrationFailed, ok, unknownError, newerSchema } from './errors';
import type { Result, StorageError } from './errors';
import type { QuerySpec, Tx, AppDBImpl } from './db';
import type { Priority, Recurrence, Task } from '../domain/model';
import { isUlid } from './id';
import { APP_SCHEMA_VERSION, META_KEY, SYNC_KEY } from './schema';
import { fallbackRawCodec, restoreSnapshot, takeSnapshot } from './snapshots';
import type { SnapshotCodec } from './snapshots';
import { defaultSyncStateRow } from './syncState';
import { type Row, type StoreName, type StoreRows } from './types';

export type MigrationStep = {
  /** The version this step upgrades TO (key semantics of ADR-002 §8 registry). */
  to: number;
  /** Stores the step's single atomic readwrite transaction must cover (`meta` is added automatically). */
  stores: StoreName[];
  run: (t: Tx) => Promise<Result<void, StorageError>> | Result<void, StorageError>;
};

export type MigrationRegistry = readonly MigrationStep[];

/* ---------------------- schemaVersion 3 (E7 organization) ---------------------- */

/**
 * Legacy MVP `priority: 0 | 1 | 2` -> the S3 `P1..P4` levels, preserving
 * USER-VISIBLE meaning.
 *
 * The MVP encoding is `2` = High, `1` = Medium, `0` = Low (evidence:
 * `src/features/tasks/fields.tsx` `PRIORITIES`, `TaskRow.tsx` `PRIORITY_ICON`)
 * and the field was required, so an "unset" case only exists in the type sense.
 * The decomposition mapping row ("0->P1, 1->P2, 2->P3, unset->P4") was written
 * against the assumption that `0` is the TOP level; applying it literally would
 * invert every stored priority (a user's "High" task would land one level above
 * "no priority"). What is implemented here is that row's INTENT — "the three
 * legacy levels map to P1..P3 in priority order, the unset case maps to
 * P4 = no priority" — i.e. High -> P1 (most urgent) … Low -> P3, anything else
 * -> P4. **Deviation from the literal table row, flagged for review card
 * t_d45b8cf7**; reverting to the literal table is exactly this switch.
 */
export function legacyPriorityToLevel(value: unknown): Priority {
  if (value === 'P1' || value === 'P2' || value === 'P3' || value === 'P4') return value;
  switch (value) {
    case 2:
      return 'P1';
    case 1:
      return 'P2';
    case 0:
      return 'P3';
    default:
      return 'P4'; // unset / unknown -> P4 = no priority (record kept, never dropped)
  }
}

/**
 * One task row v1 -> v3. Pure + idempotent (re-running yields the same row).
 *
 * - `priority` remapped per `legacyPriorityToLevel`.
 * - `tags` normalized to a `string[]` (empty when absent — the denormalized
 *   model, ADR-002 §3.5).
 * - `recurrence` reduced to the RESERVED V1 format `{freq, interval, until?}`
 *   (no end-count — R4): a legacy `count` is stripped. A shape that is not a
 *   well-formed recurrence is left untouched so boot validation quarantines it
 *   to the recovery file instead of the migration silently deleting user data.
 */
export function migrateTaskRowToV3(row: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...row };
  next['priority'] = legacyPriorityToLevel(row['priority']);
  const tags: unknown = row['tags'];
  next['tags'] = Array.isArray(tags) ? [...(tags as unknown[])] : [];
  const rec = row['recurrence'];
  if (typeof rec === 'object' && rec !== null && !Array.isArray(rec)) {
    const source = rec as { freq?: unknown; interval?: unknown; until?: unknown };
    if (source.freq !== undefined && source.interval !== undefined) {
      const reserved: Recurrence = {
        freq: source.freq as Recurrence['freq'],
        interval: source.interval as number,
      };
      if (typeof source.until === 'string') reserved.until = source.until;
      next['recurrence'] = reserved;
    }
  }
  return next;
}

/** The E7 schemaVersion 3 step: one atomic `readwrite` transaction over `tasks`. */
export const toSchemaVersion3: MigrationStep = {
  to: 3,
  stores: ['tasks'],
  run: async (t) => {
    const rows = await t.getAll('tasks');
    // Batched puts inside the one transaction (10k-row databases migrate without
    // a per-row round trip) — same atomicity, no serial await.
    const puts: Promise<unknown>[] = [];
    for (const row of rows) {
      puts.push(
        t.put('tasks', migrateTaskRowToV3(row as unknown as Record<string, unknown>) as Task),
      );
    }
    await Promise.all(puts);
    return ok(undefined);
  },
};

/* ---------------------- schemaVersion 2 (sync_state, ADR-006) ---------------------- */

/**
 * Step 2 registers the additive `sync_state` store (ADR-006 Decision 3, owned
 * by t_00d7f17b; numbering pinned by ADR-007 "after sync_state step 2; never
 * renumbered"). The STRUCTURAL store creation runs in `onupgradeneeded`
 * (idbVersion 2, schema.ts); this step seeds the singleton default row so old
 * databases arrive at the same state fresh installs get. Idempotent: an
 * existing row is never touched. The engine additionally has a lazy
 * `ensureSyncState` fallback, so a rolled-back step cannot leave sync broken.
 */
export const toSchemaVersion2: MigrationStep = {
  to: 2,
  stores: ['sync_state'],
  run: async (t) => {
    const existing = await t.get('sync_state', SYNC_KEY);
    if (existing === undefined) {
      const meta = await t.get('meta', META_KEY);
      // A corrupt (quarantined) `meta.deviceId` must not seed a corrupt
      // `sync_state` row — the validator takes '' as the "not yet adopted"
      // slot, and the engine fills the real id at setup (integration fix for
      // the E1 P2 quarantine drills, t_b5078638).
      const deviceId = meta?.deviceId ?? '';
      await t.put('sync_state', defaultSyncStateRow(isUlid(deviceId) ? deviceId : ''));
    }
    return ok(undefined);
  },
};

/**
 * Production chain: v1 baseline (ADR-002), v2 = the `sync_state` store
 * (ADR-006 Decision 3 — owned by t_00d7f17b; numbering pinned there and echoed
 * on t_b5078638), v3 = E7 organization schema. ADR-002 requires exactly one
 * step per version — any further migration appends at `to: 4`+ (two steps at
 * one version make `runMigrations` refuse to boot).
 */
export const productionMigrations: MigrationRegistry = [toSchemaVersion2, toSchemaVersion3];

export function targetVersionOf(registry: MigrationRegistry): number {
  return registry.reduce((max, s) => Math.max(max, s.to), APP_SCHEMA_VERSION);
}

async function executeStep(t: Tx, step: MigrationStep): Promise<Result<void, StorageError>> {
  const result = await step.run(t);
  if (!result.ok) return result;
  const meta = await t.get('meta', META_KEY);
  if (meta === undefined) {
    return err(unknownError(new Error('meta record missing during migration step')));
  }
  await t.put('meta', { ...meta, schemaVersion: step.to });
  return ok(undefined);
}

export type MigrateOutcome = {
  from: number;
  to: number;
  preMigrationSnapshotId: string | null;
};

export type RunMigrationsOptions = {
  registry: MigrationRegistry;
  codec?: SnapshotCodec;
  now?: () => number;
};

/**
 * Bring `meta.schemaVersion` up to the registry's target. Assumes the DB is
 * open and meta is seeded (boot's responsibility). Sets the NEWER_SCHEMA write
 * guard on the AppDB when the data is ahead of this build.
 */
export async function runMigrations(
  db: AppDBImpl,
  options: RunMigrationsOptions,
): Promise<Result<MigrateOutcome, StorageError>> {
  const registry = [...options.registry].sort((a, b) => a.to - b.to);
  const codec = options.codec ?? fallbackRawCodec;
  const now = options.now ?? Date.now;
  const from = db.schemaVersion;
  const target = targetVersionOf(options.registry);

  if (from > target) {
    const e = newerSchema(from, target);
    db.setWriteGuard(e);
    return err(e);
  }
  if (from === target) {
    return ok({ from, to: target, preMigrationSnapshotId: null });
  }

  // Registry completeness: exactly one contiguous step per version in (from, target].
  const chain = registry.filter((s) => s.to > from && s.to <= target);
  for (let v = from + 1; v <= target; v += 1) {
    const matching = chain.filter((s) => s.to === v);
    if (matching.length !== 1) {
      return err(
        migrationFailed(
          from,
          target,
          new Error(
            `migration registry has ${String(matching.length)} steps for version ${String(v)}`,
          ),
        ),
      );
    }
  }

  // Pre-migration snapshot FIRST; failure aborts with no data touched (Decision 9).
  const snap = await takeSnapshot(db, { kind: 'auto', reason: 'pre-migration', codec, now });
  if (!snap.ok) {
    return err(migrationFailed(from, target, snap.error));
  }

  for (const step of chain) {
    const stores: StoreName[] = step.stores.includes('meta')
      ? step.stores
      : [...step.stores, 'meta'];
    const stepped = await db.tx(stores, 'readwrite', (t) => executeStep(t, step));
    if (!stepped.ok) {
      // Interrupted mid-chain: roll back to the pre-migration snapshot.
      const rollback = await restoreSnapshot(db, snap.value.id, codec);
      if (!rollback.ok) {
        return err(
          migrationFailed(from, target, {
            stepError: stepped.error,
            rollbackError: rollback.error,
          }),
        );
      }
      db.setSchemaVersion(from);
      return err(migrationFailed(from, target, stepped.error));
    }
    db.setSchemaVersion(step.to);
  }
  return ok({ from, to: target, preMigrationSnapshotId: snap.value.id });
}

/* ---------------------- in-memory chain (export upgrades) ---------------------- */

function compareKeys(a: unknown, b: unknown): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      const c = compareKeys(a[i], b[i]);
      if (c !== 0) return c;
    }
    return 0;
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function keyOf(store: StoreName, row: unknown): string {
  if (store === 'meta') return META_KEY;
  return String((row as { id?: unknown } | null)?.id);
}

function indexKeyOf(row: unknown, keyPath: string | string[]): unknown {
  if (Array.isArray(keyPath)) return keyPath.map((p) => (row as Record<string, unknown>)[p]);
  return (row as Record<string, unknown>)[keyPath];
}

/** In-memory `Tx` so the SAME migration steps can upgrade export payloads. */
export class MemoryTx implements Tx {
  readonly #stores: Map<StoreName, Map<string, unknown>>;

  constructor(rows: StoreRows) {
    this.#stores = new Map();
    const entries = Object.entries(rows) as [StoreName, unknown[]][];
    for (const [name, list] of entries) {
      const map = new Map<string, unknown>();
      for (const row of list) map.set(keyOf(name, row), row);
      this.#stores.set(name, map);
    }
    for (const name of [
      'meta',
      'lists',
      'tasks',
      'settings',
      'snapshots',
      'snapshot_payloads',
      'sync_state',
    ] as const) {
      if (!this.#stores.has(name)) this.#stores.set(name, new Map<string, unknown>());
    }
  }

  #map(store: StoreName): Map<string, unknown> {
    return this.#stores.get(store) ?? new Map<string, unknown>();
  }

  get<K extends StoreName>(store: K, key: string): Promise<Row<K> | undefined> {
    return Promise.resolve(this.#map(store).get(key) as Row<K> | undefined);
  }

  getAll<K extends StoreName>(store: K, spec?: QuerySpec): Promise<Row<K>[]> {
    const rows = [...this.#map(store).values()] as Row<K>[];
    if (spec === undefined) return Promise.resolve(rows);
    const keyPath: string | string[] =
      spec.index === undefined ? 'id' : (indexKeyPaths[spec.index] ?? 'id');
    const valueOf = (row: Row<K>): unknown =>
      spec.index === undefined ? keyOf(store, row) : indexKeyOf(row, keyPath);
    const range = spec.range;
    let out = rows;
    if (range !== undefined) {
      out = out.filter((row) => {
        const v = valueOf(row);
        if ('eq' in range) return compareKeys(v, range.eq) === 0;
        const bounds = range as {
          lower?: IDBValidKey;
          lowerOpen?: boolean;
          upper?: IDBValidKey;
          upperOpen?: boolean;
        };
        if (bounds.lower !== undefined) {
          const c = compareKeys(v, bounds.lower);
          if (c < 0 || (c === 0 && bounds.lowerOpen === true)) return false;
        }
        if (bounds.upper !== undefined) {
          const c = compareKeys(v, bounds.upper);
          if (c > 0 || (c === 0 && bounds.upperOpen === true)) return false;
        }
        return true;
      });
    }
    out = [...out].sort((a, b) => compareKeys(valueOf(a), valueOf(b)));
    if (spec.direction === 'prev') out = out.reverse();
    if (spec.limit !== undefined) out = out.slice(0, spec.limit);
    return Promise.resolve(out);
  }

  put<K extends StoreName>(store: K, row: Row<K>): Promise<void> {
    this.#map(store).set(keyOf(store, row), row);
    return Promise.resolve();
  }

  delete(store: StoreName, key: string): Promise<void> {
    this.#map(store).delete(key);
    return Promise.resolve();
  }

  toStoreRows(): StoreRows {
    const out = {} as StoreRows;
    for (const [name, map] of this.#stores) {
      (out as Record<string, unknown[]>)[name] = [...map.values()];
    }
    return out;
  }
}

/** Index-name → keyPath map for MemoryTx lookups (kept in sync with schema.ts by test). */
const indexKeyPaths: Record<string, string | string[]> = {
  by_updatedAt: 'updatedAt',
  by_listId: 'listId',
  by_status: 'status',
  by_dueDate: 'dueDate',
  by_list_sort: ['listId', 'sortOrder'],
  by_parent: 'parentTaskId',
  by_takenAt: 'takenAt',
};

export type MigrateRowsOutcome = {
  rows: StoreRows;
  schemaVersion: number;
};

/**
 * Upgrade export/snapshot ROWS (not files — ADR-004 owns the file format) from
 * `from` to `to` by running the same migration steps in memory. Hook for E3's
 * "old exports upgrade through the chain" requirement (ADR-002 §8).
 */
export async function migrateRows(
  registry: MigrationRegistry,
  rows: StoreRows,
  from: number,
  to: number,
): Promise<Result<MigrateRowsOutcome, StorageError>> {
  const chain = [...registry].sort((a, b) => a.to - b.to).filter((s) => s.to > from && s.to <= to);
  for (let v = from + 1; v <= to; v += 1) {
    if (chain.filter((s) => s.to === v).length !== 1) {
      return err(
        migrationFailed(
          from,
          to,
          new Error(`migration registry has no unique step for version ${String(v)}`),
        ),
      );
    }
  }
  const mem = new MemoryTx(rows);
  for (const step of chain) {
    const result = await executeStep(mem, step);
    if (!result.ok) return err(migrationFailed(from, to, result.error));
  }
  return ok({ rows: mem.toStoreRows(), schemaVersion: to });
}
