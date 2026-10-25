/**
 * Canonical record types (ADR-003 Decision 1.2): the ADR-002 §3 shapes are
 * BYTE-IDENTICAL to what `src/storage/types.ts` declared before this module won
 * ownership — `src/storage/` re-exports them from here so no schema drift is
 * possible. Changing any field is an ADR-002 amendment plus a
 * `meta.schemaVersion` migration step — never an in-place edit.
 */

export type TaskStatus = 'open' | 'done' | 'archived';

/**
 * S3 priority model (V1, schemaVersion 2): four levels `P1..P4`, `P1` the most
 * urgent and `P4` = "no priority" (the default for new tasks). This REPLACED
 * the MVP `0 | 1 | 2` union where `2` was High, `1` Medium, `0` Low and the
 * field was required — the schemaVersion 2 migration maps the legacy values
 * onto the levels preserving user-visible meaning (see `migrations.ts`).
 */
export type Priority = 'P1' | 'P2' | 'P3' | 'P4';

/** Every level, most urgent first (UI pickers, sort helpers). */
export const PRIORITY_LEVELS = ['P1', 'P2', 'P3', 'P4'] as const;

const PRIORITY_RANK: Readonly<Record<Priority, number>> = { P1: 0, P2: 1, P3: 2, P4: 3 };

/** Sort comparator: `P1` first … `P4` (no priority) last ("sorting per level"). */
export function compareByPriority(a: Priority, b: Priority): number {
  return PRIORITY_RANK[a] - PRIORITY_RANK[b];
}

/**
 * RRULE-lite subset (S4 owns semantics). BINDING reserved format (V1, E7):
 * `{ freq, interval >= 1, until?: 'YYYY-MM-DD' }` — no exceptions and NO
 * end-count (PROJECT_ANALYSIS R4 line). The schemaVersion 2 migration strips a
 * legacy `count` field so the recurrence card implements semantics only.
 */
export type Recurrence = {
  freq: 'daily' | 'weekly' | 'monthly' | 'weekdays';
  interval: number;
  until?: string;
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
 * not appear here until a migration creates it (ADR-002 §3.7). `sync_state`
 * arrived with the ADR-006 Decision 3 migration step (schemaVersion 2).
 */
export type StoreName =
  'meta' | 'lists' | 'tasks' | 'settings' | 'snapshots' | 'snapshot_payloads' | 'sync_state';

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
