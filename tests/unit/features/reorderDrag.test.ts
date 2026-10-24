/**
 * Pointer-drag session unit suite (design §8.1, review R1 N1).
 *
 * `reorderDrag.ts` splits the drag into pure geometry + a DOM session; the
 * component suites drive the session through real rows, which leaves the
 * session's own branches uncovered: the viewport-edge auto-scroll timer,
 * `pointercancel` (the browser grabbing the gesture) and `dispose` mid-drag.
 * Everything here runs against a controlled `requestAnimationFrame` queue and
 * fake interval timers — one geometry decision per flushed frame, exactly like
 * a browser frame.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  AUTO_SCROLL_MAX_PER_FRAME,
  autoScrollDirection,
  beginPointerDrag,
  dropTargetFromMetrics,
  type DragSession,
  type ListRect,
  type PointerPos,
  type RowRect,
} from '../../../src/features/tasks/reorderDrag';

const ROWS: readonly RowRect[] = [
  { id: 'T1', top: 0, bottom: 50 },
  { id: 'T2', top: 60, bottom: 110 },
  { id: 'T3', top: 120, bottom: 170 },
];

const LIST: ListRect = { id: 'L2', left: 0, top: 0, right: 200, bottom: 400 };

/* --------------------------- rAF + interval control --------------------------- */

let rafQueue: Map<number, FrameRequestCallback>;
let rafId: number;

beforeEach(() => {
  rafQueue = new Map();
  rafId = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    rafId += 1;
    rafQueue.set(rafId, cb);
    return rafId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
    rafQueue.delete(id);
  });
  // Fake ONLY the interval timers (the auto-scroll clock) — faking rAF too
  // would clobber the controlled queue above.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Run every queued frame callback (one browser frame). */
function flushFrame(): void {
  const queued = [...rafQueue.values()];
  rafQueue.clear();
  for (const cb of queued) cb(0);
}

function pointerEvent(type: string, pos: PointerPos): Event {
  const Ctor = (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
  return new Ctor(type, { clientX: pos.x, clientY: pos.y });
}

type Drag = {
  readonly session: DragSession;
  readonly onHover: Mock;
  readonly onDrop: Mock;
  readonly onCancel: Mock;
  readonly scrollBy: Mock;
};

/** A session over the fixed 3-row geometry with spy-able callbacks. */
function drag(overrides: Partial<Parameters<typeof beginPointerDrag>[0]> = {}): Drag {
  const onHover = vi.fn();
  const onDrop = vi.fn();
  const onCancel = vi.fn();
  const scrollBy = vi.fn();
  const session = beginPointerDrag({
    taskId: 'T1',
    readRows: () => ROWS,
    readLists: () => [],
    onHover,
    onDrop,
    onCancel,
    scrollBy,
    viewportHeight: () => 400,
    ...overrides,
  });
  return { session, onHover, onDrop, onCancel, scrollBy };
}

/* ------------------------------- pure geometry ------------------------------- */

describe('dropTargetFromMetrics (pure geometry, §8.1)', () => {
  it('decides before-row / after-last / list / none', () => {
    expect(dropTargetFromMetrics({ x: 10, y: 10 }, ROWS)).toEqual({ kind: 'before', rowId: 'T1' });
    expect(dropTargetFromMetrics({ x: 10, y: 60 }, ROWS)).toEqual({ kind: 'before', rowId: 'T2' });
    expect(dropTargetFromMetrics({ x: 10, y: 165 }, ROWS)).toEqual({
      kind: 'after-last',
      rowId: 'T3',
    });
    expect(dropTargetFromMetrics({ x: 10, y: 100 }, ROWS, [LIST])).toEqual({
      kind: 'list',
      listId: 'L2',
    });
    expect(dropTargetFromMetrics({ x: 10, y: 100 }, [])).toEqual({ kind: 'none' });
  });
});

describe('autoScrollDirection (§8.1: within 48 px of an edge)', () => {
  it('maps the edge zones to -1 / 1 and the middle to 0', () => {
    expect(autoScrollDirection({ x: 0, y: 0 }, 400)).toBe(-1);
    expect(autoScrollDirection({ x: 0, y: 47 }, 400)).toBe(-1);
    expect(autoScrollDirection({ x: 0, y: 48 }, 400)).toBe(0);
    expect(autoScrollDirection({ x: 0, y: 200 }, 400)).toBe(0);
    expect(autoScrollDirection({ x: 0, y: 352 }, 400)).toBe(0);
    expect(autoScrollDirection({ x: 0, y: 353 }, 400)).toBe(1);
    expect(autoScrollDirection({ x: 0, y: 400 }, 400)).toBe(1);
  });
});

/* --------------------------------- session ---------------------------------- */

describe('beginPointerDrag (DOM session)', () => {
  it('coalesces pointer moves into one geometry decision per frame', () => {
    const { session, onHover } = drag();

    session.move({ x: 10, y: 10 });
    session.move({ x: 10, y: 60 });
    expect(onHover).not.toHaveBeenCalled(); // nothing until the frame runs

    flushFrame();
    expect(onHover).toHaveBeenCalledTimes(1);
    expect(onHover).toHaveBeenCalledWith({ kind: 'before', rowId: 'T2' });
    session.dispose();
  });

  it('up(pos) evaluates the REAL drop position synchronously (no stale hover)', () => {
    const { session, onDrop, onCancel } = drag();

    session.move({ x: 10, y: 10 }); // queued, frame NOT flushed
    session.up({ x: 10, y: 60 }); // ...but the drop reads its own position

    expect(onDrop).toHaveBeenCalledWith({ kind: 'before', rowId: 'T2' });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('auto-scroll: an edge-zone pointer starts the interval timer and leaving the zone stops it', () => {
    const { session, onHover, scrollBy } = drag();

    session.move({ x: 10, y: 380 }); // bottom edge zone → scroll down
    flushFrame();
    expect(onHover).toHaveBeenCalledWith({ kind: 'after-last', rowId: 'T3' });
    expect(scrollBy).not.toHaveBeenCalled(); // timer waits one tick

    vi.advanceTimersByTime(16);
    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(scrollBy).toHaveBeenCalledWith(AUTO_SCROLL_MAX_PER_FRAME);
    vi.advanceTimersByTime(32);
    expect(scrollBy).toHaveBeenCalledTimes(3); // ~800 px/s

    session.move({ x: 10, y: 200 }); // back to the middle → timer cleared
    flushFrame();
    vi.advanceTimersByTime(100);
    expect(scrollBy).toHaveBeenCalledTimes(3);

    session.move({ x: 10, y: 5 }); // top edge zone → scrolls the other way
    flushFrame();
    vi.advanceTimersByTime(16);
    expect(scrollBy).toHaveBeenLastCalledWith(-AUTO_SCROLL_MAX_PER_FRAME);
    expect(scrollBy).toHaveBeenCalledTimes(4);

    session.dispose();
    vi.advanceTimersByTime(100);
    expect(scrollBy).toHaveBeenCalledTimes(4); // dispose kills the timer
  });

  it('pointercancel (browser grabbed the gesture) cancels — never drops', () => {
    const { onDrop, onCancel } = drag();

    document.dispatchEvent(pointerEvent('pointermove', { x: 10, y: 100 }));
    flushFrame();
    document.dispatchEvent(new Event('pointercancel'));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('Escape cancels and stops listening for further moves', () => {
    const { onHover, onCancel } = drag();

    document.dispatchEvent(pointerEvent('pointermove', { x: 10, y: 100 }));
    flushFrame();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    onHover.mockClear();
    document.dispatchEvent(pointerEvent('pointermove', { x: 10, y: 10 }));
    flushFrame();
    expect(onHover).not.toHaveBeenCalled(); // listeners removed
  });

  it('a drop outside every target cancels', () => {
    const { session, onDrop, onCancel } = drag({ readRows: () => [] });
    session.up({ x: 999, y: 999 });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('dispose mid-drag: no hover, no drop, no timer — and the document is clean', () => {
    const { session, onHover, onDrop, onCancel, scrollBy } = drag();

    document.dispatchEvent(pointerEvent('pointermove', { x: 10, y: 380 })); // edge zone
    session.dispose();

    flushFrame(); // the cancelled frame must not evaluate
    vi.advanceTimersByTime(100); // nor tick the auto-scroll interval
    expect(onHover).not.toHaveBeenCalled();
    expect(scrollBy).not.toHaveBeenCalled();

    // Listeners are gone: later document events reach no session callbacks.
    document.dispatchEvent(pointerEvent('pointermove', { x: 10, y: 10 }));
    document.dispatchEvent(pointerEvent('pointerup', { x: 10, y: 10 }));
    document.dispatchEvent(new Event('pointercancel'));
    flushFrame();
    expect(onHover).not.toHaveBeenCalled();
    expect(onDrop).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('dispose is idempotent (the list unmounts sessions it already finished)', () => {
    const { session } = drag();
    session.dispose();
    expect(() => {
      session.dispose();
    }).not.toThrow();
  });

  it('the exposed move()/cancel() mirrors the document listeners', () => {
    const { session, onHover, onCancel } = drag();
    session.move({ x: 10, y: 165 });
    flushFrame();
    expect(onHover).toHaveBeenCalledWith({ kind: 'after-last', rowId: 'T3' });
    session.cancel();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
