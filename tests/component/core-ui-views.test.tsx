/**
 * Core UI component tests — the five views (design §7 S2 / flow F7, M3) and the
 * §14 empty/loading/error state matrix.
 *
 * Grouping, membership and order come from the domain selector; these tests pin the
 * view-level contract the reviewer checks against §16 item 6 (D3/ux-foundation grouping),
 * the count header, list badges, and the per-list deep-link error path.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/preact';
import type { JSX } from 'preact';

import { AllOpenView } from '../../src/features/all/AllOpenView';
import { CompletedView } from '../../src/features/completed/CompletedView';
import { ListView } from '../../src/features/lists/ListView';
import { TodayView } from '../../src/features/today/TodayView';
import { WeekView } from '../../src/features/week/WeekView';
import { bootError, resetTaskStore, status } from '../../src/features/tasks/store';
import { clearToasts } from '../../src/features/tasks/toasts';
import { makeList, makeTask, regions, seed, setUpCoreUi, tearDownCoreUi } from './core-ui-harness';

function dayOffset(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const pad = (n: number): string => (n < 10 ? `0${String(n)}` : String(n));
  return `${String(d.getFullYear()).padStart(4, '0')}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const EMPTY_BODIES: readonly [string, string][] = [
  ['today', 'Enjoy the clear space, or add something.'],
  ['week', 'Nothing is scheduled in this window yet.'],
  ['all', 'Tasks you add will show up here.'],
  ['completed', 'Completed tasks will collect here.'],
];

beforeEach(() => {
  setUpCoreUi();
});

afterEach(() => {
  tearDownCoreUi();
  resetTaskStore();
  clearToasts();
  bootError.value = null;
});

describe('§14 loading & error states', () => {
  it('renders the skeleton (aria-busy + a11y.loading) until the store is ready', () => {
    // No runner bound: status stays idle/loading.
    render(<TodayView />);
    const skeleton = screen.getByTestId('skeleton');
    expect(skeleton.getAttribute('aria-busy')).toBe('true');
    expect(within(skeleton).getByRole('status').textContent).toBe('Loading tasks…');
    // The h1 still paints (chrome never waits on data).
    expect(screen.getByRole('heading', { level: 1, name: 'Today' })).toBeTruthy();
  });

  it('renders the boot error panel with Retry when the store failed to load', () => {
    status.value = 'error';
    bootError.value = { code: 'UNAVAILABLE' };
    render(<TodayView />);

    const panel = screen.getByTestId('boot-error');
    expect(panel.getAttribute('role')).toBe('alert');
    expect(within(panel).getByRole('heading', { name: "Couldn't load your tasks" })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.getByTestId('boot-error-code').textContent).toBe('UNAVAILABLE');
    // Recovery link into the storage panel (E3's export/restore lives there).
    expect(within(panel).getByRole('link', { name: 'Storage & backup' })).toBeTruthy();
  });
});

describe('M3 five views — grouping per the domain selector', () => {
  async function seedMixed(): Promise<void> {
    await seed({
      lists: [makeList({ id: 'L1', name: 'Personal' }), makeList({ id: 'L2', name: 'Work' })],
      tasks: [
        makeTask({ id: 'T1', listId: 'L1', title: 'Overdue thing', dueDate: dayOffset(-2) }),
        makeTask({ id: 'T2', listId: 'L1', title: 'Due today', dueDate: dayOffset(0) }),
        makeTask({ id: 'T3', listId: 'L2', title: 'Due later', dueDate: dayOffset(4) }),
        makeTask({ id: 'T4', listId: 'L2', title: 'No date' }),
        makeTask({
          id: 'T5',
          listId: 'L1',
          title: 'Finished',
          status: 'done',
          completedAt: Date.now(),
        }),
      ],
    });
  }

  it('Today: Overdue + Today groups, count header, overdue badge marker', async () => {
    await seedMixed();
    render(<TodayView />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Today' })).toBeTruthy();
    const overdue = await screen.findByRole('heading', { level: 2, name: 'Overdue (1)' });
    expect(overdue).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Today (1)' })).toBeTruthy();
    expect(screen.getByText('2 tasks', { exact: true })).toBeTruthy();

    // Non-colour overdue signal: text + `!` marker.
    const badge = document.querySelector('.due-badge-overdue');
    expect(badge?.textContent).toContain('Overdue');
    expect(badge?.querySelector('.due-marker')?.textContent).toBe('!');
    // Only the two due tasks are members (D3 membership from the selector).
    expect(document.querySelector('[data-task-id="T3"]')).toBeNull();
    expect(document.querySelector('[data-task-id="T4"]')).toBeNull();
    expect(document.querySelector('[data-task-id="T5"]')).toBeNull();
  });

  it('Next 7 days: per-day groups (today and future days), empty groups omitted', async () => {
    await seedMixed();
    render(<WeekView />);

    expect(await screen.findByRole('heading', { level: 2, name: 'Today (1)' })).toBeTruthy();
    // The +4 day group is a localized date header; the overdue task is not a member.
    const headers = [...document.querySelectorAll<HTMLElement>('.group-header')].map(
      (node) => node.textContent,
    );
    expect(headers).toHaveLength(2);
    expect(headers[0]).toContain('Today');
    expect(document.querySelector('[data-task-id="T1"]')).toBeNull();
    expect(document.querySelector('[data-task-id="T3"]')).toBeTruthy();
  });

  it('All open: grouped by list with counts and list badges on rows', async () => {
    await seedMixed();
    render(<AllOpenView />);

    expect(await screen.findByRole('heading', { level: 2, name: 'Personal (2)' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Work (2)' })).toBeTruthy();
    expect(screen.getByText('4 tasks', { exact: true })).toBeTruthy();
    const row = document.querySelector('[data-task-id="T4"]') as HTMLElement;
    expect(row.querySelector('.list-badge')?.textContent).toContain('Work');
  });

  it('Completed: flat list with completion chip, no reorder handles (D1)', async () => {
    await seedMixed();
    render(<CompletedView />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Completed' })).toBeTruthy();
    expect(screen.getByText('1 tasks', { exact: true })).toBeTruthy();
    expect(screen.getByText(/^Completed on /u, { exact: true })).toBeTruthy();
    expect(document.querySelector('.group-header')).toBeNull();
  });

  it('Per-list: flat manual order, heading = list name, no list badge', async () => {
    await seedMixed();
    render(<ListView params={{ id: 'L1' }} />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Personal' })).toBeTruthy();
    const rows = [...document.querySelectorAll('[data-task-id]')].map(
      (el) => el.getAttribute('data-task-id') ?? '',
    );
    expect(rows).toEqual(['T1', 'T2']); // open tasks of L1, manual order
    expect(document.querySelector('.list-badge')).toBeNull();
    expect(document.querySelector('.group-header')).toBeNull();
  });

  it('per-view empty states (§14)', async () => {
    await seed({ lists: [], tasks: [] });

    const cases: readonly [JSX.Element, string][] = [
      [<TodayView key="t" />, EMPTY_BODIES[0]?.[1] ?? ''],
      [<WeekView key="w" />, EMPTY_BODIES[1]?.[1] ?? ''],
      [<AllOpenView key="a" />, EMPTY_BODIES[2]?.[1] ?? ''],
      [<CompletedView key="c" />, EMPTY_BODIES[3]?.[1] ?? ''],
    ];
    for (const [element, body] of cases) {
      const view = render(element);
      const empty = await screen.findByRole('heading', { level: 2 });
      expect(empty.textContent.length).toBeGreaterThan(0);
      expect(screen.getByText(body, { exact: true })).toBeTruthy();
      expect(screen.getAllByRole('button', { name: 'Add task' }).length).toBeGreaterThan(0);
      view.unmount();
    }
  });

  it('unknown list deep link redirects to Today with a polite announcement (§14)', async () => {
    await seed({ lists: [makeList({ id: 'L1', name: 'Personal' })], tasks: [] });
    window.location.hash = '#/list/NOPE';
    render(<ListView params={{ id: 'NOPE' }} />);

    await waitFor(() => {
      expect(window.location.hash).toBe('#/today');
    });
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('This task no longer exists');
    });
    window.location.hash = '';
  });
});
