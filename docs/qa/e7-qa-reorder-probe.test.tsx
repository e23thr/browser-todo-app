/**
 * E7 QA probe (t_ed1fa949, h_reviewer) — reorder failure toast on a parent (S2).
 *
 * Defect E7-D2 evidence (docs/qa/e7-organization.md §4). `it.fails` asserts the
 * DESIRED behaviour and passes only because the defect reproduces (polarity
 * convention: docs/qa/e9-review-probe.test.ts — flip to `it()` on the fix).
 *
 * Moving a PARENT down when the next rendered row is its own subtask computes
 * position = { afterId: <the subtask> } over the FLAT row list. Real
 * TaskRepo.move rejects that anchor (the subtask is not in the top-level
 * sibling group — REORDER_TARGET_NOT_IN_GROUP), `#rejectSync` fires and the
 * store surfaces the save-failure toast "Could not save. Your change was
 * undone." for a gesture that looks perfectly legal to the user.
 *
 * Companion probe: e7-qa-reorder-real-probe.test.ts (D1 — the same gesture
 * against the REAL TaskRepo silently unparents a SUBTASK; the component fixture
 * port masks D1 because it spreads `current`, so D1 evidence lives there only).
 *
 * Run: cp docs/qa/e7-qa-reorder-probe.test.tsx tests/component/ && \
 *      npx vitest run tests/component/e7-qa-reorder-probe.test.tsx && \
 *      mv tests/component/e7-qa-reorder-probe.test.tsx docs/qa/
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/preact';

import { TaskScreen } from '../../src/features/tasks/TaskScreen';
import { ToastHost } from '../../src/features/tasks/ToastHost';
import { resetTaskStore, sortMode, tagFilter } from '../../src/features/tasks/store';
import { clearToasts } from '../../src/features/tasks/toasts';
import { makeList, makeTask, seed, setUpCoreUi, tearDownCoreUi } from './core-ui-harness';

function renderList(): ReturnType<typeof render> {
  return render(
    <>
      <ToastHost />
      <TaskScreen
        view={{ kind: 'list', listId: 'L1' }}
        title="Personal"
        emptyIcon="folder"
        emptyTitle="No tasks"
        emptyBody="Tasks you add will show up here."
      />
    </>,
  );
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

describe('QA-E7-D2: reorder gestures never fabricate structural errors', () => {
  it.fails(
    'Move down on a parent whose next rendered row is its own subtask must not error',
    async () => {
      const h = await seed({
        lists: [makeList({ id: 'L1', name: 'Personal' })],
        tasks: [
          makeTask({ id: 'PAR', listId: 'L1', title: 'Parent', sortOrder: 'a' }),
          makeTask({
            id: 'SUB1',
            listId: 'L1',
            title: 'Sub one',
            parentTaskId: 'PAR',
            sortOrder: 'b',
          }),
          makeTask({ id: 'TOP2', listId: 'L1', title: 'Top two', sortOrder: 'c' }),
        ],
      });
      renderList();
      await screen.findByRole('button', { name: 'Parent' });

      fireEvent.click(await screen.findByRole('button', { name: 'Actions for "Parent"' }));
      const menu = await screen.findByRole('menu');
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move down' }));

      // Allow the optimistic write to settle, then check for a failure toast.
      await new Promise((r) => setTimeout(r, 50));
      const failure = document.querySelector('.toast-error');
      // eslint-disable-next-line no-console
      console.log('[qa-e7-d2] parent move-down failure toast:', failure?.textContent ?? 'none');
      // DESIRED: either the move succeeds (parent lands after its subtree in
      // the top-level group) or it is a silent no-op — never a scary toast.
      expect(failure).toBeNull();
      // And children keep their parent either way.
      expect(h.tasks.get('SUB1')?.parentTaskId).toBe('PAR');
    },
  );
});
