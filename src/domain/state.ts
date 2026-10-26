/**
 * In-memory state + pure transitions (ADR-003 Decision 3.1).
 *
 * One immutable `State` snapshot (maps + version); every transition is a pure
 * function so rollback is a data operation, never a side-effect undo. `Undo`
 * carries the before-images of EXACTLY the records an op touched — record-scoped
 * so rolling one op back can never clobber another record's changes.
 */

import type { AppError } from './kernel';
import type { List, Settings, Task } from './model';

export type MutationKind =
  | 'create-task'
  | 'patch-task'
  | 'set-done'
  | 'move-task'
  | 'remove-task'
  | 'restore-tasks'
  | 'sweep-tag'
  | 'upsert-imported'
  | 'create-list'
  | 'rename-list'
  | 'recolor-list'
  | 'move-list'
  | 'remove-list'
  | 'update-settings';

/** `pending` value: recordId -> in-flight op (UI affordances). */
export type PendingOp = {
  opId: string;
  kind: MutationKind;
  since: number;
};

export type State = {
  version: number;
  tasks: ReadonlyMap<string, Task>;
  lists: ReadonlyMap<string, List>;
  settings: Settings | null;
  pending: ReadonlyMap<string, PendingOp>;
};

export type ChangeEvent =
  | { kind: 'records'; taskIds: string[]; listIds: string[]; settings: boolean }
  | { kind: 'settled'; opId: string }
  | { kind: 'write-failed'; opId: string; error: AppError; rolledBack: string[] };

/**
 * One change batch. Upserts replace the keyed record; `evictTasks`/`evictLists`
 * remove records (tombstoned/missing rows); `settings` present (incl. `null`)
 * replaces the settings record. The same shape serves optimistic applies and
 * external (tab-sync) reconciliation.
 */
export type RecordUpdate = {
  tasks?: readonly Task[];
  lists?: readonly List[];
  evictTasks?: readonly string[];
  evictLists?: readonly string[];
  settings?: Settings | null;
};

/** Before-images of the touched records; `undefined` = the record was absent. */
export type Undo = {
  tasks: Map<string, Task | undefined>;
  lists: Map<string, List | undefined>;
  settings: Settings | undefined | null;
};

export function emptyState(): State {
  return {
    version: 0,
    tasks: new Map(),
    lists: new Map(),
    settings: null,
    pending: new Map(),
  };
}

/** The `records` ChangeEvent for a batch (ids actually touched). */
export function recordsEvent(update: RecordUpdate): ChangeEvent {
  return {
    kind: 'records',
    taskIds: [...(update.tasks ?? []).map((t) => t.id), ...(update.evictTasks ?? [])],
    listIds: [...(update.lists ?? []).map((l) => l.id), ...(update.evictLists ?? [])],
    settings: update.settings !== undefined,
  };
}

/** All record ids a batch touches (used for per-record op tracking). */
export function touchedIds(update: RecordUpdate): string[] {
  return [
    ...(update.tasks ?? []).map((t) => t.id),
    ...(update.lists ?? []).map((l) => l.id),
    ...(update.evictTasks ?? []),
    ...(update.evictLists ?? []),
  ];
}

export type ApplyResult = { next: State; undo: Undo };

/**
 * Pure apply (optimistic or authoritative): upsert every listed record, evict
 * every listed id. Returns record-scoped undo info (before-images) so `revert`
 * restores exactly what this batch touched.
 */
export function applyOptimistic(state: State, update: RecordUpdate): ApplyResult {
  const tasks = new Map(state.tasks);
  const lists = new Map(state.lists);
  const undo: Undo = {
    tasks: new Map<string, Task | undefined>(),
    lists: new Map<string, List | undefined>(),
    settings: null,
  };

  for (const t of update.tasks ?? []) {
    undo.tasks.set(t.id, tasks.get(t.id));
    tasks.set(t.id, t);
  }
  for (const id of update.evictTasks ?? []) {
    undo.tasks.set(id, tasks.get(id));
    tasks.delete(id);
  }
  for (const l of update.lists ?? []) {
    undo.lists.set(l.id, lists.get(l.id));
    lists.set(l.id, l);
  }
  for (const id of update.evictLists ?? []) {
    undo.lists.set(id, lists.get(id));
    lists.delete(id);
  }
  let settings = state.settings;
  if (update.settings !== undefined) {
    undo.settings = state.settings === null ? undefined : state.settings;
    settings = update.settings;
  }

  return {
    next: {
      version: state.version + 1,
      tasks,
      lists,
      settings,
      pending: state.pending,
    },
    undo,
  };
}

/** Restore the before-images in `undo` (record-scoped; other changes survive). */
export function revert(state: State, undo: Undo): State {
  const tasks = new Map(state.tasks);
  const lists = new Map(state.lists);
  for (const [id, before] of undo.tasks) {
    if (before === undefined) tasks.delete(id);
    else tasks.set(id, before);
  }
  for (const [id, before] of undo.lists) {
    if (before === undefined) lists.delete(id);
    else lists.set(id, before);
  }
  const settings =
    undo.settings === null ? state.settings : undo.settings === undefined ? null : undo.settings;
  return {
    version: state.version + 1,
    tasks,
    lists,
    settings,
    pending: state.pending,
  };
}

/** Set/clear `pending` entries (one recordId -> one in-flight op). */
export function withPending(
  state: State,
  entries: readonly (readonly [string, PendingOp | null])[],
): State {
  const pending = new Map(state.pending);
  for (const [id, op] of entries) {
    if (op === null) pending.delete(id);
    else pending.set(id, op);
  }
  return { ...state, version: state.version + 1, pending };
}
