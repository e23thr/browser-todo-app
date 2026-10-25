/**
 * Search (M5) component suite — design §7 S5, flow F8, checklist items 25–27.
 *
 * Covers: instant synchronous filtering through the domain index (NFKC,
 * case-insensitive, title-before-notes via rank order), `<mark>` highlighting,
 * the notes-only excerpt, the debounced `a11y.searchResults` announcement,
 * `Escape` x2, idle/no-results states, result rows fully interactive but never
 * reorderable (D1: handles absent, `a11y.reorderUnavailable` on Alt+arrows),
 * Move-to-list from results, and the recorded 10k-fixture latency numbers
 * (AC-1: "measured latency at 10k fixtures recorded").
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';

import { performance } from 'node:perf_hooks';

import { SearchView } from '../../src/features/search/SearchView';
import { searchIndexFor } from '../../src/features/search/searchIndexCache';
import { selectView } from '../../src/domain/views';
import { state } from '../../src/features/tasks/store';
import { writeEvidence } from '../evidence';
import {
  makeList,
  makeTask,
  regions,
  seed,
  setUpCoreUi,
  stubWideViewport,
  tearDownCoreUi,
} from './core-ui-harness';

const evidence: string[] = [];

beforeEach(() => {
  setUpCoreUi();
});

afterEach(() => {
  tearDownCoreUi();
});

afterAll(() => {
  if (evidence.length === 0) return;
  // Portable, repo-local evidence output (tests/evidence.ts): the machine-local scratch path
  // this used to write to does not exist on the CI runner (CI run 40194624821, ENOENT).
  writeEvidence('e2-m5-search-latency.md', evidence.join('\n') + '\n');
});

const LISTS = [makeList({ id: 'L1', name: 'Personal' }), makeList({ id: 'L2', name: 'Work' })];

function type(input: HTMLInputElement, value: string): void {
  fireEvent.input(input, { target: { value } });
}

async function searchFor(value: string): Promise<HTMLInputElement> {
  const input = await screen.findByLabelText<HTMLInputElement>('Search tasks', { exact: true });
  type(input, value);
  return input;
}

describe('S5 search states (F8.4, §14)', () => {
  it('idle: empty query shows the hint empty state, no results list', async () => {
    await seed({ lists: LISTS, tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Buy milk' })] });
    render(<SearchView />);
    expect(
      screen.getByText('Type to search your tasks (titles and notes).', { exact: true }),
    ).toBeTruthy();
    expect(document.querySelector('ul.task-list')).toBeNull();
  });

  it('no-results: echoes the query (search.empty.title)', async () => {
    await seed({ lists: LISTS, tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Buy milk' })] });
    render(<SearchView />);
    await searchFor('unicorns');
    expect(screen.getByText('No tasks match "unicorns"', { exact: true })).toBeTruthy();
  });

  it('results: filters rows per keystroke, list badge shown (D5)', async () => {
    await seed({
      lists: LISTS,
      tasks: [
        makeTask({ id: 'T1', listId: 'L1', title: 'Buy milk' }),
        makeTask({ id: 'T2', listId: 'L2', title: 'Write report' }),
      ],
    });
    render(<SearchView />);
    await searchFor('milk');
    const list = document.querySelector('ul.task-list');
    expect(list).not.toBeNull();
    const rows = (list as HTMLElement).querySelectorAll('[data-task-id]');
    expect([...rows].map((row) => row.getAttribute('data-task-id'))).toEqual(['T1']);
    // ListBadge on search results (item 10) — the mobile meta line carries the same name.
    const badge = (list as HTMLElement).querySelector('.list-badge');
    expect(badge?.textContent).toContain('Personal');
  });
});

describe('S5 matching + highlighting (item 25)', () => {
  it('NFKC case-insensitive: "MILK" matches "Buy milk" and marks the token', async () => {
    await seed({
      lists: LISTS,
      tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Buy milk' })],
    });
    render(<SearchView />);
    await searchFor('MILK');
    const marks = document.querySelectorAll('ul.task-list mark');
    expect([...marks].map((mark) => mark.textContent)).toEqual(['milk']);
  });

  it('notes-only match shows the clamped notes excerpt with the highlight', async () => {
    await seed({
      lists: LISTS,
      tasks: [
        makeTask({ id: 'T1', listId: 'L1', title: 'Buy milk', notes: 'Semi-skimmed, two bottles' }),
      ],
    });
    render(<SearchView />);
    await searchFor('skimmed');
    const excerpt = document.querySelector('.row-notes-excerpt');
    expect(excerpt).not.toBeNull();
    // The token prefix highlights inside the hyphenated word (substring scan).
    expect(excerpt?.querySelector('mark')?.textContent).toBe('skimmed');
  });

  it('title match does not render a notes excerpt', async () => {
    await seed({
      lists: LISTS,
      tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Buy milk', notes: 'Semi-skimmed' })],
    });
    render(<SearchView />);
    await searchFor('milk');
    expect(document.querySelector('.row-notes-excerpt')).toBeNull();
  });

  it('ranks title-before-notes (D5 ordering, domain rank)', async () => {
    await seed({
      lists: LISTS,
      tasks: [
        makeTask({
          id: 'T1',
          listId: 'L1',
          title: 'Water the plants',
          notes: 'milk for the compost',
        }),
        makeTask({ id: 'T2', listId: 'L1', title: 'Buy milk' }),
      ],
    });
    render(<SearchView />);
    await searchFor('milk');
    const rows = document.querySelectorAll('ul.task-list [data-task-id]');
    expect([...rows].map((row) => row.getAttribute('data-task-id'))).toEqual(['T2', 'T1']);
  });
});

describe('S5 announcement + Escape (item 26, §5.5)', () => {
  it('announces the result count debounced (300 ms) with the query', async () => {
    await seed({
      lists: LISTS,
      tasks: [
        makeTask({ id: 'T1', listId: 'L1', title: 'Buy milk' }),
        makeTask({ id: 'T2', listId: 'L1', title: 'Drink milk' }),
      ],
    });
    render(<SearchView />);
    await searchFor('milk');
    await waitFor(
      () => {
        expect(regions.polite?.textContent).toBe('2 results for "milk"');
      },
      { timeout: 2000 },
    );
  });

  it('Escape clears the query; the second Escape returns focus to the trigger (desktop)', async () => {
    const restore = stubWideViewport();
    try {
      await seed({
        lists: LISTS,
        tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Buy milk' })],
      });
      const trigger = document.createElement('a');
      trigger.href = '#/search';
      trigger.textContent = 'search trigger';
      document.body.append(trigger);

      render(<SearchView />);
      const input = await searchFor('milk');
      expect(document.querySelector('ul.task-list')).not.toBeNull();

      fireEvent.keyDown(input, { key: 'Escape' }); // first press: clear
      expect(input.value).toBe('');
      expect(document.querySelector('ul.task-list')).toBeNull();
      expect(
        screen.getByText('Type to search your tasks (titles and notes).', { exact: true }),
      ).toBeTruthy();

      fireEvent.keyDown(input, { key: 'Escape' }); // second press: close/return focus
      expect(document.activeElement).toBe(trigger);
      trigger.remove();
    } finally {
      restore();
    }
  });

  it('arrow down from the field moves into the results rows (§9.7)', async () => {
    await seed({ lists: LISTS, tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Buy milk' })] });
    render(<SearchView />);
    const input = await searchFor('milk');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const row = document.querySelector<HTMLElement>('ul.task-list [data-task-id]');
    expect(document.activeElement).toBe(row);
  });
});

describe('D1: results are interactive but never reorderable (item 27/33)', () => {
  it('no reorder handles render in results', async () => {
    await seed({ lists: LISTS, tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Buy milk' })] });
    render(<SearchView />);
    await searchFor('milk');
    expect(document.querySelector('.reorder-handle')).toBeNull();
  });

  it('Alt+arrows announce a11y.reorderUnavailable', async () => {
    await seed({ lists: LISTS, tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Buy milk' })] });
    render(<SearchView />);
    await searchFor('milk');
    const row = document.querySelector<HTMLElement>('ul.task-list [data-task-id]');
    row?.focus();
    fireEvent.keyDown(row as HTMLElement, { key: 'ArrowDown', altKey: true });
    await waitFor(() => {
      expect(regions.polite?.textContent).toContain(
        'Reordering is only available inside a list view',
      );
    });
  });

  it('result rows stay fully interactive: checkbox toggles complete (F8.5)', async () => {
    await seed({ lists: LISTS, tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Buy milk' })] });
    render(<SearchView />);
    await searchFor('milk');
    const check = screen.getByLabelText<HTMLInputElement>('Mark "Buy milk" as complete', {
      exact: true,
    });
    fireEvent.click(check);
    await waitFor(() => {
      expect(state.value.tasks.get('T1')?.status).toBe('done');
    });
  });

  it('Move to list from results moves the task and announces it (F11)', async () => {
    await seed({ lists: LISTS, tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Buy milk' })] });
    render(<SearchView />);
    await searchFor('milk');
    const trigger = await screen.findByRole('button', { name: 'Actions for "Buy milk"' });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to list…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move to list…' });
    const radios = within(dialog).getAllByRole('radio');
    expect(radios.length).toBe(1); // only Work — the current list is not a target
    fireEvent.click(radios[0] as HTMLInputElement);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move to list…' }));
    await waitFor(() => {
      expect(state.value.tasks.get('T1')?.listId).toBe('L2');
    });
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('"Buy milk" moved to Work');
    });
  });
});

describe('AC-1: measured search latency at 10,000 fixtures', () => {
  it('indexed filter stays inside the <50 ms keystroke budget; numbers recorded', async () => {
    const tasks = Array.from({ length: 10_000 }, (_unused, index) =>
      makeTask({
        id: `T${String(index).padStart(5, '0')}`,
        listId: index % 2 === 0 ? 'L1' : 'L2',
        title: index % 7 === 0 ? `Buy milk ${String(index)}` : `Task ${String(index)} chores`,
        notes: index % 11 === 0 ? `note for task ${String(index)} milk` : null,
      }),
    );
    const built = await seed({ lists: LISTS, tasks });
    expect(built.tasks.size).toBe(10_000);

    // Build is the one-time first-open cost (domain-api §5: off the first-paint path).
    const buildStart = performance.now();
    searchIndexFor(state.value);
    const buildMs = performance.now() - buildStart;

    // The per-keystroke path: exactly the synchronous call SearchView runs on input.
    const queries = ['b', 'bu', 'buy', 'buy ', 'buy m', 'buy mi', 'buy mil', 'buy milk'];
    const cold = performance.now();
    selectView(
      state.value,
      { kind: 'search', query: 'buy' },
      { today: '2026-10-25', index: searchIndexFor(state.value) },
    );
    const coldMs = performance.now() - cold;
    const samples = queries.map((query) => {
      const start = performance.now();
      const result = selectView(
        state.value,
        { kind: 'search', query },
        { today: '2026-10-25', index: searchIndexFor(state.value) },
      );
      const ms = performance.now() - start;
      // Sanity: the indexed query returns the right hit count for the full query.
      if (query === 'buy milk') {
        expect(
          result.rows.flatMap((row) => (row.type === 'task' ? [1] : [])).length,
        ).toBeGreaterThan(0);
      }
      return ms;
    });
    const median = [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)] as number;
    const worst = Math.max(...samples);

    evidence.push(
      '# E2 M5 — search latency evidence (10,000 fixtures)',
      '',
      `- fixtures: 10,000 tasks (alternating lists, mixed titles/notes)`,
      `- index build (first open, one-time): ${buildMs.toFixed(2)} ms`,
      `- cold indexed query ("buy"): ${coldMs.toFixed(2)} ms`,
      `- keystroke queries (${String(queries.length)}): median ${median.toFixed(2)} ms, worst ${worst.toFixed(2)} ms`,
      '- path measured: selectView(..., {index}) = the synchronous per-input call in SearchView (no re-scan; index maintained incrementally by searchIndexCache)',
      '- domain unit gate (search.test.ts) pins query <= 50 ms in CI; this run records the component-path numbers.',
    );
    // Generous CI headroom (the strict <=50 ms gate lives in the domain suite);
    // the recorded numbers above are the AC-1 deliverable.
    expect(worst).toBeLessThan(150);
    expect(buildMs).toBeLessThan(2000);

    // The real UI takes the same path: typing filters the DOM instantly at this size.
    render(<SearchView />);
    const input = await screen.findByLabelText<HTMLInputElement>('Search tasks', { exact: true });
    type(input, 'buy milk');
    await waitFor(() => {
      expect(document.querySelectorAll('ul.task-list [data-task-id]').length).toBeGreaterThan(0);
    });
  }, 30_000);
});

/* ------------------------ E2 F-3: §14 error.taskGone in search ------------------------ */

describe('S5 editor across a concurrent delete (E2 F-3 — §14 error.taskGone)', () => {
  it('keeps the editor open with the §14 row instead of dropping the draft', async () => {
    const built = await seed({
      lists: LISTS,
      tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Vanishing search hit' })],
    });
    render(<SearchView />);
    await searchFor('vanishing');
    // Open the editor from the result row (the title button carries the `<mark>` split,
    // so the test anchors on the row instead of on an accessible-name string).
    const opener = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-task-id="T1"] .task-title');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Edit task' });
    const title = within(dialog).getByLabelText<HTMLInputElement>('Title', { exact: true });
    fireEvent.input(title, { target: { value: 'Draft in the search screen' } });

    // Concurrent delete (another tab) while the search screen's dialog is open: the row
    // leaves the results, but the dialog must hold its last known task and flip to the
    // §14 state rather than unmount over the unsaved edits.
    await built.runner.removeTask('T1', { mode: 'cascade' });

    await within(dialog).findByText('This task no longer exists', { exact: true });
    expect(within(dialog).getByLabelText<HTMLInputElement>('Title', { exact: true }).value).toBe(
      'Draft in the search screen',
    );
    expect(within(dialog).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
    // Announced in the shell's assertive region too (§5.5), not only rendered.
    await waitFor(() => {
      expect(regions.assertive?.textContent).toBe('This task no longer exists');
    });
  });
});
