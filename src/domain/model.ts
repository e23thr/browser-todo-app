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
  | 'meta'
  | 'lists'
  | 'tasks'
  | 'settings'
  | 'snapshots'
  | 'snapshot_payloads'
  | 'sync_state'
  | 'crypto_state';

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
> & { dueDateUnset?: true; reminderAtUnset?: true; recurrenceUnset?: true };

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

/* --------------------- C1 encrypted record shapes (ADR-007 Decision 4.1) --------------------- */

/**
 * The plaintext crypto envelope carried on encrypted records (ADR-006
 * Decision 10 — binding wire slots: `payloadHash` is change detection for the
 * shadow test; `enc` + `payload` are opaque to the sync engine).
 */
export type EncEnvelope = { alg: 'AES-GCM'; v: 1; iv: string };

/** Decrypted task content — the ciphertext plaintext (Decision 4.1). */
export type TaskPayload = { title: string; notes: string | null; tags: string[] };

/** Decrypted list content. */
export type ListPayload = { name: string };

/**
 * The at-rest `tasks` row when C1 is on (Decision 4.1): plaintext merge
 * envelope + plaintext structural fields + one ciphertext payload. The record
 * is SELF-DESCRIBING — `enc` present = encrypted; a mixed store (some rows
 * plaintext) is legal and required for crash-safe migration (Decision 7.1).
 *
 * NOTE (recorded for review): `RowMap['tasks']` stays typed as `Task` — the
 * decrypted view — so the whole domain/UI layer compiles unchanged. The
 * encrypted variant is a RUNTIME shape enforced by `validate.ts` and by the
 * crypto read/write seam (the one boundary where both shapes coexist); raw
 * consumers (sync engine, snapshot/backup paths) treat rows as opaque records
 * whose envelope fields are all they may read.
 */
export type EncryptedTaskRecord = {
  id: string;
  kind: 'task';
  updatedAt: number;
  deviceId: string;
  deletedAt: number | null;
  payloadHash: string;
  enc: EncEnvelope;
  payload: string;
  // — plaintext structural fields (query/merge/schedule) —
  listId: string;
  status: TaskStatus;
  priority: Priority;
  dueDate?: string;
  reminderAt?: number;
  recurrence?: Recurrence;
  parentTaskId?: string;
  sortOrder: string;
  createdAt: number;
  completedAt?: number;
};

/** The at-rest `lists` row when C1 is on. */
export type EncryptedListRecord = {
  id: string;
  kind: 'list';
  updatedAt: number;
  deviceId: string;
  deletedAt: number | null;
  payloadHash: string;
  enc: EncEnvelope;
  payload: string;
  color: string;
  sortOrder: string;
  createdAt: number;
};

/** Either at-rest row shape (raw consumers — sync engine, snapshots). */
export type TaskRowLike = Task | EncryptedTaskRecord;
export type ListRowLike = List | EncryptedListRecord;
export type RowLike = TaskRowLike | ListRowLike;

/** `enc` present = the encrypted at-rest shape (the record is self-describing). */
export function isEncryptedRecord(row: unknown): row is EncryptedTaskRecord | EncryptedListRecord {
  return (
    typeof row === 'object' &&
    row !== null &&
    typeof (row as { enc?: unknown }).enc === 'object' &&
    (row as { enc?: unknown }).enc !== null
  );
}

/** Row kind from the row itself (`kind` on encrypted rows; field presence on plaintext ones). */
export function rowKindOf(row: RowLike): 'task' | 'list' {
  if (isEncryptedRecord(row)) return row.kind;
  return 'title' in row ? 'task' : 'list';
}
