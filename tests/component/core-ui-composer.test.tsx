/**
 * Core UI component tests — composer (design §7 S3 / flow F1) and task editor (§7 S4 / F2).
 *
 * Everything runs against a real `MutationRunner` over in-memory ports (fixtures.ts), so the
 * optimistic-then-settle path, rollback and announcements are the production ones. Announcements
 * are asserted through the mounted live regions after the 60 ms region delay.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';

import { Composer } from '../../src/features/tasks/Composer';
import { TaskEditor } from '../../src/features/tasks/TaskEditor';
import { ToastHost } from '../../src/features/tasks/ToastHost';
import { t } from '../../src/app/i18n';
import { resetPersistGate } from '../../src/features/data-safety/persistGate';
import {
  addTask,
  bindRunnerForTest,
  liveLists,
  resetTaskStore,
  state,
} from '../../src/features/tasks/store';
import { clearToasts } from '../../src/features/tasks/toasts';
import {
  makeList,
  makeTask,
  makeTestRunner,
  regions,
  seed,
  setUpCoreUi,
  tearDownCoreUi,
} from './core-ui-harness';

/**
 * Whatever the browser reports about `persist()`, the first-write notice announces one of
 * these three — the assertion must not depend on which state a given environment lands on.
 */
const persistenceNotices = (): string[] => [
  t('dataSafety.persistence.announcedGranted'),
  t('dataSafety.persistence.announcedDenied'),
  t('dataSafety.persistence.unsupported'),
];

beforeEach(() => {
  setUpCoreUi();
});

afterEach(() => {
  tearDownCoreUi();
  resetTaskStore();
  clearToasts();
});

describe('S3 composer — F1 capture', () => {
  it('saves on Enter, clears and stays focused, and announces the task', async () => {
    await seed({ lists: [makeList({ id: 'L1', name: 'Personal' })] });
    const view = render(<Composer variant="inline" />);

    const title = screen.getByLabelText<HTMLInputElement>('Title', { exact: true });
    title.focus();
    fireEvent.input(title, { target: { value: 'Buy milk' } });
    fireEvent.keyDown(title, { key: 'Enter' });

    // Optimistic: the record is in state before any write settles (add -> visible < 100 ms).
    const added = [...state.value.tasks.values()].find((task) => task.title === 'Buy milk');
    expect(added).toBeTruthy();
    expect(added?.listId).toBe('L1');

    // D6: input cleared synchronously and focus kept for back-to-back capture.
    expect(title.value).toBe('');
    expect(document.activeElement).toBe(title);

    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('Task added: Buy milk');
    });
    // Write settles: pending cleared, authoritative row present in state.
    await waitFor(() => {
      expect(state.value.pending.size).toBe(0);
    });
    view.unmount();
  });

  it("first capture: E3's first-write notice never swallows the task-added announcement", async () => {
    // Run the once-per-session §5.5 gate inside THIS capture, whatever ran before.
    resetPersistGate();
    await seed({ lists: [makeList({ id: 'L1', name: 'Personal' })] });
    const view = render(<Composer variant="inline" />);

    const title = screen.getByLabelText<HTMLInputElement>('Title', { exact: true });
    title.focus();
    fireEvent.input(title, { target: { value: 'First capture' } });
    fireEvent.keyDown(title, { key: 'Enter' });

    // M13-B1 / E2 F-1: the gate's announce fired in the same tick as this one and used to
    // cancel it inside the 60 ms window — the capture confirmation must still land first.
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('Task added: First capture');
    });
    // …and the persistence notice still reaches the user, after it rather than instead of it.
    await waitFor(
      () => {
        expect(persistenceNotices()).toContain(regions.polite?.textContent ?? '');
      },
      { timeout: 2000, interval: 50 },
    );
    view.unmount();
  });

  it('shows the linked validation error for an empty title', async () => {
    await seed({ lists: [makeList({ id: 'L1' })] });
    render(<Composer variant="inline" />);

    const title = screen.getByLabelText<HTMLInputElement>('Title', { exact: true });
    fireEvent.keyDown(title, { key: 'Enter' });

    const error = screen.getByText('Enter a title', { exact: true });
    expect(error.getAttribute('role')).toBe('alert');
    expect(title.getAttribute('aria-describedby')).toBe(error.id);
    expect(title.getAttribute('aria-invalid')).toBe('true');
    expect(state.value.tasks.size).toBe(0);
  });

  it('disables every input when no list exists and offers "New list"', async () => {
    await seed({ lists: [] });
    render(<Composer variant="inline" />);

    expect(screen.getByLabelText<HTMLInputElement>('Title', { exact: true }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Add' })).toHaveProperty('disabled', true);
    expect(
      screen.getByText('Create a list first — tasks live in lists.', { exact: true }),
    ).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'New list' }).length).toBeGreaterThan(0);
  });

  it('expands to the detail fields and Shift+Enter saves and collapses', async () => {
    await seed({ lists: [makeList({ id: 'L1', name: 'Personal' })] });
    render(<Composer variant="inline" />);

    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByLabelText('Notes', { exact: true })).toBeTruthy();
    expect(screen.getByLabelText('Due date', { exact: true })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Priority' })).toBeTruthy();

    fireEvent.input(screen.getByLabelText<HTMLInputElement>('Title', { exact: true }), {
      target: { value: 'Ship it' },
    });
    fireEvent.keyDown(screen.getByLabelText<HTMLInputElement>('Title', { exact: true }), {
      key: 'Enter',
      shiftKey: true,
    });

    expect([...state.value.tasks.values()].some((task) => task.title === 'Ship it')).toBe(true);
    expect(screen.getByRole('button', { name: 'Details' })).toBeTruthy();
    expect(screen.queryByLabelText('Notes', { exact: true })).toBeNull();
  });

  it('asks the discard confirm when Escape is pressed with a dirty draft (S7.3)', async () => {
    await seed({ lists: [makeList({ id: 'L1' })] });
    render(<Composer variant="inline" />);

    const title = screen.getByLabelText<HTMLInputElement>('Title', { exact: true });
    fireEvent.input(title, { target: { value: 'draft' } });
    fireEvent.keyDown(title, { key: 'Escape' });

    const dialog = await screen.findByRole('dialog');
    // §16-17 / S7.3: the composer asks the register's DRAFT variant ("Discard draft?"),
    // not the TaskEditor's generic `confirm.discard.title` ("Discard changes?").
    expect(within(dialog).getByRole('heading', { name: 'Discard draft?' })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(title.value).toBe('draft');

    fireEvent.keyDown(title, { key: 'Escape' });
    const again = await screen.findByRole('dialog');
    fireEvent.click(within(again).getByRole('button', { name: 'Discard' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(state.value.tasks.size).toBe(0);
  });
});

describe('S4 task editor — F2 edit', () => {
  it('saves every field in one action, closes and announces "Task saved"', async () => {
    await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' }), makeList({ id: 'L2', name: 'Work' })],
      tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Old title', notes: 'old' })],
    });
    const task = state.value.tasks.get('T1');
    expect(task).toBeTruthy();

    const onClose = vi.fn();
    render(<TaskEditor task={task!} lists={liveLists(state.value)} onClose={onClose} />);

    const title = screen.getByLabelText<HTMLInputElement>('Title', { exact: true });
    expect(title.value).toBe('Old title');

    fireEvent.input(title, { target: { value: 'New title' } });
    fireEvent.input(screen.getByLabelText<HTMLTextAreaElement>('Notes', { exact: true }), {
      target: { value: 'fresh notes' },
    });
    // A list change rides the same Save (two domain writes, one optimistic paint).
    fireEvent.change(screen.getByLabelText<HTMLSelectElement>('List', { exact: true }), {
      target: { value: 'L2' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'P1 (High)' }));

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });

    const saved = state.value.tasks.get('T1');
    expect(saved?.title).toBe('New title');
    expect(saved?.notes).toBe('fresh notes');
    expect(saved?.listId).toBe('L2');
    expect(saved?.priority).toBe('P1');
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('Task saved');
    });
  });

  it('blocks Save while the title is empty and links the error', async () => {
    await seed({ lists: [makeList({ id: 'L1' })], tasks: [makeTask({ id: 'T1', title: 'x' })] });
    const task = state.value.tasks.get('T1');
    render(<TaskEditor task={task!} lists={liveLists(state.value)} onClose={vi.fn()} />);

    const title = screen.getByLabelText<HTMLInputElement>('Title', { exact: true });
    fireEvent.input(title, { target: { value: '   ' } });

    const editor = screen.getByRole('dialog', { name: 'Edit task' });
    const error = within(editor).getByRole('alert');
    expect(error.textContent).toBe('Enter a title');
    expect(title.getAttribute('aria-describedby')).toBe(error.id);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
  });

  it('asks S7.3 before closing dirty, and Discard closes without saving', async () => {
    await seed({
      lists: [makeList({ id: 'L1' })],
      tasks: [makeTask({ id: 'T1', title: 'keep me' })],
    });
    const task = state.value.tasks.get('T1');
    const onClose = vi.fn();
    render(<TaskEditor task={task!} lists={liveLists(state.value)} onClose={onClose} />);

    fireEvent.input(screen.getByLabelText<HTMLInputElement>('Title', { exact: true }), {
      target: { value: 'changed' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    const confirm = await screen.findByRole('dialog', { name: 'Discard changes?' });
    expect(within(confirm).getByRole('button', { name: 'Keep editing' })).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep editing' }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const second = await screen.findByRole('dialog', { name: 'Discard changes?' });
    fireEvent.click(within(second).getByRole('button', { name: 'Discard' }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(state.value.tasks.get('T1')?.title).toBe('keep me');
  });

  it('deletes immediately — the S7.1 undo toast names the task in place of the confirm', async () => {
    await seed({
      lists: [makeList({ id: 'L1' })],
      tasks: [makeTask({ id: 'T1', title: 'Buy milk' })],
    });
    const task = state.value.tasks.get('T1');
    const onClose = vi.fn();
    render(<TaskEditor task={task!} lists={liveLists(state.value)} onClose={onClose} />);
    render(<ToastHost />); // the App hosts this; the undo toast needs it mounted

    fireEvent.click(screen.getByRole('button', { name: 'Delete task' }));

    // S7.1 binding (t_1b9ee0e6): no confirm dialog — the undo toast IS the confirm,
    // and it names the task the way the confirm body used to.
    expect(screen.queryByRole('dialog', { name: 'Delete task?' })).toBeNull();
    await waitFor(() => {
      expect(state.value.tasks.has('T1')).toBe(false);
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    const message = await screen.findByText('Deleted "Buy milk"', { exact: true });
    expect(message).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('Task deleted');
    });
  });

  it('shows read-only completion info on a completed task and still allows saving', async () => {
    await seed({
      lists: [makeList({ id: 'L1' })],
      tasks: [makeTask({ id: 'T1', title: 'Done thing', status: 'done', completedAt: Date.now() })],
    });
    const task = state.value.tasks.get('T1');
    render(<TaskEditor task={task!} lists={liveLists(state.value)} onClose={vi.fn()} />);

    expect(screen.getByTestId('completed-on').textContent).toMatch(/^Completed on /u);

    fireEvent.input(screen.getByLabelText<HTMLInputElement>('Title', { exact: true }), {
      target: { value: 'Renamed done' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(state.value.tasks.get('T1')?.title).toBe('Renamed done');
    });
  });

  it('disables Save with error.taskGone when the task vanished (other tab)', async () => {
    await seed({ lists: [makeList({ id: 'L1' })], tasks: [makeTask({ id: 'T1', title: 'gone' })] });
    const task = state.value.tasks.get('T1')!;
    render(<TaskEditor task={task} lists={liveLists(state.value)} onClose={vi.fn()} />);

    // Concurrent delete in another tab: rebind to a store snapshot without the record.
    bindRunnerForTest(makeTestRunner({ lists: [makeList({ id: 'L1' })], tasks: [] }).runner);

    // Signal-driven re-renders flush on a microtask — waitFor both the message and Save.
    await waitFor(() => {
      const editor = screen.getByRole('dialog', { name: 'Edit task' });
      expect(within(editor).getByRole('alert').textContent).toBe('This task no longer exists');
    });
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
  });
});

/* --------------------------- E2 core-UI review rework (N1 / N2) --------------------------- */

describe('E2 review rework — composer default list & draft discard', () => {
  it('N1: the default list falls back to the LAST-USED list, not the first one (F1.4 / §16-14)', async () => {
    await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' }), makeList({ id: 'L2', name: 'Work' })],
    });

    // Nothing used yet: first live list, as before. (The picker lives in Details.)
    const before = render(<Composer variant="inline" />);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByRole('combobox', { name: 'List' })).toHaveProperty('value', 'L1');
    before.unmount();

    // A task lands in the second list — that becomes the last-used list.
    const added = await addTask({
      title: 'Belongs to Work',
      notes: null,
      dueDate: null,
      listId: 'L2',
      priority: 'P3',
      tags: [],
    });
    expect(added.ok).toBe(true);

    const after = render(<Composer variant="inline" />);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByRole('combobox', { name: 'List' })).toHaveProperty('value', 'L2');
    after.unmount();
  });

  it('N2: a LIST-ONLY pick is a dirty draft and asks the DRAFT confirm on Escape (§16-17)', async () => {
    await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' }), makeList({ id: 'L2', name: 'Work' })],
    });
    render(<Composer variant="inline" />);

    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const title = screen.getByLabelText<HTMLInputElement>('Title', { exact: true });
    // No text at all — only the list pick differs from the default.
    fireEvent.change(screen.getByRole('combobox', { name: 'List' }), {
      target: { value: 'L2' },
    });
    fireEvent.keyDown(title, { key: 'Escape' });

    const dialog = await screen.findByRole('dialog', { name: 'Discard draft?' });
    expect(within(dialog).getByRole('button', { name: 'Keep editing' })).toBeTruthy();

    // Discarding drops the pick with the draft: the next Escape is clean (no re-ask).
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    fireEvent.keyDown(title, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});
