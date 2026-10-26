/**
 * TaskRepo — `TaskPort` adapter over `AppDB` (ADR-003 Decision 2). Owns
 * stamping (ADR-002 Decision 5), tombstoning + child cascade (Decision 6),
 * validation (Decision 11), order-key math and the rebalance hatch (Decision
 * 4.2 rule 4). Every mutation is a field-scoped patch applied read-modify-write.
 *
 * ADR-007 Decision 4.6 (E10-Q6 carriers, t_a155ebf2): the row seam's WebCrypto
 * never runs inside a live IndexedDB transaction — firefox/webkit deactivate a
 * `readwrite` tx across such an await (chromium survives only via microtask
 * scheduling). Reads use the SAFE surface (`db.get`/`db.getAll`/`db.query` —
 * these decrypt AFTER their own tx); single-row read-modify-writes merge
 * outside, seal via `sealForWrite`, and commit verbatim in ONE `txRaw` guarded
 * by the envelope `updatedAt` stamp (`STALE_WRITE` on conflict — never a lost
 * update); bulk writes stage EVERY row first (the `runSweep`/`applyImport`
 * pattern). ONE-transaction atomicity of each write set is unchanged.
 */

import { err, ok, ruleError, type AppError, type Result } from '../../domain/kernel';
import type { List, Settings, Task, TaskDraft, TaskPatch } from '../../domain/model';
import { DEFAULT_SETTINGS } from '../../domain/model';
import type {
  CompleteRecurringOutcome,
  MoveTarget,
  MoveOutcome,
  RestoreOutcome,
  TaskOccurrenceDraft,
  TaskPort,
  TaskRemoveDisposition,
  TaskRemoveOutcome,
} from '../../domain/ports';
import { invalidRecord } from '../errors';
import { logAppError } from '../errorLog';
import { OrderKeyError, orderKeyBetween, orderKeyFirst } from '../orderKey';
import { SETTINGS_KEY } from '../schema';
import { validateTask } from '../validate';
import {
  evenOrderKeys,
  guardedSealedPut,
  neighborsAround,
  sealRow,
  stageAll,
  staleWrite,
  taskGroupRows,
  taskMissing,
  txAppRaw,
  type RepoDeps,
  type SiblingGroup,
} from './support';

export class TaskRepo implements TaskPort {
  readonly #deps: RepoDeps;

  constructor(deps: RepoDeps) {
    this.#deps = deps;
  }

  async loadAll(): Promise<Result<{ tasks: Task[]; lists: List[]; settings: Settings }, AppError>> {
    const { db } = this.#deps;
    // Domain views are produced OUTSIDE any transaction (D4.6): each safe-surface
    // read decrypts after its own tx closes.
    const tasks = await db.getAll('tasks');
    if (!tasks.ok) return err(tasks.error);
    const lists = await db.getAll('lists');
    if (!lists.ok) return err(lists.error);
    const settings = await db.get('settings', SETTINGS_KEY);
    if (!settings.ok) return err(settings.error);
    return ok({
      tasks: tasks.value.filter((r) => r.deletedAt === null),
      lists: lists.value.filter((r) => r.deletedAt === null),
      settings: settings.value ?? DEFAULT_SETTINGS,
    });
  }

  async create(draft: TaskDraft): Promise<Result<Task, AppError>> {
    const { clock, ids, db } = this.#deps;
    const group: SiblingGroup = {
      listId: draft.listId,
      parentTaskId: draft.parentTaskId ?? null,
    };
    const depth = await this.#checkParent(group.parentTaskId);
    if (!depth.ok) return depth;
    const rows = await taskGroupRows(db, group);
    if (!rows.ok) return rows;
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
    const key = this.#keyAtEnd(rows.value);
    const row: Task = { ...base, sortOrder: key };
    const validated = this.#validate(row);
    if (!validated.ok) return validated;
    // Insert — no prior version to guard. Seal outside, write verbatim (D4.6).
    const sealed = await sealRow(db, 'tasks', row);
    if (!sealed.ok) return sealed;
    return txAppRaw(db, ['tasks'], 'readwrite', async (t) => {
      await t.put('tasks', sealed.value);
      return ok(row);
    });
  }

  async patch(id: string, patch: TaskPatch): Promise<Result<Task, AppError>> {
    const { clock, db } = this.#deps;
    const current = await db.get('tasks', id);
    if (!current.ok) return err(current.error);
    const row = current.value;
    if (row === undefined || row.deletedAt !== null) return err(taskMissing(id));
    const merged: Task = { ...row };
    if (patch.title !== undefined) merged.title = patch.title;
    if (patch.notes !== undefined) merged.notes = patch.notes;
    if (patch.priority !== undefined) merged.priority = patch.priority;
    if (patch.tags !== undefined) merged.tags = [...patch.tags];
    if (patch.reminderAtUnset === true) delete merged.reminderAt;
    else if (patch.reminderAt !== undefined) merged.reminderAt = patch.reminderAt;
    if (patch.recurrenceUnset === true) delete merged.recurrence;
    else if (patch.recurrence !== undefined) merged.recurrence = patch.recurrence;
    if (patch.dueDateUnset === true) delete merged.dueDate;
    else if (patch.dueDate !== undefined) merged.dueDate = patch.dueDate;
    const stamped: Task = { ...merged, updatedAt: clock(), deviceId: db.deviceId };
    const validated = this.#validate(stamped);
    if (!validated.ok) return validated;
    // D4.6 single-row RMW: stamp-guarded verbatim commit (STALE_WRITE on conflict).
    const put = await guardedSealedPut(db, 'tasks', stamped, row.updatedAt);
    if (!put.ok) return put;
    return ok(stamped);
  }

  async setDone(id: string, done: boolean): Promise<Result<Task, AppError>> {
    const { clock, db } = this.#deps;
    const current = await db.get('tasks', id);
    if (!current.ok) return err(current.error);
    const row = current.value;
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
    const put = await guardedSealedPut(db, 'tasks', stamped, row.updatedAt);
    if (!put.ok) return put;
    return ok(stamped);
  }

  /**
   * S4 recurring completion: mark the task done AND create its next occurrence
   * in ONE transaction (a half-applied pair — done without a successor — is
   * exactly the data-loss shape this repo's one-transaction rule exists to
   * prevent). The completed row is written exactly like `setDone` writes it:
   * "recurrence never mutates past occurrences". ADR-007 D4.6: both rows are
   * staged outside the tx; the read-modify-write half is stamp-guarded exactly
   * like `setDone`, and the insert half has no prior version to guard.
   */
  async completeRecurring(
    id: string,
    next: TaskOccurrenceDraft,
  ): Promise<Result<CompleteRecurringOutcome, AppError>> {
    const { clock, ids, db } = this.#deps;
    const current = await db.get('tasks', id);
    if (!current.ok) return err(current.error);
    const row = current.value;
    if (row === undefined || row.deletedAt !== null) return err(taskMissing(id));
    const now = clock();
    const done: Task = {
      ...row,
      status: 'done',
      completedAt: now,
      updatedAt: now,
      deviceId: db.deviceId,
    };
    const doneValidated = this.#validate(done);
    if (!doneValidated.ok) return doneValidated;

    const group: SiblingGroup = {
      listId: next.listId,
      parentTaskId: next.parentTaskId ?? null,
    };
    const depth = await this.#checkParent(group.parentTaskId);
    if (!depth.ok) return depth;
    const rows = await taskGroupRows(db, group);
    if (!rows.ok) return rows;
    const base: Task = {
      id: next.id ?? ids(),
      listId: next.listId,
      title: next.title,
      notes: next.notes,
      status: 'open',
      priority: next.priority,
      ...(next.dueDate !== undefined ? { dueDate: next.dueDate } : {}),
      ...(next.reminderAt !== undefined ? { reminderAt: next.reminderAt } : {}),
      ...(next.recurrence !== undefined ? { recurrence: next.recurrence } : {}),
      tags: [...next.tags],
      ...(next.parentTaskId !== undefined ? { parentTaskId: next.parentTaskId } : {}),
      sortOrder: 'h',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deviceId: db.deviceId,
    };
    const created: Task = { ...base, sortOrder: this.#keyAtEnd(rows.value) };
    const createdValidated = this.#validate(created);
    if (!createdValidated.ok) return createdValidated;
    const stagedDone = await sealRow(db, 'tasks', done);
    if (!stagedDone.ok) return stagedDone;
    const stagedCreated = await sealRow(db, 'tasks', created);
    if (!stagedCreated.ok) return stagedCreated;
    return txAppRaw(db, ['tasks'], 'readwrite', async (t) => {
      // Same optimistic stamp rule as setDone (ADR-007 D4.6): a concurrent
      // write to the completed row aborts as STALE_WRITE instead of being
      // silently overwritten.
      const latest = await t.get('tasks', id);
      if (latest === undefined || latest.updatedAt !== row.updatedAt) {
        return err(staleWrite('tasks', id));
      }
      await t.put('tasks', stagedDone.value);
      await t.put('tasks', stagedCreated.value); // one transaction: never done without its successor
      return ok({ done, created });
    });
  }

  /**
   * S7 undo (see `TaskPort.restore`): the captured rows come back with every
   * FIELD verbatim — `sortOrder`, `listId`, `parentTaskId`, `status`,
   * `completedAt`, `dueDate`, `recurrence`… — and only the stamps are
   * re-applied, like every other write here. A verbatim `updatedAt` would hide
   * the restore from the tab-sync watermark sweep (`changedSince` queries by
   * `updatedAt`) and let per-record LWW treat the undo as pre-delete state.
   * ADR-007 D4.6 bulk pattern: every row staged outside, ONE txRaw commits
   * restores + tombstones together.
   */
  async restore(rows: Task[], removeIds: string[]): Promise<Result<RestoreOutcome, AppError>> {
    const { clock, db } = this.#deps;
    const now = clock();
    const restored: Task[] = [];
    for (const row of rows) {
      const next: Task = { ...row, updatedAt: now, deviceId: db.deviceId };
      const validated = this.#validate(next);
      if (!validated.ok) return validated;
      restored.push(next);
    }
    const tombstoned: Task[] = [];
    for (const id of removeIds) {
      const current = await db.get('tasks', id);
      if (!current.ok) return err(current.error);
      const row = current.value;
      if (row === undefined || row.deletedAt !== null) continue; // idempotent
      const tomb: Task = { ...row, deletedAt: now, updatedAt: now, deviceId: db.deviceId };
      const validated = this.#validate(tomb);
      if (!validated.ok) return validated;
      tombstoned.push(tomb);
    }
    const staged = await stageAll(db, 'tasks', [...restored, ...tombstoned]);
    if (!staged.ok) return staged;
    return txAppRaw(db, ['tasks'], 'readwrite', async (t) => {
      for (const row of staged.value) await t.put('tasks', row);
      return ok({ restored, tombstoned });
    });
  }

  async move(id: string, target: MoveTarget): Promise<Result<MoveOutcome<Task>, AppError>> {
    const { clock, db, errorLog } = this.#deps;
    const current = await db.get('tasks', id);
    if (!current.ok) return err(current.error);
    const row = current.value;
    if (row === undefined || row.deletedAt !== null) return err(taskMissing(id));
    const group: SiblingGroup = {
      listId: target.group.listId,
      parentTaskId: target.group.parentTaskId,
    };
    const depth = await this.#checkParent(group.parentTaskId, id);
    if (!depth.ok) return depth;
    const rows = await taskGroupRows(db, group, id);
    if (!rows.ok) return rows;
    const position = target.position;
    const refId =
      typeof position === 'object'
        ? 'afterId' in position
          ? position.afterId
          : position.beforeId
        : null;
    if (refId !== null && !rows.value.some((r) => r.id === refId)) {
      return err(ruleError('REORDER_TARGET_NOT_IN_GROUP', `${refId} is not in the declared group`));
    }
    const now = clock();
    const stamp = { updatedAt: now, deviceId: db.deviceId } as const;

    const insertAt =
      position === 'first'
        ? 0
        : position === 'last'
          ? rows.value.length
          : 'afterId' in position
            ? rows.value.findIndex((r) => r.id === position.afterId) + 1
            : rows.value.findIndex((r) => r.id === position.beforeId);

    try {
      const { prevKey, nextKey } = neighborsAround(rows.value, position);
      const moved: Task = this.#withGroup(row, group, {
        sortOrder: orderKeyBetween(prevKey, nextKey),
        ...stamp,
      });
      const validated = this.#validate(moved);
      if (!validated.ok) return validated;
      // SINGLE-record write, stamp-guarded (D4.6): a concurrent write to the
      // moved row aborts as STALE_WRITE instead of being silently overwritten.
      const put = await guardedSealedPut(db, 'tasks', moved, row.updatedAt);
      if (!put.ok) return put;
      return ok({ row: moved, rebalanced: false });
    } catch (e) {
      if (!(e instanceof OrderKeyError) || e.code !== 'EXHAUSTED') throw e;
      // ADR-002 rebalance hatch: fresh evenly-spaced keys for the whole
      // sibling group — staged outside, ONE txRaw (D4.6 bulk pattern).
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
      return this.#rebalance(rows.value, insertAt, row, group);
    }
  }

  async remove(
    id: string,
    disposition: TaskRemoveDisposition,
  ): Promise<Result<TaskRemoveOutcome, AppError>> {
    const { clock, db } = this.#deps;
    const empty: TaskRemoveOutcome = { tombstoned: [], promoted: [] };
    const current = await db.get('tasks', id);
    if (!current.ok) return err(current.error);
    const row = current.value;
    if (row === undefined || row.deletedAt !== null) return ok(empty); // idempotent
    const childrenRead = await db.query('tasks', { index: 'by_parent', range: { eq: id } });
    if (!childrenRead.ok) return err(childrenRead.error);
    const children = childrenRead.value.filter((r) => r.deletedAt === null);
    const now = clock();
    const stamp = { updatedAt: now, deviceId: db.deviceId } as const;
    const tombstoned: Task[] = [];
    const promoted: Task[] = [];
    // Subtask disposition FIRST, the task itself last — ONE transaction either
    // way (E7 S2: `promote` moves direct subtasks up to the list's top level).
    // Every row is staged outside the tx (D4.6); the ONE txRaw covers them all.
    const stagedRows: Task[] = [];
    for (const child of children) {
      if (disposition.mode === 'promote') {
        const up: Task = { ...child, ...stamp };
        delete up.parentTaskId;
        const validated = this.#validate(up);
        if (!validated.ok) return validated;
        const sealed = await sealRow(db, 'tasks', up);
        if (!sealed.ok) return sealed;
        stagedRows.push(sealed.value);
        promoted.push(up);
      } else {
        const tomb: Task = { ...child, deletedAt: now, ...stamp };
        const sealed = await sealRow(db, 'tasks', tomb);
        if (!sealed.ok) return sealed;
        stagedRows.push(sealed.value);
        tombstoned.push(tomb);
      }
    }
    const tomb: Task = { ...row, deletedAt: now, ...stamp };
    const sealedSelf = await sealRow(db, 'tasks', tomb);
    if (!sealedSelf.ok) return sealedSelf;
    stagedRows.push(sealedSelf.value);
    tombstoned.push(tomb);
    return txAppRaw(db, ['tasks'], 'readwrite', async (t) => {
      for (const staged of stagedRows) await t.put('tasks', staged);
      return ok({ tombstoned, promoted });
    });
  }

  /**
   * S1 tag rename/delete sweep (ADR-002 §3.5 denormalized model): EVERY row
   * carrying `from` is rewritten — tombstoned rows included so exports/sync
   * never resurrect a renamed-away name. Changed rows are restamped like every
   * other write, staged outside the tx (D4.6 bulk pattern) and committed in
   * ONE transaction.
   */
  async sweepTag(from: string, to: string | null): Promise<Result<Task[], AppError>> {
    const { clock, db } = this.#deps;
    const all = await db.getAll('tasks');
    if (!all.ok) return err(all.error);
    const now = clock();
    const written: Task[] = [];
    for (const row of all.value) {
      if (!row.tags.includes(from)) continue;
      const tags =
        to === null
          ? row.tags.filter((tag) => tag !== from)
          : [...new Set(row.tags.map((tag) => (tag === from ? to : tag)))];
      const next: Task = { ...row, tags, updatedAt: now, deviceId: db.deviceId };
      const validated = this.#validate(next);
      if (!validated.ok) return validated;
      written.push(next);
    }
    // Staging is pure and concurrent-safe: every seal is issued in ONE batch
    // (the E7 S1 10k rename budget), then the writes commit together.
    const staged = await stageAll(db, 'tasks', written);
    if (!staged.ok) return staged;
    return txAppRaw(db, ['tasks'], 'readwrite', async (t) => {
      for (const row of staged.value) await t.put('tasks', row);
      return ok(written);
    });
  }

  /** M11 import path: rows keep their original stamps (ADR-003 Decision 2.1). */
  async upsertImported(rows: Task[]): Promise<Result<void, AppError>> {
    const { db } = this.#deps;
    for (const row of rows) {
      const validated = this.#validate(row);
      if (!validated.ok) return validated;
    }
    const staged = await stageAll(db, 'tasks', rows);
    if (!staged.ok) return staged;
    return txAppRaw(db, ['tasks'], 'readwrite', async (t) => {
      for (const row of staged.value) await t.put('tasks', row);
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
    parentTaskId: string | null,
    selfId?: string,
  ): Promise<Result<void, AppError>> {
    if (parentTaskId === null || parentTaskId === selfId) return ok(undefined);
    const parent = await this.#deps.db.get('tasks', parentTaskId);
    if (!parent.ok) return err(parent.error);
    const row = parent.value;
    if (row === undefined || row.deletedAt !== null) return err(taskMissing(parentTaskId));
    if (row.parentTaskId !== undefined) {
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

  /** Rebalance hatch: re-key the whole sibling group — staged outside, ONE txRaw (`rebalanced: true`). */
  async #rebalance(
    rows: Task[],
    insertAt: number,
    movedRow: Task,
    group: SiblingGroup,
  ): Promise<Result<MoveOutcome<Task>, AppError>> {
    const { clock, db } = this.#deps;
    const ordered = [...rows];
    ordered.splice(Math.min(Math.max(0, insertAt), ordered.length), 0, movedRow);
    const keys = evenOrderKeys(ordered.length);
    const now = clock();
    let settledRow: Task | null = null;
    const nexts: Task[] = [];
    for (let i = 0; i < ordered.length; i += 1) {
      const row = ordered[i] as Task;
      const isMoved = row.id === movedRow.id;
      const next = isMoved
        ? this.#withGroup(movedRow, group, {
            sortOrder: keys[i] as string,
            updatedAt: now,
            deviceId: db.deviceId,
          })
        : {
            ...row,
            sortOrder: keys[i] as string,
            updatedAt: now,
            deviceId: db.deviceId,
          };
      const validated = this.#validate(next);
      if (!validated.ok) return validated;
      nexts.push(next);
      if (isMoved) settledRow = next;
    }
    const staged = await stageAll(db, 'tasks', nexts);
    if (!staged.ok) return staged;
    return txAppRaw(db, ['tasks'], 'readwrite', async (t) => {
      for (const row of staged.value) await t.put('tasks', row);
      return ok({
        row:
          settledRow ??
          this.#withGroup(movedRow, group, {
            sortOrder: orderKeyFirst(),
            updatedAt: now,
            deviceId: db.deviceId,
          }),
        rebalanced: true,
      });
    });
  }
}
