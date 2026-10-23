/**
 * Stage B of the import pipeline (ADR-004 Decisions 5.1, 6): per-record
 * validation + the referential pass. Everything here QUARANTINES per record —
 * nothing is dropped silently (E4): invalid records land in the recovery file.
 *
 * Accepted records are whitelist-rebuilt (canonical order) — never
 * `Object.assign`/spread of untrusted objects (Decision 6.1.4).
 */

import type { List, Settings, Snapshot, Task } from '../storage/types';
import { validateRow } from '../storage/validate';
import { canonicalizeRecord } from './backup-document';
import type { RecoveryEntry } from './recovery-document';

/** A source record plus its (possibly migration-upgraded) current form. */
export type Anchored = { raw: unknown; record: unknown };

export type StageBInput = {
  settings: Anchored;
  lists: Anchored[];
  tasks: Anchored[];
  snapshots: Anchored[];
};

export type StageBOutput = {
  settings: Settings | null;
  lists: List[];
  tasks: Task[];
  /** Accepted metadata rows — informational only on import (never restored). */
  snapshots: Snapshot[];
  entries: RecoveryEntry[];
};

type Candidate<T> = {
  anchored: Anchored;
  id: string | null;
  issues: string[];
  accepted: T | null;
};

function idOf(record: unknown): string | null {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return null;
  const id = (record as Record<string, unknown>)['id'];
  return typeof id === 'string' ? id : null;
}

function collect<T>(
  store: 'settings' | 'lists' | 'tasks' | 'snapshots',
  items: Anchored[],
): Candidate<T>[] {
  const seen = new Set<string>();
  const out: Candidate<T>[] = [];
  for (const anchored of items) {
    const id = idOf(anchored.record);
    const issues: string[] = [];
    if (id !== null && seen.has(id)) {
      issues.push('duplicate id: later occurrence quarantined (first occurrence wins)');
    }
    const validated = validateRow(store, anchored.record);
    if (!validated.ok) issues.push(...validated.issues);
    if (id !== null) seen.add(id);
    let accepted: T | null = null;
    if (issues.length === 0) {
      accepted = canonicalizeRecord(store, anchored.record) as unknown as T;
    }
    out.push({ anchored, id, issues, accepted });
  }
  return out;
}

function propagateOrphans<T extends { id: string; listId?: string; parentTaskId?: string }>(
  candidates: Candidate<T>[],
): void {
  const alive = (): Set<string> =>
    new Set(
      candidates.filter((c) => c.issues.length === 0 && c.accepted !== null).map((c) => c.id ?? ''),
    );

  let changed = true;
  while (changed) {
    changed = false;
    const ids = alive();
    for (const c of candidates) {
      if (c.issues.length > 0 || c.accepted === null) continue;
      const parentId = c.accepted.parentTaskId;
      if (parentId !== undefined && !ids.has(parentId)) {
        c.issues.push('parentTaskId: references no accepted task record');
        c.accepted = null;
        changed = true;
      }
    }
  }
}

/** Mark every task that closes a parent chain cycle (iterative — no recursion). */
function markCycles(candidates: Candidate<Task>[]): void {
  const byId = new Map<string, Candidate<Task>>();
  for (const c of candidates) {
    if (c.issues.length === 0 && c.accepted !== null && c.id !== null) byId.set(c.id, c);
  }
  const state = new Map<string, 0 | 1 | 2>();
  for (const start of byId.keys()) {
    if (state.get(start) !== undefined && state.get(start) !== 0) continue;
    const path: string[] = [];
    let cur: string | undefined = start;
    while (cur !== undefined && (state.get(cur) ?? 0) === 0) {
      state.set(cur, 1);
      path.push(cur);
      cur = byId.get(cur)?.accepted?.parentTaskId;
    }
    if (cur !== undefined && state.get(cur) === 1) {
      const idx = path.indexOf(cur);
      for (const id of path.slice(idx === -1 ? 0 : idx)) {
        const c = byId.get(id);
        if (c !== undefined && c.issues.length === 0) {
          c.issues.push('parentTaskId: closes a cycle');
          c.accepted = null;
        }
      }
    }
    for (const id of path) state.set(id, 2);
  }
}

/**
 * Validate every record, then run the referential pass (Decision 6): tasks
 * pointing at quarantined lists/tasks, and parent chains that close a cycle,
 * are quarantined too — a corrupt record cascades to its unusable dependents.
 */
export function validateRecords(input: StageBInput): StageBOutput {
  const settingsCandidates = collect<Settings>('settings', [input.settings]);
  const listCandidates = collect<List>('lists', input.lists);
  const taskCandidates = collect<Task>('tasks', input.tasks);
  const snapshotCandidates = collect<Snapshot>('snapshots', input.snapshots);

  // Referential pass: tasks must reference accepted lists (tombstoned lists count).
  const listIds = new Set(
    listCandidates
      .filter((c) => c.issues.length === 0 && c.accepted !== null)
      .map((c) => c.id ?? ''),
  );
  for (const c of taskCandidates) {
    if (c.issues.length > 0 || c.accepted === null) continue;
    if (!listIds.has(c.accepted.listId)) {
      c.issues.push('listId: references no accepted list record');
      c.accepted = null;
    }
  }

  propagateOrphans(taskCandidates);
  markCycles(taskCandidates);
  propagateOrphans(taskCandidates);

  const entries: RecoveryEntry[] = [];
  const emit = (store: RecoveryEntry['store'], c: Candidate<unknown>): void => {
    if (c.issues.length === 0) return;
    entries.push({ store, id: c.id, issues: c.issues, raw: c.anchored.raw });
  };
  for (const c of settingsCandidates) emit('settings', c);
  for (const c of listCandidates) emit('lists', c);
  for (const c of taskCandidates) emit('tasks', c);
  for (const c of snapshotCandidates) emit('snapshots', c);

  const settingsAccepted = settingsCandidates.find(
    (c) => c.issues.length === 0 && c.accepted !== null,
  );
  return {
    settings: settingsAccepted?.accepted ?? null,
    lists: listCandidates.filter((c) => c.accepted !== null).map((c) => c.accepted as List),
    tasks: taskCandidates.filter((c) => c.accepted !== null).map((c) => c.accepted as Task),
    snapshots: snapshotCandidates
      .filter((c) => c.accepted !== null)
      .map((c) => c.accepted as Snapshot),
    entries,
  };
}
