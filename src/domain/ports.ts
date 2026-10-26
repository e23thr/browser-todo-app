/**
 * Repository ports (ADR-003 Decision 2.1) — the interfaces `src/storage/repos/`
 * implements over `AppDB`. Every port returns `Promise<Result<T, AppError>>`;
 * nothing throws across the boundary. Writes are field-scoped patches applied
 * read-modify-write inside one `readwrite` transaction; repos own stamping,
 * tombstoning, validation and order-key math (ADR-002 Decisions 4/5/6/11).
 */

import type { AppError, Result } from './kernel';
import type { List, Recurrence, Settings, Task, TaskDraft, TaskPatch } from './model';

/** Epoch ms UTC — injectable (ADR-002 Decision 5). */
export type Clock = () => number;

/** ULID via `storage/id.ts`, injected (keeps domain pure). */
export type IdFactory = () => string;

/**
 * == `storage/orderKey.ts` (ADR-002 Decision 4), injected — used for PROVISIONAL
 * keys on optimistic moves; the repo recomputes the authoritative key inside the
 * write transaction.
 */
export type OrderKeyOps = {
  between(a: string | null, b: string | null): string;
  first(): string;
};

/** Sibling group + insertion position for `move()` (ADR-002 Decision 4). */
export type MoveTarget = {
  group: { listId: string; parentTaskId: string | null };
  position: 'first' | 'last' | { afterId: string } | { beforeId: string };
};

export type ListPosition = 'first' | 'last' | { afterId: string } | { beforeId: string };

/** Insertion position of a task move — `MoveTarget['position']` (ADR-002 Decision 4). */
export type TaskPosition = MoveTarget['position'];

export type ListRemoveDisposition = { mode: 'move'; targetListId: string } | { mode: 'tombstone' };

/**
 * Subtask disposition for `TaskPort.remove` (E7 S2, "consistent with the
 * list-deletion UX"): `cascade` tombstones the task AND its direct subtasks
 * (the MVP behavior); `promote` tombstones only the task and moves its direct
 * subtasks up to the top level of their list. ONE transaction either way.
 */
export type TaskRemoveDisposition = { mode: 'cascade' } | { mode: 'promote' };

/**
 * Rows a task-delete transaction wrote: `tombstoned` is always non-empty (the
 * task itself), `promoted` is non-empty for `mode: 'promote'` (re-parented +
 * restamped). Returned so the pipeline can re-anchor / evict the committed
 * baseline for every touched id (ADR-003 Decision 3 step 4a).
 */
export type TaskRemoveOutcome = { tombstoned: Task[]; promoted: Task[] };

/**
 * `move()` outcome (pipeline step 4a): the authoritative row the repo wrote,
 * plus `rebalanced` — true when the order-key exhaustion hatch re-keyed EVERY
 * row of the sibling group in that transaction (ADR-002 §4.2 rule 4). The flag
 * is how the group rewrite surfaces to `MutationRunner`, which must then
 * broadcast `'all'` instead of the moved id (ADR-003 Decision 8.1 rule 2).
 */
export type MoveOutcome<T> = { row: T; rebalanced: boolean };

/**
 * Rows a list-delete transaction wrote (ADR-002 Decision 6): `moved` is
 * non-empty for `mode:'move'` (retargeted + restamped), `tombstoned` for
 * `mode:'tombstone'`. Returned so the pipeline can re-anchor / evict the
 * committed baseline for every touched id (ADR-003 Decision 3 step 4a).
 */
export type ListRemoveOutcome = { moved: Task[]; tombstoned: Task[] };

/**
 * Create input for the S4 NEXT OCCURRENCE of a recurring task: a normal
 * `TaskDraft` plus the two fields the recurrence carries forward (`recurrence`
 * itself and the reminder instant) — `TaskDraft` stays the composer's shape.
 */
export type TaskOccurrenceDraft = TaskDraft & {
  reminderAt?: number;
  recurrence?: Recurrence;
};

/** Rows the S4 `completeRecurring` transaction wrote: the completed row + its successor. */
export type CompleteRecurringOutcome = { done: Task; created: Task };

/**
 * Rows the S7 `restore` transaction wrote: `restored` are the rows written back
 * verbatim (undo of delete/complete/move), `tombstoned` the rows the undo
 * removed again (the occurrence a completed recurring task had minted).
 */
export type RestoreOutcome = { restored: Task[]; tombstoned: Task[] };

export interface TaskPort {
  loadAll(): Promise<Result<{ tasks: Task[]; lists: List[]; settings: Settings }, AppError>>;
  create(draft: TaskDraft): Promise<Result<Task, AppError>>;
  patch(id: string, patch: TaskPatch): Promise<Result<Task, AppError>>;
  /** `completedAt` stamped on done, cleared on uncomplete (ADR-002 Decision 5). */
  setDone(id: string, done: boolean): Promise<Result<Task, AppError>>;
  /**
   * S6 archive/restore (E9): `archived` flips a DONE task to `archived`
   * PRESERVING its `completedAt` (the retention partition still shows when it
   * was finished); un-archiving returns it to `done`, backfilling
   * `completedAt` when the archived row somehow lost the stamp. Only
   * done→archived and archived→done are legal — anything else is a
   * `TASK_STATUS_INVALID` rule error (never a silent reopen).
   */
  setArchived(id: string, archived: boolean): Promise<Result<Task, AppError>>;
  /**
   * S4 recurring completion: mark the task done AND create its next occurrence
   * in ONE transaction (a half-applied pair — done without a successor — is
   * exactly the data-loss shape this repo's one-transaction rule exists to
   * prevent). The completed row is written exactly like `setDone` writes it:
   * "recurrence never mutates past occurrences".
   */
  completeRecurring(
    id: string,
    next: TaskOccurrenceDraft,
  ): Promise<Result<CompleteRecurringOutcome, AppError>>;
  /**
   * S7 undo: write `rows` back (fields verbatim, stamps re-applied by the repo
   * like every other write — see the repo implementation) and tombstone
   * `removeIds` in ONE transaction. Resolves the rows the transaction wrote.
   */
  restore(rows: Task[], removeIds: string[]): Promise<Result<RestoreOutcome, AppError>>;
  /** SINGLE-record write: resolves neighbor keys, one `put` of the moved row. */
  move(id: string, target: MoveTarget): Promise<Result<MoveOutcome<Task>, AppError>>;
  /**
   * Tombstone the task plus its subtask disposition in ONE transaction;
   * idempotent (removing an absent/tombstoned row resolves with empty outcome).
   */
  remove(
    id: string,
    disposition: TaskRemoveDisposition,
  ): Promise<Result<TaskRemoveOutcome, AppError>>;
  /**
   * S1 tag rename/delete sweep over the DENORMALIZED `tags: string[]` model
   * (ADR-002 §3.5): ONE transaction rewriting every row carrying `from` —
   * `to: string` renames (de-duplicating when both names are present on a row),
   * `to: null` deletes the tag from every row. Tombstoned rows are swept too so
   * exports/sync never resurrect a renamed-away name. Changed rows are
   * restamped (`updatedAt`/`deviceId`) like every other write; resolves with the
   * rows the transaction wrote.
   */
  sweepTag(from: string, to: string | null): Promise<Result<Task[], AppError>>;
  /** M11 import path: rows keep their original stamps. */
  upsertImported(rows: Task[]): Promise<Result<void, AppError>>;
}

export interface ListPort {
  loadAll(): Promise<Result<List[], AppError>>;
  /** `id` is the pre-minted final ULID (see `TaskDraft.id`); repos mint one when absent. */
  create(input: { name: string; color: string; id?: string }): Promise<Result<List, AppError>>;
  rename(id: string, name: string): Promise<Result<List, AppError>>;
  recolor(id: string, color: string): Promise<Result<List, AppError>>;
  /** Single-record write over the global list group. */
  move(id: string, position: ListPosition): Promise<Result<MoveOutcome<List>, AppError>>;
  /**
   * ADR-002 Decision 6 verbatim: move tasks or tombstone them — ONE transaction either way.
   * Resolves with the rows that transaction wrote (see `ListRemoveOutcome`).
   */
  remove(
    id: string,
    disposition: ListRemoveDisposition,
  ): Promise<Result<ListRemoveOutcome, AppError>>;
}

export interface SettingsPort {
  get(): Promise<Result<Settings, AppError>>;
  update(patch: Partial<Omit<Settings, 'id'>>): Promise<Result<Settings, AppError>>;
}
