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
import { APP_SCHEMA_VERSION, META_KEY } from './schema';
import { fallbackRawCodec, restoreSnapshot, takeSnapshot } from './snapshots';
import type { SnapshotCodec } from './snapshots';
import { type Row, type StoreName, type StoreRows } from './types';

export type MigrationStep = {
  /** The version this step upgrades TO (key semantics of ADR-002 §8 registry). */
  to: number;
  /** Stores the step's single atomic readwrite transaction must cover (`meta` is added automatically). */
  stores: StoreName[];
  run: (t: Tx) => Promise<Result<void, StorageError>> | Result<void, StorageError>;
};

export type MigrationRegistry = readonly MigrationStep[];

/** Production chain: empty at schemaVersion 1 (ADR-002 baseline). Future steps append. */
export const productionMigrations: MigrationRegistry = [];

export function targetVersionOf(registry: MigrationRegistry): number {
  return registry.reduce((max, s) => Math.max(max, s.to), APP_SCHEMA_VERSION);
}

async function executeStep(
  t: Tx,
  step: MigrationStep,
): Promise<Result<void, StorageError>> {
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
        migrationFailed(from, target, new Error(`migration registry has ${String(matching.length)} steps for version ${String(v)}`)),
      );
    }
  }

  // Pre-migration snapshot FIRST; failure aborts with no data touched (Decision 9).
  const snap = await takeSnapshot(db, { kind: 'auto', reason: 'pre-migration', codec, now });
  if (!snap.ok) {
    return err(migrationFailed(from, target, snap.error));
  }

  for (const step of chain) {
    const stores: StoreName[] = step.stores.includes('meta') ? step.stores : [...step.stores, 'meta'];
    const stepped = await db.tx(stores, 'readwrite', (t) => executeStep(t, step));
    if (!stepped.ok) {
      // Interrupted mid-chain: roll back to the pre-migration snapshot.
      const rollback = await restoreSnapshot(db, snap.value.id, codec);
      if (!rollback.ok) {
        return err(migrationFailed(from, target, { stepError: stepped.error, rollbackError: rollback.error }));
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
    for (const name of ['meta', 'lists', 'tasks', 'settings', 'snapshots', 'snapshot_payloads'] as const) {
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
        const bounds = range as { lower?: IDBValidKey; lowerOpen?: boolean; upper?: IDBValidKey; upperOpen?: boolean };
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
      return err(migrationFailed(from, to, new Error(`migration registry has no unique step for version ${String(v)}`)));
    }
  }
  const mem = new MemoryTx(rows);
  for (const step of chain) {
    const result = await executeStep(mem, step);
    if (!result.ok) return err(migrationFailed(from, to, result.error));
  }
  return ok({ rows: mem.toStoreRows(), schemaVersion: to });
}
