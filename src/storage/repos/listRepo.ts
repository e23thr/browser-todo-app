/**
 * ListRepo — `ListPort` adapter over `AppDB` (ADR-003 Decision 2). Rename /
 * recolor / move are single-record patch-RMW writes over the one global list
 * sibling group; `remove(id, disposition)` follows ADR-002 Decision 6 VERBATIM:
 * move tasks (rewrite `listId`, stamp) or tombstone them — ONE transaction
 * either way, never a silent cascade.
 */

import { err, ok, ruleError, type AppError, type Result } from '../../domain/kernel';
import type { List } from '../../domain/model';
import type { ListPort, ListPosition, ListRemoveDisposition } from '../../domain/ports';
import { invalidRecord } from '../errors';
import { OrderKeyError, orderKeyBetween, orderKeyFirst } from '../orderKey';
import { validateList } from '../validate';
import { evenOrderKeys, listGroupRows, neighborsAround, txApp, type RepoDeps } from './support';

function listMissing(id: string): AppError {
  return ruleError('TASK_MISSING', `list ${id} is absent or tombstoned`);
}

export class ListRepo implements ListPort {
  readonly #deps: RepoDeps;

  constructor(deps: RepoDeps) {
    this.#deps = deps;
  }

  async loadAll(): Promise<Result<List[], AppError>> {
    return txApp(this.#deps.db, ['lists'], 'readonly', async (t) => {
      return ok(await listGroupRows(t));
    });
  }

  create(input: { name: string; color: string; id?: string }): Promise<Result<List, AppError>> {
    const { clock, ids, db } = this.#deps;
    return txApp(db, ['lists'], 'readwrite', async (t) => {
      const rows = await listGroupRows(t);
      const now = clock();
      let key: string;
      try {
        key = orderKeyBetween(rows.at(-1)?.sortOrder ?? null, null);
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
      return this.#validatePut(t, row);
    });
  }

  rename(id: string, name: string): Promise<Result<List, AppError>> {
    return this.#patch(id, { name });
  }

  recolor(id: string, color: string): Promise<Result<List, AppError>> {
    return this.#patch(id, { color });
  }

  move(id: string, position: ListPosition): Promise<Result<List, AppError>> {
    const { clock, db } = this.#deps;
    return txApp(db, ['lists'], 'readwrite', async (t) => {
      const row = await t.get('lists', id);
      if (row === undefined || row.deletedAt !== null) return err(listMissing(id));
      const rows = await listGroupRows(t, id);
      const refId =
        typeof position === 'object'
          ? 'afterId' in position
            ? position.afterId
            : position.beforeId
          : null;
      if (refId !== null && !rows.some((r) => r.id === refId)) {
        return err(ruleError('REORDER_TARGET_NOT_IN_GROUP', `${refId} is not in the list group`));
      }
      try {
        const { prevKey, nextKey } = neighborsAround(rows, position);
        const moved: List = {
          ...row,
          sortOrder: orderKeyBetween(prevKey, nextKey),
          updatedAt: clock(),
          deviceId: db.deviceId,
        };
        return await this.#validatePut(t, moved); // SINGLE-record write
      } catch (e) {
        if (!(e instanceof OrderKeyError) || e.code !== 'EXHAUSTED') throw e;
        return this.#rebalance(t, rows, row, position);
      }
    });
  }

  remove(id: string, disposition: ListRemoveDisposition): Promise<Result<void, AppError>> {
    const { clock, db } = this.#deps;
    return txApp(db, ['lists', 'tasks'], 'readwrite', async (t) => {
      const row = await t.get('lists', id);
      if (row === undefined || row.deletedAt !== null) return ok(undefined); // idempotent
      const tasks = (await t.getAll('tasks', { index: 'by_listId', range: { eq: id } })).filter(
        (r) => r.deletedAt === null,
      );
      const now = clock();
      if (disposition.mode === 'move') {
        const target = await t.get('lists', disposition.targetListId);
        if (target === undefined || target.deletedAt !== null || disposition.targetListId === id) {
          return err(
            ruleError(
              'LIST_DELETE_TARGET_MISSING',
              `move target ${disposition.targetListId} is missing or identical`,
            ),
          );
        }
        for (const task of tasks) {
          await t.put('tasks', {
            ...task,
            listId: disposition.targetListId,
            updatedAt: now,
            deviceId: db.deviceId,
          });
        }
      } else {
        for (const task of tasks) {
          await t.put('tasks', { ...task, deletedAt: now, updatedAt: now, deviceId: db.deviceId });
        }
      }
      await t.put('lists', { ...row, deletedAt: now, updatedAt: now, deviceId: db.deviceId });
      return ok(undefined);
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

  #patch(id: string, patch: { name?: string; color?: string }): Promise<Result<List, AppError>> {
    const { clock, db } = this.#deps;
    return txApp(db, ['lists'], 'readwrite', async (t) => {
      const row = await t.get('lists', id);
      if (row === undefined || row.deletedAt !== null) return err(listMissing(id));
      const merged: List = { ...row };
      if (patch.name !== undefined) merged.name = patch.name;
      if (patch.color !== undefined) merged.color = patch.color;
      const stamped: List = { ...merged, updatedAt: clock(), deviceId: db.deviceId };
      return this.#validatePut(t, stamped);
    });
  }

  async #validatePut(
    t: { put: (store: 'lists', row: List) => Promise<void> },
    row: List,
  ): Promise<Result<List, AppError>> {
    const v = validateList(row);
    if (!v.ok) return err(invalidRecord('lists', v.issues, row.id));
    await t.put('lists', row);
    return ok(row);
  }

  /** Rebalance hatch: re-key the whole list group in ONE transaction. */
  async #rebalance(
    t: { put: (store: 'lists', row: List) => Promise<void> },
    rows: List[],
    movedRow: List,
    position: ListPosition,
  ): Promise<Result<List, AppError>> {
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
    const now = this.#deps.clock();
    let settledRow: List | null = null;
    for (let i = 0; i < ordered.length; i += 1) {
      const row = ordered[i] as List;
      const next: List = {
        ...row,
        sortOrder: keys[i] as string,
        updatedAt: now,
        deviceId: this.#deps.db.deviceId,
      };
      const v = validateList(next);
      if (!v.ok) return err(invalidRecord('lists', v.issues, next.id));
      await t.put('lists', next);
      if (row.id === movedRow.id) settledRow = next;
    }
    return ok(settledRow ?? movedRow);
  }
}
