/**
 * Component-test fixtures for the core UI (M1–M4).
 *
 * `makeTestRunner` builds a real `MutationRunner` over in-memory ports that settle
 * IMMEDIATELY, so component tests exercise the exact production path (optimistic
 * apply → synchronous notify → write → authoritative swap) without IndexedDB and
 * without manual write settlement. Bind it with `bindRunnerForTest` and reset both
 * the store signals and the module singletons in `beforeEach`/`afterEach`.
 */

import { ok, type Result } from '../../src/domain/kernel';
import type { List, Settings, Task, TaskDraft, TaskPatch } from '../../src/domain/model';
import { DEFAULT_SETTINGS } from '../../src/domain/model';
import { MutationRunner } from '../../src/domain/pipeline';
import type {
  CompleteRecurringOutcome,
  ListPort,
  ListPosition,
  ListRemoveDisposition,
  ListRemoveOutcome,
  MoveOutcome,
  MoveTarget,
  RestoreOutcome,
  SettingsPort,
  TaskOccurrenceDraft,
  TaskPort,
  TaskRemoveDisposition,
  TaskRemoveOutcome,
} from '../../src/domain/ports';
import type { AppError } from '../../src/domain/kernel';
import { orderKeyBetween, orderKeyFirst } from '../../src/storage/orderKey';
import { newUlid } from '../../src/storage/id';
import { registerLiveRegions } from '../../src/app/announce';

let seq = 0;
const clock = (): number => Date.now();

export function makeList(over: Partial<List> = {}): List {
  seq += 1;
  return {
    id: over.id ?? `L${String(seq)}`,
    name: over.name ?? `List ${String(seq)}`,
    color: over.color ?? '#2e6fd9',
    sortOrder: over.sortOrder ?? 'h',
    createdAt: over.createdAt ?? clock(),
    updatedAt: over.updatedAt ?? clock(),
    deletedAt: over.deletedAt ?? null,
    deviceId: 'TEST',
  };
}

export function makeTask(over: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: over.id ?? `T${String(seq)}`,
    listId: over.listId ?? 'L1',
    title: over.title ?? `Task ${String(seq)}`,
    notes: over.notes ?? null,
    status: over.status ?? 'open',
    priority: over.priority ?? 'P4',
    tags: over.tags ?? [],
    sortOrder: over.sortOrder ?? 'h',
    createdAt: over.createdAt ?? clock(),
    updatedAt: over.updatedAt ?? clock(),
    deletedAt: null,
    deviceId: 'TEST',
    ...(over.dueDate !== undefined ? { dueDate: over.dueDate } : {}),
    ...(over.completedAt !== undefined ? { completedAt: over.completedAt } : {}),
    ...(over.parentTaskId !== undefined ? { parentTaskId: over.parentTaskId } : {}),
    // S5 (t_ee8ecb0b): reminder instants + recurrence seeding for notification tests.
    ...(over.reminderAt !== undefined ? { reminderAt: over.reminderAt } : {}),
    ...(over.recurrence !== undefined ? { recurrence: over.recurrence } : {}),
  };
}

export type TestRunner = {
  readonly runner: MutationRunner;
  readonly tasks: Map<string, Task>;
  readonly lists: Map<string, List>;
  readonly settings: Settings;
};

function byOrder(
  a: { sortOrder: string; id: string },
  b: { sortOrder: string; id: string },
): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder < b.sortOrder ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

function siblingsOf<
  T extends { listId?: string; sortOrder: string; id: string; deletedAt?: number | null },
>(rows: Iterable<T>, match: (row: T) => boolean, excludeId: string): T[] {
  return [...rows]
    .filter((row) => match(row) && row.id !== excludeId && (row.deletedAt ?? null) === null)
    .sort(byOrder);
}

function keyAt(rows: readonly { sortOrder: string }[], position: ListPosition): string {
  if (position === 'first') return orderKeyBetween(null, rows[0]?.sortOrder ?? null);
  if (position === 'last') return orderKeyBetween(rows.at(-1)?.sortOrder ?? null, null);
  if ('afterId' in position) {
    const at = rows.findIndex(
      (row) => 'id' in row && (row as { id: string }).id === position.afterId,
    );
    const ref = rows[at];
    return orderKeyBetween(ref?.sortOrder ?? null, rows[at + 1]?.sortOrder ?? null);
  }
  const at = rows.findIndex(
    (row) => 'id' in row && (row as { id: string }).id === position.beforeId,
  );
  const ref = rows[at];
  return orderKeyBetween(rows[at - 1]?.sortOrder ?? null, ref?.sortOrder ?? null);
}

/** In-memory ports: every write resolves `ok` on the next microtask.
 *  `hangWrites` makes `setDone` never settle (the §5.6 3-second fallback probe). */
export function makeTestRunner(
  seed: {
    tasks?: readonly Task[];
    lists?: readonly List[];
    settings?: Partial<Settings>;
    hangWrites?: boolean;
    /** Every `move` write fails (§8.3 rollback probe: row returns + saveFailed). */
    failMoves?: boolean;
  } = {},
): TestRunner {
  const tasks = new Map<string, Task>((seed.tasks ?? []).map((task) => [task.id, task]));
  const lists = new Map<string, List>((seed.lists ?? []).map((list) => [list.id, list]));
  const settings: Settings = { ...DEFAULT_SETTINGS, ...(seed.settings ?? {}) };

  const visible = (): Task[] => [...tasks.values()].filter((task) => task.deletedAt === null);
  const liveLists = (): List[] => [...lists.values()].filter((list) => list.deletedAt === null);

  const taskPort: TaskPort = {
    async loadAll() {
      return ok({ tasks: visible(), lists: liveLists(), settings });
    },
    async create(draft: TaskDraft): Promise<Result<Task, AppError>> {
      const siblings = siblingsOf(
        visible(),
        (task) => task.listId === draft.listId && task.parentTaskId === undefined,
        '',
      );
      const task = makeTask({
        id: draft.id ?? newUlid(),
        listId: draft.listId,
        title: draft.title,
        notes: draft.notes,
        priority: draft.priority,
        tags: [...draft.tags],
        sortOrder: orderKeyBetween(siblings.at(-1)?.sortOrder ?? null, null),
        ...(draft.dueDate !== undefined ? { dueDate: draft.dueDate } : {}),
        ...(draft.parentTaskId !== undefined ? { parentTaskId: draft.parentTaskId } : {}),
      });
      tasks.set(task.id, task);
      return ok(task);
    },
    async patch(id: string, patch: TaskPatch): Promise<Result<Task, AppError>> {
      const current = tasks.get(id);
      if (current === undefined)
        return { ok: false, error: { code: 'RULE', rule: 'TASK_MISSING', message: id } };
      const next: Task = {
        ...current,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.tags !== undefined ? { tags: [...patch.tags] } : {}),
        ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate } : {}),
        ...(patch.reminderAt !== undefined ? { reminderAt: patch.reminderAt } : {}),
        ...(patch.recurrence !== undefined ? { recurrence: patch.recurrence } : {}),
        updatedAt: clock(),
      };
      const withoutDue = (task: Task): Task => {
        const copy = { ...task };
        delete copy.dueDate;
        return copy;
      };
      const withoutReminder = (task: Task): Task => {
        const copy = { ...task };
        delete copy.reminderAt;
        return copy;
      };
      const clearedDue = patch.dueDateUnset === true ? withoutDue(next) : next;
      const cleaned = patch.reminderAtUnset === true ? withoutReminder(clearedDue) : clearedDue;
      tasks.set(id, cleaned);
      return ok(cleaned);
    },
    async setDone(id: string, done: boolean): Promise<Result<Task, AppError>> {
      if (seed.hangWrites === true) {
        return new Promise<never>(() => undefined);
      }
      const current = tasks.get(id);
      if (current === undefined)
        return { ok: false, error: { code: 'RULE', rule: 'TASK_MISSING', message: id } };
      const next: Task = done
        ? { ...current, status: 'done', completedAt: clock(), updatedAt: clock() }
        : { ...current, status: 'open', updatedAt: clock() };
      if (!done) delete next.completedAt;
      tasks.set(id, next);
      return ok(next);
    },
    async setArchived(id: string, archived: boolean): Promise<Result<Task, AppError>> {
      const current = tasks.get(id);
      if (current === undefined)
        return { ok: false, error: { code: 'RULE', rule: 'TASK_MISSING', message: id } };
      if (archived && current.status !== 'done')
        return {
          ok: false,
          error: {
            code: 'RULE',
            rule: 'TASK_STATUS_INVALID',
            message: `archive expects a done task, got ${current.status}`,
          },
        };
      if (!archived && current.status !== 'archived')
        return {
          ok: false,
          error: {
            code: 'RULE',
            rule: 'TASK_STATUS_INVALID',
            message: `restore expects an archived task, got ${current.status}`,
          },
        };
      const now = clock();
      const next: Task = { ...current, status: archived ? 'archived' : 'done', updatedAt: now };
      if (!archived && next.completedAt === undefined) next.completedAt = now;
      tasks.set(id, next);
      return ok(next);
    },
    async completeRecurring(
      id: string,
      next: TaskOccurrenceDraft,
    ): Promise<Result<CompleteRecurringOutcome, AppError>> {
      if (seed.hangWrites === true) {
        return new Promise<never>(() => undefined);
      }
      const current = tasks.get(id);
      if (current === undefined)
        return { ok: false, error: { code: 'RULE', rule: 'TASK_MISSING', message: id } };
      const now = clock();
      const doneRow: Task = { ...current, status: 'done', completedAt: now, updatedAt: now };
      tasks.set(id, doneRow);
      const created = makeTask({
        id: next.id ?? newUlid(),
        listId: next.listId,
        title: next.title,
        // TaskDraft's notes/priority/tags are REQUIRED (model.ts), so they are
        // passed through directly — the conditional spreads below stay for the
        // genuinely optional fields (exactOptionalPropertyTypes).
        notes: next.notes,
        priority: next.priority,
        tags: [...next.tags],
        ...(next.dueDate !== undefined ? { dueDate: next.dueDate } : {}),
        ...(next.reminderAt !== undefined ? { reminderAt: next.reminderAt } : {}),
        ...(next.recurrence !== undefined ? { recurrence: next.recurrence } : {}),
      });
      tasks.set(created.id, created);
      return ok({ done: doneRow, created });
    },
    async restore(rows: Task[], removeIds: string[]): Promise<Result<RestoreOutcome, AppError>> {
      const now = clock();
      const restored: Task[] = [];
      for (const row of rows) {
        const back: Task = { ...row, updatedAt: now };
        tasks.set(back.id, back);
        restored.push(back);
      }
      const tombstoned: Task[] = [];
      for (const id of removeIds) {
        const current = tasks.get(id);
        if (current === undefined) continue;
        const row: Task = { ...current, deletedAt: now, updatedAt: now };
        tasks.set(id, row);
        tasks.delete(id);
        tombstoned.push(row);
      }
      return ok({ restored, tombstoned });
    },
    async move(id: string, target: MoveTarget): Promise<Result<MoveOutcome<Task>, AppError>> {
      if (seed.failMoves === true) {
        return { ok: false, error: { code: 'TX_ABORTED', cause: new Error('move write failed') } };
      }
      const current = tasks.get(id);
      if (current === undefined)
        return { ok: false, error: { code: 'RULE', rule: 'TASK_MISSING', message: id } };
      const siblings = siblingsOf(
        visible(),
        (task) =>
          task.listId === target.group.listId &&
          (target.group.parentTaskId === null
            ? task.parentTaskId === undefined
            : task.parentTaskId === target.group.parentTaskId),
        id,
      );
      const next: Task = {
        ...current,
        listId: target.group.listId,
        sortOrder: keyAt(siblings, target.position),
        updatedAt: clock(),
      };
      tasks.set(id, next);
      return ok({ row: next, rebalanced: false });
    },
    async remove(
      id: string,
      disposition: TaskRemoveDisposition,
    ): Promise<Result<TaskRemoveOutcome, AppError>> {
      const now = clock();
      const current = tasks.get(id);
      // Idempotent: removing an absent row resolves with an empty outcome.
      if (current === undefined) return ok({ tombstoned: [], promoted: [] });
      const children = [...tasks.values()].filter(
        (task) => task.parentTaskId === id && task.deletedAt === null,
      );
      const tombstoned: Task[] = [];
      const promoted: Task[] = [];
      const tombstone = (task: Task): void => {
        const row: Task = { ...task, deletedAt: now, updatedAt: now };
        tasks.delete(task.id);
        tombstoned.push(row);
      };
      tombstone(current);
      if (disposition.mode === 'cascade') {
        for (const child of children) tombstone(child);
      } else {
        for (const child of children) {
          const row: Task = { ...child, updatedAt: now };
          delete row.parentTaskId;
          tasks.set(child.id, row);
          promoted.push(row);
        }
      }
      return ok({ tombstoned, promoted });
    },
    async sweepTag(from: string, to: string | null): Promise<Result<Task[], AppError>> {
      const now = clock();
      const rewritten: Task[] = [];
      for (const task of tasks.values()) {
        if (!task.tags.includes(from)) continue;
        const row: Task = {
          ...task,
          tags:
            to === null
              ? task.tags.filter((tag) => tag !== from)
              : [...new Set(task.tags.map((tag) => (tag === from ? to : tag)))],
          updatedAt: now,
        };
        tasks.set(row.id, row);
        rewritten.push(row);
      }
      return ok(rewritten);
    },
    async upsertImported(rows: Task[]): Promise<Result<void, AppError>> {
      for (const row of rows) tasks.set(row.id, row);
      return ok(undefined);
    },
  };

  const listPort: ListPort = {
    async loadAll() {
      return ok(liveLists().sort(byOrder));
    },
    async create(input): Promise<Result<List, AppError>> {
      const siblings = siblingsOf(liveLists(), () => true, '');
      const list = makeList({
        id: input.id ?? newUlid(),
        name: input.name,
        color: input.color,
        sortOrder: orderKeyBetween(siblings.at(-1)?.sortOrder ?? null, null),
      });
      lists.set(list.id, list);
      return ok(list);
    },
    async rename(id, name): Promise<Result<List, AppError>> {
      const current = lists.get(id);
      if (current === undefined)
        return { ok: false, error: { code: 'RULE', rule: 'TASK_MISSING', message: id } };
      const next = { ...current, name, updatedAt: clock() };
      lists.set(id, next);
      return ok(next);
    },
    async recolor(id, color): Promise<Result<List, AppError>> {
      const current = lists.get(id);
      if (current === undefined)
        return { ok: false, error: { code: 'RULE', rule: 'TASK_MISSING', message: id } };
      const next = { ...current, color, updatedAt: clock() };
      lists.set(id, next);
      return ok(next);
    },
    async move(id, position): Promise<Result<MoveOutcome<List>, AppError>> {
      const current = lists.get(id);
      if (current === undefined)
        return { ok: false, error: { code: 'RULE', rule: 'TASK_MISSING', message: id } };
      const siblings = siblingsOf(liveLists(), () => true, id);
      const next = { ...current, sortOrder: keyAt(siblings, position), updatedAt: clock() };
      lists.set(id, next);
      return ok({ row: next, rebalanced: false });
    },
    async remove(
      id: string,
      disposition: ListRemoveDisposition,
    ): Promise<Result<ListRemoveOutcome, AppError>> {
      const affected = [...tasks.values()].filter((task) => task.listId === id);
      const moved: Task[] = [];
      const tombstoned: Task[] = [];
      if (disposition.mode === 'move') {
        for (const task of affected) {
          const next = { ...task, listId: disposition.targetListId, updatedAt: clock() };
          tasks.set(task.id, next);
          moved.push(next);
        }
      } else {
        for (const task of affected) {
          tasks.delete(task.id);
          tombstoned.push(task);
        }
      }
      lists.delete(id);
      return ok({ moved, tombstoned });
    },
  };

  const settingsPort: SettingsPort = {
    async get() {
      return ok(settings);
    },
    async update(patch) {
      Object.assign(settings, patch);
      return ok(settings);
    },
  };

  const runner = new MutationRunner({
    tasks: taskPort,
    lists: listPort,
    settings: settingsPort,
    clock,
    ids: () => newUlid(),
    orderKeys: { between: orderKeyBetween, first: orderKeyFirst },
    deviceId: 'TEST',
  });

  return { runner, tasks, lists, settings };
}

/** Mount the two global live regions; returns a disposer + the region elements. */
export function mountLiveRegions(): {
  polite: HTMLElement;
  assertive: HTMLElement;
  dispose: () => void;
} {
  const polite = document.createElement('div');
  polite.setAttribute('role', 'status');
  const assertive = document.createElement('div');
  assertive.setAttribute('role', 'alert');
  document.body.append(polite, assertive);
  const dispose = registerLiveRegions({ polite, assertive });
  return {
    polite,
    assertive,
    dispose: () => {
      dispose();
      polite.remove();
      assertive.remove();
    },
  };
}

/** jsdom ships no `matchMedia`; this restores it after installing the wide pattern. */
export function stubWideViewport(): () => void {
  const original = globalThis.matchMedia;
  globalThis.matchMedia = (query: string) => ({
    media: query,
    matches: query.includes('min-width: 1024px'),
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- required MediaQueryList member for a structurally assignable stub (same shape app.test.tsx ships)
    addListener: () => undefined,
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- see the addListener note above
    removeListener: () => undefined,
    dispatchEvent: () => false,
  });
  return () => {
    globalThis.matchMedia = original;
  };
}
