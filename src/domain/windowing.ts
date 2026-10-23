/**
 * Pure virtualization math (ADR-003 Decision 7). One function serves every view
 * (rows are flat: group headers are rows too). Uniform-height fast path for task
 * rows (`uniformPx`, one CSS custom property co-designed with h_designer);
 * variable heights go through an O(n) prefix-sum + binary-search path (10k rows
 * sum in < 0.1 ms). The UI layer owns the a11y/scroll glue: `pin` forces the
 * focused row into the window so focus never dies while scrolling.
 */

export type WindowSpec = {
  count: number;
  /** Uniform fast path when every row has this exact height (px). */
  uniformPx?: number;
  heightAt: (i: number) => number;
  viewportPx: number;
  scrollTop: number;
  /** Rows rendered beyond the visible range on each side. Default 8. */
  overscan?: number;
  /** Indices forced into the window (focused row). */
  pin?: number[];
};

export type WindowResult = {
  /** `[start, end)` row indices to render. */
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
};

const DEFAULT_OVERSCAN = 8;

export function computeWindow(spec: WindowSpec): WindowResult {
  const { count, viewportPx, uniformPx } = spec;
  const overscan = Math.max(0, spec.overscan ?? DEFAULT_OVERSCAN);
  if (count <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };

  const uniform = uniformPx !== undefined && uniformPx > 0;
  // Prefix sums over [0, i) — or the O(1) closed form on the uniform path.
  const offsetAt = (i: number): number =>
    uniform ? uniformPx * i : prefixSum(spec.heightAt, count, i);
  const total = offsetAt(count);

  const scrollTop = Math.min(Math.max(0, spec.scrollTop), Math.max(0, total - viewportPx));
  const visibleTop = scrollTop;
  const visibleBottom = scrollTop + Math.max(0, viewportPx);

  let start = uniform
    ? Math.floor(visibleTop / uniformPx)
    : firstIndexAtOrAfter(spec.heightAt, count, visibleTop);
  let end = uniform
    ? Math.ceil(visibleBottom / uniformPx)
    : firstTopAtOrAfter(spec.heightAt, count, visibleBottom);
  start = Math.max(0, start - overscan);
  end = Math.min(count, Math.max(start, end) + overscan);

  for (const pin of spec.pin ?? []) {
    if (!Number.isInteger(pin) || pin < 0 || pin >= count) continue;
    start = Math.min(start, pin);
    end = Math.max(end, pin + 1);
  }

  return {
    start,
    end,
    padTop: offsetAt(start),
    padBottom: Math.max(0, total - offsetAt(end)),
  };
}

function prefixSum(heightAt: (i: number) => number, count: number, upTo: number): number {
  let sum = 0;
  for (let i = 0; i < upTo && i < count; i += 1) sum += Math.max(0, heightAt(i));
  return sum;
}

/** Smallest index `i` whose cumulative bottom offset is > `target` (binary search). */
function firstIndexAtOrAfter(
  heightAt: (i: number) => number,
  count: number,
  target: number,
): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (prefixSum(heightAt, count, mid + 1) <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Smallest index `i` whose cumulative TOP offset is >= `target` (= end of the visible range). */
function firstTopAtOrAfter(heightAt: (i: number) => number, count: number, target: number): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (prefixSum(heightAt, count, mid) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
