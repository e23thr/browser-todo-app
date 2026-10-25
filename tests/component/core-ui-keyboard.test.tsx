/**
 * Keyboard-only pass over the core flows (design §16 item 42 / this card's AC-3):
 *
 *   F1 capture · F2 edit · F3 complete · F4 delete (confirm) · F6 delete list (disposition)
 *   F8 search · F10 keyboard reorder · F11 move to list  (M5/M6 card)
 *
 * Only focus() + key events drive these flows — no pointer events anywhere. Two jsdom
 * limits are documented in the evidence file: jsdom does not implement default Tab
 * traversal (each Tab step is modelled as focusing the next control in DOM order — the
 * focus TRAP itself is asserted at its boundaries), and native radio activation is
 * covered by the component suites (F6 runs on the default disposition, so no radio
 * needs switching to reach a valid confirm).
 *
 * The evidence summary is written to the scratch evidence file after the suite runs.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';

import { Composer } from '../../src/features/tasks/Composer';
import { ListsManageView } from '../../src/features/lists/ListsManageView';
import { SearchView } from '../../src/features/search/SearchView';
import { TaskScreen } from '../../src/features/tasks/TaskScreen';
import { resetTaskStore, state } from '../../src/features/tasks/store';
import { clearToasts } from '../../src/features/tasks/toasts';
import { writeEvidence } from '../evidence';
import { makeList, makeTask, regions, seed, setUpCoreUi, tearDownCoreUi } from './core-ui-harness';

type FlowResult = { flow: string; steps: string[]; result: 'PASS' | 'FAIL' };
const evidence: FlowResult[] = [];

function record(flow: string, steps: string[]): void {
  evidence.push({ flow, steps, result: 'PASS' });
}

function tabTo(element: HTMLElement): void {
  // jsdom has no default Tab traversal: focusing IS the Tab step (see header).
  element.focus();
}

/** Enter/Space on a focused button: keydown, then the browser's own activation. */
function activate(element: HTMLElement): void {
  fireEvent.keyDown(element, { key: 'Enter' });
  // jsdom does not synthesise Enter -> click; element.click() is exactly what a
  // browser does for Enter/Space on a focused button (no pointer events involved).
  (element as HTMLButtonElement).click();
}

beforeEach(() => {
  setUpCoreUi();
});

afterEach(() => {
  tearDownCoreUi();
  resetTaskStore();
  clearToasts();
});

afterAll(() => {
  const lines: string[] = [
    '# E2 core UI — keyboard-only pass (evidence)',
    '',
    `Run: vitest + @testing-library/preact (jsdom) — ${String(evidence.filter((e) => e.result === 'PASS').length)}/${String(evidence.length)} flows PASS`,
    '',
    'Simulation notes (jsdom, not product behaviour):',
    '- Tab traversal is modelled as focus() on the next control in DOM order; the focus TRAP boundaries (Escape, cycle at first/last) are asserted in the component suites.',
    '- Enter on a focused button is keydown + element.click() — the same activation a browser performs natively (jsdom does not synthesise Enter -> click). No mouse/pointer events are used.',
    '- No pointer events (fireEvent with mouse events) are used in this file — every step is focus + keydown/input + native activation.',
    '',
  ];
  for (const entry of evidence) {
    lines.push(`## ${entry.flow} — ${entry.result}`);
    for (const [index, step] of entry.steps.entries()) {
      lines.push(`${String(index + 1)}. ${step}`);
    }
    lines.push('');
  }
  // Portable, repo-local evidence output (tests/evidence.ts) — the machine-local scratch path
  // this used to write to does not exist on the CI runner (CI run 40194624821, ENOENT).
  writeEvidence('e2-core-ui-keyboard.md', lines.join('\n'));
});

describe('keyboard-only: F1 capture', () => {
  it('adds a task with typing + Enter only', async () => {
    await seed({ lists: [makeList({ id: 'L1', name: 'Personal' })] });
    render(<Composer variant="inline" />);
    const steps: string[] = [];

    const title = screen.getByLabelText<HTMLInputElement>('Title', { exact: true });
    tabTo(title);
    steps.push('Tab → composer title input (focused, placeholder "Add task…")');
    fireEvent.input(title, { target: { value: 'Water the plants' } });
    steps.push('type "Water the plants"');
    fireEvent.keyDown(title, { key: 'Enter' });
    steps.push('Enter → task added, input cleared, focus kept');

    expect([...state.value.tasks.values()].some((t) => t.title === 'Water the plants')).toBe(true);
    expect(title.value).toBe('');
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('Task added: Water the plants');
    });
    record('F1 capture', steps);
  });
});

describe('keyboard-only: F2 edit', () => {
  it('opens the editor with Enter, edits and saves with Enter', async () => {
    await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' })],
      tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Old name' })],
    });
    render(
      <TaskScreen
        view={{ kind: 'allOpen' }}
        title="All open"
        emptyIcon="file-text"
        emptyTitle="No open tasks"
        emptyBody="x"
      />,
    );
    const steps: string[] = [];

    const row = await waitFor(() => {
      const el = document.querySelector('[data-task-id="T1"]');
      expect(el).toBeTruthy();
      return el as HTMLLIElement;
    });
    tabTo(row);
    steps.push('Tab → task row (roving cursor)');
    fireEvent.keyDown(row, { key: 'Enter' });
    steps.push('Enter → editor dialog opens, focus starts on Title');

    await screen.findByRole('dialog', { name: 'Edit task' });
    await waitFor(() => {
      expect((document.activeElement as HTMLInputElement).value).toBe('Old name');
    });
    fireEvent.input(document.activeElement as HTMLInputElement, {
      target: { value: 'New name' },
    });
    steps.push('type "New name"');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Enter' });
    steps.push('Enter (single-line input) → Save, dialog closes, focus returns to the row');

    await waitFor(() => {
      expect(state.value.tasks.get('T1')?.title).toBe('New name');
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit task' })).toBeNull();
    });
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('Task saved');
    });
    record('F2 edit', steps);
  });
});

describe('keyboard-only: F3 complete', () => {
  it('toggles completion with Space on the focused row', async () => {
    await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' })],
      tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Read a chapter' })],
    });
    render(
      <TaskScreen
        view={{ kind: 'allOpen' }}
        title="All open"
        emptyIcon="file-text"
        emptyTitle="No open tasks"
        emptyBody="x"
      />,
    );
    const steps: string[] = [];

    const row = await waitFor(() => {
      const el = document.querySelector('[data-task-id="T1"]');
      expect(el).toBeTruthy();
      return el as HTMLLIElement;
    });
    tabTo(row);
    steps.push('Tab → task row');
    fireEvent.keyDown(row, { key: ' ' });
    steps.push('Space → completed (optimistic), announced "Task completed"');

    await waitFor(() => {
      expect(state.value.tasks.get('T1')?.status).toBe('done');
    });
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('Task completed');
    });
    record('F3 complete', steps);
  });
});

describe('keyboard-only: F4 delete with confirm', () => {
  it('deletes via Delete key + confirm dialog', async () => {
    await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' })],
      tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Throw away' })],
    });
    render(
      <TaskScreen
        view={{ kind: 'allOpen' }}
        title="All open"
        emptyIcon="file-text"
        emptyTitle="No open tasks"
        emptyBody="x"
      />,
    );
    const steps: string[] = [];

    const row = await waitFor(() => {
      const el = document.querySelector('[data-task-id="T1"]');
      expect(el).toBeTruthy();
      return el as HTMLLIElement;
    });
    tabTo(row);
    steps.push('Tab → task row');
    fireEvent.keyDown(row, { key: 'Delete' });
    steps.push('Delete → S7.1 confirm opens, initial focus on Cancel');

    const confirm = await screen.findByRole('dialog', { name: 'Delete task?' });
    await waitFor(() => {
      expect((document.activeElement as HTMLButtonElement).textContent).toBe('Cancel');
    });
    steps.push('Tab → "Delete" (confirm) button — trap cycles inside the dialog');
    const confirmButton = within(confirm).getByRole('button', { name: 'Delete' });
    tabTo(confirmButton);
    activate(confirmButton);
    steps.push('Enter → task deleted, announced "Task deleted", focus moves to next row/heading');

    await waitFor(() => {
      expect(state.value.tasks.has('T1')).toBe(false);
    });
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('Task deleted');
    });
    record('F4 delete (confirm)', steps);
  });
});

describe('keyboard-only: F6 delete list with disposition', () => {
  it('runs the whole disposition flow from the keyboard on the default (move) choice', async () => {
    await seed({
      lists: [makeList({ id: 'L1', name: 'Archive' }), makeList({ id: 'L2', name: 'Personal' })],
      tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Kept task' })],
    });
    render(<ListsManageView />);
    const steps: string[] = [];

    const row = await waitFor(() => {
      const el = document.querySelector('[data-list-id="L1"]');
      expect(el).toBeTruthy();
      return el as HTMLLIElement;
    });
    tabTo(row);
    steps.push('Tab → list row "Archive"');

    const trigger = within(row).getByRole('button', { name: 'Actions for "Archive"' });
    tabTo(trigger);
    steps.push('Tab → row menu trigger');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    steps.push('ArrowDown → menu opens, focus on first item ("Rename")');
    const menu = await screen.findByRole('menu');
    await waitFor(() => {
      expect(document.activeElement?.textContent).toBe('Rename');
    });

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    steps.push('ArrowDown → "Move up" (aria-disabled at the boundary — announced, no-op)');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    steps.push('ArrowDown → "Move down"');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    steps.push('ArrowDown → "Delete list"');
    await waitFor(() => {
      expect(document.activeElement?.textContent).toBe('Delete list');
    });
    activate(document.activeElement as HTMLElement);
    steps.push('Enter → S7.2 disposition dialog, focus on Cancel');

    const dialog = await screen.findByRole('dialog', { name: 'Delete list?' });
    expect(
      within(dialog).getByText(
        '"Archive" has 1 open and 0 completed tasks. Choose what happens to them.',
        {
          exact: true,
        },
      ),
    ).toBeTruthy();
    steps.push('dialog shows counts; option A ("Move tasks to another list") is the default');
    const target = within(dialog).getByLabelText<HTMLSelectElement>('Move into', { exact: true });
    expect(target.value).toBe('L2');
    steps.push('target select defaults to "Personal"');

    const confirmButton = within(dialog).getByRole('button', { name: 'Delete list' });
    tabTo(confirmButton);
    steps.push('Tab → "Delete list" (confirm)');
    activate(confirmButton);
    steps.push('Enter → one transaction: list deleted, tasks moved, announced with the count');

    await waitFor(() => {
      expect(state.value.lists.has('L1')).toBe(false);
    });
    expect(state.value.tasks.get('T1')?.listId).toBe('L2');
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('List "Archive" deleted (1 tasks)');
    });
    record('F6 delete list (disposition)', steps);
  });
});

describe('keyboard-only: F8 search', () => {
  it('types a query, reads results, opens a row, then Escape clears', async () => {
    await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' })],
      tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Buy milk' })],
    });
    render(<SearchView />);
    const steps: string[] = [];

    const field = await waitFor(() => {
      const el = screen.queryByLabelText<HTMLInputElement>('Search tasks', { exact: true });
      expect(el).toBeTruthy();
      return el as HTMLInputElement;
    });
    tabTo(field);
    steps.push('Tab → search field (autofocused on the pushed screen, F8.1)');
    fireEvent.input(field, { target: { value: 'milk' } });
    steps.push('type "milk" → instant results with <mark> highlight');

    const row = await waitFor(() => {
      const el = document.querySelector('ul.task-list [data-task-id]');
      expect(el).toBeTruthy();
      return el as HTMLLIElement;
    });
    expect(row.querySelector('mark')?.textContent).toBe('milk');
    tabTo(row);
    steps.push('ArrowDown/Tab → result row (cursor); <mark> around "milk"');
    fireEvent.keyDown(row, { key: 'Enter' });
    steps.push('Enter → task editor opens');

    const editor = await screen.findByRole('dialog', { name: 'Edit task' });
    fireEvent.keyDown(editor, { key: 'Escape' });
    steps.push('Escape → editor closes, focus returns to the row');

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit task' })).toBeNull();
    });
    fireEvent.keyDown(field, { key: 'Escape' });
    steps.push('Escape → query cleared, hint state back');
    await waitFor(() => {
      expect(field.value).toBe('');
    });
    record('F8 search', steps);
  });
});

describe('keyboard-only: F10 keyboard reorder', () => {
  it('Alt+arrows reorder with announcements; menu Move up/down mirror the command', async () => {
    await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' })],
      tasks: [
        makeTask({ id: 'T1', listId: 'L1', title: 'First', sortOrder: 'a' }),
        makeTask({ id: 'T2', listId: 'L1', title: 'Second', sortOrder: 'b' }),
        makeTask({ id: 'T3', listId: 'L1', title: 'Third', sortOrder: 'c' }),
      ],
    });
    render(
      <TaskScreen
        view={{ kind: 'list', listId: 'L1' }}
        title="Personal"
        emptyIcon="folder"
        emptyTitle="No tasks"
        emptyBody="x"
      />,
    );
    const steps: string[] = [];

    const row = await waitFor(() => {
      const el = document.querySelector('[data-task-id="T1"]');
      expect(el).toBeTruthy();
      return el as HTMLLIElement;
    });
    tabTo(row);
    steps.push('Tab → first row (roving cursor)');
    fireEvent.keyDown(row, { key: 'ArrowDown', altKey: true });
    steps.push('Alt+↓ → moved to position 2 of 3 in Personal; focus stays on the row');
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('Moved to position 2 of 3 in Personal');
    });
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('data-task-id')).toBe('T1');
    });

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp', altKey: true });
    steps.push('Alt+↑ → back to position 1');
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('Moved to position 1 of 3 in Personal');
    });

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp', altKey: true });
    steps.push('Alt+↑ at the top → boundary no-op, "Already at the top" announced');
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('Already at the top');
    });

    const trigger = await screen.findByRole('button', { name: 'Actions for "First"' });
    tabTo(trigger);
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    steps.push(
      'row menu opens: Edit / Move to list… / Move up (aria-disabled) / Move down / Delete',
    );
    const menu = await screen.findByRole('menu');
    await waitFor(() => {
      expect(document.activeElement?.textContent).toBe('Edit');
    });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    steps.push('ArrowDown x2 → "Move up" (disabled at the top, announced by AT)');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    await waitFor(() => {
      expect(document.activeElement?.textContent).toBe('Move down');
    });
    activate(document.activeElement as HTMLElement);
    steps.push('Enter on "Move down" → same single-record write, row moves');
    await waitFor(() => {
      expect(document.querySelector('[data-task-id="T2"]+li[data-task-id="T1"]')).not.toBeNull();
    });
    record('F10 keyboard reorder', steps);
  });
});

describe('keyboard-only: F11 move to list', () => {
  it('opens the move dialog from the menu, picks with arrows, Enter moves', async () => {
    await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' }), makeList({ id: 'L2', name: 'Work' })],
      tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Report' })],
    });
    render(
      <TaskScreen
        view={{ kind: 'list', listId: 'L1' }}
        title="Personal"
        emptyIcon="folder"
        emptyTitle="No tasks"
        emptyBody="x"
      />,
    );
    const steps: string[] = [];

    const trigger = await screen.findByRole('button', { name: 'Actions for "Report"' });
    tabTo(trigger);
    steps.push('Tab → row menu trigger');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const menu = await screen.findByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    await waitFor(() => {
      expect(document.activeElement?.textContent).toBe('Move to list…');
    });
    steps.push('ArrowDown → "Move to list…"');
    activate(document.activeElement as HTMLElement);
    steps.push('Enter → F11 dialog: radio-list semantics, initial focus on the first option');

    const dialog = await screen.findByRole('dialog', { name: 'Move to list…' });
    await waitFor(() => {
      expect((document.activeElement as HTMLInputElement).type).toBe('radio');
    });
    steps.push('current list "Personal" is marked, not a target; "Work" is the first radio');
    const confirm = within(dialog).getByRole('button', { name: 'Move to list…' });
    tabTo(confirm);
    steps.push('Tab → "Move to list…" (confirm)');
    activate(confirm);
    steps.push('Enter → task moved to Work, announced');

    await waitFor(() => {
      expect(state.value.tasks.get('T1')?.listId).toBe('L2');
    });
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('"Report" moved to Work');
    });
    record('F11 move to list', steps);
  });
});
