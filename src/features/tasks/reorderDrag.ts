/**
 * Pointer drag for manual reorder (design §8.1, flows F9, checklist item 31).
 *
 * Split into two layers so every decision is unit-testable without a layout:
 *
 *   - `dropTargetFromMetrics()` — pure geometry: given the pointer position and
 *     the rendered row rectangles (plus, on desktop, the sidebar list drop
 *     rects), decide the drop intent (before a row / after the last row / onto
 *     a sidebar list / none). Row midpoints decide the insertion slot, so
 *     dropping on the top half of a row inserts BEFORE it (§8.1 insertion
 *     line).
 *   - `beginPointerDrag()` — the DOM session: document-level pointermove /
 *     pointerup / Escape listeners with requestAnimationFrame coalescing (one
 *     geometry decision per frame, §9.1 60 fps contract), viewport-edge
 *     auto-scroll (within 48 px of an edge, max ~800 px/s, §8.1), and the
 *     drop/cancel callbacks.
 *
 * The list component owns the visual state (ghost via `data-dragging`,
 * insertion line via `data-drop-before`/`data-drop-after`, sidebar highlight);
 * this module only computes WHERE and WHEN.
 */

/** Where the pointer wants to drop, in list terms. */
export type DropIntent =
  | { readonly kind: 'before'; readonly rowId: string }
  | { readonly kind: 'after-last'; readonly rowId: string }
  | { readonly kind: 'list'; readonly listId: string }
  | { readonly kind: 'none' };

export interface RowRect {
  readonly id: string;
  readonly top: number;
  readonly bottom: number;
}

export interface ListRect {
  readonly id: string;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface PointerPos {
  readonly x: number;
  readonly y: number;
}

function withinRect(pos: PointerPos, rect: ListRect): boolean {
  return pos.x >= rect.left && pos.x <= rect.right && pos.y >= rect.top && pos.y <= rect.bottom;
}

/**
 * The drop intent for `pos`. Sidebar lists win over rows (§8.1 "desktop
 * extra"): they are checked first, and only when the pointer is actually over
 * one of their rects. Otherwise the row whose midpoint the pointer crossed
 * decides: above the midpoint → insert before that row, below every midpoint →
 * after the last row.
 */
export function dropTargetFromMetrics(
  pos: PointerPos,
  rows: readonly RowRect[],
  lists: readonly ListRect[] = [],
): DropIntent {
  for (const list of lists) {
    if (withinRect(pos, list)) return { kind: 'list', listId: list.id };
  }
  for (const row of rows) {
    const mid = (row.top + row.bottom) / 2;
    if (pos.y < mid) return { kind: 'before', rowId: row.id };
  }
  const last = rows[rows.length - 1];
  return last === undefined ? { kind: 'none' } : { kind: 'after-last', rowId: last.id };
}

/** -1 = scroll up, 0 = no auto-scroll, 1 = scroll down (§8.1: within 48 px of an edge). */
export function autoScrollDirection(pos: PointerPos, viewportHeight: number): -1 | 0 | 1 {
  const zone = 48;
  if (pos.y < zone) return -1;
  if (pos.y > viewportHeight - zone) return 1;
  return 0;
}

/** Auto-scroll step for one frame, px (§8.1: max ~800 px/s ≈ 13 px per 60 fps frame). */
export const AUTO_SCROLL_MAX_PER_FRAME = 13;

export interface DragSessionOptions {
  readonly taskId: string;
  readonly readRows: () => readonly RowRect[];
  readonly readLists: () => readonly ListRect[];
  readonly onHover: (intent: DropIntent) => void;
  readonly onDrop: (intent: DropIntent) => void;
  readonly onCancel: () => void;
  /** Viewport height for edge auto-scroll (defaults to the window's). */
  readonly viewportHeight?: () => number;
  /** Scroll target for auto-scroll (defaults to the window). */
  readonly scrollBy: (deltaY: number) => void;
}

export interface DragSession {
  readonly move: (pos: PointerPos) => void;
  readonly up: (pos: PointerPos | null) => void;
  readonly cancel: () => void;
  readonly dispose: () => void;
}

/**
 * Start a drag session over the document. The caller wires the handle's
 * `pointerdown`; every later decision happens here, once per animation frame.
 * `up(null)` (or `Escape`) cancels — the row returns to its original position
 * and `onCancel` announces `a11y.reorderCancelled` (§8.1).
 */
export function beginPointerDrag(options: DragSessionOptions): DragSession {
  const viewportHeight = options.viewportHeight ?? ((): number => window.innerHeight || 768);
  let intent: DropIntent = { kind: 'none' };
  let frame: number | null = null;
  let pending: PointerPos | null = null;
  let disposed = false;
  let scrolling: -1 | 0 | 1 = 0;
  let scrollTimer: ReturnType<typeof setInterval> | null = null;

  const evaluate = (pos: PointerPos): DropIntent =>
    dropTargetFromMetrics(pos, options.readRows(), options.readLists());

  const stopAutoScroll = (): void => {
    if (scrollTimer !== null) {
      clearInterval(scrollTimer);
      scrollTimer = null;
    }
    scrolling = 0;
  };

  const runFrame = (): void => {
    frame = null;
    if (disposed || pending === null) return;
    const pos = pending;
    pending = null;
    intent = evaluate(pos);
    options.onHover(intent);

    const direction = autoScrollDirection(pos, viewportHeight());
    if (direction !== scrolling) {
      stopAutoScroll();
      scrolling = direction;
      if (direction !== 0) {
        scrollTimer = setInterval(() => {
          options.scrollBy(direction * AUTO_SCROLL_MAX_PER_FRAME);
        }, 16);
      }
    }
  };

  const onMove = (event: PointerEvent): void => {
    if (disposed) return;
    pending = { x: event.clientX, y: event.clientY };
    if (frame === null) frame = requestAnimationFrame(runFrame);
  };

  const finish = (pos: PointerPos | null): void => {
    if (disposed) return;
    if (pos !== null) {
      // Evaluate the REAL drop position synchronously — the last frame may not
      // have run yet, and a drop must never use a stale hover target.
      intent = evaluate(pos);
    }
    cleanup();
    if (pos === null || intent.kind === 'none') options.onCancel();
    else options.onDrop(intent);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    // §8.1: Escape during drag cancels — the row returns to its original spot.
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish(null);
    }
  };

  const cleanup = (): void => {
    disposed = true;
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
    stopAutoScroll();
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onPointCancel);
    document.removeEventListener('keydown', onKeyDown, true);
  };

  const onUp = (event: PointerEvent): void => {
    finish({ x: event.clientX, y: event.clientY });
  };

  const onPointCancel = (): void => {
    finish(null); // browser grabbed the gesture (system scroll, notification…) → cancel
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onPointCancel);
  document.addEventListener('keydown', onKeyDown, true);

  return {
    move: (pos) => {
      pending = pos;
      if (frame === null) frame = requestAnimationFrame(runFrame);
    },
    up: (pos) => {
      finish(pos);
    },
    cancel: () => {
      finish(null);
    },
    dispose: cleanup,
  };
}
