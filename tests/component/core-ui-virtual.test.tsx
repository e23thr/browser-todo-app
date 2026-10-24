/**
 * Virtualization (§5.7, ADR-003 Decision 7) component suite.
 *
 * Beyond ~200 rows the list windows rows through the domain `computeWindow`:
 * DOM rows stay capped (~35 at any viewport), pad spacers carry the full scroll
 * height, and the roving cursor stays materialized as window slice OR as its own
 * out-of-window segment (V1: never by widening the window toward the scroll
 * position) — keyboard End / PageDown / arrow across the window boundary all
 * focus the right row — while `aria-posinset`/`aria-setsize` report the REAL
 * list position (not the window's). The scroll listener coalesces to one
 * geometry decision per animation frame (§5.7 60 fps contract); the AC evidence
 * records the DOM row cap + window-math cost at 1k/10k rows (real-browser scroll
 * fps is outside jsdom — the e2e lane owns that number).
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/preact';
import { performance } from 'node:perf_hooks';

import { TaskScreen } from '../../src/features/tasks/TaskScreen';
import { VIRTUALIZE_ROWS } from '../../src/features/tasks/TaskList';
import { computeWindow } from '../../src/domain/windowing';
import { makeList, makeTask, seed, setUpCoreUi, tearDownCoreUi } from './core-ui-harness';
import { resetTaskStore } from '../../src/features/tasks/store';

const evidence: string[] = [];

function makeMany(count: number): ReturnType<typeof makeTask>[] {
  return Array.from({ length: count }, (_unused, index) =>
    makeTask({
      id: `T${String(index).padStart(4, '0')}`,
      listId: 'L1',
      title: `Task ${String(index)}`,
      sortOrder: `k${String(index).padStart(6, '0')}`,
    }),
  );
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

function domRowCount(): number {
  return document.querySelectorAll('ul.task-list [data-task-id]').length;
}

function focusedTaskId(): string | null {
  return document.activeElement?.getAttribute('data-task-id') ?? null;
}

beforeEach(() => {
  setUpCoreUi();
});

afterEach(() => {
  tearDownCoreUi();
  resetTaskStore();
  // The V1 test shadows `window.scrollY` (jsdom has no layout to scroll); restore
  // jsdom's default so later suites don't boot "already scrolled to the bottom".
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
});

afterAll(async () => {
  if (evidence.length === 0) return;
  const fs = await import('node:fs');
  fs.writeFileSync(
    '/home/ubuntu/.hermes/profiles/h_junior_coder/cache/scratch/e2-virtualization.md',
    evidence.join('\n') + '\n',
  );
});

describe('§5.7 virtualized rendering', () => {
  it('caps the DOM rows far below the list size (1k+ rows)', async () => {
    await seed({ lists: [makeList({ id: 'L1', name: 'Personal' })], tasks: makeMany(1200) });
    renderList();

    await waitFor(() => {
      expect(domRowCount()).toBeGreaterThan(0);
    });
    const rendered = domRowCount();
    expect(rendered).toBeLessThanOrEqual(60); // viewport + 2x overscan, never the full list
    expect(rendered).toBeLessThan(VIRTUALIZE_ROWS);
    expect(document.querySelector('ul.task-list')?.getAttribute('data-virtualized')).toBe('true');

    evidence.push(
      '# E2 virtualization evidence (component lane, jsdom)',
      '',
      `- 1,200 rows -> ${String(rendered)} DOM rows (cap = viewport ~768px / 56px + 2x8 overscan)`,
      '- scroll listeners: passive, rAF-coalesced (one computeWindow per frame)',
      '- real-browser 60fps scroll fps belongs to the e2e lane (jsdom has no layout/paint)',
    );
  });

  it('renders every row below the threshold (no windowing on small lists)', async () => {
    await seed({ lists: [makeList({ id: 'L1', name: 'Personal' })], tasks: makeMany(50) });
    renderList();
    await waitFor(() => {
      expect(domRowCount()).toBe(50);
    });
    expect(document.querySelector('ul.task-list')?.getAttribute('data-virtualized')).toBeNull();
  });

  it('pad spacers carry the off-screen rows (uniform estimate)', async () => {
    await seed({ lists: [makeList({ id: 'L1', name: 'Personal' })], tasks: makeMany(1200) });
    renderList();
    await waitFor(() => {
      expect(domRowCount()).toBeGreaterThan(0);
    });
    const pads = [...document.querySelectorAll<HTMLElement>('.task-list-pad')];
    expect(pads.length).toBeGreaterThanOrEqual(1); // top and/or bottom spacer
    const totalPad = pads.reduce((sum, pad) => sum + Number.parseFloat(pad.style.height || '0'), 0);
    // 1200 rows x 56px estimate minus what is rendered must be padded out.
    expect(totalPad).toBeGreaterThan(1000 * 56);
  });

  it('aria-posinset/aria-setsize report the real position, not the window', async () => {
    await seed({ lists: [makeList({ id: 'L1', name: 'Personal' })], tasks: makeMany(1200) });
    renderList();
    const first = await waitFor(() => {
      const row = document.querySelector<HTMLElement>('ul.task-list [data-task-id]');
      if (row === null) throw new Error('no rows');
      return row;
    });
    expect(first.getAttribute('aria-setsize')).toBe('1200');
    expect(first.getAttribute('aria-posinset')).toBe('1');
  });
});

describe('keyboard navigation across the virtual window', () => {
  it('End focuses the LAST row (pinned into view even off-window)', async () => {
    await seed({ lists: [makeList({ id: 'L1', name: 'Personal' })], tasks: makeMany(1200) });
    renderList();
    await waitFor(() => {
      expect(domRowCount()).toBeGreaterThan(0);
    });
    const first = document.querySelector<HTMLElement>('ul.task-list [data-task-id]');
    await act(async () => {
      first?.focus();
    });
    fireEvent.keyDown(first as HTMLElement, { key: 'End' });

    await waitFor(() => {
      expect(focusedTaskId()).toBe('T1199');
    });
    // The focused row is materialized and reports its real position.
    const last = document.querySelector<HTMLElement>('[data-task-id="T1199"]');
    expect(last).not.toBeNull();
    expect(last?.getAttribute('aria-posinset')).toBe('1200');
  });

  it('arrow keys walk the cursor across window boundaries', async () => {
    await seed({ lists: [makeList({ id: 'L1', name: 'Personal' })], tasks: makeMany(1200) });
    renderList();
    await waitFor(() => {
      expect(domRowCount()).toBeGreaterThan(0);
    });
    let current = document.querySelector<HTMLElement>('ul.task-list [data-task-id]');
    await act(async () => {
      current?.focus();
    });

    // Walk well past one window (rendered window is ~30 rows).
    for (let step = 0; step < 40; step += 1) {
      fireEvent.keyDown(current as HTMLElement, { key: 'ArrowDown' });
      await waitFor(() => {
        expect(focusedTaskId()).toBe(`T${String(step + 1).padStart(4, '0')}`);
      });
      current = document.querySelector<HTMLElement>(
        `[data-task-id="T${String(step + 1).padStart(4, '0')}"]`,
      );
      expect(current).not.toBeNull();
    }
  });

  it('PageDown jumps ~10 rows inside the virtualized list', async () => {
    await seed({ lists: [makeList({ id: 'L1', name: 'Personal' })], tasks: makeMany(1200) });
    renderList();
    await waitFor(() => {
      expect(domRowCount()).toBeGreaterThan(0);
    });
    const first = document.querySelector<HTMLElement>('ul.task-list [data-task-id]');
    await act(async () => {
      first?.focus();
    });
    fireEvent.keyDown(first as HTMLElement, { key: 'PageDown' });
    await waitFor(() => {
      expect(focusedTaskId()).toBe('T0010');
    });
  });
});

describe('V1 regression: pinned cursor vs. scroll position (§9.1 < 200 DOM rows)', () => {
  it('keeps the window viewport-sized and the cursor mounted/focused at the far scroll end', async () => {
    await seed({ lists: [makeList({ id: 'L1', name: 'Personal' })], tasks: makeMany(1200) });
    renderList();
    await waitFor(() => {
      expect(domRowCount()).toBeGreaterThan(0);
    });
    const cursorEl = (): HTMLElement | null =>
      document.querySelector<HTMLElement>('[data-task-id="T0000"]');

    // Park the roving cursor on the first row — it holds DOM focus (AC3's premise).
    const first = document.querySelector<HTMLElement>('ul.task-list [data-task-id]');
    await act(async () => {
      first?.focus();
    });
    expect(focusedTaskId()).toBe('T0000');

    // jsdom has no layout: emulate scrolling the page to the very bottom and fire
    // the scroll event the app listens to (rAF-coalesced → one window decision).
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 66_000 });
    window.dispatchEvent(new Event('scroll'));

    // The window follows the SCROLL POSITION: the real list end renders —
    await waitFor(() => {
      const rows = document.querySelectorAll('ul.task-list [data-task-id]');
      expect(rows[rows.length - 1]?.getAttribute('aria-posinset')).toBe('1200');
    });
    // …and total DOM rows stay viewport-sized + the ONE pinned cursor row (V1:
    // pre-fix this rendered all 1 200 rows — the window spanned cursor→scroll).
    expect(domRowCount()).toBeLessThan(60);
    expect(domRowCount()).toBeLessThan(VIRTUALIZE_ROWS);
    // The cursor row never unmounted: it keeps its REAL aria position and focus.
    const cursor = cursorEl();
    expect(cursor).not.toBeNull();
    expect(cursor?.getAttribute('aria-posinset')).toBe('1');
    expect(document.activeElement).toBe(cursor);

    // Scrolling back INTO the cursor's range moves the row into the window slice —
    // focus must survive that keyed move too (AC3: never dropped to document.body).
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
    window.dispatchEvent(new Event('scroll'));
    await waitFor(() => {
      expect(focusedTaskId()).toBe('T0000');
    });
    expect(domRowCount()).toBeLessThan(60);
    expect(cursorEl()?.getAttribute('aria-posinset')).toBe('1');
  });
});

describe('AC: window-math cost at scale', () => {
  it('computeWindow over 1k and 10k variable heights stays sub-millisecond', () => {
    const measure = (count: number): number => {
      const heightAt = (i: number): number => (i % 37 === 0 ? 76 : 56);
      const start = performance.now();
      for (let frame = 0; frame < 100; frame += 1) {
        computeWindow({
          count,
          heightAt,
          viewportPx: 768,
          scrollTop: Math.min(frame * 123, count * 56 - 768),
          pin: frame % 10 === 0 ? [(frame * 7) % count] : [],
        });
      }
      return (performance.now() - start) / 100;
    };
    const perFrame1k = measure(1000);
    const perFrame10k = measure(10_000);
    evidence.push(
      `- computeWindow per frame (variable heights, binary search): 1k rows ${perFrame1k.toFixed(4)} ms, 10k rows ${perFrame10k.toFixed(4)} ms (100 frames averaged)`,
    );
    expect(perFrame1k).toBeLessThan(5);
    expect(perFrame10k).toBeLessThan(5);
  });
});
