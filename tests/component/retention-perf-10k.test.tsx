/**
 * S6 retention-view performance at 10k completed tasks (E9 AC: "retention view
 * performs at 10k completed tasks" — the numbers recorded here are the
 * acceptance evidence, logged to the run output like the Q18 baseline before
 * S6 landed).
 *
 * The partition must not widen the §5.7/§9.1 virtualization contract: DOM task
 * rows stay far below the 200-row virtualization floor at every group shape
 * (recent + older + archived all populated), and the render stays inside the
 * generous jsdom ceiling (real-browser numbers ride the e2e drill).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { render } from '@testing-library/preact';

import { TaskScreen } from '../../src/features/tasks/TaskScreen';
import { state, today } from '../../src/features/tasks/store';
import { selectView } from '../../src/domain/views';
import { makeList, makeTask, seed, setUpCoreUi, tearDownCoreUi } from './core-ui-harness';

const DAY = 24 * 60 * 60 * 1000;

describe('S6 retention view @10k completed tasks', () => {
  beforeEach(() => {
    setUpCoreUi();
  });
  afterEach(() => {
    tearDownCoreUi();
  });

  it('keeps the DOM-row cap and records the retention-view numbers', async () => {
    const list = makeList({ id: 'L1', name: 'Archive' });
    const now = Date.now();
    // 10k finished tasks across every retention shape: 5k recent done,
    // 4k older done, 1k archived (all three groups populated at scale).
    const tasks = Array.from({ length: 10_000 }, (_u, i) => {
      const bucket = i % 10;
      const archived = bucket === 0;
      const older = bucket === 1 || bucket === 2;
      return makeTask({
        id: `T${String(i).padStart(5, '0')}`,
        listId: 'L1',
        title: `${archived ? 'Archived' : 'Done'} ${String(i)}`,
        status: archived ? 'archived' : 'done',
        completedAt: now - (older ? 40 * DAY : 1 * DAY) - i,
        sortOrder: `k${String(i).padStart(6, '0')}`,
      });
    });
    const seedStart = performance.now();
    await seed({ lists: [list], tasks });
    const seedMs = performance.now() - seedStart;

    const renderStart = performance.now();
    render(
      <TaskScreen
        view={{ kind: 'completed' }}
        title="Completed"
        emptyIcon="check-circle"
        emptyTitle="Nothing completed yet"
        emptyBody="Completed tasks will collect here."
      />,
    );
    const renderMs = performance.now() - renderStart;
    const domRows = document.querySelectorAll('ul.task-list [data-task-id]').length;
    const domHeaders = [...document.querySelectorAll('h2.group-header')].map(
      (el) => el.textContent,
    );

    // The full partition (all three groups) is asserted at the DOMAIN level:
    // with 10k rows the list is virtualized, so only the recent group's header
    // is inside the rendered window — a DOM assertion of all three would pin
    // the OPPOSITE contract (no virtualization).
    const view = selectView(state.value, { kind: 'completed' }, { today: today.value });
    const groupRows = view.rows.filter(
      (r): r is Extract<(typeof view.rows)[number], { type: 'group' }> => r.type === 'group',
    );
    expect(
      groupRows.map((r) =>
        r.label.kind === 'retention' ? `retention:${r.label.bucket}` : r.label.kind,
      ),
    ).toEqual(['retention:recent', 'retention:older', 'archived']);
    expect(groupRows.map((r) => r.count)).toEqual([7000, 2000, 1000]);

    // QA evidence: the recorded 10k retention numbers (completion metadata).
    // eslint-disable-next-line no-console -- numbers go to the run log
    console.log(
      `[S6 retention @10k] seed ${seedMs.toFixed(1)}ms, render ${renderMs.toFixed(1)}ms, ` +
        `DOM rows ${String(domRows)} of 10000, DOM headers ${domHeaders.join(' | ')}`,
    );

    // The rendered window starts at the recent group's header…
    expect(domHeaders[0]).toContain('Recently completed (last 7 days)');
    // §5.7/§9.1 virtualization floor — the partition may not widen the window.
    expect(domRows).toBeGreaterThan(0);
    expect(domRows).toBeLessThan(200);
    expect(renderMs).toBeLessThan(2_000); // generous jsdom ceiling; real numbers logged
  });
});
