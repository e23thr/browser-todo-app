/**
 * Editor edit sessions (ADR-005 Decision 7, E9) — the domain half of the update flow's
 * edit-protection contract, wired by the E2 core-UI composer/task editor (card t_fa3af43d).
 *
 * Division of labour, fixed by `src/app/update.ts`: the update flow OWNS the tracking
 * (`beginEdit` / `markEditPersisted` / the `registerEditFlusher` port) and sequences the
 * flush before its single deliberate `location.reload()`; this module owns WHAT a flush
 * means for the task editors — a durable ADR-002 write of the in-flight draft, its `Result`
 * mapped to the flusher's `{ok}` outcome — plus the `useEditSession` hook the components use
 * to declare "this draft is dirty, uncommitted content".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { editInFlight, getRegisteredEditFlusher } from '../../../src/app/update';
import {
  flushPendingEdits,
  openEditSession,
  pendingEditSessionCount,
  resetEditSessions,
} from '../../../src/features/tasks/editSession';

const flushed: Promise<{ ok: true }> = Promise.resolve({ ok: true });

/**
 * Drive the flush exactly the way `applyUpdate()` does — through the PORT the update flow
 * has registered (`registerEditFlusher`), never this module's internal alias (review D2).
 */
async function flushThroughUpdateFlow(): Promise<{ ok: boolean }> {
  const flusher = getRegisteredEditFlusher();
  if (flusher === null) throw new Error('the update flow has no flusher registered');
  return flusher();
}

beforeEach(() => {
  resetEditSessions();
});

afterEach(() => {
  resetEditSessions();
});

describe('edit sessions (Decision 7)', () => {
  it('tracks nothing and registers no flusher while every editor is clean', async () => {
    expect(editInFlight.value).toBe(false);
    expect(pendingEditSessionCount()).toBe(0);
    expect(getRegisteredEditFlusher()).toBeNull();
    // Nothing to flush -> trivially safe (the update flow only calls the flusher when an
    // edit is in flight, but the flush itself must never depend on that).
    await expect(flushPendingEdits()).resolves.toEqual({ ok: true });
  });

  it('marks an edit in flight and registers THE flusher while a session is open', () => {
    openEditSession(() => flushed);

    expect(editInFlight.value).toBe(true);
    expect(pendingEditSessionCount()).toBe(1);
    expect(getRegisteredEditFlusher()).not.toBeNull();
  });

  it('flushes the draft durably (Ok) and ends the session', async () => {
    const commit = vi.fn(() => flushed);
    openEditSession(commit);

    await expect(flushThroughUpdateFlow()).resolves.toEqual({ ok: true });
    expect(commit).toHaveBeenCalledTimes(1);

    // The edit is over: nothing in flight and the flusher released, so the conservative DOM
    // dirty-guard alone protects any editor that has not wired a session yet.
    expect(editInFlight.value).toBe(false);
    expect(pendingEditSessionCount()).toBe(0);
    expect(getRegisteredEditFlusher()).toBeNull();
  });

  it('aborts the flush on a failed commit (Err) and keeps the edit in flight', async () => {
    openEditSession(() => Promise.resolve({ ok: false }));

    await expect(flushThroughUpdateFlow()).resolves.toEqual({ ok: false });
    // Still in flight: the update flow must NOT reload over content it could not write.
    expect(editInFlight.value).toBe(true);
    expect(getRegisteredEditFlusher()).not.toBeNull();
  });

  it('treats a throwing commit as a failed flush — never a reload over lost content', async () => {
    openEditSession(() => Promise.reject(new Error('storage exploded')));

    await expect(flushThroughUpdateFlow()).resolves.toEqual({ ok: false });
    expect(editInFlight.value).toBe(true);
  });

  it('flushes every open draft and stops at the first failure', async () => {
    const order: string[] = [];
    openEditSession(() => {
      order.push('first');
      return flushed;
    });
    openEditSession(() => {
      order.push('second');
      return Promise.resolve({ ok: false });
    });
    const third = vi.fn(() => flushed);
    openEditSession(third);

    await expect(flushThroughUpdateFlow()).resolves.toEqual({ ok: false });
    expect(order).toEqual(['first', 'second']);
    expect(third).not.toHaveBeenCalled();
    expect(editInFlight.value).toBe(true);
  });

  it('keeps protecting the remaining drafts when one session ends early', () => {
    const first = openEditSession(() => flushed);
    openEditSession(() => flushed);

    // One editor resolves its edit (saved or discarded); the other is still uncommitted, so
    // the update flow must keep treating an edit as in flight.
    first();
    expect(pendingEditSessionCount()).toBe(1);
    expect(editInFlight.value).toBe(true);
    expect(getRegisteredEditFlusher()).not.toBeNull();
  });

  it('clears edit-in-flight only when the LAST session ends', () => {
    const first = openEditSession(() => flushed);
    const second = openEditSession(() => flushed);

    first();
    expect(editInFlight.value).toBe(true);

    second();
    expect(editInFlight.value).toBe(false);
    expect(pendingEditSessionCount()).toBe(0);
    expect(getRegisteredEditFlusher()).toBeNull();
  });

  it('reopens a fresh session after an end (composer: type -> discard -> type)', async () => {
    const first = openEditSession(() => flushed);
    first();

    const commit = vi.fn(() => flushed);
    openEditSession(commit);
    expect(editInFlight.value).toBe(true);

    await expect(flushThroughUpdateFlow()).resolves.toEqual({ ok: true });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(editInFlight.value).toBe(false);
  });

  it('ending the same session twice is a no-op', () => {
    const end = openEditSession(() => flushed);
    end();
    end();

    expect(pendingEditSessionCount()).toBe(0);
    expect(editInFlight.value).toBe(false);
  });

  it('resetEditSessions() closes everything (test seam)', () => {
    openEditSession(() => flushed);
    openEditSession(() => flushed);

    resetEditSessions();

    expect(pendingEditSessionCount()).toBe(0);
    expect(editInFlight.value).toBe(false);
    expect(getRegisteredEditFlusher()).toBeNull();
  });
});
