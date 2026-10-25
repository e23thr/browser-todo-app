/**
 * TaskRepo — `TaskPort` adapter over `AppDB` (ADR-003 Decision 2). Owns
 * stamping (ADR-002 Decision 5), tombstoning + child cascade (Decision 6),
 * validation (Decision 11), order-key math and the rebalance hatch (Decision
 * 4.2 rule 4). Every mutation is a field-scoped patch applied read-modify-write
 * inside ONE `readwrite` transaction; reorder writes exactly one row.
 */

import { err, ok, ruleError, type AppError, type Result } from '../../domain/kernel';
import type { List, Settings, Task, TaskDraft, TaskPatch } from '../../domain/model';
import { DEFAULT_SETTINGS } from '../../domain/model';
import type {
  MoveTarget,
  MoveOutcome,
  TaskPort,
  TaskRemoveDisposition,
  TaskRemoveOutcome,
} from '../../domain/ports';
import { invalidRecord } from '../errors';
import { logAppError } from '../errorLog';
import { OrderKeyError, orderKeyBetween, orderKeyFirst } from '../orderKey';
import type { Tx } from '../db';
import { validateTask } from '../validate';
import {
  evenOrderKeys,
  neighborsAround,
  taskGroupRows,
  taskMissing,
  txApp,
  type RepoDeps,
  type SiblingGroup,
} from './support';

export class TaskRepo implements TaskPort {
  readonly #deps: RepoDeps;

  constructor(deps: RepoDeps) {
    this.#deps = deps;
  }

  async loadAll(): Promise<Result<{ tasks: Task[]; lists: List[]; settings: Settings }, AppError>> {
    const read = await txApp(
      this.#deps.db,
      ['tasks', 'lists', 'settings'],
      'readonly',
      async (t) => {
        const tasks = (await t.getAll('tasks')).filter((r) => r.deletedAt === null);
        const lists = (await t.getAll('lists')).filter((r) => r.deletedAt === null);
        const settings = (await t.get('settings', 'settings')) ?? DEFAULT_SETTINGS;
        return ok({ tasks, lists, settings });
      },
    );
    return read;
  }

  create(draft: TaskDraft): Promise<Result<Task, AppError>> {
    const { clock, ids, db } = this.#deps;
    return txApp(db, ['tasks'], 'readwrite', async (t) => {
      const group: SiblingGroup = {
        listId: draft.listId,
        parentTaskId: draft.parentTaskId ?? null,
      };
      const depth = await this.#checkParent(t, group.parentTaskId);
      if (!depth.ok) return depth;
      const rows = await taskGroupRows(t, group);
      const now = clock();
      const base: Task = {
        id: draft.id ?? ids(),
        listId: draft.listId,
        title: draft.title,
        notes: draft.notes,
        status: 'open',
        priority: draft.priority,
        ...(draft.dueDate !== undefined ? { dueDate: draft.dueDate } : {}),
        tags: [...draft.tags],
        ...(draft.parentTaskId !== undefined ? { parentTaskId: draft.parentTaskId } : {}),
        sortOrder: 'h',
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        deviceId: db.deviceId,
      };
      const key = this.#keyAtEnd(rows);
      const row: Task = { ...base, sortOrder: key };
      const validated = this.#validate(row);
      if (!validated.ok) return validated;
      await t.put('tasks', row);
      return ok(row);
    });
  }

  patch(id: string, patch: TaskPatch): Promise<Result<Task, AppError>> {
    const { clock, db } = this.#deps;
    return txApp(db, ['tasks'], 'readwrite', async (t) => {
      const row = await t.get('tasks', id);
      if (row === undefined || row.deletedAt !== null) return err(taskMissing(id));
      const merged: Task = { ...row };
      if (patch.title !== undefined) merged.title = patch.title;
      if (patch.notes !== undefined) merged.notes = patch.notes;
      if (patch.priority !== undefined) merged.priority = patch.priority;
      if (patch.tags !== undefined) merged.tags = [...patch.tags];
      if (patch.reminderAtUnset === true) delete merged.reminderAt;
      else if (patch.reminderAt !== undefined) merged.reminderAt = patch.reminderAt;
      if (patch.recurrence !== undefined) merged.recurrence = patch.recurrence;
      if (patch.dueDateUnset === true) delete merged.dueDate;
      else if (patch.dueDate !== undefined) merged.dueDate = patch.dueDate;
      const stamped: Task = { ...merged, updatedAt: clock(), deviceId: db.deviceId };
      const validated = this.#validate(stamped);
      if (!validated.ok) return validated;
      await t.put('tasks', stamped);
      return ok(stamped);
    });
  }

  setDone(id: string, done: boolean): Promise<Result<Task, AppError>> {
    const { clock, db } = this.#deps;
    return txApp(db, ['tasks'], 'readwrite', async (t) => {
      const row = await t.get('tasks', id);
      if (row === undefined || row.deletedAt !== null) return err(taskMissing(id));
      const now = clock();
      const stamped: Task = {
        ...row,
        status: done ? 'done' : 'open',
        updatedAt: now,
        deviceId: db.deviceId,
      };
      if (done) stamped.completedAt = now;
      else delete stamped.completedAt;
      const validated = this.#validate(stamped);
      if (!validated.ok) return validated;
      await t.put('tasks', stamped);
      return ok(stamped);
    });
  }

  move(id: string, target: MoveTarget): Promise<Result<MoveOutcome<Task>, AppError>> {
    const { clock, db, errorLog } = this.#deps;
    return txApp(db, ['tasks'], 'readwrite', async (t) => {
      const row = await t.get('tasks', id);
      if (row === undefined || row.deletedAt !== null) return err(taskMissing(id));
      const group: SiblingGroup = {
        listId: target.group.listId,
        parentTaskId: target.group.parentTaskId,
      };
      const depth = await this.#checkParent(t, group.parentTaskId, id);
      if (!depth.ok) return depth;
      const rows = await taskGroupRows(t, group, id);
      const position = target.position;
      const refId =
        typeof position === 'object'
          ? 'afterId' in position
            ? position.afterId
            : position.beforeId
          : null;
      if (refId !== null && !rows.some((r) => r.id === refId)) {
        return err(
          ruleError('REORDER_TARGET_NOT_IN_GROUP', `${refId} is not in the declared group`),
        );
      }
      const now = clock();
      const stamp = { updatedAt: now, deviceId: db.deviceId } as const;

      const insertAt =
        position === 'first'
          ? 0
          : position === 'last'
            ? rows.length
            : 'afterId' in position
              ? rows.findIndex((r) => r.id === position.afterId) + 1
              : rows.findIndex((r) => r.id === position.beforeId);

      try {
        const { prevKey, nextKey } = neighborsAround(rows, position);
        const moved: Task = this.#withGroup(row, group, {
          sortOrder: orderKeyBetween(prevKey, nextKey),
          ...stamp,
        });
        const validated = this.#validate(moved);
        if (!validated.ok) return validated;
        await t.put('tasks', moved); // SINGLE-record write
        return ok({ row: moved, rebalanced: false });
      } catch (e) {
        if (!(e instanceof OrderKeyError) || e.code !== 'EXHAUSTED') throw e;
        // ADR-002 rebalance hatch: fresh evenly-spaced keys for the whole
        // sibling group in ONE transaction — observable in the error log.
        logAppError(
          errorLog,
          'repos',
          'reorder-rebalance',
          {
            code: 'UNKNOWN',
            cause: e,
          },
          `sibling group (${group.listId}, ${group.parentTaskId ?? 'top'})`,
        );
        return this.#rebalance(t, rows, insertAt, row, group);
      }
    });
  }

  remove(
    id: string,
    disposition: TaskRemoveDisposition,
  ): Promise<Result<TaskRemoveOutcome, AppError>> {
    const { clock, db } = this.#deps;
    return txApp(db, ['tasks'], 'readwrite', async (t) => {
      const empty: TaskRemoveOutcome = { tombstoned: [], promoted: [] };
      const row = await t.get('tasks', id);
      if (row === undefined || row.deletedAt !== null) return ok(empty); // idempotent
      const children = (await t.getAll('tasks', { index: 'by_parent', range: { eq: id } })).filter(
        (r) => r.deletedAt === null,
      );
      const now = clock();
      const stamp = { updatedAt: now, deviceId: db.deviceId } as const;
      const tombstoned: Task[] = [];
      const promoted: Task[] = [];
      // Subtask disposition FIRST, the task itself last — one transaction either
      // way (E7 S2: `promote` moves direct subtasks up to the list's top level).
      for (const child of children) {
        if (disposition.mode === 'promote') {
          const up: Task = { ...child, ...stamp };
          delete up.parentTaskId;
          const validated = this.#validate(up);
          if (!validated.ok) return validated;
          await t.put('tasks', up);
          promoted.push(up);
        } else {
          const tomb: Task = { ...child, deletedAt: now, ...stamp };
          await t.put('tasks', tomb);
          tombstoned.push(tomb);
        }
      }
      const tomb: Task = { ...row, deletedAt: now, ...stamp };
      await t.put('tasks', tomb);
      tombstoned.push(tomb);
      return ok({ tombstoned, promoted });
    });
  }

  /**
   * S1 tag rename/delete sweep (ADR-002 §3.5 denormalized model): ONE
   * transaction rewriting EVERY row carrying `from` — tombstoned rows included
   * so exports/sync never resurrect a renamed-away name. Changed rows are
   * restamped like every other write.
   */
  sweepTag(from: string, to: string | null): Promise<Result<Task[], AppError>> {
    const { clock, db } = this.#deps;
    return txApp(db, ['tasks'], 'readwrite', async (t) => {
      const rows = await t.getAll('tasks');
      const now = clock();
      const written: Task[] = [];
      // Every request is issued synchronously and awaited in ONE batch: the
      // transaction is still exactly one (atomic) sweep, but the write path
      // never round-trips per row — this is the 10k rename-propagation budget
      // (E7 S1 benchmark in `tests/unit/storage/repos-e7.test.ts`).
      const puts: Promise<unknown>[] = [];
      for (const row of rows) {
        if (!row.tags.includes(from)) continue;
        const tags =
          to === null
            ? row.tags.filter((tag) => tag !== from)
            : [...new Set(row.tags.map((tag) => (tag === from ? to : tag)))];
        const next: Task = { ...row, tags, updatedAt: now, deviceId: db.deviceId };
        const validated = this.#validate(next);
        if (!validated.ok) return validated;
        puts.push(t.put('tasks', next));
        written.push(next);
      }
      await Promise.all(puts);
      return ok(written);
    });
  }

  /** M11 import path: rows keep their original stamps (ADR-003 Decision 2.1). */
  upsertImported(rows: Task[]): Promise<Result<void, AppError>> {
    const { db } = this.#deps;
    return txApp(db, ['tasks'], 'readwrite', async (t) => {
      for (const row of rows) {
        const validated = this.#validate(row);
        if (!validated.ok) return validated;
        await t.put('tasks', row);
      }
      return ok(undefined);
    });
  }

  /** Raw rows with `updatedAt > since` (tombstones included) — tab-sync watermark sweep. */
  async changedSince(since: number): Promise<Result<Task[], AppError>> {
    const read = await this.#deps.db.query('tasks', {
      index: 'by_updatedAt',
      range: { lower: since, lowerOpen: true },
    });
    return read;
  }

  /* ------------------------------ internals ------------------------------ */

  #validate(row: Task): Result<void, AppError> {
    const v = validateTask(row);
    return v.ok ? ok(undefined) : err(invalidRecord('tasks', v.issues, row.id));
  }

  #withGroup(
    row: Task,
    group: SiblingGroup,
    stamp: { sortOrder: string; updatedAt: number; deviceId: string },
  ): Task {
    const moved: Task = { ...row, listId: group.listId, ...stamp };
    if (group.parentTaskId === null) delete moved.parentTaskId;
    else moved.parentTaskId = group.parentTaskId;
    return moved;
  }

  async #checkParent(
    t: Tx,
    parentTaskId: string | null,
    selfId?: string,
  ): Promise<Result<void, AppError>> {
    if (parentTaskId === null || parentTaskId === selfId) return ok(undefined);
    const parent = await t.get('tasks', parentTaskId);
    if (parent === undefined || parent.deletedAt !== null) return err(taskMissing(parentTaskId));
    if (parent.parentTaskId !== undefined) {
      return err(ruleError('PARENT_DEPTH_EXCEEDED', 'subtasks cannot nest (V1 is one level)'));
    }
    return ok(undefined);
  }

  #keyAtEnd(rows: readonly { sortOrder: string }[]): string {
    try {
      return orderKeyBetween(rows.at(-1)?.sortOrder ?? null, null);
    } catch {
      return orderKeyFirst();
    }
  }

  /** Rebalance hatch: re-key the whole sibling group in ONE transaction (`rebalanced: true`). */
  async #rebalance(
    t: Tx,
    rows: Task[],
    insertAt: number,
    movedRow: Task,
    group: SiblingGroup,
  ): Promise<Result<MoveOutcome<Task>, AppError>> {
    const ordered = [...rows];
    ordered.splice(Math.min(Math.max(0, insertAt), ordered.length), 0, movedRow);
    const keys = evenOrderKeys(ordered.length);
    const now = this.#deps.clock();
    let settledRow: Task | null = null;
    for (let i = 0; i < ordered.length; i += 1) {
      const row = ordered[i] as Task;
      const isMoved = row.id === movedRow.id;
      const next = isMoved
        ? this.#withGroup(movedRow, group, {
            sortOrder: keys[i] as string,
            updatedAt: now,
            deviceId: this.#deps.db.deviceId,
          })
        : {
            ...row,
            sortOrder: keys[i] as string,
            updatedAt: now,
            deviceId: this.#deps.db.deviceId,
          };
      const validated = this.#validate(next);
      if (!validated.ok) return validated;
      await t.put('tasks', next);
      if (isMoved) settledRow = next;
    }
    return ok({
      row:
        settledRow ??
        this.#withGroup(movedRow, group, {
          sortOrder: orderKeyFirst(),
          updatedAt: now,
          deviceId: this.#deps.db.deviceId,
        }),
      rebalanced: true,
    });
  }
}
