/**
 * Conflict-copy resolution bookkeeping (E8 S9) — the UI half of the PRE-DECIDED
 * §6.2 policy: the engine already resolved the records (LWW); the UI only
 * surfaces the copies and lets the user choose. It NEVER re-merges.
 *
 * All three actions are UI-level bookkeeping over ordinary task rows
 * (docs/dev/sync-engine-api.md §5):
 *  - keep both    → nothing is written;
 *  - keep the copy → delete the ORIGINAL row (tombstone path — it propagates);
 *  - discard the copy → delete the COPY row (same path).
 *
 * Deleting uses `mode: 'promote'`, never `cascade`: a resolve is a choice
 * between two versions of ONE task, so subtasks of the deleted row are
 * re-parented instead of silently destroyed with it.
 */

import { signal } from '@preact/signals';

import { ok, type AppError, type Result } from '../../domain/kernel';
import type { ConflictSummary } from '../../sync';
import { deleteTask } from '../tasks/store';

export type ResolveAction = 'keep-both' | 'keep-copy' | 'discard-copy';

/**
 * copyIds handled this session. Module-scoped (like the engine's in-memory
 * conflict list) so the accounting survives panel unmounts; acknowledged
 * together with the engine state and reset between tests.
 */
export const resolvedConflicts = signal<ReadonlySet<string>>(new Set());

/** Conflicts the user has not acted on yet, in engine order. */
export function unresolvedConflicts(conflicts: readonly ConflictSummary[]): ConflictSummary[] {
  const done = resolvedConflicts.value;
  return conflicts.filter((entry) => !done.has(entry.copyId));
}

export function markConflictResolved(copyId: string): void {
  resolvedConflicts.value = new Set(resolvedConflicts.value).add(copyId);
}

export function resetResolvedConflicts(): void {
  resolvedConflicts.value = new Set();
}

/**
 * Apply one resolve action. Returns the storage result so the caller can
 * announce success/failure — a failed delete must leave the conflict visible
 * (never a silent loss).
 */
export async function applyResolveAction(
  summary: ConflictSummary,
  action: ResolveAction,
): Promise<Result<void, AppError>> {
  if (action === 'keep-both') return ok(undefined);
  const target = action === 'keep-copy' ? summary.recordId : summary.copyId;
  const removed = await deleteTask(target, { mode: 'promote' });
  if (!removed.ok) return { ok: false, error: removed.error };
  return ok(undefined);
}
