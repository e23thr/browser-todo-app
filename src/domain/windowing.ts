/**
 * Pure virtualization math (ADR-003 Decision 7). One function serves every view
 * (rows are flat: group headers are rows too). Uniform-height fast path for task
 * rows (`uniformPx`, one CSS custom property co-designed with h_designer);
 * variable heights go through an O(n) prefix-sum + binary-search path (10k rows
 * sum in < 0.1 ms). The UI layer owns the a11y/scroll glue: the window is the
 * SCROLL-VIEWPORT window only (§9.1 V1 — it never spans from a pinned cursor to
 * the scroll position, which materialised the whole list), and a `pin` that
 * falls outside it comes back as its own spacer+row segment, so the focused row
 * stays mounted without O(distance) DOM rows.
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
  /** Indices that must stay mounted (roving cursor), even outside the window. */
  pin?: number[];
};

/** A pinned row rendered OUTSIDE `[start, end)` so focus never dies on scroll (V1). */
export type PinnedSegment = {
  /** Row index — a valid integer outside `[start, end)` (pins inside it render in the window). */
  index: number;
  /**
   * Spacer rendered immediately BEFORE the row (px): the gap since the previously
   * rendered element (list top, the previous segment's row, or the window end).
   * The gap AFTER the last segment of a side belongs to `padTop`/`padBottom`, so
   * the render order `[above segments] padTop [window rows] [below segments]
   * padBottom` tiles the exact list height.
   */
  padBefore: number;
};

export type WindowResult = {
  /** `[start, end)` row indices to render — scroll-viewport window ± overscan. */
  start: number;
  end: number;
  /** Spacer directly above the window rows (0 while an above-segment chain is open). */
  padTop: number;
  /** Trailing spacer after the below-segment chain (0 while such a chain is open). */
  padBottom: number;
  /** Pinned rows outside the window, ascending — rendered as pad+row segments. */
  pins: readonly PinnedSegment[];
};

const DEFAULT_OVERSCAN = 8;

export function computeWindow(spec: WindowSpec): WindowResult {
  const { count, viewportPx, uniformPx } = spec;
  const overscan = Math.max(0, spec.overscan ?? DEFAULT_OVERSCAN);
  if (count <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0, pins: [] };

  const uniform = uniformPx !== undefined && uniformPx > 0;
  // Prefix sums over [0, i) — or the O(1) closed form on the uniform path.
  const offsetAt = (i: number): number =>
    uniform ? uniformPx * i : prefixSum(spec.heightAt, count, i);
  const total = offsetAt(count);

  const scrollTop = Math.min(Math.max(0, spec.scrollTop), Math.max(0, total - viewportPx));
  const visibleTop = scrollTop;
  const visibleBottom = scrollTop + Math.max(0, viewportPx);

  // V1 / §9.1: the window is the scroll-viewport window ONLY — never widened
  // toward a pinned cursor (a cursor parked at the top + a scroll at the bottom
  // would otherwise materialise O(distance) rows, up to the entire list).
  let start = uniform
    ? Math.floor(visibleTop / uniformPx)
    : firstIndexAtOrAfter(spec.heightAt, count, visibleTop);
  let end = uniform
    ? Math.ceil(visibleBottom / uniformPx)
    : firstTopAtOrAfter(spec.heightAt, count, visibleBottom);
  start = Math.max(0, start - overscan);
  end = Math.min(count, Math.max(start, end) + overscan);

  // Pins outside the window (deduped, valid): each side tiles its own gap chain —
  // `padBefore` fills the gap since the previously rendered element, the trailing
  // gap falls to padTop/padBottom. Pins inside [start, end) render with the window.
  const outside = [...new Set(spec.pin ?? [])]
    .filter(
      (pin) => Number.isInteger(pin) && pin >= 0 && pin < count && (pin < start || pin >= end),
    )
    .sort((a, b) => a - b);

  const chain = (
    pins: readonly number[],
    from: number,
  ): { readonly segments: PinnedSegment[]; readonly covered: number } => {
    let previousBottom = from;
    const segments: PinnedSegment[] = [];
    for (const pin of pins) {
      const top = offsetAt(pin);
      const bottom = offsetAt(pin + 1);
      segments.push({ index: pin, padBefore: Math.max(0, top - previousBottom) });
      previousBottom = bottom;
    }
    return { segments, covered: Math.max(0, previousBottom - from) };
  };
  const above = chain(
    outside.filter((pin) => pin < start),
    0,
  );
  const below = chain(
    outside.filter((pin) => pin >= end),
    offsetAt(end),
  );

  return {
    start,
    end,
    padTop: Math.max(0, offsetAt(start) - above.covered),
    padBottom: Math.max(0, total - offsetAt(end) - below.covered),
    pins: [...above.segments, ...below.segments],
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
