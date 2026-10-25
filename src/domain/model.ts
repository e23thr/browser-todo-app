/**
 * Canonical record types (ADR-003 Decision 1.2): the ADR-002 §3 shapes are
 * BYTE-IDENTICAL to what `src/storage/types.ts` declared before this module won
 * ownership — `src/storage/` re-exports them from here so no schema drift is
 * possible. Changing any field is an ADR-002 amendment plus a
 * `meta.schemaVersion` migration step — never an in-place edit.
 */

export type TaskStatus = 'open' | 'done' | 'archived';
export type Priority = 0 | 1 | 2;

/** RRULE-lite subset (S4 owns semantics). */
export type Recurrence = {
  freq: 'daily' | 'weekly' | 'monthly' | 'weekdays';
  interval: number;
  until?: string;
  count?: number;
};

export type List = {
  id: string;
  name: string;
  color: string;
  sortOrder: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  deviceId: string;
};

export type Task = {
  id: string;
  listId: string;
  title: string;
  notes: string | null;
  status: TaskStatus;
  priority: Priority;
  dueDate?: string;
  reminderAt?: number;
  recurrence?: Recurrence;
  tags: string[];
  parentTaskId?: string;
  sortOrder: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  deletedAt: number | null;
  deviceId: string;
};

/** Singleton; the single record has `id: 'settings'` (ADR-002 §3.4). */
export type Settings = {
  id: 'settings';
  theme: 'light' | 'dark' | 'system';
  locale: string;
  weekStart: 0 | 1;
  defaultListId: string | null;
  notificationsEnabled: boolean;
  lastBackupAt: number | null;
};

/**
 * Store names (ADR-002 Decision 3). `tags` is deliberately reserved and must
 * not appear here until a migration creates it (ADR-002 §3.7).
 */
export type StoreName = 'meta' | 'lists' | 'tasks' | 'settings' | 'snapshots' | 'snapshot_payloads';

/** Field-scoped create input — repos stamp ids/timestamps (ADR-002 Decision 5). */
export type TaskDraft = {
  /**
   * Pre-minted final ULID (ADR-003 Decision 3.2: "injected IdFactory mints
   * final ULIDs up front" — provisional rows must not churn ids between paint
   * and write). Repos mint one when absent (e.g. import paths).
   */
  id?: string;
  listId: string;
  title: string;
  notes: string | null;
  priority: Priority;
  dueDate?: string;
  tags: string[];
  parentTaskId?: string;
};

/**
 * Field-scoped patch applied read-modify-write inside one transaction
 * (ADR-003 Decision 2.2.1). `dueDateUnset` clears the due date; membership
 * (list/parent) changes go through `TaskPort.move`, never a patch.
 */
export type TaskPatch = Partial<
  Pick<Task, 'title' | 'notes' | 'priority' | 'dueDate' | 'tags' | 'reminderAt' | 'recurrence'>
> & { dueDateUnset?: true; reminderAtUnset?: true };

/** Settings used before the first `update()` persists the singleton row. */
export const DEFAULT_SETTINGS: Settings = {
  id: 'settings',
  theme: 'system',
  locale: 'en',
  weekStart: 1,
  defaultListId: null,
  notificationsEnabled: false,
  lastBackupAt: null,
};
