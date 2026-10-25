/**
 * E7 UI flows (S1 tags, S2 subtasks, S3 priority) — component-level proof for
 * the acceptance criteria: tags create/rename/delete + filter, single-level
 * subtasks (create/navigate/complete) incl. the parent-deletion disposition
 * dialog, and the four-level priority model with per-level sorting.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';

import { TaskScreen } from '../../src/features/tasks/TaskScreen';
import { ToastHost } from '../../src/features/tasks/ToastHost';
import { resetTaskStore, sortMode, tagFilter } from '../../src/features/tasks/store';
import { clearToasts } from '../../src/features/tasks/toasts';
import { makeList, makeTask, seed, setUpCoreUi, tearDownCoreUi } from './core-ui-harness';

function renderAllOpen(): ReturnType<typeof render> {
  return render(
    <>
      <ToastHost />
      <TaskScreen
        view={{ kind: 'allOpen' }}
        title="All open"
        emptyIcon="file-text"
        emptyTitle="No open tasks"
        emptyBody="Tasks you add will show up here."
      />
    </>,
  );
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-task-id]')];
}

beforeEach(() => {
  setUpCoreUi();
  tagFilter.value = null;
  sortMode.value = 'manual';
});

afterEach(() => {
  tearDownCoreUi();
  resetTaskStore();
  clearToasts();
});

describe('S3 priority model (P1..P4)', () => {
  it('edits the four levels in the editor and shows the level badge on the row', async () => {
    const h = await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' })],
      tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Ship it', priority: 'P4' })],
    });
    renderAllOpen();
    // P4 = no chip on the row.
    expect(screen.queryByRole('img', { name: 'P4 (None)' })).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: 'Ship it' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'P1 (High)' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(h.tasks.get('T1')?.priority).toBe('P1');
    });
    await screen.findByRole('img', { name: 'P1 (High)' });
  });

  it('sorts the view per level (P1 first) and disables manual reorder while sorted', async () => {
    await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' })],
      tasks: [
        makeTask({ id: 'T1', listId: 'L1', title: 'None', priority: 'P4', sortOrder: 'h' }),
        makeTask({ id: 'T2', listId: 'L1', title: 'Urgent', priority: 'P1', sortOrder: 'i' }),
        makeTask({ id: 'T3', listId: 'L1', title: 'Medium', priority: 'P2', sortOrder: 'j' }),
      ],
    });
    renderAllOpen();
    const titles = (): (string | null | undefined)[] =>
      rows().map((row) => row.querySelector('.task-title')?.textContent);

    expect(titles()).toEqual(['None', 'Urgent', 'Medium']);

    const sortSelect = await screen.findByTestId('sort-mode');
    fireEvent.change(sortSelect, { target: { value: 'priority' } });
    await waitFor(() => {
      expect(titles()).toEqual(['Urgent', 'Medium', 'None']);
    });

    // Sorted = derived order: the row menu offers no Move up/down items.
    const menuTrigger = await screen.findByRole('button', { name: 'Actions for "Urgent"' });
    fireEvent.click(menuTrigger);
    const menu = await screen.findByRole('menu');
    const labels = within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent);
    expect(labels).not.toContain('Move up');
    expect(labels).not.toContain('Move down');
  });
});

describe('S1 tags — create, filter, rename, delete', () => {
  it('attaches a tag in the editor and filters the view by it', async () => {
    const h = await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' })],
      tasks: [
        makeTask({ id: 'T1', listId: 'L1', title: 'Tagged' }),
        makeTask({ id: 'T2', listId: 'L1', title: 'Untagged' }),
      ],
    });
    renderAllOpen();

    fireEvent.click(await screen.findByRole('button', { name: 'Tagged' }));
    const dialog = await screen.findByRole('dialog');
    const tagInput = within(dialog).getByPlaceholderText('Add a tag…', { exact: true });
    fireEvent.input(tagInput, { target: { value: 'work' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    // Chip appears before saving (dirty state).
    await within(dialog).findByRole('button', { name: 'Remove tag work' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(h.tasks.get('T1')?.tags).toEqual(['work']);
    });

    // The filter narrows the view to the tagged task only.
    const filter = await screen.findByTestId('tag-filter');
    fireEvent.change(filter, { target: { value: 'work' } });
    await waitFor(() => {
      expect(rows().map((row) => row.getAttribute('data-task-id'))).toEqual(['T1']);
    });
    fireEvent.change(filter, { target: { value: '' } });
    await waitFor(() => {
      expect(rows()).toHaveLength(2);
    });
  });

  it('renames and deletes tags from the manage dialog (sweep over tasks)', async () => {
    const h = await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' })],
      tasks: [
        makeTask({ id: 'T1', listId: 'L1', title: 'One', tags: ['work'] }),
        makeTask({ id: 'T2', listId: 'L1', title: 'Two', tags: ['work', 'home'] }),
      ],
    });
    renderAllOpen();

    fireEvent.click(await screen.findByRole('button', { name: 'Manage tags' }));
    const dialog = await screen.findByRole('dialog');
    const tagRows = within(dialog).getAllByRole('listitem');
    const workRow = tagRows.find((row) => row.textContent.startsWith('work'));
    expect(workRow).toBeDefined();

    // Rename work -> office (propagates to every task carrying it).
    fireEvent.click(within(workRow as HTMLElement).getByRole('button', { name: 'Rename' }));
    const renameInput = within(dialog).getByLabelText('Rename', { exact: true });
    fireEvent.input(renameInput, { target: { value: 'office' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(h.tasks.get('T1')?.tags).toEqual(['office']);
      expect(h.tasks.get('T2')?.tags).toEqual(['office', 'home']);
    });

    // Delete home -> removed everywhere, tasks kept.
    await waitFor(() => {
      expect(
        within(dialog)
          .getAllByRole('listitem')
          .some((row) => row.textContent.startsWith('home')),
      ).toBe(true);
    });
    const homeRow = within(dialog)
      .getAllByRole('listitem')
      .find((row) => row.textContent.startsWith('home'));
    fireEvent.click(within(homeRow as HTMLElement).getByRole('button', { name: 'Delete' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete tag?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete tag' }));
    await waitFor(() => {
      expect(h.tasks.get('T2')?.tags).toEqual(['office']);
    });
  });
});

describe('S2 subtasks — create, navigate, complete, disposition', () => {
  it('creates a subtask from the editor and completes it independently', async () => {
    const h = await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' })],
      tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Parent' })],
    });
    renderAllOpen();

    fireEvent.click(await screen.findByRole('button', { name: 'Parent' }));
    const dialog = await screen.findByRole('dialog');
    const subtaskInput = within(dialog).getByLabelText('Add subtask', { exact: true });
    fireEvent.input(subtaskInput, { target: { value: 'Step one' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add subtask' }));

    await waitFor(() => {
      expect(within(dialog).getByText('Step one', { exact: true })).toBeTruthy();
    });
    // Created in the same list, one level deep.
    const created = [...h.tasks.values()].find((task) => task.title === 'Step one');
    expect(created?.parentTaskId).toBe('T1');
    expect(created?.listId).toBe('L1');

    // Independent completion: the subtask toggles without touching the parent.
    const subtaskRow = within(dialog)
      .getAllByRole('listitem')
      .find((row) => row.textContent.includes('Step one'));
    const checkbox = within(subtaskRow as HTMLElement).getByRole('checkbox');
    fireEvent.click(checkbox);
    await waitFor(() => {
      expect([...h.tasks.values()].find((task) => task.title === 'Step one')?.status).toBe('done');
    });
    expect(h.tasks.get('T1')?.status).toBe('open');

    // Navigate: the subtask title opens ITS editor (depth guard: no subtasks section).
    fireEvent.click(within(subtaskRow as HTMLElement).getByRole('button', { name: 'Step one' }));
    const subtaskDialog = await screen.findByRole('dialog');
    expect(within(subtaskDialog).queryByLabelText('Add subtask', { exact: true })).toBeNull();
  });

  it('offers the disposition dialog when deleting a parent (cascade vs promote)', async () => {
    const h = await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' })],
      tasks: [
        makeTask({ id: 'T1', listId: 'L1', title: 'Parent' }),
        makeTask({ id: 'C1', listId: 'L1', title: 'Kid one', parentTaskId: 'T1' }),
        makeTask({ id: 'C2', listId: 'L1', title: 'Kid two', parentTaskId: 'T1' }),
      ],
    });
    renderAllOpen();

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for "Parent"' }));
    const menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog');
    // Default disposition = promote (subtasks keep living).
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(h.tasks.has('T1')).toBe(false);
    });
    expect(h.tasks.get('C1')?.parentTaskId).toBeUndefined();
    expect(h.tasks.get('C2')?.parentTaskId).toBeUndefined();
    expect(h.tasks.get('C1')?.listId).toBe('L1');
  });

  it('deletes subtasks too when the cascade option is chosen', async () => {
    const h = await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' })],
      tasks: [
        makeTask({ id: 'T1', listId: 'L1', title: 'Parent' }),
        makeTask({ id: 'C1', listId: 'L1', title: 'Kid one', parentTaskId: 'T1' }),
        makeTask({ id: 'C2', listId: 'L1', title: 'Kid two', parentTaskId: 'T1' }),
      ],
    });
    renderAllOpen();

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for "Parent"' }));
    const menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Also delete 2 subtasks' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect([...h.tasks.keys()]).toEqual([]);
    });
  });
});
