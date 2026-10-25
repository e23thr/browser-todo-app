/**
 * E7 QA probe (t_ed1fa949, h_reviewer) — tag-filter staleness on rename/delete (S1).
 *
 * Defect E7-D3 evidence (docs/qa/e7-organization.md §4). `it.fails` asserts the
 * DESIRED behaviour and passes only because the defect reproduces (polarity
 * convention: docs/qa/e9-review-probe.test.ts — flip to `it()` on the fix).
 *
 * The store signal `tagFilter` (src/features/tasks/store.ts) is never
 * reconciled by `renameTag`/`deleteTag` (TagsManageDialog). Renaming or
 * deleting the tag the view is CURRENTLY filtered by leaves `tagFilter` pointing
 * at the stale name, so `filterByTag` (src/domain/views.ts) matches nothing and
 * the list silently empties while the tag-filter <select> — whose options come
 * from the live task tags — no longer contains that value (the select visually
 * resets to "no filter" while the view stays filtered to nothing).
 *
 * Run: cp docs/qa/e7-qa-tagfilter-probe.test.tsx tests/component/ && \
 *      npx vitest run tests/component/e7-qa-tagfilter-probe.test.tsx && \
 *      mv tests/component/e7-qa-tagfilter-probe.test.tsx docs/qa/
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';

import { TaskScreen } from '../../src/features/tasks/TaskScreen';
import { resetTaskStore, sortMode, tagFilter } from '../../src/features/tasks/store';
import { makeList, makeTask, seed, setUpCoreUi, tearDownCoreUi } from './core-ui-harness';

function renderList(): ReturnType<typeof render> {
  return render(
    <TaskScreen
      view={{ kind: 'list', listId: 'L1' }}
      title="Personal"
      emptyIcon="folder"
      emptyTitle="No open tasks"
      emptyBody="Tasks you add will show up here."
    />,
  );
}

function rows(): (string | null)[] {
  return [...document.querySelectorAll('[data-task-id]')].map((r) => r.getAttribute('data-task-id'));
}

beforeEach(() => {
  setUpCoreUi();
  sortMode.value = 'manual';
});

afterEach(() => {
  tearDownCoreUi();
  resetTaskStore();
});

describe('QA-E7-D3: active tag-filter stays coherent across manage-tags edits', () => {
  it.fails('renaming the active filter tag must not leave a stale filter that empties the list', async () => {
    const h = await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' })],
      tasks: [
        makeTask({ id: 'T1', listId: 'L1', title: 'Alpha', sortOrder: 'a', tags: ['work'] }),
        makeTask({ id: 'T2', listId: 'L1', title: 'Beta', sortOrder: 'b', tags: ['home'] }),
      ],
    });
    renderList();
    await screen.findByRole('button', { name: 'Alpha' });

    // Filter the view to the 'work' tag.
    const filter = await screen.findByTestId('tag-filter');
    fireEvent.change(filter, { target: { value: 'work' } });
    await waitFor(() => expect(rows()).toEqual(['T1']));

    // Rename via the manage dialog (the production path).
    fireEvent.click(await screen.findByRole('button', { name: 'Manage tags' }));
    const dialog = await screen.findByRole('dialog');
    const tagRow = [...dialog.querySelectorAll('li')].find((r) =>
      r.textContent.startsWith('work'),
    );
    if (tagRow === undefined) throw new Error('tag row "work" not found in manage dialog');
    fireEvent.click(within(tagRow).getByRole('button', { name: 'Rename' }));
    const input = within(dialog).getByLabelText('Rename', { exact: true });
    fireEvent.input(input, { target: { value: 'office' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => { expect(h.tasks.get('T1')?.tags).toEqual(['office']); });

    // Close dialog if still open (Save may keep it open when rows remain).
    fireEvent.keyDown(document, { key: 'Escape' });

    // DESIRED: the filter follows the rename — T1 stays visible under 'office'.
    const visible = rows();
    const select = await screen.findByTestId<HTMLSelectElement>('tag-filter');
    // eslint-disable-next-line no-console
    console.log(
      '[qa-e7-d3] rows after rename of active filter =',
      JSON.stringify(visible),
      '| select value =',
      select.value,
      '| options =',
      JSON.stringify([...select.options].map((o) => o.value)),
    );
    expect(visible).toEqual(['T1']);
    expect(select.value).toBe('office');
  });

  it.fails('deleting the active filter tag must clear the filter (not empty the list)', async () => {
    const h = await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' })],
      tasks: [
        makeTask({ id: 'T1', listId: 'L1', title: 'Alpha', sortOrder: 'a', tags: ['work'] }),
        makeTask({ id: 'T2', listId: 'L1', title: 'Beta', sortOrder: 'b', tags: ['home'] }),
      ],
    });
    renderList();
    await screen.findByRole('button', { name: 'Alpha' });

    const filter = await screen.findByTestId('tag-filter');
    fireEvent.change(filter, { target: { value: 'work' } });
    await waitFor(() => expect(rows()).toEqual(['T1']));

    fireEvent.click(await screen.findByRole('button', { name: 'Manage tags' }));
    const dialog = await screen.findByRole('dialog');
    const tagRow = [...dialog.querySelectorAll('li')].find((r) =>
      r.textContent.startsWith('work'),
    );
    if (tagRow === undefined) throw new Error('tag row "work" not found in manage dialog');
    fireEvent.click(within(tagRow).getByRole('button', { name: 'Delete' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete tag?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete tag' }));
    await waitFor(() => { expect(h.tasks.get('T1')?.tags).toEqual([]); });

    // DESIRED: the active filter clears, so both tasks are visible again.
    const visible = rows();
    const select = await screen.findByTestId<HTMLSelectElement>('tag-filter');
    // eslint-disable-next-line no-console
    console.log(
      '[qa-e7-d3] rows after delete of active filter =',
      JSON.stringify(visible),
      '| select value =',
      select.value,
      '| options =',
      JSON.stringify([...select.options].map((o) => o.value)),
    );
    expect(visible).toEqual(['T1', 'T2']);
    expect(select.value).toBe('');
  });
});
