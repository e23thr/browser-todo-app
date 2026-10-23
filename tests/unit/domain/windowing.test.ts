/**
 * Pure virtualization math (ADR-003 Decision 7): visible range covered, bounds
 * clamped, overscan applied, `pin` always in the window, and the uniform fast
 * path agrees with the prefix-sum path.
 */
import { describe, expect, it } from 'vitest';

import { computeWindow } from '../../../src/domain/windowing';

const uniform = (px: number) => (): number => px;

describe('windowing: computeWindow', () => {
  it('renders nothing for an empty row list', () => {
    expect(
      computeWindow({ count: 0, heightAt: uniform(40), viewportPx: 400, scrollTop: 0 }),
    ).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
  });

  it('covers the visible range plus overscan (uniform fast path)', () => {
    const w = computeWindow({
      count: 1000,
      uniformPx: 40,
      heightAt: uniform(40),
      viewportPx: 400,
      scrollTop: 4000, // rows 100..119 visible
      overscan: 8,
    });
    expect(w.start).toBe(92);
    expect(w.end).toBe(118);
    expect(w.padTop).toBe(92 * 40);
    expect(w.padBottom).toBe((1000 - 118) * 40);
  });

  it('prefix-sum path agrees with the uniform fast path', () => {
    for (const scrollTop of [0, 123, 4000, 39600]) {
      const fast = computeWindow({
        count: 1000,
        uniformPx: 40,
        heightAt: uniform(40),
        viewportPx: 400,
        scrollTop,
      });
      const slow = computeWindow({
        count: 1000,
        heightAt: uniform(40),
        viewportPx: 400,
        scrollTop,
      });
      expect(slow).toEqual(fast);
    }
  });

  it('supports variable heights via prefix sums', () => {
    // rows: 3 x 20px headers + task rows of 40px
    const heightAt = (i: number): number => (i % 4 === 0 ? 20 : 40);
    const w = computeWindow({ count: 100, heightAt, viewportPx: 200, scrollTop: 0, overscan: 0 });
    expect(w.start).toBe(0);
    expect(w.padTop).toBe(0);
    // total = 25*20 + 75*40 = 3500
    expect(w.padBottom).toBeGreaterThan(0);
    expect(w.padBottom).toBeLessThan(3500);
  });

  it('clamps scrollTop beyond the scrollable range', () => {
    const w = computeWindow({
      count: 10,
      uniformPx: 40,
      heightAt: uniform(40),
      viewportPx: 200,
      scrollTop: 999999,
      overscan: 0,
    });
    expect(w.end).toBe(10);
    expect(w.padBottom).toBe(0);
    expect(w.padTop).toBeGreaterThan(0);
  });

  it('always includes pinned indices', () => {
    const w = computeWindow({
      count: 1000,
      uniformPx: 40,
      heightAt: uniform(40),
      viewportPx: 400,
      scrollTop: 0,
      overscan: 0,
      pin: [999, 500],
    });
    expect(w.start).toBe(0);
    expect(w.end).toBe(1000);
    const w2 = computeWindow({
      count: 1000,
      uniformPx: 40,
      heightAt: uniform(40),
      viewportPx: 400,
      scrollTop: 20000,
      overscan: 0,
      pin: [0],
    });
    expect(w2.start).toBe(0);
  });

  it('ignores out-of-range pins and keeps bounds inside [0, count]', () => {
    const w = computeWindow({
      count: 5,
      uniformPx: 40,
      heightAt: uniform(40),
      viewportPx: 200,
      scrollTop: 0,
      overscan: 100,
      pin: [-1, 99, 2.5],
    });
    expect(w.start).toBe(0);
    expect(w.end).toBe(5);
  });

  it('never renders more than the viewport needs at 10k rows (window stays small)', () => {
    const w = computeWindow({
      count: 10000,
      uniformPx: 44,
      heightAt: uniform(44),
      viewportPx: 800,
      scrollTop: 220000,
    });
    expect(w.end - w.start).toBeLessThanOrEqual(Math.ceil(800 / 44) + 2 * 8);
  });
});
