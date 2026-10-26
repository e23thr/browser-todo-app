/**
 * Fake ports with per-write deferred control: tests decide exactly when (and
 * with WHAT authoritative record) each repo write resolves, so the optimistic
 * pipeline's ordering, swap and rollback behavior is observable deterministically.
 * The three ports share one recorder so multi-port ops (list-delete disposition)
 * stay testable.
 */
import { err, ok, type AppError, type Result } from '../../../src/domain/kernel';
import type { List, Settings, Task, TaskDraft, TaskPatch } from '../../../src/domain/model';
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
} from '../../../src/domain/ports';

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export type FakeWrite = {
  op: string;
  args: unknown[];
  done: boolean;
  settle: (r: Result<unknown, AppError>) => void;
};

export class FakeRecorder {
  writes: FakeWrite[] = [];
  repoNow = 999_999;
  repoDevice = 'REPO-DEVICE';

  get unsettled(): FakeWrite[] {
    return this.writes.filter((w) => !w.done);
  }

  /** Resolve the oldest unsettled write with `value` (the repo's authoritative result). */
  succeed(value: unknown): void {
    const w = this.unsettled[0];
    if (w === undefined) throw new Error('no pending write');
    w.done = true;
    w.settle(ok(value));
  }

  /** Fail the oldest unsettled write with `error`. */
  fail(error: AppError): void {
    const w = this.unsettled[0];
    if (w === undefined) throw new Error('no pending write');
    w.done = true;
    w.settle(err(error));
  }

  record<T>(op: string, args: unknown[]): Promise<Result<T, AppError>> {
    const d = deferred<Result<unknown, AppError>>();
    this.writes.push({ op, args, settle: d.resolve, done: false });
    return d.promise as Promise<Result<T, AppError>>;
  }
}

export async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

export function makeTaskRow(over: Partial<Task> = {}): Task {
  return {
    id: over.id ?? 'REPO-TASK',
    listId: over.listId ?? 'L1',
    title: over.title ?? 'title',
    notes: over.notes ?? null,
    status: over.status ?? 'open',
    priority: over.priority ?? 'P4',
    tags: over.tags ?? [],
    sortOrder: over.sortOrder ?? 'h',
    createdAt: over.createdAt ?? 1,
    updatedAt: over.updatedAt ?? 999_999,
    deletedAt: over.deletedAt ?? null,
    deviceId: over.deviceId ?? 'REPO-DEVICE',
    ...(over.dueDate !== undefined ? { dueDate: over.dueDate } : {}),
    ...(over.completedAt !== undefined ? { completedAt: over.completedAt } : {}),
    ...(over.parentTaskId !== undefined ? { parentTaskId: over.parentTaskId } : {}),
  };
}

export function makeListRow(over: Partial<List> = {}): List {
  return {
    id: over.id ?? 'REPO-LIST',
    name: over.name ?? 'Inbox',
    color: over.color ?? '#336699',
    sortOrder: over.sortOrder ?? 'h',
    createdAt: over.createdAt ?? 1,
    updatedAt: over.updatedAt ?? 999_999,
    deletedAt: over.deletedAt ?? null,
    deviceId: over.deviceId ?? 'REPO-DEVICE',
  };
}

export function makeSettingsRow(over: Partial<Settings> = {}): Settings {
  return {
    id: 'settings',
    theme: 'system',
    locale: 'en',
    weekStart: 1,
    defaultListId: null,
    notificationsEnabled: false,
    lastBackupAt: null,
    ...over,
  };
}

export class FakeTaskPort implements TaskPort {
  loaded: { tasks: Task[]; lists: List[]; settings: Settings } | null = null;
  readonly rec: FakeRecorder;

  constructor(rec: FakeRecorder) {
    this.rec = rec;
  }

  loadAll(): Promise<Result<{ tasks: Task[]; lists: List[]; settings: Settings }, AppError>> {
    return Promise.resolve(
      ok(this.loaded ?? { tasks: [], lists: [], settings: makeSettingsRow() }),
    );
  }

  create(draft: TaskDraft): Promise<Result<Task, AppError>> {
    return this.rec.record<Task>('create', [draft]);
  }

  patch(id: string, patch: TaskPatch): Promise<Result<Task, AppError>> {
    return this.rec.record<Task>('patch', [id, patch]);
  }

  setDone(id: string, done: boolean): Promise<Result<Task, AppError>> {
    return this.rec.record<Task>('setDone', [id, done]);
  }
  setArchived(id: string, archived: boolean): Promise<Result<Task, AppError>> {
    return this.rec.record<Task>('setArchived', [id, archived]);
  }

  completeRecurring(
    id: string,
    next: TaskOccurrenceDraft,
  ): Promise<Result<CompleteRecurringOutcome, AppError>> {
    return this.rec.record<CompleteRecurringOutcome>('completeRecurring', [id, next]);
  }

  restore(rows: Task[], removeIds: string[]): Promise<Result<RestoreOutcome, AppError>> {
    return this.rec.record<RestoreOutcome>('restore', [rows, removeIds]);
  }

  move(id: string, target: MoveTarget): Promise<Result<MoveOutcome<Task>, AppError>> {
    return this.rec.record<MoveOutcome<Task>>('move', [id, target]);
  }

  remove(
    id: string,
    disposition: TaskRemoveDisposition,
  ): Promise<Result<TaskRemoveOutcome, AppError>> {
    return this.rec.record<TaskRemoveOutcome>('remove', [id, disposition]);
  }

  sweepTag(from: string, to: string | null): Promise<Result<Task[], AppError>> {
    return this.rec.record<Task[]>('sweepTag', [from, to]);
  }

  upsertImported(rows: Task[]): Promise<Result<void, AppError>> {
    return this.rec.record<undefined>('upsertImported', [rows]);
  }
}

export class FakeListPort implements ListPort {
  readonly rec: FakeRecorder;

  constructor(rec: FakeRecorder) {
    this.rec = rec;
  }

  loadAll(): Promise<Result<List[], AppError>> {
    return Promise.resolve(ok([]));
  }

  create(input: { name: string; color: string; id?: string }): Promise<Result<List, AppError>> {
    return this.rec.record<List>('createList', [input]);
  }

  rename(id: string, name: string): Promise<Result<List, AppError>> {
    return this.rec.record<List>('rename', [id, name]);
  }

  recolor(id: string, color: string): Promise<Result<List, AppError>> {
    return this.rec.record<List>('recolor', [id, color]);
  }

  move(id: string, position: ListPosition): Promise<Result<MoveOutcome<List>, AppError>> {
    return this.rec.record<MoveOutcome<List>>('moveList', [id, position]);
  }

  remove(
    id: string,
    disposition: ListRemoveDisposition,
  ): Promise<Result<ListRemoveOutcome, AppError>> {
    return this.rec.record<ListRemoveOutcome>('removeList', [id, disposition]);
  }
}

export class FakeSettingsPort implements SettingsPort {
  readonly rec: FakeRecorder;

  constructor(rec: FakeRecorder) {
    this.rec = rec;
  }

  get(): Promise<Result<Settings, AppError>> {
    return Promise.resolve(ok(makeSettingsRow()));
  }

  update(patch: Partial<Omit<Settings, 'id'>>): Promise<Result<Settings, AppError>> {
    return this.rec.record<Settings>('updateSettings', [patch]);
  }
}
