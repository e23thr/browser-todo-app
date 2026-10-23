/**
 * Record types for the local-first todo database.
 *
 * BINDING: these shapes are ADR-002 §3 verbatim. Changing any field is an ADR
 * amendment plus a `meta.schemaVersion` migration step — never an in-place edit.
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

/** Singleton under out-of-line key `'meta'` (ADR-002 §3.1). */
export type Meta = {
  schemaVersion: number;
  deviceId: string;
  createdAt: number;
  lastOpenedAt: number;
  lastPurgeAt?: number;
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

export type SnapshotKind = 'auto' | 'manual';
export type SnapshotReason = 'scheduled' | 'pre-migration' | 'pre-import' | 'manual';

export type Snapshot = {
  id: string;
  takenAt: number;
  kind: SnapshotKind;
  reason: SnapshotReason;
  sizeBytes: number;
  schemaVersion: number;
  payloadRef: string;
};

export type SnapshotPayload = {
  id: string;
  payload: string;
};

/**
 * Store names (ADR-002 Decision 3). `tags` is deliberately reserved and must
 * not appear here until a migration creates it (ADR-002 §3.7).
 */
export type StoreName = 'meta' | 'lists' | 'tasks' | 'settings' | 'snapshots' | 'snapshot_payloads';

export type RowMap = {
  meta: Meta;
  lists: List;
  tasks: Task;
  settings: Settings;
  snapshots: Snapshot;
  snapshot_payloads: SnapshotPayload;
};

export type Row<K extends StoreName> = RowMap[K];

/** Per-store row inventory — the unit snapshot payloads and export upgrades move. */
export type StoreRows = { [K in StoreName]: Row<K>[] };

/** All stores, in a stable order (snapshot dumps, full scans). */
export const STORE_NAMES: readonly StoreName[] = [
  'meta',
  'lists',
  'tasks',
  'settings',
  'snapshots',
  'snapshot_payloads',
] as const;

/** Stores whose rows are user data covered by export/snapshot payloads (ADR-002 §3.6). */
export const DATA_STORES: readonly ('lists' | 'tasks' | 'settings')[] = ['lists', 'tasks', 'settings'] as const;
