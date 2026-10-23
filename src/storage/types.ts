/**
 * Record types for the local-first todo database.
 *
 * BINDING: these shapes are ADR-002 §3 verbatim. `Task`/`List`/`Settings` (and
 * their field unions) now live in `src/domain/model.ts` — their canonical TS home
 * per ADR-003 Decision 1.2 — and are re-exported here so every ADR-002 import
 * site keeps compiling. Changing any field is an ADR amendment plus a
 * `meta.schemaVersion` migration step — never an in-place edit.
 */

export type {
  List,
  Priority,
  Recurrence,
  Settings,
  StoreName,
  Task,
  TaskStatus,
} from '../domain/model';

import type { List, Settings, StoreName, Task } from '../domain/model';

/** Singleton under out-of-line key `'meta'` (ADR-002 §3.1). */
export type Meta = {
  schemaVersion: number;
  deviceId: string;
  createdAt: number;
  lastOpenedAt: number;
  lastPurgeAt?: number;
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
export const DATA_STORES: readonly ('lists' | 'tasks' | 'settings')[] = [
  'lists',
  'tasks',
  'settings',
] as const;
