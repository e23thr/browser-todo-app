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

export interface TaskPort {
  loadAll(): Promise<Result<{ tasks: Task[]; lists: List[]; settings: Settings }, AppError>>;
  create(draft: TaskDraft): Promise<Result<Task, AppError>>;
  patch(id: string, patch: TaskPatch): Promise<Result<Task, AppError>>;
  /** `completedAt` stamped on done, cleared on uncomplete (ADR-002 Decision 5). */
  setDone(id: string, done: boolean): Promise<Result<Task, AppError>>;
  /** SINGLE-record write: resolves neighbor keys, one `put` of the moved row. */
  move(id: string, target: MoveTarget): Promise<Result<Task, AppError>>;
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
  move(id: string, position: ListPosition): Promise<Result<List, AppError>>;
  /** ADR-002 Decision 6 verbatim: move tasks or tombstone them — ONE transaction either way. */
  remove(id: string, disposition: ListRemoveDisposition): Promise<Result<void, AppError>>;
}

export interface SettingsPort {
  get(): Promise<Result<Settings, AppError>>;
  update(patch: Partial<Omit<Settings, 'id'>>): Promise<Result<Settings, AppError>>;
}
