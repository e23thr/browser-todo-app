/**
 * Shared repo-adapter internals (ADR-003 Decision 2): stamping, sibling-group
 * reads over ADR-002 indexes, and the rebalance hatch's evenly-spaced keys.
 * Adapters own stamping/tombstoning/validation/order-key math; the wrapper
 * `put` stays raw.
 */

import { ruleError, type AppError, type Result } from '../../domain/kernel';
import type { Clock, IdFactory } from '../../domain/ports';
import type { List, Task } from '../../domain/model';
import type { AppDB, QuerySpec, Tx } from '../db';
import { err, ok, type StorageError } from '../errors';
import type { ErrorLog } from '../errorLog';
import type { Row, StoreName } from '../types';

/**
 * `AppDB.tx` types its callback as `Result<T, StorageError>`, but rule errors
 * (`RULE: TASK_MISSING` …) must be returnable from inside the transaction so
 * the wrapper aborts it and the error keeps its exact shape (ADR-003 Decision
 * 8.3: stale writes fail `RULE`, no partial writes). One contained widening at
 * this seam keeps every call site typed to `AppError`.
 */
export function txApp<T>(
  db: AppDB,
  stores: StoreName[],
  mode: 'readonly' | 'readwrite',
  fn: (t: Tx) => Promise<Result<T, AppError>>,
): Promise<Result<T, AppError>> {
  return db.tx<T>(stores, mode, fn as unknown as (t: Tx) => Promise<Result<T, StorageError>>);
}

/**
 * The same widening over the AT-REST transaction `AppDB.txRaw` (ADR-007
 * Decision 4.6): repo write paths stage seals outside and commit verbatim
 * bytes inside. Fallback rule identical to the sync engine's (`sync/engine.ts`
 *): a double without `txRaw` is raw under `tx`.
 */
export function txAppRaw<T>(
  db: AppDB,
  stores: StoreName[],
  mode: 'readonly' | 'readwrite',
  fn: (t: Tx) => Promise<Result<T, AppError>>,
): Promise<Result<T, AppError>> {
  const run = db.txRaw === undefined ? db.tx.bind(db) : db.txRaw.bind(db);
  return run<T>(stores, mode, fn as unknown as (t: Tx) => Promise<Result<T, StorageError>>);
}

/**
 * Typed retryable conflict (ADR-007 Decision 4.6): the optimistic stamp guard
 * re-read the AT-REST row inside the commit transaction and its envelope
 * `updatedAt` no longer matches the version the merge was based on. `RULE` per
 * ADR-003 Decision 8.3 — the caller re-reads and re-applies; nothing was lost.
 */
export function staleWrite(store: StoreName, id: string): AppError {
  return ruleError('STALE_WRITE', `${store} ${id} changed since it was read — retry the write`);
}

/**
 * Stage ONE domain row to its at-rest form OUTSIDE any transaction
 * (`AppDB.sealForWrite`; identity for doubles without it — non-transforming
 * doubles seal nothing, exactly like `tx`/`txRaw` fall back to raw).
 */
export async function sealRow<K extends 'tasks' | 'lists'>(
  db: AppDB,
  store: K,
  row: Row<K>,
): Promise<Result<Row<K>, AppError>> {
  if (db.sealForWrite === undefined) return ok(row);
  const sealed = await db.sealForWrite(store, row);
  return sealed.ok ? ok(sealed.value) : err(sealed.error);
}

/** Stage EVERY row outside a transaction (the D4.6 bulk pattern); first refusal wins, nothing written. */
export async function stageAll<K extends 'tasks' | 'lists'>(
  db: AppDB,
  store: K,
  rows: readonly Row<K>[],
): Promise<Result<Row<K>[], AppError>> {
  const sealed = await Promise.all(rows.map((row) => sealRow(db, store, row)));
  const out: Row<K>[] = [];
  for (const s of sealed) {
    if (!s.ok) return err(s.error);
    out.push(s.value);
  }
  return ok(out);
}

/**
 * Single-row read-modify-write commit (ADR-007 Decision 4.6): the merged row
 * is sealed OUTSIDE the transaction and written VERBATIM in ONE `txRaw`. The
 * pessimistic single-tx guard is gone, so the tx re-reads the AT-REST row and
 * compares its envelope-level `updatedAt` (plaintext in both row shapes)
 * against the version the merge was based on — a mismatch aborts with the
 * typed retryable `STALE_WRITE` error, so a concurrent write is never silently
 * lost. A vanished base row conflicts too (never a resurrection).
 */
export async function guardedSealedPut<K extends 'tasks' | 'lists'>(
  db: AppDB,
  store: K,
  row: Row<K>,
  baseUpdatedAt: number,
): Promise<Result<void, AppError>> {
  const sealed = await sealRow(db, store, row);
  if (!sealed.ok) return sealed;
  return txAppRaw(db, [store], 'readwrite', async (t) => {
    const current = await t.get(store, row.id);
    if (current === undefined || current.updatedAt !== baseUpdatedAt) {
      return err(staleWrite(store, row.id));
    }
    await t.put(store, sealed.value);
    return ok(undefined);
  });
}

export { err, ok };

export type RepoDeps = {
  db: AppDB;
  clock: Clock;
  ids: IdFactory;
  errorLog?: ErrorLog;
};

export function byOrder(
  a: { sortOrder: string; id: string },
  b: { sortOrder: string; id: string },
): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder < b.sortOrder ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export type SiblingGroup = { listId: string; parentTaskId: string | null };

/**
 * Live rows of one task sibling group (ADR-002 Decision 4): top-level tasks via
 * `by_list_sort`, subtasks via `by_parent` (in-memory `(sortOrder, id)` sort —
 * subtask groups are bounded at V1 scale). `excludeId` is left out (the moved
 * row is not its own neighbor).
 *
 * ADR-007 Decision 4.6: read through the SAFE surface — `db.query` closes its
 * own transaction before the row seam decrypts, so no crypto runs inside a
 * live transaction. Group membership (incl. `listId`) is re-checked in memory
 * so spec-ignoring doubles stay correct.
 */
export async function taskGroupRows(
  db: AppDB,
  group: SiblingGroup,
  excludeId?: string,
): Promise<Result<Task[], AppError>> {
  const spec: QuerySpec =
    group.parentTaskId === null
      ? { index: 'by_list_sort', range: { lower: [group.listId], upper: [group.listId, []] } }
      : { index: 'by_parent', range: { eq: group.parentTaskId } };
  const read = await db.query('tasks', spec);
  if (!read.ok) return err(read.error);
  return ok(
    read.value
      .filter(
        (r) =>
          r.id !== excludeId &&
          r.deletedAt === null &&
          r.listId === group.listId &&
          (group.parentTaskId === null
            ? r.parentTaskId === undefined
            : r.parentTaskId === group.parentTaskId),
      )
      .sort(byOrder),
  );
}

/** Live lists in `(sortOrder, id)` order (the one global sibling group), via the safe surface. */
export async function listGroupRows(
  db: AppDB,
  excludeId?: string,
): Promise<Result<List[], AppError>> {
  const read = await db.query('lists', {});
  if (!read.ok) return err(read.error);
  return ok(read.value.filter((r) => r.id !== excludeId && r.deletedAt === null).sort(byOrder));
}

/** Neighbors of the insertion position among `group` (moved row excluded). */
export function neighborsAround(
  group: readonly { id: string; sortOrder: string }[],
  position: 'first' | 'last' | { afterId: string } | { beforeId: string },
): { prevKey: string | null; nextKey: string | null } {
  if (position === 'first') {
    return { prevKey: null, nextKey: group[0]?.sortOrder ?? null };
  }
  if (position === 'last') {
    return { prevKey: group.at(-1)?.sortOrder ?? null, nextKey: null };
  }
  const refId = 'afterId' in position ? position.afterId : position.beforeId;
  const at = group.findIndex((r) => r.id === refId);
  if ('afterId' in position) {
    return {
      prevKey: group[at]?.sortOrder ?? null,
      nextKey: group[at + 1]?.sortOrder ?? null,
    };
  }
  return {
    prevKey: at > 0 ? (group[at - 1]?.sortOrder ?? null) : null,
    nextKey: group[at]?.sortOrder ?? null,
  };
}

/**
 * Rebalance keys: `n` fresh, evenly spaced, canonical base-36 fraction keys in
 * `(0, 1)` — strictly increasing, ≤ 12 chars (ADR-002 Decision 4.2 rule 4).
 */
export function evenOrderKeys(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    let value = (i + 1) / (n + 1);
    let key = '';
    for (let digit = 0; digit < 12 && value > 0; digit += 1) {
      const scaled = value * 36;
      const d = Math.floor(scaled);
      key += '0123456789abcdefghijklmnopqrstuvwxyz'[d] ?? '0';
      value = scaled - d;
    }
    key = key.replace(/0+$/u, '');
    out.push(key.length === 0 ? '0h' : key);
  }
  return out;
}

export function taskMissing(id: string): AppError {
  return ruleError('TASK_MISSING', `task ${id} is absent or tombstoned`);
}

/**
 * Primary-key reads for the tab-sync receiver path (ADR-003 Decision 8.1 rule
 * 2: "for each id in ChangeSet: re-read the record from the repo"). Tombstoned
 * rows come back as `null` so `reconcile` can evict them.
 */
export async function readRows(
  db: AppDB,
  taskIds: readonly string[],
  listIds: readonly string[],
): Promise<Result<{ tasks: Map<string, Task | null>; lists: Map<string, List | null> }, AppError>> {
  const tasks = new Map<string, Task | null>();
  const lists = new Map<string, List | null>();
  for (const id of taskIds) {
    const r = await db.get('tasks', id);
    if (!r.ok) return err(r.error);
    tasks.set(id, r.value === undefined || r.value.deletedAt !== null ? null : r.value);
  }
  for (const id of listIds) {
    const r = await db.get('lists', id);
    if (!r.ok) return err(r.error);
    lists.set(id, r.value === undefined || r.value.deletedAt !== null ? null : r.value);
  }
  return ok({ tasks, lists });
}
