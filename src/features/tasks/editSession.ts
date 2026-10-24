/**
 * Edit sessions — the core-UI half of ADR-005 Decision 7's in-flight-edit contract (E9).
 *
 * Decision 7 defines an edit as in flight from `edit-begin` (dirty, uncommitted content)
 * until `edit-persisted` (the committing IDB transaction from the ADR-002 storage layer
 * acknowledged `Ok`). `src/app/update.ts` owns the tracking signals and sequences the update
 * toast's flush before its single deliberate `location.reload()`; this module owns WHAT a
 * flush means for the task editors:
 *
 *   - `useEditSession(dirty, commit)` — a composer/editor whose draft is dirty registers a
 *     session whose `commit()` is the durable ADR-002 write of that draft (`addTask` /
 *     `saveTask`, their `Result` mapped to the flusher's `{ok}` outcome). `applyUpdate()`
 *     awaits it before reloading (rule 2), and a failed commit ABORTS the reload with the
 *     draft untouched in the DOM.
 *   - The flusher is registered only while at least one session is open (house
 *     `register*`-port style, like `registerQuickAddHandler`). While no session is open the
 *     update flow falls back to the conservative DOM dirty-guard's refusal
 *     ("Save or discard your edit before updating."), so an editor that has NOT wired a
 *     session is still never reloaded over.
 *   - Ending the last session clears the edit-in-flight counter (`markEditPersisted`); an
 *     earlier end leaves it set. Over-protecting an edit is safe; under-protecting is not.
 *
 * Known limitation (documented per review N1): `registerEditFlusher` is a SINGLE slot, so
 * while a task draft is open a concurrent dirty draft in a surface without its own session
 * (e.g. a list-name dialog opened from the composer) is protected by the DOM dirty-guard,
 * but the registered flush only commits the task drafts — that sibling draft is still lost
 * if Apply proceeds. Closing it needs per-field ownership of the guard's dirty set, which
 * is a Decision-7 contract change (h_senior_coder's call), not a wiring decision; the
 * conservative refusal remains the behaviour whenever NO task draft is open.
 *
 * Session lifetime is driven by the components' `dirty` flag through the hook's effect, so
 * every ending is covered without extra call sites: a successful commit clears the draft
 * (dirty -> false), a discard clears or unmounts it, and a FAILED flush leaves the draft
 * dirty so the edit stays in flight.
 */

import { useEffect, useRef } from 'preact/hooks';

import {
  beginEdit,
  markEditPersisted,
  registerEditFlusher,
  type FlushOutcome,
} from '../../app/update';

/** The durable write of one editor's in-flight draft (ADR-002 `Result` -> `{ok}`). */
export type DraftCommit = () => Promise<FlushOutcome>;

const pending = new Map<number, DraftCommit>();
let nextSessionId = 0;
let disposeFlusher: (() => void) | null = null;

/**
 * THE registered flusher: commit every open draft in registration order and stop at the
 * first failure, so a reload only ever follows a fully durable write of all in-flight
 * edits (Decision 7 rule 2). A commit that acks `Ok` ENDS its session — that ack IS the
 * Decision 7 `edit-persisted` boundary. Never throws — an unexpected storage error is a
 * failed flush, not a reload over lost content.
 */
export async function flushPendingEdits(): Promise<FlushOutcome> {
  // Snapshot: a commit may open or close sessions while it runs (the composer clears its
  // draft, which ends its own session).
  for (const [id, commit] of [...pending.entries()]) {
    let outcome: FlushOutcome;
    try {
      outcome = await commit();
    } catch {
      return { ok: false };
    }
    if (!outcome.ok) return outcome;
    closeSession(id); // durable ack -> this edit is persisted; a later end() is a no-op
  }
  return { ok: true };
}

/** Remove a session; release the flusher and clear edit-in-flight only with the last one. */
function closeSession(id: number): void {
  if (!pending.delete(id)) return;
  if (pending.size > 0) return; // another draft is still uncommitted — keep protecting it
  disposeFlusher?.();
  disposeFlusher = null;
  markEditPersisted();
}

/**
 * Register an in-flight edit with the update flow and return its end routine (idempotent).
 * The first open registers the flusher; the last end releases it and clears the update
 * flow's edit-in-flight counter.
 */
export function openEditSession(commit: DraftCommit): () => void {
  const id = (nextSessionId += 1);
  pending.set(id, commit);
  beginEdit();
  if (disposeFlusher === null) disposeFlusher = registerEditFlusher(flushPendingEdits);

  let open = true;
  return () => {
    if (!open) return;
    open = false;
    closeSession(id);
  };
}

/**
 * Declare "this editor holds dirty, uncommitted content" for as long as `active` is true.
 * The session commits the CURRENT draft (the ref below), never the one captured when it
 * opened, and closes itself on unmount or when the draft becomes clean again.
 */
export function useEditSession(active: boolean, commit: DraftCommit): void {
  const commitRef = useRef(commit);
  commitRef.current = commit; // latest-ref: a flush always runs after the render that typed

  useEffect(() => {
    if (!active) return;
    return openEditSession(() => commitRef.current());
  }, [active]);
}

/* ------------------------------- test seams ------------------------------- */

/** How many editors currently hold an in-flight edit. */
export function pendingEditSessionCount(): number {
  return pending.size;
}

/** Close every session (component-test reset, mirroring `resetTaskStore`). */
export function resetEditSessions(): void {
  pending.clear();
  disposeFlusher?.();
  disposeFlusher = null;
  markEditPersisted();
}
