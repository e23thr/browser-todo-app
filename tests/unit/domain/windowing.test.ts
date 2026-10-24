/**
 * Pure virtualization math (ADR-003 Decision 7): visible range covered, bounds
 * clamped, overscan applied, and the V1 pin contract — a pinned cursor NEVER
 * widens the window toward the scroll position (§9.1 "< 200 DOM rows at any
 * scroll position"); it comes back as its own `{ index, padBefore }` segment so
 * the pads + segments still tile the exact list height. The uniform fast path
 * agrees with the prefix-sum path.
 */
import { describe, expect, it } from 'vitest';

import { computeWindow } from '../../../src/domain/windowing';

const uniform = (px: number) => (): number => px;

/** Independent prefix-sum offsets — the tiling invariants must not reuse the impl's math. */
function offsets(heightAt: (i: number) => number, count: number): number[] {
  const out: number[] = [0];
  for (let i = 0; i < count; i += 1) out.push((out[i] ?? 0) + Math.max(0, heightAt(i)));
  return out;
}

describe('windowing: computeWindow', () => {
  it('renders nothing for an empty row list', () => {
    expect(
      computeWindow({ count: 0, heightAt: uniform(40), viewportPx: 400, scrollTop: 0 }),
    ).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0, pins: [] });
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
    expect(w.pins).toEqual([]);
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

  // ---------------------------------------------------------------- V1 contract ----

  it('V1: a cursor pinned above the scroll viewport never widens the window', () => {
    const w = computeWindow({
      count: 1000,
      uniformPx: 40,
      heightAt: uniform(40),
      viewportPx: 400,
      scrollTop: 20000, // scroll viewport = rows 500..509
      overscan: 0,
      pin: [0], // roving cursor parked near the top
    });
    // The window stays the scroll-viewport window — it must NOT span back to the cursor.
    expect(w.start).toBe(500);
    expect(w.end).toBe(510);
    // The cursor row comes back as its own segment instead…
    expect(w.pins).toEqual([{ index: 0, padBefore: 0 }]);
    // …whose pads tile [0, offset(start)) exactly: row 0 sits at its real offset and
    // padTop carries the rest of the gap up to the window.
    expect(w.padTop).toBe(500 * 40 - 40);
    expect(w.padBottom).toBe((1000 - 510) * 40);
    // Rendered rows: 10 window rows + 1 pinned row — nowhere near the full list.
    expect(w.end - w.start + w.pins.length).toBeLessThan(200);
  });

  it('V1: a cursor pinned below the scroll viewport comes back as a trailing segment', () => {
    const w = computeWindow({
      count: 1000,
      uniformPx: 40,
      heightAt: uniform(40),
      viewportPx: 400,
      scrollTop: 0, // scroll viewport = rows 0..9
      overscan: 0,
      pin: [999], // roving cursor parked at the end
    });
    expect(w.start).toBe(0);
    expect(w.end).toBe(10);
    expect(w.padTop).toBe(0);
    // padBefore = the gap from the window end to row 999; padBottom tiles to the very end.
    expect(w.pins).toEqual([{ index: 999, padBefore: (999 - 10) * 40 }]);
    expect(w.padBottom).toBe(0);
    expect(w.end - w.start + w.pins.length).toBeLessThan(200);
  });

  it('adds no segment for a pin already inside the window', () => {
    const w = computeWindow({
      count: 1000,
      uniformPx: 40,
      heightAt: uniform(40),
      viewportPx: 400,
      scrollTop: 0,
      overscan: 8,
      pin: [5],
    });
    expect(w.start).toBe(0);
    expect(w.end).toBe(18);
    expect(w.pins).toEqual([]);
    expect(w.padTop).toBe(0);
    expect(w.padBottom).toBe((1000 - 18) * 40);
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
    expect(w.pins).toEqual([]);
  });

  it('never renders more than the viewport needs at 10k rows, even with a far pin', () => {
    const w = computeWindow({
      count: 10000,
      uniformPx: 44,
      heightAt: uniform(44),
      viewportPx: 800,
      scrollTop: 220000,
      pin: [0], // cursor at the top while the scroll sits at the bottom (the V1 shape)
    });
    expect(w.end - w.start).toBeLessThanOrEqual(Math.ceil(800 / 44) + 2 * 8);
    // …plus ONE pinned row, never the ~4 955 rows a cursor→scroll span would materialise.
    expect(w.pins).toHaveLength(1);
    expect(w.pins[0]?.index).toBe(0);
    expect(w.end - w.start + w.pins.length).toBeLessThan(200);
  });

  it('tiles the exact list height with pads + segments on both sides of the window', () => {
    const count = 100;
    const heightAt = (i: number): number => (i % 4 === 0 ? 20 : 40);
    const off = offsets(heightAt, count);
    const total = off[count] ?? 0;
    const cases: ReadonlyArray<{ scrollTop: number; pin: number[] }> = [
      { scrollTop: 0, pin: [] },
      { scrollTop: 0, pin: [99] },
      { scrollTop: 123, pin: [0, 7, 99] },
      { scrollTop: 1200, pin: [0, 50, 99] },
      { scrollTop: 100, pin: [-1, 50, 50, 200, 2.5] }, // duplicates + out-of-range drop out
      { scrollTop: 999999, pin: [0] },
    ];
    for (const { scrollTop, pin } of cases) {
      const label = `scrollTop=${String(scrollTop)} pin=[${pin.join(',')}]`;
      const w = computeWindow({ count, heightAt, viewportPx: 200, scrollTop, overscan: 5, pin });
      const windowRows = (off[w.end] ?? 0) - (off[w.start] ?? 0);
      const segments = w.pins.reduce(
        (sum, seg) => sum + seg.padBefore + ((off[seg.index + 1] ?? 0) - (off[seg.index] ?? 0)),
        0,
      );
      // Every pixel of the list is covered exactly once: pads + rendered rows == total.
      expect(w.padTop + windowRows + segments + w.padBottom, `tiles: ${label}`).toBe(total);
      // Segments only ever carry rows OUTSIDE the window, once each, with sane pads.
      for (const seg of w.pins) {
        expect(seg.index < w.start || seg.index >= w.end, `outside: ${label}`).toBe(true);
        expect(seg.padBefore, `padBefore >= 0: ${label}`).toBeGreaterThanOrEqual(0);
      }
      expect(new Set(w.pins.map((seg) => seg.index)).size, `no dup: ${label}`).toBe(w.pins.length);
      expect(w.padTop, `padTop >= 0: ${label}`).toBeGreaterThanOrEqual(0);
      expect(w.padBottom, `padBottom >= 0: ${label}`).toBeGreaterThanOrEqual(0);
      // The window itself still never spans more than the viewport needs.
      expect(w.end - w.start, `span: ${label}`).toBeLessThanOrEqual(Math.ceil(200 / 20) + 2 * 5);
    }
  });
});
