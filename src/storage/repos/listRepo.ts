/**
 * ListRepo — `ListPort` adapter over `AppDB` (ADR-003 Decision 2). Rename /
 * recolor / move are single-record patch-RMW writes over the one global list
 * sibling group; `remove(id, disposition)` follows ADR-002 Decision 6 VERBATIM:
 * move tasks (rewrite `listId`, stamp) or tombstone them — ONE transaction
 * either way, never a silent cascade.
 *
 * ADR-007 Decision 4.6 (E10-Q6 carriers, t_a155ebf2): no seam work runs inside
 * a live transaction — reads use the safe surface, single-row RMWs are
 * stamp-guarded verbatim commits in ONE `txRaw`, multi-row writes stage every
 * row first (the `runSweep`/`applyImport` pattern).
 */

import { err, ok, ruleError, type AppError, type Result } from '../../domain/kernel';
import type { List, Task } from '../../domain/model';
import type {
  ListPort,
  ListPosition,
  ListRemoveDisposition,
  ListRemoveOutcome,
  MoveOutcome,
} from '../../domain/ports';
import { invalidRecord } from '../errors';
import { logAppError } from '../errorLog';
import { OrderKeyError, orderKeyBetween, orderKeyFirst } from '../orderKey';
import { validateList } from '../validate';
import {
  evenOrderKeys,
  guardedSealedPut,
  listGroupRows,
  neighborsAround,
  sealRow,
  stageAll,
  txAppRaw,
  type RepoDeps,
} from './support';

function listMissing(id: string): AppError {
  return ruleError('TASK_MISSING', `list ${id} is absent or tombstoned`);
}

export class ListRepo implements ListPort {
  readonly #deps: RepoDeps;

  constructor(deps: RepoDeps) {
    this.#deps = deps;
  }

  async loadAll(): Promise<Result<List[], AppError>> {
    return listGroupRows(this.#deps.db);
  }

  async create(input: {
    name: string;
    color: string;
    id?: string;
  }): Promise<Result<List, AppError>> {
    const { clock, ids, db } = this.#deps;
    const rows = await listGroupRows(db);
    if (!rows.ok) return rows;
    const now = clock();
    let key: string;
    try {
      key = orderKeyBetween(rows.value.at(-1)?.sortOrder ?? null, null);
    } catch {
      key = orderKeyFirst();
    }
    const row: List = {
      id: input.id ?? ids(),
      name: input.name,
      color: input.color,
      sortOrder: key,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deviceId: db.deviceId,
    };
    return this.#sealPut(row);
  }

  rename(id: string, name: string): Promise<Result<List, AppError>> {
    return this.#patch(id, { name });
  }

  recolor(id: string, color: string): Promise<Result<List, AppError>> {
    return this.#patch(id, { color });
  }

  async move(id: string, position: ListPosition): Promise<Result<MoveOutcome<List>, AppError>> {
    const { clock, db, errorLog } = this.#deps;
    const current = await db.get('lists', id);
    if (!current.ok) return err(current.error);
    const row = current.value;
    if (row === undefined || row.deletedAt !== null) return err(listMissing(id));
    const rows = await listGroupRows(db, id);
    if (!rows.ok) return rows;
    const refId =
      typeof position === 'object'
        ? 'afterId' in position
          ? position.afterId
          : position.beforeId
        : null;
    if (refId !== null && !rows.value.some((r) => r.id === refId)) {
      return err(ruleError('REORDER_TARGET_NOT_IN_GROUP', `${refId} is not in the list group`));
    }
    try {
      const { prevKey, nextKey } = neighborsAround(rows.value, position);
      const moved: List = {
        ...row,
        sortOrder: orderKeyBetween(prevKey, nextKey),
        updatedAt: clock(),
        deviceId: db.deviceId,
      };
      const validated = this.#validate(moved);
      if (!validated.ok) return validated;
      // SINGLE-record write, stamp-guarded (D4.6).
      const put = await guardedSealedPut(db, 'lists', moved, row.updatedAt);
      if (!put.ok) return put;
      return ok({ row: moved, rebalanced: false });
    } catch (e) {
      if (!(e instanceof OrderKeyError) || e.code !== 'EXHAUSTED') throw e;
      // ADR-003 Decision 4: the list-group rebalance is observable in the local
      // error log, exactly like the task sibling-group hatch.
      logAppError(
        errorLog,
        'repos',
        'reorder-rebalance',
        { code: 'UNKNOWN', cause: e },
        'lists (global group)',
      );
      return this.#rebalance(rows.value, row, position);
    }
  }

  async remove(
    id: string,
    disposition: ListRemoveDisposition,
  ): Promise<Result<ListRemoveOutcome, AppError>> {
    const { clock, db } = this.#deps;
    const current = await db.get('lists', id);
    if (!current.ok) return err(current.error);
    const row = current.value;
    if (row === undefined || row.deletedAt !== null) {
      // Idempotent: nothing was written, so nothing moved or was tombstoned.
      return ok({ moved: [], tombstoned: [] });
    }
    const tasksRead = await db.query('tasks', { index: 'by_listId', range: { eq: id } });
    if (!tasksRead.ok) return err(tasksRead.error);
    const tasks = tasksRead.value.filter((r) => r.deletedAt === null);
    const now = clock();
    const moved: Task[] = [];
    const tombstoned: Task[] = [];
    // Every write is staged outside the tx (D4.6); ONE txRaw still covers the
    // tasks and the list together (ADR-002 Decision 6 — all-or-nothing).
    const stagedTasks: Task[] = [];
    if (disposition.mode === 'move') {
      const target = await db.get('lists', disposition.targetListId);
      if (!target.ok) return err(target.error);
      if (
        target.value === undefined ||
        target.value.deletedAt !== null ||
        disposition.targetListId === id
      ) {
        return err(
          ruleError(
            'LIST_DELETE_TARGET_MISSING',
            `move target ${disposition.targetListId} is missing or identical`,
          ),
        );
      }
      for (const task of tasks) {
        const written: Task = {
          ...task,
          listId: disposition.targetListId,
          updatedAt: now,
          deviceId: db.deviceId,
        };
        const sealed = await sealRow(db, 'tasks', written);
        if (!sealed.ok) return sealed;
        stagedTasks.push(sealed.value);
        moved.push(written);
      }
    } else {
      for (const task of tasks) {
        const written: Task = {
          ...task,
          deletedAt: now,
          updatedAt: now,
          deviceId: db.deviceId,
        };
        const sealed = await sealRow(db, 'tasks', written);
        if (!sealed.ok) return sealed;
        stagedTasks.push(sealed.value);
        tombstoned.push(written);
      }
    }
    const sealedList = await sealRow(db, 'lists', {
      ...row,
      deletedAt: now,
      updatedAt: now,
      deviceId: db.deviceId,
    });
    if (!sealedList.ok) return sealedList;
    return txAppRaw(db, ['lists', 'tasks'], 'readwrite', async (t) => {
      for (const task of stagedTasks) await t.put('tasks', task);
      await t.put('lists', sealedList.value);
      return ok({ moved, tombstoned });
    });
  }

  /** Raw rows with `updatedAt > since` (tombstones included) — tab-sync watermark sweep. */
  async changedSince(since: number): Promise<Result<List[], AppError>> {
    return this.#deps.db.query('lists', {
      index: 'by_updatedAt',
      range: { lower: since, lowerOpen: true },
    });
  }

  /* ------------------------------ internals ------------------------------ */

  #validate(row: List): Result<void, AppError> {
    const v = validateList(row);
    return v.ok ? ok(undefined) : err(invalidRecord('lists', v.issues, row.id));
  }

  async #patch(
    id: string,
    patch: { name?: string; color?: string },
  ): Promise<Result<List, AppError>> {
    const { clock, db } = this.#deps;
    const current = await db.get('lists', id);
    if (!current.ok) return err(current.error);
    const row = current.value;
    if (row === undefined || row.deletedAt !== null) return err(listMissing(id));
    const merged: List = { ...row };
    if (patch.name !== undefined) merged.name = patch.name;
    if (patch.color !== undefined) merged.color = patch.color;
    const stamped: List = { ...merged, updatedAt: clock(), deviceId: db.deviceId };
    const validated = this.#validate(stamped);
    if (!validated.ok) return validated;
    // D4.6 single-row RMW: stamp-guarded verbatim commit (STALE_WRITE on conflict).
    const put = await guardedSealedPut(db, 'lists', stamped, row.updatedAt);
    if (!put.ok) return put;
    return ok(stamped);
  }

  /** Insert helper: seal outside, write verbatim in ONE txRaw (no prior version to guard). */
  async #sealPut(row: List): Promise<Result<List, AppError>> {
    const { db } = this.#deps;
    const validated = this.#validate(row);
    if (!validated.ok) return validated;
    const sealed = await sealRow(db, 'lists', row);
    if (!sealed.ok) return sealed;
    return txAppRaw(db, ['lists'], 'readwrite', async (t) => {
      await t.put('lists', sealed.value);
      return ok(row);
    });
  }

  /** Rebalance hatch: re-key the whole list group — staged outside, ONE txRaw (`rebalanced: true`). */
  async #rebalance(
    rows: List[],
    movedRow: List,
    position: ListPosition,
  ): Promise<Result<MoveOutcome<List>, AppError>> {
    const { clock, db } = this.#deps;
    const insertAt =
      position === 'first'
        ? 0
        : position === 'last'
          ? rows.length
          : 'afterId' in position
            ? rows.findIndex((r) => r.id === position.afterId) + 1
            : rows.findIndex((r) => r.id === position.beforeId);
    const ordered = [...rows];
    ordered.splice(Math.min(Math.max(0, insertAt), ordered.length), 0, movedRow);
    const keys = evenOrderKeys(ordered.length);
    const now = clock();
    let settledRow: List | null = null;
    const nexts: List[] = [];
    for (let i = 0; i < ordered.length; i += 1) {
      const row = ordered[i] as List;
      const next: List = {
        ...row,
        sortOrder: keys[i] as string,
        updatedAt: now,
        deviceId: db.deviceId,
      };
      const validated = this.#validate(next);
      if (!validated.ok) return validated;
      nexts.push(next);
      if (row.id === movedRow.id) settledRow = next;
    }
    const staged = await stageAll(db, 'lists', nexts);
    if (!staged.ok) return staged;
    return txAppRaw(db, ['lists'], 'readwrite', async (t) => {
      for (const row of staged.value) await t.put('lists', row);
      return ok({ row: settledRow ?? movedRow, rebalanced: true });
    });
  }
}
