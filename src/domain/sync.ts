/**
 * Concurrent-tab protocol contract (ADR-003 Decision 8) — pure half.
 *
 * Channel `local-first-todo:tabs:v1`, one message type `data-changed`, sent
 * AFTER the IDB commit. The message is ADVERSORY ONLY: IndexedDB is the single
 * source of truth, receivers re-read rows and call `reconcile`, which returns
 * the state update to apply (never writes anything itself — "never write on
 * receipt"). Correctness does not depend on delivery: `src/app/tabSync.ts` adds
 * the `by_updatedAt` watermark sweep on tab focus (Decision 8.2).
 */

import type { List, Settings, Task } from './model';
import type { RecordUpdate, State } from './state';

export type TabId = string;

export type ChangeSet = { tasks?: string[]; lists?: string[]; settings?: boolean };

/**
 * What a commit announces (ADR-003 Decision 8.1 sender rule 2): a targeted id
 * list for single-record ops, or `'all'` for ops that touched many rows
 * (list-delete disposition, import, purge, rebalance).
 */
export type ChangeAnnouncement = ChangeSet | 'all';

export type BroadcastMessage = {
  v: 1;
  type: 'data-changed';
  origin: TabId;
  at: number;
  change: ChangeAnnouncement;
};

export const TAB_SYNC_CHANNEL = 'local-first-todo:tabs:v1';

/** Receiver rule 1: ignore own messages (BroadcastChannel does not echo — tag anyway). */
export function isOwnMessage(msg: BroadcastMessage, self: TabId): boolean {
  return msg.origin === self;
}

/** Structural check for messages arriving from the channel (foreign input). */
export function isBroadcastMessage(v: unknown): v is BroadcastMessage {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Partial<BroadcastMessage>;
  return m.v === 1 && m.type === 'data-changed' && typeof m.origin === 'string';
}

/**
 * Fresh row reads keyed by id, straight from the repo after the message
 * arrived. `null` = tombstoned or missing -> evict from state.
 */
export type FreshRows = {
  tasks?: ReadonlyMap<string, Task | null>;
  lists?: ReadonlyMap<string, List | null>;
  settings?: Settings | null;
};

/**
 * Pure reconcile (ADR-003 Decision 8.1 rule 2). Records with an in-flight
 * optimistic op are left untouched — a watermark sweep must never clobber a
 * write this tab has applied but not yet settled.
 */
export function reconcile(state: State, msg: BroadcastMessage, rows: FreshRows): RecordUpdate {
  const update: RecordUpdate = {};
  const touchTasks = new Set<string>();
  const touchLists = new Set<string>();
  let touchSettings = false;

  if (msg.change === 'all') {
    for (const id of state.tasks.keys()) touchTasks.add(id);
    for (const id of state.lists.keys()) touchLists.add(id);
    for (const id of rows.tasks?.keys() ?? []) touchTasks.add(id);
    for (const id of rows.lists?.keys() ?? []) touchLists.add(id);
    touchSettings = true;
  } else {
    for (const id of msg.change.tasks ?? []) touchTasks.add(id);
    for (const id of msg.change.lists ?? []) touchLists.add(id);
    touchSettings = msg.change.settings === true;
  }

  const tasks: Task[] = [];
  const evictTasks: string[] = [];
  for (const id of touchTasks) {
    if (state.pending.has(id)) continue;
    const row = rows.tasks?.get(id);
    if (row != null && row.deletedAt === null) tasks.push(row);
    else evictTasks.push(id);
  }
  const lists: List[] = [];
  const evictLists: string[] = [];
  for (const id of touchLists) {
    if (state.pending.has(id)) continue;
    const row = rows.lists?.get(id);
    if (row != null && row.deletedAt === null) lists.push(row);
    else evictLists.push(id);
  }

  if (tasks.length > 0) update.tasks = tasks;
  if (evictTasks.length > 0) update.evictTasks = evictTasks;
  if (lists.length > 0) update.lists = lists;
  if (evictLists.length > 0) update.evictLists = evictLists;
  if (touchSettings) {
    update.settings = rows.settings ?? null;
  }
  return update;
}
