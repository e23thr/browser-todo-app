/**
 * Manual reorder (M6) component suite — design §8, flows F9/F10/F11,
 * checklist items 31–36.
 *
 * Covers: `Alt+↑/↓/Home/End` (one position per press, focus stays on the moved
 * row, `a11y.taskMoved {position}{total}{list}` every press, boundary no-op +
 * `a11y.reorderBoundary`), per-list row menu (Move up/Move down aria-disabled at
 * the ends), the single-record write (spy on the runner's `moveTask`), persist
 * across a simulated reload (re-bind the same port storage), pointer drag from
 * the handle (ghost + insertion line + drop + Escape cancel + drop onto a
 * sidebar list = move-to-list), move-to-list dialog (F11), aggregate views
 * (`a11y.reorderUnavailable`, no handles) and §8.3 write-failure rollback
 * (row returns + assertive `a11y.saveFailed` + Retry toast).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';

import { getDropHoverListId } from '../../src/app/lists';
import { TaskScreen } from '../../src/features/tasks/TaskScreen';
import { ToastHost } from '../../src/features/tasks/ToastHost';
import { bindRunnerForTest, resetTaskStore, state } from '../../src/features/tasks/store';
import { clearToasts } from '../../src/features/tasks/toasts';
import { makeList, makeTask, regions, seed, setUpCoreUi, tearDownCoreUi } from './core-ui-harness';

const LISTS = [makeList({ id: 'L1', name: 'Personal' }), makeList({ id: 'L2', name: 'Work' })];

function threeTasks(): ReturnType<typeof makeTask>[] {
  return [
    makeTask({ id: 'T1', listId: 'L1', title: 'First', sortOrder: 'a' }),
    makeTask({ id: 'T2', listId: 'L1', title: 'Second', sortOrder: 'b' }),
    makeTask({ id: 'T3', listId: 'L1', title: 'Third', sortOrder: 'c' }),
  ];
}

function renderList(): void {
  render(
    <TaskScreen
      view={{ kind: 'list', listId: 'L1' }}
      title="Personal"
      emptyIcon="folder"
      emptyTitle="Empty"
      emptyBody="Nothing"
    />,
  );
}

function renderAllOpen(): void {
  render(
    <TaskScreen
      view={{ kind: 'allOpen' }}
      title="All open"
      emptyIcon="file-text"
      emptyTitle="Empty"
      emptyBody="Nothing"
    />,
  );
}

function rowOrder(): string[] {
  return [...document.querySelectorAll('ul.task-list [data-task-id]')].map(
    (row) => row.getAttribute('data-task-id') ?? '',
  );
}

function rowOf(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`li[data-task-id="${id}"]`);
  if (el === null) throw new Error(`no row ${id}`);
  return el;
}

/** Real DOM focus + commit the roving state (focus events are not wrapped in act). */
async function focusRow(id: string): Promise<HTMLElement> {
  const row = rowOf(id);
  row.focus();
  await act(async () => undefined); // flush the focus-driven state + microtasks
  return rowOf(id);
}

/** jsdom has no layout: give each row a synthetic 60 px pitch for drag geometry. */
function stubRowRects(): void {
  [...document.querySelectorAll('li[data-task-id]')].forEach((el, index) => {
    el.getBoundingClientRect = (): DOMRect => ({
      top: index * 60,
      bottom: index * 60 + 56,
      left: 0,
      right: 300,
      width: 300,
      height: 56,
      x: 0,
      y: index * 60,
      toJSON: () => ({}),
    });
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

describe('§8.2 keyboard reorder (F10, items 32/36)', () => {
  it('Alt+↓ moves one position, keeps focus on the moved row, announces position/total/list', async () => {
    await seed({ lists: LISTS, tasks: threeTasks() });
    renderList();

    const first = await focusRow('T1');
    fireEvent.keyDown(first, { key: 'ArrowDown', altKey: true });

    await waitFor(() => {
      expect(rowOrder()).toEqual(['T2', 'T1', 'T3']);
    });
    expect(document.activeElement).toBe(rowOf('T1')); // focus stays on the moved row
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('Moved to position 2 of 3 in Personal');
    });
  });

  it('Alt+↑, Alt+Home and Alt+End move to top / edge / bottom', async () => {
    await seed({ lists: LISTS, tasks: threeTasks() });
    renderList();

    await focusRow('T3');
    fireEvent.keyDown(rowOf('T3'), { key: 'ArrowUp', altKey: true });
    await waitFor(() => {
      expect(rowOrder()).toEqual(['T1', 'T3', 'T2']);
    });

    fireEvent.keyDown(rowOf('T3'), { key: 'End', altKey: true });
    await waitFor(() => {
      expect(rowOrder()).toEqual(['T1', 'T2', 'T3']);
    });

    fireEvent.keyDown(rowOf('T3'), { key: 'Home', altKey: true });
    await waitFor(() => {
      expect(rowOrder()).toEqual(['T3', 'T1', 'T2']);
    });
    expect(document.activeElement).toBe(rowOf('T3'));
  });

  it('boundary: Alt+↑ on the first row is a no-op with a11y.reorderBoundary and no write', async () => {
    const built = await seed({ lists: LISTS, tasks: threeTasks() });
    const spy = vi.spyOn(built.runner, 'moveTask');
    renderList();

    await focusRow('T1');
    fireEvent.keyDown(rowOf('T1'), { key: 'ArrowUp', altKey: true });

    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('Already at the top');
    });
    expect(rowOrder()).toEqual(['T1', 'T2', 'T3']);
    expect(spy).not.toHaveBeenCalled();
  });

  it('exactly ONE moveTask write per press (single-record reorder, §5.7)', async () => {
    const built = await seed({ lists: LISTS, tasks: threeTasks() });
    const spy = vi.spyOn(built.runner, 'moveTask');
    renderList();

    await focusRow('T1');
    fireEvent.keyDown(rowOf('T1'), { key: 'ArrowDown', altKey: true });
    await waitFor(() => {
      expect(rowOrder()).toEqual(['T2', 'T1', 'T3']);
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toEqual({
      group: { listId: 'L1', parentTaskId: null },
      position: { afterId: 'T2' },
    });
  });

  it('persists across a simulated reload (re-bind + load keeps the new order)', async () => {
    const built = await seed({ lists: LISTS, tasks: threeTasks() });
    renderList();
    await focusRow('T1');
    fireEvent.keyDown(rowOf('T1'), { key: 'ArrowDown', altKey: true });
    await waitFor(() => {
      expect(rowOrder()).toEqual(['T2', 'T1', 'T3']);
    });

    // Reload: fresh store signals, same durable storage (the in-memory port maps).
    resetTaskStore();
    bindRunnerForTest(built.runner);
    const loaded = await built.runner.load();
    expect(loaded.ok).toBe(true);
    cleanup(); // unmount the pre-reload screen before rendering the fresh one
    renderList();
    expect(rowOrder()).toEqual(['T2', 'T1', 'T3']);
  });

  it('write failure rolls back the position + assertive saveFailed + Retry toast (§8.3)', async () => {
    await seed({ lists: LISTS, tasks: threeTasks(), failMoves: true });
    renderList();
    render(<ToastHost />); // the App hosts this; the failure toast needs it mounted

    await focusRow('T1');
    fireEvent.keyDown(rowOf('T1'), { key: 'ArrowDown', altKey: true });

    await waitFor(() => {
      expect(regions.assertive?.textContent).toBe('Could not save. Your change was undone.');
    });
    // The optimistic move was rolled back — the row is back where it started.
    expect(rowOrder()).toEqual(['T1', 'T2', 'T3']);
    const toast = await screen.findByText("Couldn't save", { exact: true });
    expect(
      within(toast.closest('.toast') as HTMLElement).getByText('Try again', { exact: true }),
    ).toBeTruthy();
  });
});

describe('§8.2 per-list row menu (item 11)', () => {
  it('Move up/Move down present and aria-disabled at the ends', async () => {
    await seed({ lists: LISTS, tasks: threeTasks() });
    renderList();

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for "First"' }));
    let menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Edit', 'Move to list…', 'Move up', 'Move down', 'Delete']);
    expect(
      within(menu).getByRole('menuitem', { name: 'Move up' }).getAttribute('aria-disabled'),
    ).toBe('true');
    expect(
      within(menu).getByRole('menuitem', { name: 'Move down' }).getAttribute('aria-disabled'),
    ).toBeNull();
    fireEvent.keyDown(menu, { key: 'Escape' });

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for "Third"' }));
    menu = await screen.findByRole('menu');
    expect(
      within(menu).getByRole('menuitem', { name: 'Move down' }).getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('Move down menu item moves the row (button equivalent, §8.2)', async () => {
    await seed({ lists: LISTS, tasks: threeTasks() });
    renderList();
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for "First"' }));
    const menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move down' }));
    await waitFor(() => {
      expect(rowOrder()).toEqual(['T2', 'T1', 'T3']);
    });
  });
});

describe('§8.1 pointer drag (F9, item 31)', () => {
  async function startDrag(id: string): Promise<HTMLElement> {
    renderList();
    stubRowRects();
    const handle = document.querySelector<HTMLElement>(`[data-reorder-handle="${id}"]`);
    if (handle === null) throw new Error('no handle');
    fireEvent.pointerDown(handle, { clientX: 10, clientY: 10, pointerId: 1 });
    return handle;
  }

  it('drag from the handle shows ghost + insertion line, drop reorders + announces', async () => {
    await seed({ lists: LISTS, tasks: threeTasks() });
    await startDrag('T1');

    fireEvent.pointerMove(document, { clientX: 10, clientY: 110, pointerId: 1 });
    await waitFor(() => {
      // Pointer crossed T2's midpoint: insertion line marks where T1 lands.
      expect(rowOf('T3').getAttribute('data-drop-before')).toBe('true');
    });
    expect(rowOf('T1').getAttribute('data-dragging')).toBe('true'); // ghost (§8.1)

    fireEvent.pointerUp(document, { clientX: 10, clientY: 110, pointerId: 1 });
    await waitFor(() => {
      expect(rowOrder()).toEqual(['T2', 'T1', 'T3']);
    });
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('Moved to position 2 of 3 in Personal');
    });
  });

  it('Escape during drag cancels: no write, polite reorderCancelled (§8.1)', async () => {
    const built = await seed({ lists: LISTS, tasks: threeTasks() });
    const spy = vi.spyOn(built.runner, 'moveTask');
    await startDrag('T1');
    fireEvent.pointerMove(document, { clientX: 10, clientY: 110, pointerId: 1 });
    await waitFor(() => {
      expect(rowOf('T3').getAttribute('data-drop-before')).toBe('true');
    });

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('Move cancelled');
    });
    expect(rowOf('T1').getAttribute('data-dragging')).toBeNull();
    expect(rowOrder()).toEqual(['T1', 'T2', 'T3']);
    expect(spy).not.toHaveBeenCalled();
  });

  it('drop on the last slot moves to the bottom', async () => {
    await seed({ lists: LISTS, tasks: threeTasks() });
    await startDrag('T1');
    fireEvent.pointerMove(document, { clientX: 10, clientY: 170, pointerId: 1 });
    await waitFor(() => {
      expect(rowOf('T3').getAttribute('data-drop-after')).toBe('true');
    });
    fireEvent.pointerUp(document, { clientX: 10, clientY: 170, pointerId: 1 });
    await waitFor(() => {
      expect(rowOrder()).toEqual(['T2', 'T3', 'T1']);
    });
    const t1Order = state.value.tasks.get('T1')?.sortOrder ?? '';
    const t3Order = state.value.tasks.get('T3')?.sortOrder ?? '';
    expect(t1Order > t3Order).toBe(true);
  });

  it('drag onto a sidebar list moves the task there (§8.1 desktop extra, item 34)', async () => {
    const built = await seed({ lists: LISTS, tasks: threeTasks() });
    const spy = vi.spyOn(built.runner, 'moveTask');
    const sidebarLink = document.createElement('a');
    sidebarLink.setAttribute('data-drop-list-id', 'L2');
    sidebarLink.getBoundingClientRect = (): DOMRect => ({
      left: 0,
      top: 0,
      right: 200,
      bottom: 400,
      width: 200,
      height: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    document.body.append(sidebarLink);

    await startDrag('T1');
    fireEvent.pointerMove(document, { clientX: 50, clientY: 100, pointerId: 1 });
    await waitFor(() => {
      expect(getDropHoverListId()).toBe('L2'); // shell renders the highlight from this signal
    });
    fireEvent.pointerUp(document, { clientX: 50, clientY: 100, pointerId: 1 });

    await waitFor(() => {
      expect(state.value.tasks.get('T1')?.listId).toBe('L2');
    });
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('"First" moved to Work');
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]?.position).toBe('last');
    sidebarLink.remove();
  });
});

describe('F11 move-to-list dialog (item 35)', () => {
  it('offers only other lists, current list marked; move announces taskMovedToList', async () => {
    await seed({ lists: LISTS, tasks: threeTasks() });
    renderList();

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for "First"' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to list…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move to list…' });

    const radios = within(dialog).getAllByRole('radio');
    expect(radios.length).toBe(1);
    expect((radios[0] as HTMLInputElement).value).toBe('L2');
    expect(dialog.textContent).toContain('Move into: Personal'); // current list marked (F11.1)

    fireEvent.click(radios[0] as HTMLInputElement);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move to list…' }));

    await waitFor(() => {
      expect(state.value.tasks.get('T1')?.listId).toBe('L2');
    });
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('"First" moved to Work');
    });
    // The row left the per-list view.
    expect(rowOrder()).toEqual(['T2', 'T3']);
  });
});

describe('item 33: aggregate views never reorder', () => {
  it('no handles render; Alt+↓ announces a11y.reorderUnavailable and writes nothing', async () => {
    const built = await seed({ lists: LISTS, tasks: threeTasks() });
    const spy = vi.spyOn(built.runner, 'moveTask');
    renderAllOpen();

    expect(document.querySelector('.reorder-handle')).toBeNull();
    const row = await focusRow('T1');
    fireEvent.keyDown(row, { key: 'ArrowDown', altKey: true });
    await waitFor(() => {
      expect(regions.polite?.textContent).toContain(
        'Reordering is only available inside a list view',
      );
    });
    expect(spy).not.toHaveBeenCalled();
  });
});
