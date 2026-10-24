/**
 * Core UI × update flow (ADR-005 Decision 7, E9) — the composer and the task editor open an
 * edit session whenever they hold dirty, uncommitted content, and the update flow's flush
 * commits that draft through the ADR-002 storage layer BEFORE its single deliberate reload
 * (card t_fa3af43d, replacing the E2E suite's former `#e2e-edit-standin` textarea).
 *
 * Everything runs against a real `MutationRunner` over in-memory ports (core-ui-harness), so
 * the flush IS the production write path — same optimistic-then-settle pipeline the rest of
 * the core-UI suites exercise — and `editInFlight` is the very signal `applyUpdate()` reads.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';

import { editInFlight, getRegisteredEditFlusher, type FlushOutcome } from '../../src/app/update';
import { Composer } from '../../src/features/tasks/Composer';
import { TaskEditor } from '../../src/features/tasks/TaskEditor';
import { resetEditSessions } from '../../src/features/tasks/editSession';
import { liveLists, resetTaskStore, state } from '../../src/features/tasks/store';
import { clearToasts } from '../../src/features/tasks/toasts';
import { makeList, makeTask, seed, setUpCoreUi, tearDownCoreUi } from './core-ui-harness';

beforeEach(() => {
  setUpCoreUi();
  resetEditSessions();
});

afterEach(() => {
  tearDownCoreUi();
  resetEditSessions();
  resetTaskStore();
  clearToasts();
});

/**
 * Flush exactly the way the update toast's Apply does: through the PORT registered with the
 * update flow (`registerEditFlusher`) — never the session module's internal alias (review D2).
 */
async function flushThroughUpdateFlow(): Promise<FlushOutcome> {
  const flusher = getRegisteredEditFlusher();
  if (flusher === null) throw new Error('the update flow has no flusher registered');
  return flusher();
}

describe('E9 — the composer draft is an in-flight edit that flushes durably', () => {
  it('opens a session on dirty content and flushes the draft as a real task', async () => {
    await seed({ lists: [makeList({ id: 'L1', name: 'Personal' })] });
    const view = render(<Composer variant="inline" />);

    const title = screen.getByLabelText<HTMLInputElement>('Title', { exact: true });
    expect(editInFlight.value).toBe(false);

    title.focus();
    fireEvent.input(title, { target: { value: 'Uncommitted draft' } });
    expect(editInFlight.value).toBe(true);
    expect(getRegisteredEditFlusher()).not.toBeNull();

    // What the update toast's Apply awaits before its deliberate reload (rule 2).
    await expect(flushThroughUpdateFlow()).resolves.toEqual({ ok: true });

    const flushed = [...state.value.tasks.values()].find(
      (task) => task.title === 'Uncommitted draft',
    );
    expect(flushed?.listId).toBe('L1');
    // The ack is the durable one: the pipeline settled, no write left pending.
    await waitFor(() => {
      expect(state.value.pending.size).toBe(0);
    });
    await waitFor(() => {
      expect(title.value).toBe('');
    });
    expect(editInFlight.value).toBe(false);
    view.unmount();
  });

  it('refuses the flush while the draft cannot be committed, and keeps it intact', async () => {
    await seed({ lists: [makeList({ id: 'L1', name: 'Personal' })] });
    const view = render(<Composer variant="inline" />);

    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const notes = screen.getByLabelText<HTMLTextAreaElement>('Notes', { exact: true });
    fireEvent.input(notes, { target: { value: 'notes with no title yet' } });
    expect(editInFlight.value).toBe(true);

    // No title -> no task can be written, so the flush FAILS instead of letting the reload
    // destroy the draft (Decision 7 rule 2: abort, edit untouched in the DOM).
    await expect(flushThroughUpdateFlow()).resolves.toEqual({ ok: false });
    expect(editInFlight.value).toBe(true);
    expect(getRegisteredEditFlusher()).not.toBeNull();
    expect(state.value.tasks.size).toBe(0);
    expect(notes.value).toBe('notes with no title yet');
    view.unmount();
  });

  it('ends the session when the draft is discarded (S7.3 confirm)', async () => {
    await seed({ lists: [makeList({ id: 'L1', name: 'Personal' })] });
    const view = render(<Composer variant="inline" />);

    const title = screen.getByLabelText<HTMLInputElement>('Title', { exact: true });
    fireEvent.input(title, { target: { value: 'typed then discarded' } });
    expect(editInFlight.value).toBe(true);

    fireEvent.keyDown(title, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(editInFlight.value).toBe(false);
    expect(getRegisteredEditFlusher()).toBeNull();
    expect(state.value.tasks.size).toBe(0);
    view.unmount();
  });

  it('flushes the CURRENT draft after type -> clear -> type again (regression)', async () => {
    // Review N: the DOM guard's baseline is captured once per element, so a field that is
    // cleared and retyped must still flush the SECOND text — and the clean transition in
    // between (session closed, counter cleared) must not wedge or lose the new session.
    await seed({ lists: [makeList({ id: 'L1', name: 'Personal' })] });
    const view = render(<Composer variant="inline" />);

    const title = screen.getByLabelText<HTMLInputElement>('Title', { exact: true });
    title.focus();
    fireEvent.input(title, { target: { value: 'first attempt' } });
    expect(editInFlight.value).toBe(true);

    fireEvent.input(title, { target: { value: '' } }); // back to the baseline: clean again
    expect(editInFlight.value).toBe(false);
    expect(getRegisteredEditFlusher()).toBeNull();

    fireEvent.input(title, { target: { value: 'second attempt' } });
    expect(editInFlight.value).toBe(true);

    await expect(flushThroughUpdateFlow()).resolves.toEqual({ ok: true });

    const titles = [...state.value.tasks.values()].map((task) => task.title);
    expect(titles).toEqual(['second attempt']);
    expect(editInFlight.value).toBe(false);
    view.unmount();
  });
});

describe('E9 — the task editor patch is an in-flight edit that flushes durably', () => {
  it('opens a session while dirty and flushes the edit as a durable save', async () => {
    await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' })],
      tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Original title' })],
    });
    const task = state.value.tasks.get('T1');
    const view = render(
      <TaskEditor
        task={task!}
        lists={liveLists(state.value)}
        onClose={() => {
          view.unmount();
        }}
      />,
    );

    const title = screen.getByLabelText<HTMLInputElement>('Title', { exact: true });
    fireEvent.input(title, { target: { value: 'Edited mid-update' } });
    expect(editInFlight.value).toBe(true);

    await expect(flushThroughUpdateFlow()).resolves.toEqual({ ok: true });

    expect(state.value.tasks.get('T1')?.title).toBe('Edited mid-update');
    await waitFor(() => {
      expect(state.value.pending.size).toBe(0);
    });
    expect(editInFlight.value).toBe(false);
    view.unmount();
  });

  it('refuses the flush for an unsavable edit and keeps the state unchanged', async () => {
    await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' })],
      tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Original title' })],
    });
    const task = state.value.tasks.get('T1');
    const onClose = (): void => undefined;
    const view = render(
      <TaskEditor task={task!} lists={liveLists(state.value)} onClose={onClose} />,
    );

    const title = screen.getByLabelText<HTMLInputElement>('Title', { exact: true });
    fireEvent.input(title, { target: { value: '   ' } }); // invalid: Save is disabled
    expect(editInFlight.value).toBe(true);

    await expect(flushThroughUpdateFlow()).resolves.toEqual({ ok: false });
    expect(editInFlight.value).toBe(true);
    expect(state.value.tasks.get('T1')?.title).toBe('Original title');
    view.unmount();
  });

  it('ends the session when the edit is discarded (S7.3 confirm)', async () => {
    await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' })],
      tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'keep me' })],
    });
    const task = state.value.tasks.get('T1');
    const view = render(
      <TaskEditor
        task={task!}
        lists={liveLists(state.value)}
        onClose={() => {
          view.unmount();
        }}
      />,
    );

    fireEvent.input(screen.getByLabelText<HTMLInputElement>('Title', { exact: true }), {
      target: { value: 'changed' },
    });
    expect(editInFlight.value).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const confirm = await screen.findByRole('dialog', { name: 'Discard changes?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Discard' }));

    await waitFor(() => {
      expect(editInFlight.value).toBe(false);
    });
    expect(getRegisteredEditFlusher()).toBeNull();
    expect(state.value.tasks.get('T1')?.title).toBe('keep me');
    view.unmount();
  });

  it('ends the session when the edit saves successfully (ack Ok)', async () => {
    await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' })],
      tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Original title' })],
    });
    const task = state.value.tasks.get('T1');
    const view = render(
      <TaskEditor
        task={task!}
        lists={liveLists(state.value)}
        onClose={() => {
          view.unmount();
        }}
      />,
    );

    fireEvent.input(screen.getByLabelText<HTMLInputElement>('Title', { exact: true }), {
      target: { value: 'Saved title' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(state.value.tasks.get('T1')?.title).toBe('Saved title');
    });
    await waitFor(() => {
      expect(editInFlight.value).toBe(false);
    });
    expect(getRegisteredEditFlusher()).toBeNull();
    view.unmount();
  });
});
