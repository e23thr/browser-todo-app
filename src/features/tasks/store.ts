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
import { noteTaskCreated } from '../install/installPrompt';
import { msUntilNextLocalMidnight, todayStr } from '../../domain/dates';
import { err, ok, type AppError, type Result } from '../../domain/kernel';
import type { List, Priority, Recurrence, Settings, Task } from '../../domain/model';
import { MutationRunner, type SetDoneOutcome } from '../../domain/pipeline';
import type {
  ListRemoveDisposition,
  ListPosition,
  RestoreOutcome,
  TaskPosition,
  TaskRemoveDisposition,
} from '../../domain/ports';
import { emptyState, type State } from '../../domain/state';
import { classifyUnknown } from '../../storage/errors';
import { defaultErrorLog } from '../../storage/errorLog';
import { newUlid } from '../../storage/id';
import { orderKeyBetween, orderKeyFirst } from '../../storage/orderKey';
import { boot, resetBootSingleton } from '../../storage/boot';
import { ListRepo, SettingsRepo, TaskRepo, readRows } from '../../storage/repos';
import { noteWriteFailure } from '../data-safety/pendingWrites';
import { newToastId, pushToast, dismissToast } from './toasts';

/**
 * In-flight `guard()` slow-write report timers (§5.6).
 *
 * They are module-level state like the signals `resetTaskStore()` clears: a probe that
 * leaves a never-settling write (the `hangWrites` fixture) arms one that would otherwise
 * fire during a LATER test — pushing a bogus toast AND bumping the global announce token,
 * which swallows that test's pending polite message (the intermittent E2 gate failure
 * `expected '' to be 'List "Scratch" deleted (2 tasks)'`).
 */
const reportTimers = new Set<ReturnType<typeof setTimeout>>();

/** A write still in flight after this long is reported once (§5.6). */
export const WRITE_SLOW_MS = 3000;

export type StoreStatus = 'idle' | 'loading' | 'ready' | 'error';

export const status = signal<StoreStatus>('idle');
export const bootError = signal<AppError | null>(null);
export const state = signal<State>(emptyState());
/** Local calendar day (`YYYY-MM-DD`) every date selector compares against (D9). */
export const today = signal<string>(todayStr(Date.now));
/**
 * Last list a task was actually created or saved into (F1.4 / §16-14: the composer's
 * default is `defaultListId`, else THIS list, else the first live one). Session-scoped —
 * persisting it belongs to the domain `Settings` record, which is not this card's scope.
 */
export const lastUsedListId = signal<string | null>(null);
/**
 * S1 tag filter for the task views (session-scoped): `null` = show everything.
 * Lives here so the choice survives view switches (and resets with the store).
 */
export const tagFilter = signal<string | null>(null);
/**
 * S3 view sort mode (session-scoped): `'manual'` is the pinned per-view order,
 * `'priority'` sorts every group `P1` first (and disables manual reorder).
 */
export const sortMode = signal<'manual' | 'priority'>('manual');

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

export type TagUsage = { readonly name: string; readonly count: number };

/**
 * Every tag in use on live tasks (excluding tombstoned rows), alphabetical,
 * with usage counts — the S1 filter chips / manage dialog read this.
 */
export function allTags(s: State = state.value): TagUsage[] {
  const counts = new Map<string, number>();
  for (const task of s.tasks.values()) {
    if (task.deletedAt !== null) continue;
    for (const tag of task.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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

/**
 * Reset every module-level signal (component tests).
 *
 * Also disarms any in-flight `guard()` slow-write report (see `reportTimers`): those
 * timers are module state just like the signals, and a probe that leaves a never-settling
 * write must not report — or cancel another test's announcement — after its own test ended.
 */
export function resetTaskStore(): void {
  for (const timer of reportTimers) clearTimeout(timer);
  reportTimers.clear();
  dropUndoOffer(); // the S7 undo window must not outlive its store (or test)
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
  lastUsedListId.value = null;
  tagFilter.value = null;
  sortMode.value = 'manual';
  setListOptions([]);
}

/**
 * Boot retry for the §14 error rows: drop the storage boot singleton (closing its live
 * IDB connections) and boot again. The UI reaches storage ONLY through this module —
 * ADR-003 composition root — so screens call `retryBoot()`, never `src/storage/boot`.
 */
export function retryBoot(): void {
  resetBootSingleton();
  void startTaskStore();
}

/* -------------------------- bulk data replacement -------------------------- */

/**
 * A wholesale data replacement landed outside the pipeline (import / snapshot
 * restore / wipe — ADR-004's atomic `applyImport` writes through the storage
 * layer and bypasses `MutationRunner.onCommitted`, so nothing announces it):
 * re-read the whole dataset into state and announce the bulk change so every
 * other tab runs its `'all'` refresh path (ADR-003 Decision 8.1). Watermark
 * semantics (D4) are untouched — `TabSync.replaceAll()` is not a sweep.
 *
 * Wired to the engine's post-commit seam by `wireDataReplacedRefresh()`.
 */
export async function refreshAfterDataReplace(): Promise<void> {
  const sync = tabSync;
  if (sync !== null) {
    await sync.replaceAll();
    return;
  }
  const r = runner;
  if (r === null) return;
  await r.load();
}

/* ------------------------------- failure UX ------------------------------- */

/**
 * Report a failed (or pathologically slow) write exactly once: assertive
 * `<failureMessage>` + an `error.save.title` toast carrying Retry. Retry re-runs the
 * SAME mutation through a fresh `guard`, so a second failure reports again.
 */
function reportFailure(id: string, rerun: () => void, failureMessage: string): void {
  announce(t(failureMessage), 'assertive');
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

/**
 * `failureMessage` is the assertive announcement for THIS operation's failure: the
 * default `a11y.saveFailed` ("Your change was undone") is only true when the pipeline
 * rolled that write back, so a leg whose effects persist elsewhere must say so (review N3).
 */
async function guard<T>(
  op: () => Promise<Result<T, AppError>>,
  failureMessage = 'a11y.saveFailed',
): Promise<Result<T, AppError>> {
  const id = newToastId();
  // Object holder (not a `let`): the flag flips inside a closure, and TS would
  // otherwise narrow it to `false` in the straight-line flow below.
  const flag = { reported: false };
  const report = (rerun: () => void): void => {
    if (flag.reported) return;
    flag.reported = true;
    reportFailure(id, rerun, failureMessage);
  };
  // Rerun = the same op again, wrapped so a second failure reports again.
  const rerun = (): void => {
    void guard(op);
  };

  const timer = setTimeout(() => {
    reportTimers.delete(timer);
    report(rerun);
  }, WRITE_SLOW_MS);
  reportTimers.add(timer);
  // Settle = disarm AND forget: both success and failure paths leave no live timer.
  const settle = (): void => {
    clearTimeout(timer);
    reportTimers.delete(timer);
  };

  let result: Result<T, AppError>;
  try {
    result = await op();
  } catch (error) {
    // Contract: nothing throws across a seam — classify defensively so a broken
    // adapter still surfaces as feedback instead of a silent dead control.
    settle();
    result = err(classifyUnknown(error));
  }
  settle();

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

/* ------------------------------ S7 undo (toast) ------------------------------ */

/**
 * Undo window (S7, binding decision on t_1b9ee0e6): ONE single-step undo per
 * toast, offered for 10 s. The newest offer replaces the previous one (no
 * stack, no redo in V1), and an undo writes the exact prior rows back through
 * `MutationRunner.restoreTasks` — `sortOrder`, `listId`, `parentTaskId`,
 * `status` and `completedAt` included.
 */
export const UNDO_WINDOW_MS = 10_000;

type UndoOffer = {
  readonly toastId: string;
  readonly tasks: readonly Task[];
  readonly drop: readonly string[];
};

let undoOffer: UndoOffer | null = null;
let undoTimer: ReturnType<typeof setTimeout> | null = null;

/** Drop the offer on the table (expiry, replacement, toast dismissal, store reset). */
function dropUndoOffer(): void {
  if (undoTimer !== null) {
    clearTimeout(undoTimer);
    undoTimer = null;
  }
  const offer = undoOffer;
  // Clear BEFORE dismissing: the undo toast's `onDismiss` is this very function
  // (any dismissal route drops the offer), so the re-entry must see no offer.
  undoOffer = null;
  if (offer !== null) dismissToast(offer.toastId);
}

/** The single undo currently offered (test seam; at most one by construction). */
export function currentUndoOffer(): { tasks: readonly Task[]; drop: readonly string[] } | null {
  return undoOffer === null ? null : { tasks: undoOffer.tasks, drop: undoOffer.drop };
}

/**
 * Offer the undo toast for a destructive op whose prior images were captured
 * BEFORE the optimistic apply. `drop` lists ids the op created (a recurring
 * completion's successor) — an undo tombstones them again.
 */
function offerUndo(
  messageKey: string,
  params: Readonly<Record<string, string | number>>,
  tasks: readonly Task[],
  drop: readonly string[] = [],
): void {
  dropUndoOffer(); // single-step: the newest offer replaces any previous one
  const id = newToastId();
  undoOffer = { toastId: id, tasks, drop };
  // The store owns the 10 s window so the offer expires even when no ToastHost
  // is mounted; the toast host dismisses the visual on the same duration.
  undoTimer = setTimeout(() => {
    undoTimer = null;
    undoOffer = null;
  }, UNDO_WINDOW_MS);
  pushToast({
    id,
    tone: 'info',
    messageKey,
    params,
    durationMs: UNDO_WINDOW_MS,
    // Any dismissal route (Escape, close, auto-expiry) abandons the offer.
    onDismiss: dropUndoOffer,
    action: {
      key: 'common.undo',
      run: () => {
        void undoLastAction();
      },
    },
  });
  // The toast is never the only channel (§5.5): the SAME message also lands in
  // the polite region, deferred behind the action's own announcement so both
  // reach a screen-reader user in order (SC 4.1.3).
  announce(t(messageKey, params), 'polite', { deferred: true });
}

/**
 * Apply the offered undo: write the captured rows back, tombstone what the op
 * created, and dismiss the toast. Single-step — a second call within the window
 * is a no-op.
 */
export function undoLastAction(): Promise<Result<RestoreOutcome, AppError> | null> {
  const offer = undoOffer;
  undoOffer = null;
  if (undoTimer !== null) {
    clearTimeout(undoTimer);
    undoTimer = null;
  }
  if (offer === null) return Promise.resolve(null);
  dismissToast(offer.toastId);
  const r = runner;
  if (r === null) return Promise.resolve(null);
  return guard(() => r.restoreTasks(offer.tasks, offer.drop)).then((result) => {
    if (result.ok) announce(t('a11y.undoDone'));
    return result;
  });
}

/* ------------------------------- mutations ------------------------------- */

export interface TaskInput {
  readonly title: string;
  readonly notes: string | null;
  readonly dueDate: string | null;
  readonly listId: string;
  readonly priority: Priority;
  /** S1: attached tag names (denormalized model — creating a tag = attaching it). */
  readonly tags: readonly string[];
  /** S2: set for a subtask (single level — `PARENT_DEPTH_EXCEEDED` guards). */
  readonly parentTaskId?: string;
  /**
   * `undefined` = leave the reminder unchanged (composer path), `null` = clear
   * it, a number = the `reminderAt` instant (S5 reminder field).
   */
  readonly reminderAt?: number | null;
  /**
   * S4 recurrence: `undefined` = leave unchanged, `null` = clear it ("Repeat:
   * Never"), an object = the RRULE-lite rule (`{freq, interval, until?}`).
   */
  readonly recurrence?: Recurrence | null;
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
      tags: [...input.tags],
      ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}),
    }),
  ).then((result) => {
    // E3 §5.5: the first successfully created task IS "first meaningful use" — request
    // navigator.storage.persist() exactly once (fire-and-forget inside; it never blocks or
    // fails this write, and it is what flips the Settings storage row to granted/denied).
    if (result.ok) {
      void noteFirstMeaningfulWrite();
      // ADR-008 Decision 3 (S13): the same moment is when the install offer becomes eligible
      // (once per session, never before the first task) — see src/features/install.
      noteTaskCreated();
      lastUsedListId.value = input.listId; // F1.4: the next composer defaults to THIS list
    }
    return result;
  });
}

/**
 * Save every edited field (S4). Two guarded writes — one field-scoped patch, plus a
 * single-record move when the list changed (ADR-003 Decision 4: a membership change IS
 * a `move`, never a patch) — and ONE honest outcome per leg: the patch rolls back with
 * the generic `a11y.saveFailed`, while the move announces `a11y.moveFailed`, because by
 * then the field edits HAVE persisted (review N3 — "Your change was undone" was false
 * for exactly that branch). Each leg's Retry re-runs only the write that failed.
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
      tags: [...input.tags],
      ...(input.dueDate !== null ? { dueDate: input.dueDate } : { dueDateUnset: true }),
      ...(input.recurrence === undefined
        ? {}
        : input.recurrence !== null
          ? { recurrence: input.recurrence }
          : { recurrenceUnset: true as const }),
      ...(input.reminderAt === undefined
        ? {}
        : input.reminderAt !== null
          ? { reminderAt: input.reminderAt }
          : { reminderAtUnset: true as const }),
    }),
  );
  if (!patched.ok) return err(patched.error);

  if (input.listId !== current.listId) {
    const moved = await guard(
      () =>
        r.moveTask(id, {
          group: { listId: input.listId, parentTaskId: null },
          position: 'last',
        }),
      'a11y.moveFailed', // the patch above already landed — nothing was "undone"
    );
    if (!moved.ok) return err(moved.error);
  }
  lastUsedListId.value = input.listId;
  return ok(undefined);
}

/** Prior images a delete touches: the task plus its LIVE direct subtasks. */
function priorDeleteImages(id: string, s: State = state.value): Task[] {
  const task = s.tasks.get(id);
  if (task === undefined) return [];
  const children = [...s.tasks.values()].filter(
    (row) => row.parentTaskId === id && row.deletedAt === null,
  );
  return [task, ...children];
}

/**
 * S7 undo for delete: the captured images are written back exactly, so an undo
 * reverses EITHER subtask disposition (cascade brings the children back,
 * promote re-parents them back under the task). The undo toast replaces the
 * S7.1 confirm on the task path (binding decision) — the subtask disposition
 * dialog stays because it decides what happens to the CHILDREN, which no toast
 * can ask.
 */
export function deleteTask(
  id: string,
  disposition: TaskRemoveDisposition,
): Promise<Result<undefined, AppError>> {
  const r = runner;
  if (r === null) return noRunner();
  const prior = priorDeleteImages(id, r.getState());
  const title = prior[0]?.title ?? '';
  return guard(() => r.removeTask(id, disposition)).then((result) => {
    if (result.ok && prior.length > 0) offerUndo('undo.taskDeleted', { title }, prior);
    return result;
  });
}

/**
 * S1 tag rename/delete (one sweep transaction over the denormalized model).
 * The UI owns the announcements; `guard` reports write failures as usual.
 */
export function renameTag(from: string, to: string): Promise<Result<Task[], AppError>> {
  const r = runner;
  if (r === null) return noRunner();
  return guard(() => r.renameTag(from, to));
}

export function deleteTag(name: string): Promise<Result<Task[], AppError>> {
  const r = runner;
  if (r === null) return noRunner();
  return guard(() => r.deleteTag(name));
}

/**
 * Patch the ADR-002 `settings` singleton through the guarded write protocol
 * (S5 `notificationsEnabled` toggle is the current caller).
 */
export function patchSettings(
  patch: Partial<Omit<Settings, 'id'>>,
): Promise<Result<Settings, AppError>> {
  const r = runner;
  if (r === null) return noRunner();
  return guard(() => r.updateSettings(patch));
}

/**
 * Set (a number) or clear (`null`) a task's `reminderAt` — one field-scoped
 * guarded patch (S5; the command palette's reminder dialog is the V1 surface).
 */
export function setTaskReminder(
  id: string,
  reminderAt: number | null,
): Promise<Result<Task, AppError>> {
  const r = runner;
  if (r === null) return noRunner();
  return guard(() =>
    r.patchTask(id, reminderAt === null ? { reminderAtUnset: true as const } : { reminderAt }),
  );
}

/**
 * Complete / uncomplete. S4: completing a recurring task mints its next
 * occurrence (the domain decides, over the all-day due date). S7: the success
 * leg offers the undo toast — undoing reopens the row AND tombstones the
 * successor the completion created (single step, exact prior state).
 */
export function setTaskDone(id: string, done: boolean): Promise<Result<SetDoneOutcome, AppError>> {
  const r = runner;
  if (r === null) return noRunner();
  const before = r.getState().tasks.get(id);
  return guard(() => r.setDone(id, done)).then((result) => {
    if (result.ok && done && before !== undefined) {
      const created = result.value.created;
      offerUndo(
        'undo.taskCompleted',
        { title: before.title },
        [before],
        created === undefined ? [] : [created.id],
      );
    }
    return result;
  });
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
  const before = r.getState().tasks.get(id);
  return guard(() => r.moveTask(id, { group: { listId, parentTaskId: null }, position })).then(
    (result) => {
      // S7: a move (reorder, drag, move-to-list) is undoable too — the undo
      // writes the prior row back, so the exact `sortOrder` AND the source list
      // return, not just "some position near it".
      if (result.ok && before !== undefined) {
        offerUndo('undo.taskMoved', { title: before.title }, [before]);
      }
      return result;
    },
  );
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
