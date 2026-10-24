/**
 * Task store — the ONE place domain state meets Preact signals (ADR-003 handoff,
 * docs/dev/domain-api.md §3). Components read signals; they never touch IndexedDB
 * or repositories directly.
 *
 * Lifecycle: `startTaskStore()` boots the ADR-002 store, wires the repo ports into a
 * `MutationRunner`, mirrors its state into signals, starts the tab-sync transport and
 * recomputes the local "today" label on day rollover (design D9: `visibilitychange` +
 * a local-midnight timer, no reload). Tests bind a runner built over fake ports with
 * `bindRunnerForTest` and reset with `resetTaskStore()`.
 *
 * Write protocol (design §5.6): every mutation goes through `guard()` —
 *   - the pipeline applies optimistically BEFORE any I/O (the <100 ms perceived path),
 *   - a write not settled after 3 s is reported once via `a11y.saveFailed` (assertive)
 *     with a Retry toast,
 *   - a failed write is reported the same way after the pipeline has rolled the state
 *     back to the last committed image, and `QUOTA_EXCEEDED` is handed to Epic E3's
 *     pending-write queue (§5.5 export/cleanup dialog — typed, never swallowed).
 *
 * The store is the single failure reporter (announce + toast + retry): every UI-originated
 * mutation runs through `guard`, so subscribing to `write-failed` as well would announce
 * and toast the same rollback twice. `MutationRunner`'s `onError` still records every
 * failure branch in the structured error log (ADR-002 §10.4).
 */

import { signal } from '@preact/signals';

import { announce } from '../../app/announce';
import { t } from '../../app/i18n';
import { setListOptions } from '../../app/lists';
import { createTabSync, type TabSync } from '../../app/tabSync';
import { noteFirstMeaningfulWrite } from '../data-safety/persistGate';
import { msUntilNextLocalMidnight, todayStr } from '../../domain/dates';
import { err, ok, type AppError, type Result } from '../../domain/kernel';
import type { List, Priority, Task } from '../../domain/model';
import { MutationRunner } from '../../domain/pipeline';
import type { ListRemoveDisposition, ListPosition, TaskPosition } from '../../domain/ports';
import { emptyState, type State } from '../../domain/state';
import { classifyUnknown } from '../../storage/errors';
import { defaultErrorLog } from '../../storage/errorLog';
import { newUlid } from '../../storage/id';
import { orderKeyBetween, orderKeyFirst } from '../../storage/orderKey';
import { boot } from '../../storage/boot';
import { ListRepo, SettingsRepo, TaskRepo, readRows } from '../../storage/repos';
import { noteWriteFailure } from '../data-safety/pendingWrites';
import { newToastId, pushToast, dismissToast } from './toasts';

/** A write still in flight after this long is reported once (§5.6). */
export const WRITE_SLOW_MS = 3000;

export type StoreStatus = 'idle' | 'loading' | 'ready' | 'error';

export const status = signal<StoreStatus>('idle');
export const bootError = signal<AppError | null>(null);
export const state = signal<State>(emptyState());
/** Local calendar day (`YYYY-MM-DD`) every date selector compares against (D9). */
export const today = signal<string>(todayStr(Date.now));

const clock = (): number => Date.now();

let runner: MutationRunner | null = null;
let unsubscribe: (() => void) | null = null;
let tabSync: TabSync | null = null;
let started = false;
let rolloverTimer: ReturnType<typeof setTimeout> | null = null;
let onVisibility: (() => void) | null = null;

export function getRunner(): MutationRunner | null {
  return runner;
}

/** Live lists in display order (`(sortOrder, id)`), tombstones excluded. */
export function liveLists(s: State = state.value): List[] {
  return [...s.lists.values()]
    .filter((list) => list.deletedAt === null)
    .sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder < b.sortOrder ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

function mirror(next: State): void {
  state.value = next;
  // The shell's sidebar/drawer read list options from `app/lists` (their documented
  // mount point): whoever wires the domain calls setListOptions() whenever lists change.
  setListOptions(liveLists(next).map((list) => ({ id: list.id, name: list.name })));
}

function attach(r: MutationRunner): void {
  runner = r;
  unsubscribe?.();
  unsubscribe = r.subscribe(() => {
    mirror(r.getState());
  });
  mirror(r.getState());
}

/* ------------------------------- day rollover ------------------------------- */

function armMidnight(): void {
  if (rolloverTimer !== null) clearTimeout(rolloverTimer);
  rolloverTimer = setTimeout(
    () => {
      recomputeToday();
    },
    msUntilNextLocalMidnight(clock) + 50,
  );
}

function recomputeToday(): void {
  const next = todayStr(clock);
  if (next !== today.value) today.value = next;
  armMidnight();
}

function armRollover(): void {
  if (onVisibility !== null) return;
  onVisibility = (): void => {
    if (document.visibilityState === 'visible') recomputeToday();
  };
  document.addEventListener('visibilitychange', onVisibility);
  armMidnight();
}

function disarmRollover(): void {
  if (onVisibility !== null) {
    document.removeEventListener('visibilitychange', onVisibility);
    onVisibility = null;
  }
  if (rolloverTimer !== null) {
    clearTimeout(rolloverTimer);
    rolloverTimer = null;
  }
}

/* --------------------------------- boot path -------------------------------- */

/**
 * Boot the store and wire the runner. Idempotent; resolves when the first load
 * attempt has settled (`status` becomes `ready` or `error`).
 */
export async function startTaskStore(): Promise<void> {
  if (started) return;
  started = true;
  status.value = 'loading';
  bootError.value = null;
  armRollover();

  const booted = await boot();
  if (!booted.ok) {
    status.value = 'error';
    bootError.value = booted.error;
    started = false;
    return;
  }

  const db = booted.value;
  const repoDeps = { db, clock, ids: (): string => newUlid(clock()) };
  const taskRepo = new TaskRepo(repoDeps);
  const listRepo = new ListRepo(repoDeps);
  const settingsRepo = new SettingsRepo(repoDeps);

  // The transport needs the runner to exist, and the runner's commit hook needs the
  // transport — a delegating holder breaks the cycle (composition root, domain-api §7).
  let sync: TabSync | null = null;

  const r = new MutationRunner({
    tasks: taskRepo,
    lists: listRepo,
    settings: settingsRepo,
    clock,
    ids: repoDeps.ids,
    orderKeys: { between: orderKeyBetween, first: orderKeyFirst },
    deviceId: db.deviceId,
    onCommitted: (change) => {
      sync?.announce(change);
    },
    onError: (info) => {
      defaultErrorLog.record({
        layer: 'domain',
        op: info.op,
        error: info.error,
        detail: `${info.opId} rolled back: ${info.rolledBack.join(',')}`,
      });
    },
  });
  attach(r);

  sync = createTabSync({
    runner: r,
    reads: {
      loadAll: () => taskRepo.loadAll(),
      getSettings: () => settingsRepo.get(),
      readRows: (taskIds, listIds) => readRows(db, taskIds, listIds),
      tasksChangedSince: (since) => taskRepo.changedSince(since),
      listsChangedSince: (since) => listRepo.changedSince(since),
    },
    clock,
    tabId: newUlid(clock()),
  });
  tabSync = sync;
  sync.start();

  const loaded = await r.load();
  if (!loaded.ok) {
    status.value = 'error';
    bootError.value = loaded.error;
    started = false;
    return;
  }
  status.value = 'ready';
}

/* ------------------------------ test seams ------------------------------ */

/** Bind a runner built over fake ports (component tests). Replaces the boot path. */
export function bindRunnerForTest(r: MutationRunner): void {
  started = true;
  status.value = 'loading';
  armRollover();
  attach(r);
  status.value = 'ready';
}

/** Reset every module-level signal (component tests). */
export function resetTaskStore(): void {
  unsubscribe?.();
  unsubscribe = null;
  runner = null;
  tabSync?.stop();
  tabSync = null;
  started = false;
  disarmRollover();
  status.value = 'idle';
  bootError.value = null;
  state.value = emptyState();
  today.value = todayStr(Date.now);
  setListOptions([]);
}

/* ------------------------------- failure UX ------------------------------- */

/**
 * Report a failed (or pathologically slow) write exactly once: assertive
 * `a11y.saveFailed` + an `error.save.title` toast carrying Retry. Retry re-runs the
 * SAME mutation through a fresh `guard`, so a second failure reports again.
 */
function reportFailure(id: string, rerun: () => void): void {
  announce(t('a11y.saveFailed'), 'assertive');
  pushToast({
    id,
    tone: 'error',
    messageKey: 'error.save.title',
    action: {
      key: 'common.retry',
      run: () => {
        dismissToast(id);
        rerun();
      },
    },
  });
}

async function guard<T>(op: () => Promise<Result<T, AppError>>): Promise<Result<T, AppError>> {
  const id = newToastId();
  // Object holder (not a `let`): the flag flips inside a closure, and TS would
  // otherwise narrow it to `false` in the straight-line flow below.
  const flag = { reported: false };
  const report = (rerun: () => void): void => {
    if (flag.reported) return;
    flag.reported = true;
    reportFailure(id, rerun);
  };
  // Rerun = the same op again, wrapped so a second failure reports again.
  const rerun = (): void => {
    void guard(op);
  };

  const timer = setTimeout(() => {
    report(rerun);
  }, WRITE_SLOW_MS);

  let result: Result<T, AppError>;
  try {
    result = await op();
  } catch (error) {
    // Contract: nothing throws across a seam — classify defensively so a broken
    // adapter still surfaces as feedback instead of a silent dead control.
    clearTimeout(timer);
    result = err(classifyUnknown(error));
  }
  clearTimeout(timer);

  if (result.ok) {
    if (flag.reported) dismissToast(id); // landed late: the warning is obsolete
    return result;
  }
  report(rerun);
  // §5.5: QUOTA_EXCEEDED is typed end-to-end and opens E3's blocking, non-destructive
  // dialog with this write queued for retry — never swallowed, never dropped.
  noteWriteFailure(result.error, t('error.save.title'), async () => (await op()).ok);
  return result;
}

/* ------------------------------- mutations ------------------------------- */

export interface TaskInput {
  readonly title: string;
  readonly notes: string | null;
  readonly dueDate: string | null;
  readonly listId: string;
  readonly priority: Priority;
}

function noRunner(): Promise<Result<never, AppError>> {
  // The store is not booted (or boot failed): report honestly as unavailable.
  return Promise.resolve(err({ code: 'UNAVAILABLE' }));
}

export function addTask(input: TaskInput): Promise<Result<Task, AppError>> {
  const r = runner;
  if (r === null) return noRunner();
  return guard(() =>
    r.createTask({
      listId: input.listId,
      title: input.title,
      notes: input.notes,
      priority: input.priority,
      ...(input.dueDate !== null ? { dueDate: input.dueDate } : {}),
      tags: [],
    }),
  ).then((result) => {
    // E3 §5.5: the first successfully created task IS "first meaningful use" — request
    // navigator.storage.persist() exactly once (fire-and-forget inside; it never blocks or
    // fails this write, and it is what flips the Settings storage row to granted/denied).
    if (result.ok) void noteFirstMeaningfulWrite();
    return result;
  });
}

/**
 * Save every edited field (S4): one field-scoped patch transaction, plus a separate
 * single-record move when the list changed (ADR-003 Decision 4 — a membership change
 * IS a `move`, never a patch). The optimistic apply paints both before any I/O, so the
 * user sees one atomic save; each write rolls back independently on failure.
 */
export async function saveTask(id: string, input: TaskInput): Promise<Result<void, AppError>> {
  const r = runner;
  if (r === null) return noRunner();
  const current = r.getState().tasks.get(id);
  if (current === undefined) {
    return err({ code: 'RULE', rule: 'TASK_MISSING', message: `no task ${id}` });
  }

  const patched = await guard(() =>
    r.patchTask(id, {
      title: input.title,
      notes: input.notes,
      priority: input.priority,
      ...(input.dueDate !== null ? { dueDate: input.dueDate } : { dueDateUnset: true }),
    }),
  );
  if (!patched.ok) return err(patched.error);

  if (input.listId !== current.listId) {
    const moved = await guard(() =>
      r.moveTask(id, {
        group: { listId: input.listId, parentTaskId: null },
        position: 'last',
      }),
    );
    if (!moved.ok) return err(moved.error);
  }
  return ok(undefined);
}

export function deleteTask(id: string): Promise<Result<void, AppError>> {
  const r = runner;
  if (r === null) return noRunner();
  return guard(() => r.removeTask(id));
}

export function setTaskDone(id: string, done: boolean): Promise<Result<Task, AppError>> {
  const r = runner;
  if (r === null) return noRunner();
  return guard(() => r.setDone(id, done));
}

export function addList(input: { name: string; color: string }): Promise<Result<List, AppError>> {
  const r = runner;
  if (r === null) return noRunner();
  return guard(() => r.createList(input));
}

export function renameList(id: string, name: string): Promise<Result<List, AppError>> {
  const r = runner;
  if (r === null) return noRunner();
  return guard(() => r.renameList(id, name));
}

export function recolorList(id: string, color: string): Promise<Result<List, AppError>> {
  const r = runner;
  if (r === null) return noRunner();
  return guard(() => r.recolorList(id, color));
}

/**
 * One task move — the single-record write behind keyboard/menu reorder (§8.2),
 * drag drop (§8.1) and move-to-list (F11). `position` is a `MoveTarget` position
 * (ADR-002 fractional order key): the pipeline mints ONE new order key and the
 * repo persists ONE record — never a renumbering transaction (§5.7).
 */
export function moveTaskTo(
  id: string,
  listId: string,
  position: TaskPosition,
): Promise<Result<Task, AppError>> {
  const r = runner;
  if (r === null) return noRunner();
  return guard(() => r.moveTask(id, { group: { listId, parentTaskId: null }, position }));
}

/** `delta` = ±1 along the list order; boundary moves reject so callers can announce. */
export function moveList(id: string, delta: -1 | 1): Promise<Result<List, AppError>> {
  const r = runner;
  if (r === null) return noRunner();
  const all = liveLists(r.getState());
  const index = all.findIndex((list) => list.id === id);
  if (index < 0) {
    return Promise.resolve(err({ code: 'RULE', rule: 'TASK_MISSING', message: `no list ${id}` }));
  }
  if ((delta === -1 && index === 0) || (delta === 1 && index === all.length - 1)) {
    return Promise.resolve(
      err({ code: 'RULE', rule: 'REORDER_TARGET_NOT_IN_GROUP', message: 'boundary' }),
    );
  }
  const position: ListPosition =
    delta === -1
      ? index === 1
        ? 'first'
        : { afterId: all[index - 2]?.id ?? '' }
      : { afterId: all[index + 1]?.id ?? '' };
  return guard(() => r.moveList(id, position));
}

/** Is a list move of `delta` possible? (menu items `aria-disable` themselves at ends) */
export function canMoveList(id: string, delta: -1 | 1): boolean {
  const all = liveLists();
  const index = all.findIndex((list) => list.id === id);
  if (index < 0) return false;
  return delta === -1 ? index > 0 : index < all.length - 1;
}

export function removeList(
  id: string,
  disposition: ListRemoveDisposition,
): Promise<Result<void, AppError>> {
  const r = runner;
  if (r === null) return noRunner();
  return guard(() => r.removeList(id, disposition));
}
