/**
 * Maintained search-index singleton for the M5 search view (ADR-003 Decision 6,
 * docs/dev/domain-api.md §5 "Build is off the first-paint path — lazy on first
 * search open — UI card").
 *
 * The domain `SearchIndex` is the query engine (word-prefix AND over title +
 * notes, monotone keystroke narrowing). This module keeps it in sync with the
 * store's `State`:
 *
 *   - `searchIndexFor(state)` builds lazily on FIRST use (first search open —
 *     never on the app's first-paint path), then diffs the task map ONCE per
 *     `state.version` change (object-identity diff, O(live tasks), microseconds
 *     at 10k) and applies incremental `upsert`/`remove`.
 *   - Query keystrokes never touch this module beyond `state.version` reads:
 *     the view passes the previous hits into `index.search(query, previous)`
 *     for monotone narrowing.
 *
 * `resetSearchIndexForTest()` exists for component tests (fresh corpus per
 * suite) — production has exactly one index for the tab's lifetime.
 */

import { SearchIndex } from '../../domain/search';
import type { Task } from '../../domain/model';
import type { State } from '../../domain/state';

let index: SearchIndex | null = null;
let syncedVersion = -1;
let syncedIds = new Map<string, Task>();

function liveTasks(state: State): Map<string, Task> {
  const out = new Map<string, Task>();
  for (const task of state.tasks.values()) {
    if (task.deletedAt !== null) continue;
    if (!state.lists.has(task.listId)) continue;
    out.set(task.id, task);
  }
  return out;
}

/**
 * The store-backed index for `state`. First call builds from scratch; later
 * calls re-sync incrementally when (and only when) the state version moved.
 */
export function searchIndexFor(state: State): SearchIndex {
  const current = index === null ? new SearchIndex() : index;
  const tasks = liveTasks(state);

  if (index === null || state.version !== syncedVersion) {
    for (const [id, task] of tasks) {
      const previous = syncedIds.get(id);
      if (previous === undefined || previous !== task) current.upsert(task);
    }
    for (const id of syncedIds.keys()) {
      if (!tasks.has(id)) current.remove(id);
    }
    index = current;
    syncedIds = tasks;
    syncedVersion = state.version;
  }
  return current;
}

/** Drop the singleton (component tests between corpora). */
export function resetSearchIndexForTest(): void {
  index = null;
  syncedIds = new Map();
  syncedVersion = -1;
}
