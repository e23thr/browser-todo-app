/**
 * E2 core-UI QA probes — independent verification of the M1–M4 flows (h_reviewer).
 *
 * Written for docs/qa/e2-core-ui.md against PROJECT_ANALYSIS §4 (M1–M4), §8 (accessibility),
 * §10 (E6 date semantics) and design core-domain §5.5 / §5.6 / §14 / §16. The probes
 * re-derive the acceptance-critical assertions instead of re-running the implementation's:
 *
 *   - E6 date-boundary membership for every view (today−1 / today / +6 / +7 / no date),
 *   - the §5.6 optimistic apply + rollback contract with a FORCED port failure,
 *   - the F3 900 ms completion retention and the §5.5 announcement set,
 *   - both delete-list disposition branches asserted against DOMAIN state,
 *   - §14 loading / error / empty / zero-list states.
 *
 * The keyboard-only pass of the five core flows, the <100 ms optimistic-add measurement and
 * the ≥44 px touch-target sweep run in a real browser: tests/e2e/core-ui-keyboard.spec.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import type { ComponentType, JSX } from 'preact';

import { AllOpenView } from '../../src/features/all/AllOpenView';
import { CompletedView } from '../../src/features/completed/CompletedView';
import { ListView } from '../../src/features/lists/ListView';
import { ListsManageView } from '../../src/features/lists/ListsManageView';
import { TodayView } from '../../src/features/today/TodayView';
import { WeekView } from '../../src/features/week/WeekView';
import {
  bindRunnerForTest,
  bootError,
  resetTaskStore,
  setTaskDone,
  state,
  status,
  WRITE_SLOW_MS,
} from '../../src/features/tasks/store';
import { announce } from '../../src/app/announce';
import { clearToasts, toasts } from '../../src/features/tasks/toasts';
import {
  makeList,
  makeTask,
  makeTestRunner,
  regions,
  seed,
  setUpCoreUi,
  stubWideViewport,
  tearDownCoreUi,
} from './core-ui-harness';

/** Local calendar-day label `offset` days from today (E6: local components, never UTC). */
function dayOffset(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const pad = (n: number): string => (n < 10 ? `0${String(n)}` : String(n));
  return `${String(d.getFullYear()).padStart(4, '0')}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function row(id: string): HTMLElement | null {
  return document.querySelector(`[data-task-id="${id}"]`);
}

function visibleTaskIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[data-task-id]')].map(
    (el) => el.dataset['taskId'] ?? '',
  );
}

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Mount inside a real `<main>`: the shell's focus contracts target `main [data-view-title]`,
 * which only resolves when the screen sits in its landmark (as it does in the app).
 * The ad-hoc containers are removed again in `afterEach`.
 */
const mainContainers: HTMLElement[] = [];

function renderInMain(element: JSX.Element): void {
  const container = document.createElement('main');
  document.body.append(container);
  mainContainers.push(container);
  render(element, { container });
}

/** Boundary seed: one task on each side of every date edge the spec draws. */
async function seedBoundaries(): Promise<void> {
  await seed({
    lists: [makeList({ id: 'L1', name: 'Personal' }), makeList({ id: 'L2', name: 'Work' })],
    tasks: [
      makeTask({ id: 'T_OVER', listId: 'L1', title: 'Overdue bill', dueDate: dayOffset(-1) }),
      makeTask({ id: 'T_TODAY', listId: 'L1', title: 'Due today', dueDate: dayOffset(0) }),
      makeTask({ id: 'T_SIX', listId: 'L2', title: 'Six days out', dueDate: dayOffset(6) }),
      makeTask({ id: 'T_SEVEN', listId: 'L2', title: 'Seven days out', dueDate: dayOffset(7) }),
      makeTask({ id: 'T_NODATE', listId: 'L1', title: 'Someday task' }),
      makeTask({
        id: 'T_DONE',
        listId: 'L1',
        title: 'Finished today',
        status: 'done',
        dueDate: dayOffset(0),
        completedAt: Date.now(),
      }),
    ],
  });
}

beforeEach(() => {
  setUpCoreUi();
});

afterEach(() => {
  tearDownCoreUi();
  resetTaskStore();
  clearToasts();
  bootError.value = null;
  for (const container of mainContainers.splice(0)) container.remove();
});

/* ------------------------------------------------------------------ M3 views */

describe('M3 views — E6 date-boundary membership (PROJECT_ANALYSIS §10 E6)', () => {
  it('Today: overdue + due-today only; the +7, no-date and completed tasks stay out', async () => {
    await seedBoundaries();
    render(<TodayView />);

    expect(await screen.findByRole('heading', { level: 2, name: 'Overdue (1)' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Today (1)' })).toBeTruthy();
    expect(screen.getByText('2 tasks', { exact: true })).toBeTruthy();
    expect(visibleTaskIds().sort()).toEqual(['T_OVER', 'T_TODAY']);
    // Non-colour overdue signal: text + `!` marker (§8 "status never colour alone").
    const badge = document.querySelector('.due-badge-overdue');
    expect(badge?.textContent).toContain('Overdue');
    expect(badge?.querySelector('.due-marker')?.textContent).toBe('!');
  });

  it('Next 7 days: window is today … today+6 inclusive — the +7 task is outside it', async () => {
    await seedBoundaries();
    render(<WeekView />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Next 7 days' })).toBeTruthy();
    const ids = visibleTaskIds();
    expect(ids).toContain('T_TODAY');
    expect(ids).toContain('T_SIX');
    // Boundary rules: overdue is not re-listed, +7 is one day past the window.
    expect(ids).not.toContain('T_OVER');
    expect(ids).not.toContain('T_SEVEN');
    expect(ids).not.toContain('T_NODATE');
    expect(ids).not.toContain('T_DONE');
    expect(screen.getByText('2 tasks', { exact: true })).toBeTruthy();
    // Empty day groups are omitted (ux-foundation §4.4): exactly two day headers.
    expect(document.querySelectorAll('.group-header')).toHaveLength(2);
  });

  it('All open / per-list / Completed: membership and counts per the selector', async () => {
    await seedBoundaries();

    const all = render(<AllOpenView />);
    expect(await screen.findByRole('heading', { level: 1, name: 'All open' })).toBeTruthy();
    expect(screen.getByText('5 tasks', { exact: true })).toBeTruthy();
    expect(visibleTaskIds().sort()).toEqual(['T_NODATE', 'T_OVER', 'T_SEVEN', 'T_SIX', 'T_TODAY']);
    all.unmount();

    // Per-list: one list's open tasks in manual order, no list badge, no group headers.
    const list = render(<ListView params={{ id: 'L1' }} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Personal' })).toBeTruthy();
    expect(visibleTaskIds().sort()).toEqual(['T_NODATE', 'T_OVER', 'T_TODAY']);
    expect(document.querySelector('.list-badge')).toBeNull();
    expect(document.querySelector('.group-header')).toBeNull();
    list.unmount();

    const completed = render(<CompletedView key="c" />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Completed' })).toBeTruthy();
    expect(visibleTaskIds()).toEqual(['T_DONE']);
    expect(screen.getByText('1 tasks', { exact: true })).toBeTruthy();
    completed.unmount();
  });
});

/* -------------------------------------------------------------------- M4 F3 */

describe('M4 complete/uncomplete — §5.6 optimism, F3 retention, §5.5 announcements', () => {
  it('applies completion to the UI while the write is still in flight (hangWrites)', async () => {
    // A runner whose setDone NEVER settles: anything the user can see can only
    // come from the optimistic step — no authoritative swap can ever arrive.
    const built = makeTestRunner({
      lists: [makeList({ id: 'L1', name: 'Personal' })],
      tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Water plants', dueDate: dayOffset(0) })],
      hangWrites: true,
    });
    bindRunnerForTest(built.runner);
    await built.runner.load();
    render(<TodayView />);

    const checkbox = await screen.findByRole('checkbox', {
      name: 'Mark "Water plants" as complete',
    });
    fireEvent.click(checkbox);

    // Synchronous optimistic apply (pipeline steps 1–2), before any I/O settles.
    expect(state.value.tasks.get('T1')?.status).toBe('done');
    expect(row('T1')?.getAttribute('data-done')).toBe('true');
    expect(row('T1')?.getAttribute('data-retained')).toBe('true');
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('Task completed');
    });
    // The write never settled — the UI state above is the optimistic one, by construction.
    expect(state.value.tasks.get('T1')?.status).toBe('done');
  });

  it('keeps the completed row visible for 900 ms, then moves it to Completed', async () => {
    await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' })],
      tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Read a chapter', dueDate: dayOffset(0) })],
    });
    render(<TodayView />);

    fireEvent.click(
      await screen.findByRole('checkbox', { name: 'Mark "Read a chapter" as complete' }),
    );
    expect(row('T1')?.getAttribute('data-retained')).toBe('true');

    // RETAIN_COMPLETED_MS = 900: still on screen just after the toggle…
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(row('T1')).not.toBeNull();
    // …and gone from the open view once the retention window elapses.
    await waitFor(
      () => {
        expect(row('T1')).toBeNull();
      },
      { timeout: 2000 },
    );
    expect(state.value.tasks.get('T1')?.completedAt).toBeTypeOf('number');
  });

  it('uncompletes from Completed: state open, completedAt cleared, announced', async () => {
    await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' })],
      tasks: [
        makeTask({
          id: 'T1',
          listId: 'L1',
          title: 'Already done',
          status: 'done',
          completedAt: Date.now(),
        }),
      ],
    });
    render(<CompletedView />);

    fireEvent.click(
      await screen.findByRole('checkbox', { name: 'Mark "Already done" as not complete' }),
    );
    await waitFor(() => {
      expect(state.value.tasks.get('T1')?.status).toBe('open');
    });
    expect(state.value.tasks.get('T1')?.completedAt).toBeUndefined();
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('Task reopened');
    });
    await waitFor(() => {
      expect(visibleTaskIds()).toEqual([]);
    });
  });
});

/* ------------------------------------------------------- §5.6 write protocol */

describe('§5.6 write protocol — forced failure rolls back and reports', () => {
  it('rolls the row back to its committed image, announces assertively and offers Retry', async () => {
    const built = await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' })],
      tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Flaky write', dueDate: dayOffset(0) })],
    });
    // Break ONLY the write path, behind the pipeline's back: the row is still in the
    // loaded state (committed baseline) but gone from the port's map, so setDone fails
    // with RULE/TASK_MISSING after the optimistic apply has already painted.
    built.tasks.delete('T1');
    render(<TodayView />);

    const checkbox = await screen.findByRole('checkbox', {
      name: 'Mark "Flaky write" as complete',
    });
    fireEvent.click(checkbox);

    // Optimistic apply is synchronous — visible before the write could settle.
    expect(state.value.tasks.get('T1')?.status).toBe('done');
    expect(row('T1')?.getAttribute('data-done')).toBe('true');

    // Failure: reverted to the committed baseline, reported on BOTH channels.
    await waitFor(() => {
      expect(state.value.tasks.get('T1')?.status).toBe('open');
    });
    expect(row('T1')?.getAttribute('data-done')).toBeNull();
    await waitFor(() => {
      expect(regions.assertive?.textContent).toBe('Could not save. Your change was undone.');
    });
    expect(toasts.value).toHaveLength(1);
    expect(toasts.value[0]?.messageKey).toBe('error.save.title');
    expect(toasts.value[0]?.action?.key).toBe('common.retry');
  });
});

/* -------------------- §5.6 stale fallback report (E2 F-3 gate flake) -------------------- */

describe('§5.6 never-settling write — its slow-write report must not outlive its test', () => {
  /** Arm `setTaskDone` against a port whose `setDone` never settles (the hangWrites probe). */
  async function startHangingWrite(): Promise<void> {
    await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' })],
      tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Hanging write' })],
      hangWrites: true,
    });
    void setTaskDone('T1', true);
  }

  /** Past WRITE_SLOW_MS plus the 60 ms announce delay, so a report would have landed. */
  function passSlowWriteWindow(): void {
    vi.advanceTimersByTime(WRITE_SLOW_MS + 100);
  }

  it('control: while the write is in flight the WRITE_SLOW_MS report fires once', async () => {
    vi.useFakeTimers();
    try {
      await startHangingWrite();
      expect(toasts.value).toHaveLength(0);

      passSlowWriteWindow();

      expect(toasts.value).toHaveLength(1);
      expect(toasts.value[0]?.messageKey).toBe('error.save.title');
      expect(regions.assertive?.textContent).toBe('Could not save. Your change was undone.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('resetTaskStore cancels it, so no report leaks into the next test (E2 F-3)', async () => {
    vi.useFakeTimers();
    try {
      await startHangingWrite();
      // Exactly what every component suite runs between tests (core-ui-harness
      // `setUpCoreUi` / this file's afterEach).
      resetTaskStore();

      passSlowWriteWindow();

      // Nothing may survive the reset: no toast, and — the actual E2 gate flake — no
      // assertive announcement. A surviving report bumps the GLOBAL announce token and
      // swallows whatever pending polite message the next test announced, which is how
      // `expected '' to be 'List "Scratch" deleted (2 tasks)'` showed up under load.
      expect(toasts.value).toHaveLength(0);
      expect(regions.assertive?.textContent ?? '').toBe('');
      expect(regions.polite?.textContent ?? '').toBe('');
    } finally {
      vi.useRealTimers();
    }
  });
});

/* --------- §5.5 cross-region independence (E2 F-3 follow-up, WCAG 4.1.3) --------- */

describe('§5.5 live regions — one region never cancels the other’s pending message', () => {
  it('lands BOTH halves of the +1066/+1072 collision: the rollback report must not swallow the optimistic completion', async () => {
    const built = await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' })],
      tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Flaky toggle', dueDate: dayOffset(0) })],
    });
    // Break ONLY the write path (the §5.6 probe above): the optimistic apply paints and
    // announces `Task completed` (polite) on click, the failed write rolls back and reports
    // `Could not save…` (assertive) a few ms later — the exact two-message collision of the
    // E2 F-3 evidence log, well inside one 60 ms announce window.
    built.tasks.delete('T1');
    render(<TodayView />);

    fireEvent.click(
      await screen.findByRole('checkbox', { name: 'Mark "Flaky toggle" as complete' }),
    );

    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('Task completed');
    });
    await waitFor(() => {
      expect(regions.assertive?.textContent).toBe('Could not save. Your change was undone.');
    });
  });

  it('an assertive announce does NOT cancel a pending polite message', async () => {
    // Production collision: a fast failing write's assertive `a11y.saveFailed` lands inside
    // the announce window of `a11y.taskSaved` / `a11y.taskCompleted`. Driven here through
    // announce() over the harness-mounted production regions (role=status / role=alert).
    announce('Task completed');
    await tick(6);
    announce('Could not save. Your change was undone.', 'assertive');
    await tick(120);

    expect(regions.polite?.textContent).toBe('Task completed');
    expect(regions.assertive?.textContent).toBe('Could not save. Your change was undone.');
  });

  it('a polite announce does NOT cancel a pending assertive message (the mirror)', async () => {
    announce('Could not save. Your change was undone.', 'assertive');
    await tick(6);
    announce('Task completed');
    await tick(120);

    expect(regions.assertive?.textContent).toBe('Could not save. Your change was undone.');
    expect(regions.polite?.textContent).toBe('Task completed');
  });
});

/* -------------------------------------------------------------------- M1 F2 */

describe('M1 editor (F2) — save, focus return, taskGone', () => {
  it('saves title + priority + list in one path, closes, announces and restores focus', async () => {
    await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' }), makeList({ id: 'L2', name: 'Work' })],
      tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Old name', dueDate: dayOffset(0) })],
    });
    render(<TodayView />);

    const opener = await screen.findByRole('button', { name: 'Old name' });
    // A real pointer click focuses the button first (jsdom does not) — the editor then
    // restores focus to it on close (§16 item 19).
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Edit task' });
    // §16 item 18: focus starts on the title field.
    await waitFor(() => {
      expect(document.activeElement).toBe(within(dialog).getByLabelText('Title', { exact: true }));
    });

    const title = within(dialog).getByLabelText<HTMLInputElement>('Title', { exact: true });
    fireEvent.input(title, { target: { value: 'New name' } });
    fireEvent.click(within(dialog).getByLabelText('Medium', { exact: true }));
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'List' }), {
      target: { value: 'L2' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit task' })).toBeNull();
    });
    const saved = state.value.tasks.get('T1');
    expect(saved?.title).toBe('New name');
    expect(saved?.listId).toBe('L2');
    expect(saved?.priority).toBe(1);
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('Task saved');
    });
    // §16 item 19: focus returns to the originating row control.
    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
  });

  it('taskGone (§14 S4): a concurrent delete keeps the editor, the draft and an honest message (F-3)', async () => {
    const built = await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' })],
      tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Vanishing act', dueDate: dayOffset(0) })],
    });
    render(<TodayView />);

    fireEvent.click(await screen.findByRole('button', { name: 'Vanishing act' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit task' });
    const title = within(dialog).getByLabelText<HTMLInputElement>('Title', { exact: true });
    title.focus();
    // Unsaved work the PM decision forbids losing silently.
    fireEvent.input(title, { target: { value: 'Draft that must not vanish' } });

    // Deleted concurrently (another tab / pipeline removal) while the dialog is open:
    // removeTask EVICTS the row from state. The composed screen must NOT unmount the
    // editor over that — it holds the last known task so the §14 `error.taskGone` state
    // is reachable in situ (E2 F-3; core-ui-composer.test.tsx pins the standalone half).
    await built.runner.removeTask('T1');

    // 1. The dialog is still open and the §14 row renders inside it.
    const gone = await within(dialog).findByText('This task no longer exists', { exact: true });
    expect(gone).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Edit task' })).toBe(dialog);

    // 2. The unsaved draft survives verbatim and Save is disabled (§14 S4).
    expect(within(dialog).getByLabelText<HTMLInputElement>('Title', { exact: true }).value).toBe(
      'Draft that must not vanish',
    );
    expect(within(dialog).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);

    // 3. The feedback is ANNOUNCED, not only painted: it lands in the shell's assertive
    //    region (§5.5) as well as the dialog's own role="alert" row.
    await waitFor(() => {
      expect(regions.assertive?.textContent).toBe('This task no longer exists');
    });

    // 4. Keyboard: the row's removal does not steal focus — the caret is still in the
    //    dialog, so the state and its controls stay reachable.
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Title', { exact: true }));

    // 5. The only way the draft goes away is the explicit S7.3 discard confirm.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    const discard = await screen.findByRole('dialog', { name: 'Discard changes?' });
    expect(within(discard).getByText('You have unsaved changes.', { exact: true })).toBeTruthy();
    // Keep editing → the draft is still there.
    fireEvent.click(within(discard).getByRole('button', { name: 'Keep editing' }));
    expect(within(dialog).getByLabelText<HTMLInputElement>('Title', { exact: true }).value).toBe(
      'Draft that must not vanish',
    );
  });

  it('a delete the user confirms from the editor closes it without the taskGone state', async () => {
    await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' })],
      tasks: [
        makeTask({ id: 'T1', listId: 'L1', title: 'Deliberate delete', dueDate: dayOffset(0) }),
      ],
    });
    render(<TodayView />);

    fireEvent.click(await screen.findByRole('button', { name: 'Deliberate delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit task' });
    const title = within(dialog).getByLabelText<HTMLInputElement>('Title', { exact: true });
    fireEvent.input(title, { target: { value: 'Edited right before deleting' } });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete task' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete task?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));

    // A user-initiated delete is NOT the §14 error state: no "task no longer exists"
    // row and no assertive announcement may fire on the way out (the editor closes
    // before the optimistic eviction can render the gone state).
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit task' })).toBeNull();
    });
    expect(screen.queryByText('This task no longer exists', { exact: true })).toBeNull();
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('Task deleted');
    });
    expect(regions.assertive?.textContent ?? '').not.toBe('This task no longer exists');
  });
});

/* -------------------------------------------------------------------- M1 F4 */

describe('M1 delete task (F4 / S7.1) — confirm, Escape, announcement', () => {
  async function openConfirm(): Promise<HTMLElement> {
    const menu = await screen.findByRole('button', { name: 'Actions for "Throw away"' });
    fireEvent.click(menu);
    const popup = await screen.findByRole('menu');
    fireEvent.click(within(popup).getByRole('menuitem', { name: 'Delete' }));
    return screen.findByRole('dialog', { name: 'Delete task?' });
  }

  it('Escape cancels without touching the task and returns focus to the row menu', async () => {
    await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' })],
      tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Throw away' })],
    });
    render(<AllOpenView />);
    const trigger = await screen.findByRole('button', { name: 'Actions for "Throw away"' });

    const dialog = await openConfirm();
    expect(
      within(dialog).getByText('"Throw away" will be deleted. This can\'t be undone.', {
        exact: true,
      }),
    ).toBeTruthy();
    // S7: initial focus on the safe action.
    await waitFor(() => {
      expect((document.activeElement as HTMLButtonElement | null)?.textContent).toBe('Cancel');
    });

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Delete task?' })).toBeNull();
    });
    expect(state.value.tasks.has('T1')).toBe(true);
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });

  it('confirm deletes the task and announces "Task deleted"', async () => {
    await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' })],
      tasks: [makeTask({ id: 'T1', listId: 'L1', title: 'Throw away' })],
    });
    render(<AllOpenView />);

    const dialog = await openConfirm();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(state.value.tasks.has('T1')).toBe(false);
    });
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('Task deleted');
    });
  });
});

/* -------------------------------------------------------------------- M2 F5 */

describe('M2 lists (F5/F6) — create, rename, keyboard reorder, disposition', () => {
  async function openRowMenu(name: string): Promise<HTMLElement> {
    fireEvent.click(await screen.findByRole('button', { name }));
    return screen.findByRole('menu');
  }

  it('creates a list and renames it through the desktop ListDialog (F5.2 wide path)', async () => {
    await seed({ lists: [makeList({ id: 'L1', name: 'Personal' })] });
    // The compact path renames inline (covered by core-ui-lists.test.tsx); this probe takes
    // the OTHER branch — the desktop dialog — so both F5.2 paths are verified somewhere.
    const restoreWide = stubWideViewport();
    try {
      render(<ListsManageView />);

      fireEvent.click(await screen.findByRole('button', { name: 'New list' }));
      const dialog = await screen.findByRole('dialog', { name: 'New list' });
      fireEvent.input(within(dialog).getByLabelText('List name', { exact: true }), {
        target: { value: 'Errands' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

      await waitFor(() => {
        expect([...state.value.lists.values()].some((list) => list.name === 'Errands')).toBe(true);
      });
      await waitFor(() => {
        expect(regions.polite?.textContent).toBe('List created: Errands');
      });

      const menu = await openRowMenu('Actions for "Errands"');
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Rename' }));
      const rename = await screen.findByRole('dialog', { name: 'Rename' });
      fireEvent.input(within(rename).getByLabelText('List name', { exact: true }), {
        target: { value: 'Groceries' },
      });
      fireEvent.click(within(rename).getByRole('button', { name: 'Save' }));

      await waitFor(() => {
        expect(regions.polite?.textContent).toBe('List renamed to Groceries');
      });
      expect([...state.value.lists.values()].some((list) => list.name === 'Groceries')).toBe(true);
    } finally {
      restoreWide();
    }
  });

  it('Alt+ArrowDown moves a list one position; the boundary is a no-op with its own message', async () => {
    await seed({
      lists: [
        makeList({ id: 'L1', name: 'Alpha', sortOrder: 'a' }),
        makeList({ id: 'L2', name: 'Beta', sortOrder: 'b' }),
      ],
    });
    render(<ListsManageView />);

    const liveOrder = (): string[] =>
      [...state.value.lists.values()]
        .filter((list) => list.deletedAt === null)
        .sort((a, b) => (a.sortOrder < b.sortOrder ? -1 : 1))
        .map((list) => list.id);

    const alphaRow = await waitFor(() => {
      const el = document.querySelector('[data-list-id="L1"]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    fireEvent.keyDown(alphaRow, { key: 'ArrowDown', altKey: true });
    await waitFor(() => {
      expect(liveOrder()).toEqual(['L2', 'L1']);
    });
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('List moved');
    });

    // L1 is last now: another Alt+↓ is a boundary no-op with its own announcement.
    const alphaRowNow = document.querySelector('[data-list-id="L1"]') as HTMLElement;
    fireEvent.keyDown(alphaRowNow, { key: 'ArrowDown', altKey: true });
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('Already at the bottom');
    });
    expect(liveOrder()).toEqual(['L2', 'L1']);
  });

  it('F6 disposition A (move): one confirm retargets every task and announces the count', async () => {
    await seed({
      lists: [
        makeList({ id: 'L1', name: 'Archive', sortOrder: 'a' }),
        makeList({ id: 'L2', name: 'Personal', sortOrder: 'b' }),
      ],
      tasks: [
        makeTask({ id: 'T1', listId: 'L1', title: 'Kept open', status: 'open' }),
        makeTask({
          id: 'T2',
          listId: 'L1',
          title: 'Kept done',
          status: 'done',
          completedAt: Date.now(),
        }),
      ],
    });
    renderInMain(<ListsManageView />);
    const menu = await openRowMenu('Actions for "Archive"');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete list' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete list?' });
    expect(
      within(dialog).getByText(
        '"Archive" has 1 open and 1 completed tasks. Choose what happens to them.',
        { exact: true },
      ),
    ).toBeTruthy();
    // Option A is the default and the target select defaults to the other live list.
    const target = within(dialog).getByLabelText<HTMLSelectElement>('Move into', { exact: true });
    expect(target.value).toBe('L2');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete list' }));
    await waitFor(() => {
      expect(state.value.lists.has('L1')).toBe(false);
    });
    expect(state.value.tasks.get('T1')?.listId).toBe('L2');
    expect(state.value.tasks.get('T2')?.listId).toBe('L2');
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('List "Archive" deleted (2 tasks)');
    });
    // §16 item 29: focus lands on the Lists screen heading after the deletion.
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('data-view-title')).toBe('');
    });
  });

  it('F6 disposition B (delete tasks): confirming the danger option removes them too', async () => {
    await seed({
      lists: [
        makeList({ id: 'L1', name: 'Scratch', sortOrder: 'a' }),
        makeList({ id: 'L2', name: 'Personal', sortOrder: 'b' }),
      ],
      tasks: [
        makeTask({ id: 'T1', listId: 'L1', title: 'Doomed open' }),
        makeTask({
          id: 'T2',
          listId: 'L1',
          title: 'Doomed done',
          status: 'done',
          completedAt: Date.now(),
        }),
      ],
    });
    render(<ListsManageView />);

    const menu = await openRowMenu('Actions for "Scratch"');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete list' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete list?' });
    fireEvent.click(within(dialog).getByLabelText('Also delete 2 tasks', { exact: true }));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete list' }));
    await waitFor(() => {
      expect(state.value.lists.has('L1')).toBe(false);
    });
    // Tombstoned rows must leave every view: only L2's live tasks remain visible in state.
    const visible = [...state.value.tasks.values()].filter((task) => task.deletedAt === null);
    expect(visible).toHaveLength(0);
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('List "Scratch" deleted (2 tasks)');
    });
  });
});

/* -------------------------------------------------------------------- §14 */

describe('§14 state matrix — loading, error, empty, zero-list composer', () => {
  it('loading: aria-busy skeleton with the a11y.loading status line', () => {
    render(<TodayView />);
    const skeleton = screen.getByTestId('skeleton');
    expect(skeleton.getAttribute('aria-busy')).toBe('true');
    expect(within(skeleton).getByRole('status').textContent).toBe('Loading tasks…');
    // Chrome paints without data: the h1 is there immediately.
    expect(screen.getByRole('heading', { level: 1, name: 'Today' })).toBeTruthy();
  });

  it('error: role=alert boot panel with Retry and the typed error code', () => {
    status.value = 'error';
    bootError.value = { code: 'BLOCKED', message: 'probe' };
    render(<TodayView />);

    const panel = screen.getByTestId('boot-error');
    expect(panel.getAttribute('role')).toBe('alert');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.getByTestId('boot-error-code').textContent).toBe('BLOCKED');
  });

  it('empty: every view renders its §14 empty copy with an Add task action', async () => {
    await seed({ lists: [], tasks: [] });
    const cases: readonly [ComponentType, string][] = [
      [TodayView, 'Nothing due today'],
      [WeekView, 'Nothing due in the next 7 days'],
      [AllOpenView, 'No open tasks'],
      [CompletedView, 'Nothing completed yet'],
    ];
    for (const [Component, title] of cases) {
      const view = render(<Component />);
      expect((await screen.findByRole('heading', { level: 2, name: title })).textContent).toBe(
        title,
      );
      expect(screen.getAllByRole('button', { name: 'Add task' }).length).toBeGreaterThan(0);
      view.unmount();
    }
  });

  it('zero lists: the composer is disabled with needsList + a New list action', async () => {
    await seed({ lists: [], tasks: [] });
    render(<ListsManageView />);
    expect(await screen.findByRole('heading', { level: 2, name: 'No lists yet' })).toBeTruthy();
    expect(
      screen.getByText('Tasks live in lists. Create your first list to start.', { exact: true }),
    ).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'New list' }).length).toBeGreaterThan(0);
  });
});
