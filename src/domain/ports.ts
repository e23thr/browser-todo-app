/**
 * Repository ports (ADR-003 Decision 2.1) — the interfaces `src/storage/repos/`
 * implements over `AppDB`. Every port returns `Promise<Result<T, AppError>>`;
 * nothing throws across the boundary. Writes are field-scoped patches applied
 * read-modify-write inside one `readwrite` transaction; repos own stamping,
 * tombstoning, validation and order-key math (ADR-002 Decisions 4/5/6/11).
 */

import type { AppError, Result } from './kernel';
import type { List, Settings, Task, TaskDraft, TaskPatch } from './model';

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

export type ListRemoveDisposition = { mode: 'move'; targetListId: string } | { mode: 'tombstone' };

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

export interface TaskPort {
  loadAll(): Promise<Result<{ tasks: Task[]; lists: List[]; settings: Settings }, AppError>>;
  create(draft: TaskDraft): Promise<Result<Task, AppError>>;
  patch(id: string, patch: TaskPatch): Promise<Result<Task, AppError>>;
  /** `completedAt` stamped on done, cleared on uncomplete (ADR-002 Decision 5). */
  setDone(id: string, done: boolean): Promise<Result<Task, AppError>>;
  /** SINGLE-record write: resolves neighbor keys, one `put` of the moved row. */
  move(id: string, target: MoveTarget): Promise<Result<MoveOutcome<Task>, AppError>>;
  /** Tombstone + direct-subtask cascade in ONE transaction; idempotent. */
  remove(id: string): Promise<Result<void, AppError>>;
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
