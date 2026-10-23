/**
 * Core UI component tests — lists management (design §7 S6 / flows F5, F6):
 * create, rename (inline on compact), Alt+↑/↓ reorder with announcements, and the
 * delete-with-task-disposition confirm (S7.2) in both modes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';

import { ListsManageView } from '../../src/features/lists/ListsManageView';
import { resetTaskStore, state } from '../../src/features/tasks/store';
import { clearToasts } from '../../src/features/tasks/toasts';
import { makeList, makeTask, regions, seed, setUpCoreUi, tearDownCoreUi } from './core-ui-harness';

function liveListIds(): string[] {
  return [...state.value.lists.values()]
    .filter((list) => list.deletedAt === null)
    .sort((a, b) => (a.sortOrder < b.sortOrder ? -1 : 1))
    .map((list) => list.id);
}

function openRowMenu(name: string): Promise<HTMLElement> {
  return screen.findByRole('button', { name }).then(async (trigger) => {
    fireEvent.click(trigger);
    return screen.findByRole('menu');
  });
}

beforeEach(() => {
  setUpCoreUi();
});

afterEach(() => {
  tearDownCoreUi();
  resetTaskStore();
  clearToasts();
});

describe('S6 lists — create & rename (F5)', () => {
  it('shows the documented empty state with the New list action', async () => {
    await seed({ lists: [] });
    render(<ListsManageView />);
    expect(await screen.findByRole('heading', { level: 2, name: 'No lists yet' })).toBeTruthy();
    expect(
      screen.getByText('Tasks live in lists. Create your first list to start.', { exact: true }),
    ).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'New list' }).length).toBeGreaterThan(0);
  });

  it('creates a list through the dialog with D10 validation', async () => {
    await seed({ lists: [makeList({ id: 'L1', name: 'Personal' })] });
    render(<ListsManageView />);

    fireEvent.click(await screen.findByRole('button', { name: 'New list' }));
    const dialog = await screen.findByRole('dialog', { name: 'New list' });
    const input = within(dialog).getByLabelText<HTMLInputElement>('List name', { exact: true });
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save.hasAttribute('disabled')).toBe(true);

    // Duplicate name (case-insensitive, D10) — error after blur, Save stays off.
    fireEvent.input(input, { target: { value: 'personal' } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(within(dialog).getByRole('alert').textContent).toBe(
        'A list with this name already exists',
      );
    });
    expect(save.hasAttribute('disabled')).toBe(true);

    // Too long (61 chars) after fixing the duplicate.
    fireEvent.input(input, { target: { value: 'x'.repeat(61) } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(within(dialog).getByRole('alert').textContent).toBe('Use 60 characters or fewer');
    });

    fireEvent.input(input, { target: { value: 'Work' } });
    await waitFor(() => {
      expect(save.hasAttribute('disabled')).toBe(false);
    });
    fireEvent.click(save);

    const created = await waitFor(() => {
      const list = [...state.value.lists.values()].find((l) => l.name === 'Work');
      expect(list).toBeTruthy();
      return list as { id: string };
    });
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('List created: Work');
    });
    // Appended at the end of the list order (F5.1).
    expect(liveListIds()).toEqual(['L1', created.id]);
  });

  it('renames inline on compact screens: Enter saves, Escape cancels (F5.2)', async () => {
    await seed({ lists: [makeList({ id: 'L1', name: 'Personal' })] });
    render(<ListsManageView />);

    const menu = await openRowMenu('Actions for "Personal"');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Rename' }));

    const input = await screen.findByLabelText('List name', { exact: true });
    expect((input as HTMLInputElement).value).toBe('Personal');

    // Escape cancels: reopen and cancel first.
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByLabelText('List name', { exact: true })).toBeNull();
    });
    expect(state.value.lists.get('L1')?.name).toBe('Personal');

    const menu2 = await openRowMenu('Actions for "Personal"');
    fireEvent.click(within(menu2).getByRole('menuitem', { name: 'Rename' }));
    const input2 = await screen.findByLabelText('List name', { exact: true });
    fireEvent.input(input2, { target: { value: 'Personal stuff' } });
    fireEvent.keyDown(input2, { key: 'Enter' });

    await waitFor(() => {
      expect(state.value.lists.get('L1')?.name).toBe('Personal stuff');
    });
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('List renamed to Personal stuff');
    });
  });
});

describe('S6 lists — reorder (§8.2 keyboard)', () => {
  it('moves a list with Alt+↑/↓ and announces a11y.listMoved', async () => {
    await seed({
      lists: [
        makeList({ id: 'L1', name: 'A', sortOrder: 'a' }),
        makeList({ id: 'L2', name: 'B', sortOrder: 'b' }),
      ],
    });
    render(<ListsManageView />);

    const rowB = await waitFor(() => {
      const el = document.querySelector('[data-list-id="L2"]');
      expect(el).toBeTruthy();
      return el as HTMLLIElement;
    });
    rowB.focus();
    fireEvent.keyDown(rowB, { key: 'ArrowUp', altKey: true });

    await waitFor(() => {
      expect(liveListIds()).toEqual(['L2', 'L1']);
    });
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('List moved');
    });
    // Focus stays on the moved row (§8.2).
    expect(document.activeElement).toBe(document.querySelector('[data-list-id="L2"]'));
  });

  it('announces the boundary as a no-op (a11y.reorderBoundary)', async () => {
    await seed({
      lists: [
        makeList({ id: 'L1', name: 'A', sortOrder: 'a' }),
        makeList({ id: 'L2', name: 'B', sortOrder: 'b' }),
      ],
    });
    render(<ListsManageView />);

    const rowA = await waitFor(() => {
      const el = document.querySelector('[data-list-id="L1"]');
      expect(el).toBeTruthy();
      return el as HTMLLIElement;
    });
    rowA.focus();
    fireEvent.keyDown(rowA, { key: 'ArrowUp', altKey: true });

    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('Already at the top');
    });
    expect(liveListIds()).toEqual(['L1', 'L2']);
  });

  it('disables the menu equivalents at the boundaries (aria-disabled)', async () => {
    await seed({
      lists: [
        makeList({ id: 'L1', name: 'A', sortOrder: 'a' }),
        makeList({ id: 'L2', name: 'B', sortOrder: 'b' }),
      ],
    });
    render(<ListsManageView />);

    const menuA = await openRowMenu('Actions for "A"');
    const moveUp = within(menuA).getByRole('menuitem', { name: 'Move up' });
    expect(moveUp.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(moveUp); // no-op
    expect(liveListIds()).toEqual(['L1', 'L2']);

    fireEvent.keyDown(menuA, { key: 'Escape' });
    const menuB = await openRowMenu('Actions for "B"');
    const moveDown = within(menuB).getByRole('menuitem', { name: 'Move down' });
    expect(moveDown.getAttribute('aria-disabled')).toBe('true');
  });
});

describe('F6 delete list with task disposition (S7.2)', () => {
  it('shows counts and moves the tasks when "move" is confirmed (ONE transaction)', async () => {
    await seed({
      lists: [makeList({ id: 'L1', name: 'A' }), makeList({ id: 'L2', name: 'B' })],
      tasks: [
        makeTask({ id: 'T1', listId: 'L1', title: 'One' }),
        makeTask({ id: 'T2', listId: 'L1', title: 'Two' }),
        makeTask({ id: 'T3', listId: 'L1', title: 'Three', status: 'done', completedAt: 1 }),
      ],
    });
    render(<ListsManageView />);

    const menu = await openRowMenu('Actions for "A"');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete list' }));

    const dialog = await screen.findByRole('dialog', { name: 'Delete list?' });
    expect(
      within(dialog).getByText(
        '"A" has 2 open and 1 completed tasks. Choose what happens to them.',
        { exact: true },
      ),
    ).toBeTruthy();
    // Disposition radio group: option A default, nested target select defaulting to B.
    const moveRadio = within(dialog).getByRole<HTMLInputElement>('radio', {
      name: 'Move tasks to another list',
    });
    expect(moveRadio.checked).toBe(true);
    const target = within(dialog).getByLabelText<HTMLSelectElement>('Move into', { exact: true });
    expect(target.value).toBe('L2');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete list' }));

    await waitFor(() => {
      expect(state.value.lists.has('L1')).toBe(false);
    });
    // Tasks retargeted in the SAME disposition transaction; counts unchanged.
    expect(state.value.tasks.get('T1')?.listId).toBe('L2');
    expect(state.value.tasks.get('T2')?.listId).toBe('L2');
    expect(state.value.tasks.get('T3')?.listId).toBe('L2');
    expect(state.value.tasks.size).toBe(3);
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('List "A" deleted (3 tasks)');
    });
  });

  it('deletes the tasks too when option B is chosen', async () => {
    await seed({
      lists: [makeList({ id: 'L1', name: 'A' }), makeList({ id: 'L2', name: 'B' })],
      tasks: [
        makeTask({ id: 'T1', listId: 'L1', title: 'One' }),
        makeTask({ id: 'T2', listId: 'L1', title: 'Two' }),
      ],
    });
    render(<ListsManageView />);

    const menu = await openRowMenu('Actions for "A"');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete list' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete list?' });

    fireEvent.click(within(dialog).getByRole('radio', { name: 'Also delete 2 tasks' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete list' }));

    await waitFor(() => {
      expect(state.value.lists.has('L1')).toBe(false);
    });
    expect(state.value.tasks.size).toBe(0);
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('List "A" deleted (2 tasks)');
    });
  });

  it('needs no disposition for an empty list and cancels with Escape', async () => {
    await seed({
      lists: [makeList({ id: 'L1', name: 'Empty' }), makeList({ id: 'L2', name: 'B' })],
    });
    render(<ListsManageView />);

    const menu = await openRowMenu('Actions for "Empty"');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete list' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete list?' });
    expect(within(dialog).queryByRole('radio')).toBeNull();

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Delete list?' })).toBeNull();
    });
    expect(state.value.lists.has('L1')).toBe(true);

    // …and confirms for real the second time.
    const menu2 = await openRowMenu('Actions for "Empty"');
    fireEvent.click(within(menu2).getByRole('menuitem', { name: 'Delete list' }));
    const dialog2 = await screen.findByRole('dialog', { name: 'Delete list?' });
    fireEvent.click(within(dialog2).getByRole('button', { name: 'Delete list' }));
    await waitFor(() => {
      expect(state.value.lists.has('L1')).toBe(false);
    });
  });

  it('disables option A when no other list exists (last list)', async () => {
    await seed({
      lists: [makeList({ id: 'L1', name: 'Only' })],
      tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'One' })],
    });
    render(<ListsManageView />);

    const menu = await openRowMenu('Actions for "Only"');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete list' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete list?' });

    const moveRadio = within(dialog).getByRole<HTMLInputElement>('radio', {
      name: 'Move tasks to another list',
    });
    expect(moveRadio.disabled).toBe(true);
    expect(
      within(dialog).getByText('Create another list to move tasks into', { exact: true }),
    ).toBeTruthy();
    // Default falls back to the only valid choice so Confirm is never dead.
    const deleteRadio = within(dialog).getByRole<HTMLInputElement>('radio', {
      name: 'Also delete 1 tasks',
    });
    expect(deleteRadio.checked).toBe(true);
    expect(
      within(dialog).getByRole('button', { name: 'Delete list' }).hasAttribute('disabled'),
    ).toBe(false);
  });
});
