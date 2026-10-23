/**
 * Optimistic write pipeline (ADR-003 Decision 3).
 *
 * Normative order for EVERY mutation (add / complete / reorder / edit / delete):
 *
 *   1. APPLY   pure `applyOptimistic` computes next State + undo info
 *   2. NOTIFY  state committed + listeners notified SYNCHRONOUSLY (no await
 *              before this point) -> paint. This is the <100ms perceived path.
 *   3. WRITE   repo call (async), serialized (one FIFO write queue = per-record
 *              serialization in submission order, plus multi-record ops stay
 *              ordered against single-record ones)
 *   4a. OK     the authoritative record REPLACES the provisional entry (stamps
 *              are authoritative from the repo); notify `records` + `settled`
 *   4b. FAIL   cancel queued ops for the affected ids -> restore the last
 *              COMMITTED baseline -> notify `write-failed` with the AppError
 *
 * Rollback invariant: after any failure, every affected record equals its last
 * committed (authoritative) image — never a provisional one. Queued ops on the
 * affected ids are cancelled "because their baseline is now invalid"
 * (deterministic and tested); each rolled-back op gets its own `write-failed`.
 */

import { err, ok, ruleError, type AppError, type Result } from './kernel';
import {
  DEFAULT_SETTINGS,
  type List,
  type Settings,
  type Task,
  type TaskDraft,
  type TaskPatch,
} from './model';
import type {
  Clock,
  IdFactory,
  ListPort,
  ListPosition,
  ListRemoveDisposition,
  MoveTarget,
  OrderKeyOps,
  SettingsPort,
  TaskPort,
} from './ports';
import {
  applyOptimistic,
  emptyState,
  recordsEvent,
  revert,
  touchedIds,
  withPending,
  type ChangeEvent,
  type MutationKind,
  type RecordUpdate,
  type State,
} from './state';
import type { ChangeSet } from './sync';

export type PipelineErrorInfo = {
  op: MutationKind;
  opId: string;
  error: AppError;
  rolledBack: string[];
};

export type MutationRunnerDeps = {
  tasks: TaskPort;
  lists: ListPort;
  settings: SettingsPort;
  clock: Clock;
  ids: IdFactory;
  orderKeys: OrderKeyOps;
  deviceId: string;
  /** Wired by `app/tabSync.ts`: fired AFTER a write commits, never on failure. */
  onCommitted?: (change: ChangeSet) => void;
  /** Structured local error log (ADR-002 §10.4) — every error branch records. */
  onError?: (info: PipelineErrorInfo) => void;
};

type EntryStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

type Entry = {
  opId: string;
  kind: MutationKind;
  ids: string[];
  change: ChangeSet;
  undo: ReturnType<typeof applyOptimistic>['undo'];
  status: EntryStatus;
  resolve: (r: Result<unknown, AppError>) => void;
};

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function byOrder(
  a: { sortOrder: string; id: string },
  b: { sortOrder: string; id: string },
): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder < b.sortOrder ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function refIdOf(
  position: 'first' | 'last' | { afterId: string } | { beforeId: string },
): string | null {
  if (typeof position !== 'object') return null;
  return 'afterId' in position ? position.afterId : position.beforeId;
}

/** `Result<void, E>` -> `Result<undefined, E>` (the ports' void-op seam). */
function asUndefined(r: Result<void, AppError>): Result<undefined, AppError> {
  return r.ok ? ok(undefined) : err(r.error);
}

function omit<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  const rest: Partial<T> = {};
  for (const k of Object.keys(obj) as (keyof T)[]) {
    if (k !== key) rest[k] = obj[k];
  }
  return rest as Omit<T, K>;
}

export class MutationRunner {
  readonly #deps: MutationRunnerDeps;
  #state: State = emptyState();
  #listeners = new Set<(ev: ChangeEvent) => void>();
  /** Application-ordered live ops (optimistic applied, not yet finalized). */
  #live: Entry[] = [];
  /** Last committed (authoritative) image per record — the rollback baseline. */
  #committedTasks = new Map<string, Task>();
  #committedLists = new Map<string, List>();
  #committedSettings: Settings | null = null;
  #queue: Promise<void> = Promise.resolve();
  #opCounter = 0;

  constructor(deps: MutationRunnerDeps) {
    this.#deps = deps;
  }

  getState(): State {
    return this.#state;
  }

  subscribe(listener: (ev: ChangeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Initial load: replace state wholesale from the repos (committed truth). */
  async load(): Promise<Result<void, AppError>> {
    const loaded = await this.#deps.tasks.loadAll();
    if (!loaded.ok) {
      this.#recordError('create-task', 'load', loaded.error, []);
      return err(loaded.error);
    }
    const update: RecordUpdate = {
      tasks: loaded.value.tasks,
      lists: loaded.value.lists,
      settings: loaded.value.settings,
    };
    this.applyExternal(update);
    return ok(undefined);
  }

  /**
   * External refresh (tab sync / watermark sweep). State only — never writes
   * anywhere, never triggers `onCommitted` (receivers don't rebroadcast).
   */
  applyExternal(update: RecordUpdate): void {
    const { next } = applyOptimistic(this.#state, update);
    this.#state = next;
    this.#rememberCommitted(update);
    this.#emit(recordsEvent(update));
  }

  /* ------------------------------ task ops ------------------------------ */

  createTask(draft: TaskDraft): Promise<Result<Task, AppError>> {
    const opId = this.#nextOpId();
    const parent = draft.parentTaskId;
    if (parent !== undefined) {
      const parentTask = this.#state.tasks.get(parent);
      if (parentTask !== undefined && parentTask.parentTaskId !== undefined) {
        return this.#rejectSync(
          'create-task',
          opId,
          'PARENT_DEPTH_EXCEEDED',
          'subtasks cannot nest',
        );
      }
    }
    const now = this.#deps.clock();
    const task: Task = {
      id: this.#deps.ids(),
      listId: draft.listId,
      title: draft.title,
      notes: draft.notes,
      status: 'open',
      priority: draft.priority,
      ...(draft.dueDate !== undefined ? { dueDate: draft.dueDate } : {}),
      tags: [...draft.tags],
      ...(parent !== undefined ? { parentTaskId: parent } : {}),
      sortOrder: this.#provisionalKeyFor(draft.listId, parent),
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deviceId: this.#deps.deviceId,
    };
    return this.#run<Task>(
      'create-task',
      opId,
      { tasks: [task] },
      { tasks: [task.id] },
      async () => this.#deps.tasks.create({ ...draft, id: task.id }),
      (created) => ({ tasks: [created] }),
    );
  }

  patchTask(id: string, patch: TaskPatch): Promise<Result<Task, AppError>> {
    const opId = this.#nextOpId();
    const prev = this.#state.tasks.get(id);
    if (prev === undefined) {
      return this.#rejectSync('patch-task', opId, 'TASK_MISSING', `no task ${id}`);
    }
    const next: Task = {
      ...prev,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate } : {}),
      ...(patch.tags !== undefined ? { tags: [...patch.tags] } : {}),
      ...(patch.reminderAt !== undefined ? { reminderAt: patch.reminderAt } : {}),
      ...(patch.recurrence !== undefined ? { recurrence: patch.recurrence } : {}),
      updatedAt: this.#deps.clock(),
      deviceId: this.#deps.deviceId,
    };
    const cleared = patch.dueDateUnset === true ? omit(next, 'dueDate') : next;
    return this.#run<Task>(
      'patch-task',
      opId,
      { tasks: [cleared] },
      { tasks: [id] },
      async () => this.#deps.tasks.patch(id, patch),
      (saved) => ({ tasks: [saved] }),
    );
  }

  setDone(id: string, done: boolean): Promise<Result<Task, AppError>> {
    const opId = this.#nextOpId();
    const prev = this.#state.tasks.get(id);
    if (prev === undefined) {
      return this.#rejectSync('set-done', opId, 'TASK_MISSING', `no task ${id}`);
    }
    const now = this.#deps.clock();
    const stamped = { ...prev, updatedAt: now, deviceId: this.#deps.deviceId };
    const next: Task = done
      ? { ...stamped, status: 'done', completedAt: now }
      : omit({ ...stamped, status: 'open' as const }, 'completedAt');
    return this.#run<Task>(
      'set-done',
      opId,
      { tasks: [next] },
      { tasks: [id] },
      async () => this.#deps.tasks.setDone(id, done),
      (saved) => ({ tasks: [saved] }),
    );
  }

  moveTask(id: string, target: MoveTarget): Promise<Result<Task, AppError>> {
    const opId = this.#nextOpId();
    const prev = this.#state.tasks.get(id);
    if (prev === undefined) {
      return this.#rejectSync('move-task', opId, 'TASK_MISSING', `no task ${id}`);
    }
    const parentId: string | undefined = target.group.parentTaskId ?? undefined;
    if (parentId !== undefined) {
      const parentTask = this.#state.tasks.get(parentId);
      if (parentTask !== undefined && parentTask.parentTaskId !== undefined) {
        return this.#rejectSync('move-task', opId, 'PARENT_DEPTH_EXCEEDED', 'subtasks cannot nest');
      }
    }
    const group = this.#groupRows(target.group, id);
    const refId = refIdOf(target.position);
    if (refId !== null && !group.some((t) => t.id === refId)) {
      return this.#rejectSync(
        'move-task',
        opId,
        'REORDER_TARGET_NOT_IN_GROUP',
        `${refId} is not in the declared sibling group`,
      );
    }
    const { prevKey, nextKey } = this.#neighborsAround(group, id, target.position);
    let sortOrder = prev.sortOrder;
    try {
      sortOrder = this.#deps.orderKeys.between(prevKey, nextKey);
    } catch {
      // Provisional key could not be minted (pathological adjacency): keep the
      // current key — the repo recomputes authoritatively and may rebalance.
    }
    const next: Task = {
      ...prev,
      listId: target.group.listId,
      sortOrder,
      updatedAt: this.#deps.clock(),
      deviceId: this.#deps.deviceId,
    };
    if (parentId !== undefined) next.parentTaskId = parentId;
    else delete next.parentTaskId;
    return this.#run<Task>(
      'move-task',
      opId,
      { tasks: [next] },
      { tasks: [id] },
      async () => this.#deps.tasks.move(id, target),
      (saved) => ({ tasks: [saved] }),
    );
  }

  removeTask(id: string): Promise<Result<void, AppError>> {
    const opId = this.#nextOpId();
    const prev = this.#state.tasks.get(id);
    if (prev === undefined) {
      return this.#rejectSync('remove-task', opId, 'TASK_MISSING', `no task ${id}`);
    }
    const childIds = [...this.#state.tasks.values()]
      .filter((t) => t.parentTaskId === id)
      .map((t) => t.id);
    return this.#run<undefined>(
      'remove-task',
      opId,
      { evictTasks: [id, ...childIds] },
      { tasks: [id, ...childIds] },
      async () => asUndefined(await this.#deps.tasks.remove(id)),
      () => ({}),
    );
  }

  /** M11 import path: rows keep their original stamps. */
  upsertImported(rows: Task[]): Promise<Result<void, AppError>> {
    const opId = this.#nextOpId();
    return this.#run<undefined>(
      'upsert-imported',
      opId,
      { tasks: rows },
      { tasks: rows.map((t) => t.id) },
      async () => asUndefined(await this.#deps.tasks.upsertImported(rows)),
      () => ({ tasks: rows }),
    );
  }

  /* ------------------------------ list ops ------------------------------ */

  createList(input: { name: string; color: string }): Promise<Result<List, AppError>> {
    const opId = this.#nextOpId();
    const now = this.#deps.clock();
    const lists = [...this.#state.lists.values()].filter((l) => l.deletedAt === null).sort(byOrder);
    let sortOrder = 'h';
    try {
      sortOrder = this.#deps.orderKeys.between(lists.at(-1)?.sortOrder ?? null, null);
    } catch {
      sortOrder = this.#deps.orderKeys.first();
    }
    const list: List = {
      id: this.#deps.ids(),
      name: input.name,
      color: input.color,
      sortOrder,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deviceId: this.#deps.deviceId,
    };
    return this.#run<List>(
      'create-list',
      opId,
      { lists: [list] },
      { lists: [list.id] },
      async () => this.#deps.lists.create({ ...input, id: list.id }),
      (created) => ({ lists: [created] }),
    );
  }

  renameList(id: string, name: string): Promise<Result<List, AppError>> {
    return this.#patchList('rename-list', id, { name });
  }

  recolorList(id: string, color: string): Promise<Result<List, AppError>> {
    return this.#patchList('recolor-list', id, { color });
  }

  moveList(id: string, position: ListPosition): Promise<Result<List, AppError>> {
    const opId = this.#nextOpId();
    const prev = this.#state.lists.get(id);
    if (prev === undefined) {
      return this.#rejectSync('move-list', opId, 'TASK_MISSING', `no list ${id}`);
    }
    const group = [...this.#state.lists.values()]
      .filter((l) => l.deletedAt === null && l.id !== id)
      .sort(byOrder);
    const refId = refIdOf(position);
    if (refId !== null && !group.some((l) => l.id === refId)) {
      return this.#rejectSync(
        'move-list',
        opId,
        'REORDER_TARGET_NOT_IN_GROUP',
        `${refId} is not in the list group`,
      );
    }
    const { prevKey, nextKey } = this.#neighborsAround(group, id, position);
    let sortOrder = prev.sortOrder;
    try {
      sortOrder = this.#deps.orderKeys.between(prevKey, nextKey);
    } catch {
      // Repo recomputes authoritatively (see moveTask).
    }
    const next: List = {
      ...prev,
      sortOrder,
      updatedAt: this.#deps.clock(),
      deviceId: this.#deps.deviceId,
    };
    return this.#run<List>(
      'move-list',
      opId,
      { lists: [next] },
      { lists: [id] },
      async () => this.#deps.lists.move(id, position),
      (saved) => ({ lists: [saved] }),
    );
  }

  removeList(id: string, disposition: ListRemoveDisposition): Promise<Result<void, AppError>> {
    const opId = this.#nextOpId();
    const prev = this.#state.lists.get(id);
    if (prev === undefined) {
      // Idempotent: removing an already-gone list is a no-op (ADR-002 Decision 6).
      return Promise.resolve(ok(undefined));
    }
    const affected = [...this.#state.tasks.values()].filter((t) => t.listId === id);
    if (disposition.mode === 'move') {
      const target = this.#state.lists.get(disposition.targetListId);
      if (target === undefined || target.deletedAt !== null || disposition.targetListId === id) {
        return this.#rejectSync(
          'remove-list',
          opId,
          'LIST_DELETE_TARGET_MISSING',
          `bad move target ${disposition.targetListId}`,
        );
      }
      const now = this.#deps.clock();
      const moved = affected.map((t) => ({
        ...t,
        listId: disposition.targetListId,
        updatedAt: now,
        deviceId: this.#deps.deviceId,
      }));
      return this.#run<undefined>(
        'remove-list',
        opId,
        { evictLists: [id], tasks: moved },
        { lists: [id], tasks: moved.map((t) => t.id) },
        async () => asUndefined(await this.#deps.lists.remove(id, disposition)),
        () => ({}),
      );
    }
    return this.#run<undefined>(
      'remove-list',
      opId,
      { evictLists: [id], evictTasks: affected.map((t) => t.id) },
      { lists: [id], tasks: affected.map((t) => t.id) },
      async () => asUndefined(await this.#deps.lists.remove(id, disposition)),
      () => ({}),
    );
  }

  /* ---------------------------- settings ops ---------------------------- */

  updateSettings(patch: Partial<Omit<Settings, 'id'>>): Promise<Result<Settings, AppError>> {
    const opId = this.#nextOpId();
    const next: Settings = { ...(this.#state.settings ?? DEFAULT_SETTINGS), ...patch };
    return this.#run<Settings>(
      'update-settings',
      opId,
      { settings: next },
      { settings: true },
      async () => this.#deps.settings.update(patch),
      (saved) => ({ settings: saved }),
    );
  }

  /* ------------------------------ internals ------------------------------ */

  #patchList(
    kind: MutationKind,
    id: string,
    patch: { name?: string; color?: string },
  ): Promise<Result<List, AppError>> {
    const opId = this.#nextOpId();
    const prev = this.#state.lists.get(id);
    if (prev === undefined) {
      return this.#rejectSync(kind, opId, 'TASK_MISSING', `no list ${id}`);
    }
    const next: List = {
      ...prev,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
      updatedAt: this.#deps.clock(),
      deviceId: this.#deps.deviceId,
    };
    return this.#run<List>(
      kind,
      opId,
      { lists: [next] },
      { lists: [id] },
      async () =>
        patch.name !== undefined
          ? this.#deps.lists.rename(id, patch.name)
          : this.#deps.lists.recolor(id, patch.color ?? prev.color),
      (saved) => ({ lists: [saved] }),
    );
  }

  #nextOpId(): string {
    this.#opCounter += 1;
    return `op-${String(this.#opCounter)}-${String(this.#deps.clock())}`;
  }

  #emit(ev: ChangeEvent): void {
    for (const listener of [...this.#listeners]) listener(ev);
  }

  #recordError(kind: MutationKind, opId: string, error: AppError, rolledBack: string[]): void {
    this.#deps.onError?.({ op: kind, opId, error, rolledBack });
  }

  #rejectSync<T>(
    kind: MutationKind,
    opId: string,
    rule:
      | 'PARENT_DEPTH_EXCEEDED'
      | 'REORDER_TARGET_NOT_IN_GROUP'
      | 'LIST_DELETE_TARGET_MISSING'
      | 'TASK_MISSING',
    message: string,
  ): Promise<Result<T, AppError>> {
    const error = ruleError(rule, message);
    this.#recordError(kind, opId, error, []);
    return Promise.resolve(err(error));
  }

  #rememberCommitted(update: RecordUpdate): void {
    for (const t of update.tasks ?? []) this.#committedTasks.set(t.id, t);
    for (const id of update.evictTasks ?? []) this.#committedTasks.delete(id);
    for (const l of update.lists ?? []) this.#committedLists.set(l.id, l);
    for (const id of update.evictLists ?? []) this.#committedLists.delete(id);
    if (update.settings !== undefined) this.#committedSettings = update.settings;
  }

  /**
   * The pipeline core. Optimistic apply happens SYNCHRONOUSLY (steps 1-2); the
   * write is queued (step 3) and settles into swap-or-rollback (step 4).
   */
  #run<TReturn>(
    kind: MutationKind,
    opId: string,
    optimistic: RecordUpdate,
    change: ChangeSet,
    write: () => Promise<Result<TReturn, AppError>>,
    settle: (value: TReturn) => RecordUpdate,
  ): Promise<Result<TReturn, AppError>> {
    // Steps 1-2: pure apply + synchronous notify (no await before this point).
    const { next, undo } = applyOptimistic(this.#state, optimistic);
    const pendingEntries = touchedIds(optimistic).map(
      (id) => [id, { opId, kind, since: this.#deps.clock() }] as const,
    );
    this.#state = withPending(next, pendingEntries);
    this.#emit(recordsEvent(optimistic));

    const d = deferred<Result<TReturn, AppError>>();
    const entry: Entry = {
      opId,
      kind,
      ids: touchedIds(optimistic),
      change,
      undo,
      status: 'queued',
      resolve: (r) => {
        d.resolve(r as Result<TReturn, AppError>);
      },
    };
    this.#live.push(entry);

    // Step 3: serialized write (FIFO = per-record submission order).
    this.#queue = this.#queue.then(async () => {
      if (entry.status === 'cancelled') return;
      entry.status = 'running';
      const result = await write();
      if (result.ok) {
        // Step 4a: authoritative swap, then settle notification.
        entry.status = 'done';
        this.#live = this.#live.filter((e) => e !== entry);
        const authoritative = settle(result.value);
        this.#applyAuthoritative(authoritative);
        this.#clearPending(entry);
        this.#rememberCommitted(authoritative);
        this.#emit(recordsEvent(authoritative));
        this.#emit({ kind: 'settled', opId });
        this.#deps.onCommitted?.(change);
        entry.resolve(result);
      } else {
        // Step 4b: cancel queued ops on the affected ids, roll back, report.
        this.#rollbackFrom(entry, result.error);
        entry.resolve(result);
      }
    });
    return d.promise;
  }

  /** Step 4a helper: authoritative records replace provisional entries. */
  #applyAuthoritative(update: RecordUpdate): void {
    const { next } = applyOptimistic(this.#state, update);
    this.#state = next;
  }

  #clearPending(entry: Entry): void {
    this.#state = withPending(
      this.#state,
      entry.ids.map((id) => [id, null] as const),
    );
  }

  /**
   * Step 4b: roll back `failed` plus every queued op sharing its ids (their
   * baseline is now invalid), in REVERSE application order, then re-anchor every
   * affected record to its last committed image. Each rolled-back op emits its
   * own `write-failed` and resolves `err`.
   */
  #rollbackFrom(failed: Entry, error: AppError): void {
    const affected = new Set(failed.ids);
    const cancelled = this.#live.filter(
      (e) => e !== failed && e.status === 'queued' && e.ids.some((id) => affected.has(id)),
    );
    const rolledBack = [...cancelled].reverse();
    rolledBack.push(failed);

    const allIds: string[] = [];
    for (const entry of rolledBack) {
      entry.status = entry === failed ? 'failed' : 'cancelled';
      this.#state = revert(this.#state, entry.undo);
      allIds.push(...entry.ids);
    }
    this.#live = this.#live.filter((e) => !rolledBack.includes(e));

    // Re-anchor to the committed baseline (never a provisional image).
    const unique = [...new Set(allIds)];
    const reAnchor: RecordUpdate = { evictTasks: [], evictLists: [] };
    const tasks = [];
    const lists = [];
    for (const id of unique) {
      const task = this.#committedTasks.get(id);
      const list = this.#committedLists.get(id);
      if (task !== undefined) tasks.push(task);
      else if (list !== undefined) lists.push(list);
      else if (this.#state.tasks.has(id)) (reAnchor.evictTasks as string[]).push(id);
      else if (this.#state.lists.has(id)) (reAnchor.evictLists as string[]).push(id);
    }
    if (tasks.length > 0) reAnchor.tasks = tasks;
    if (lists.length > 0) reAnchor.lists = lists;
    if (this.#committedSettings !== null || this.#state.settings !== null) {
      // Settings touched by a rolled-back op restore to committed (or absent).
      const touchedSettings = rolledBack.some((e) => e.change.settings === true);
      if (touchedSettings) reAnchor.settings = this.#committedSettings;
    }
    if (
      (reAnchor.tasks?.length ?? 0) > 0 ||
      (reAnchor.lists?.length ?? 0) > 0 ||
      (reAnchor.evictTasks?.length ?? 0) > 0 ||
      (reAnchor.evictLists?.length ?? 0) > 0 ||
      reAnchor.settings !== undefined
    ) {
      this.#applyAuthoritative(reAnchor);
    }

    this.#state = withPending(
      this.#state,
      unique.map((id) => [id, null] as const),
    );

    for (const entry of rolledBack) {
      this.#emit({
        kind: 'write-failed',
        opId: entry.opId,
        error,
        rolledBack: entry.ids,
      });
      this.#recordError(entry.kind, entry.opId, error, entry.ids);
      if (entry !== failed) entry.resolve(err(error));
    }
  }

  /* ------------------------- optimistic helpers ------------------------- */

  /** Sibling group rows (live, excluding `excludeId`) in `(sortOrder, id)` order. */
  #groupRows(group: { listId: string; parentTaskId: string | null }, excludeId: string): Task[] {
    return [...this.#state.tasks.values()]
      .filter(
        (t) =>
          t.id !== excludeId &&
          t.deletedAt === null &&
          t.listId === group.listId &&
          (group.parentTaskId === null
            ? t.parentTaskId === undefined
            : t.parentTaskId === group.parentTaskId),
      )
      .sort(byOrder);
  }

  /** Provisional order key for a new task appended at the end of its group. */
  #provisionalKeyFor(listId: string, parentTaskId: string | undefined): string {
    const group = this.#groupRows({ listId, parentTaskId: parentTaskId ?? null }, '');
    try {
      return this.#deps.orderKeys.between(group.at(-1)?.sortOrder ?? null, null);
    } catch {
      return this.#deps.orderKeys.first();
    }
  }

  /** Neighbors of the insertion position among `group` (excluding `id`). */
  #neighborsAround(
    group: readonly { id: string; sortOrder: string }[],
    id: string,
    position: 'first' | 'last' | { afterId: string } | { beforeId: string },
  ): { prevKey: string | null; nextKey: string | null } {
    const rows = group.filter((t) => t.id !== id);
    if (position === 'first') {
      return { prevKey: null, nextKey: rows[0]?.sortOrder ?? null };
    }
    if (position === 'last') {
      return { prevKey: rows.at(-1)?.sortOrder ?? null, nextKey: null };
    }
    const refId = refIdOf(position) as string;
    const at = rows.findIndex((t) => t.id === refId);
    if ('afterId' in position) {
      const ref = rows[at];
      return {
        prevKey: ref?.sortOrder ?? null,
        nextKey: rows[at + 1]?.sortOrder ?? null,
      };
    }
    return {
      prevKey: at > 0 ? (rows[at - 1]?.sortOrder ?? null) : null,
      nextKey: rows[at]?.sortOrder ?? null,
    };
  }
}
