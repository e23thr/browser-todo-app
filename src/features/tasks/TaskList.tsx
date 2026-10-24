/**
 * Task list (design §7 S2 + §9.1 focus model + §8 reorder + §5.7 virtualization).
 *
 * One real `ul`/`li` list carrying interleaved group headers (`li[role=presentation]`
 * holding a real `h2`) and task rows, with ROW-LEVEL ROVING FOCUS: exactly one row is
 * tabbable, the inner controls of every other row are `tabindex="-1"`, and the arrow
 * keys move the row cursor (scrolling the target into view).
 *
 * Keyboard map on a focused row (§9.1): `↑`/`↓` move, `Home`/`End` jump, `PageUp`/
 * `PageDown` jump ~10, `Space` toggles complete (page scroll prevented), `Enter` opens
 * the editor, `Delete` opens the delete confirm. When the cursor's row disappears
 * (delete / concurrent tab) focus moves to the row that took its place, else the view
 * heading — focus is never dropped on the document.
 *
 * M6 reorder (this card, §8): `Alt+↑`/`Alt+↓`/`Alt+Home`/`Alt+End` emit ONE move per
 * press through `onMove` (the screen owns boundary/unavailable announcements and the
 * single-record write); the `ReorderHandle` performs the identical commands and is the
 * only drag entry point; `beginPointerDrag` computes drop targets (rows + sidebar
 * lists) and the list renders the ghost (`data-dragging`), the insertion line
 * (`data-drop-before`/`-after`) and the drop-on-list highlight.
 *
 * M5/M6 virtualization (§5.7): beyond `VIRTUALIZE_ROWS` the list windows the rows
 * through the domain's `computeWindow` (prefix-sum + binary search over measured
 * heights, uniform estimate `--row-height-task` for unmeasured rows), listening to the
 * nearest scroll parent with one geometry decision per animation frame. The roving
 * cursor PINS its row into the window before focusing it, so keyboard navigation and
 * focus survive any scroll position; every rendered row carries `aria-posinset`/
 * `aria-setsize` (its real position in the FULL list, not the window).
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { JSX, TargetedEvent } from 'preact';

import type { List, Task } from '../../domain/model';
import type { TaskPosition } from '../../domain/ports';
import type { ViewRow } from '../../domain/views';
import { computeWindow } from '../../domain/windowing';
import { setDropHoverListId } from '../../app/lists';
import { groupTitle } from './labels';
import { beginPointerDrag, type DropIntent, type ListRect, type RowRect } from './reorderDrag';
import type { MoveDelta } from './TaskRow';
import { TaskRow } from './TaskRow';

/** Rendered DOM rows stay below this count (§9.1: "virtualize beyond ~200 rows"). */
export const VIRTUALIZE_ROWS = 200;

/** Fallback row height (px) when `--row-height-task` is unavailable (jsdom, boot). */
const ESTIMATED_ROW_PX = 56;

export interface TaskListProps {
  readonly rows: readonly ViewRow[];
  readonly ariaLabel: string;
  readonly today: string;
  readonly lists: readonly List[];
  readonly showListBadge: boolean;
  /** Just-completed rows held in place for 900 ms (F3) — rendered checked + dimmed. */
  readonly retainedIds?: readonly string[];
  /** Search query (S5): `<mark>` highlight + notes excerpt on matching rows. */
  readonly highlight?: string;
  /** Per-list view only (D1): handles + move menu items (§8). */
  readonly reorderable?: boolean;
  /** Row id carrying the 600 ms "moved" highlight after a drop (§8.1). */
  readonly movedId?: string | null;
  readonly onToggle: (task: Task, done: boolean) => void;
  readonly onOpen: (id: string) => void;
  readonly onDelete: (id: string) => void;
  /** Keyboard/menu move (§8.2). The screen decides move vs. announce-unavailable. */
  readonly onMove?: (id: string, delta: MoveDelta) => void;
  /** Drag drop onto a row position (§8.1) — one `MoveTarget` position. */
  readonly onMoveTo?: (id: string, position: TaskPosition) => void;
  /** Row menu `Move to list…` (F11) — the screen opens the move dialog. */
  readonly onMoveToList?: (id: string) => void;
  /** Desktop drag onto a sidebar list (§8.1 extra) — move-to-list. */
  readonly onDropOnList?: (id: string, listId: string) => void;
  /** Drag ended without a drop (Escape / outside) — announce `a11y.reorderCancelled`. */
  readonly onDragCancel?: () => void;
}

function taskIdsOf(rows: readonly ViewRow[]): string[] {
  return rows.flatMap((row) => (row.type === 'task' ? [row.task.id] : []));
}

function rowElement(id: string): HTMLLIElement | null {
  for (const el of document.querySelectorAll<HTMLElement>('[data-task-id]')) {
    if (el.dataset['taskId'] === id && el.closest('ul.task-list') !== null)
      return el as HTMLLIElement;
  }
  return null;
}

/** Nearest scrollable ancestor (§5.7 scroll source), or the window when none. */
function scrollParentOf(element: HTMLElement): HTMLElement | Window {
  let node: HTMLElement | null = element.parentElement;
  while (node !== null) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
    node = node.parentElement;
  }
  return window;
}

/** The uniform row-height estimate from the design token (§5.7, co-designed value). */
function estimatedRowPx(list: HTMLUListElement | null): number {
  if (list === null) return ESTIMATED_ROW_PX;
  const raw = getComputedStyle(list).getPropertyValue('--row-height-task').trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : ESTIMATED_ROW_PX;
}

/** Live row rectangles in DOM order (drag hit-testing; rendered rows only). */
function renderedRowRects(list: HTMLUListElement | null): RowRect[] {
  if (list === null) return [];
  const out: RowRect[] = [];
  for (const el of list.querySelectorAll<HTMLElement>('[data-task-id]')) {
    const rect = el.getBoundingClientRect();
    out.push({ id: el.dataset['taskId'] ?? '', top: rect.top, bottom: rect.bottom });
  }
  return out;
}

/** Sidebar list drop targets (§8.1 desktop extra; `data-drop-list-id` set by the shell). */
function sidebarListRects(): ListRect[] {
  const out: ListRect[] = [];
  for (const el of document.querySelectorAll<HTMLElement>('[data-drop-list-id]')) {
    const rect = el.getBoundingClientRect();
    out.push({
      id: el.dataset['dropListId'] ?? '',
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
    });
  }
  return out;
}

/** `MoveTarget` position for an insertion intent (single order-key write, §5.7). */
function positionForIntent(intent: DropIntent, taskIds: readonly string[]): TaskPosition | null {
  if (intent.kind === 'list' || intent.kind === 'none') return null;
  if (intent.kind === 'after-last') return 'last';
  const at = taskIds.indexOf(intent.rowId);
  if (at < 0) return null;
  const previous = taskIds[at - 1];
  return previous === undefined ? 'first' : { afterId: previous };
}

export function TaskList({
  rows,
  ariaLabel,
  today,
  lists,
  showListBadge,
  retainedIds,
  highlight,
  reorderable = false,
  movedId = null,
  onToggle,
  onOpen,
  onDelete,
  onMove,
  onMoveTo,
  onMoveToList,
  onDropOnList,
  onDragCancel,
}: TaskListProps): JSX.Element {
  const ids = taskIdsOf(rows);
  const [currentId, setCurrentId] = useState<string | null>(ids[0] ?? null);
  const previousIds = useRef<string[]>(ids);
  const [drag, setDrag] = useState<{ readonly taskId: string; readonly intent: DropIntent } | null>(
    null,
  );

  // ------------------------------ virtualization ------------------------------
  const listRef = useRef<HTMLUListElement | null>(null);
  const heights = useRef(new Map<string, number>());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportPx, setViewportPx] = useState(0);
  const rafFrame = useRef<number | null>(null);
  const estimate = estimatedRowPx(listRef.current);
  const virtualized = rows.length > VIRTUALIZE_ROWS;

  useLayoutEffect(() => {
    if (!virtualized) return;
    const list = listRef.current;
    if (list === null) return;
    // Measure what is actually rendered (real heights feed the prefix sums);
    // jsdom reports 0 and keeps the uniform estimate — deterministic in tests.
    for (const el of list.querySelectorAll<HTMLElement>('[data-task-id]')) {
      const height = el.getBoundingClientRect().height;
      if (height > 0) heights.current.set(el.dataset['taskId'] ?? '', height);
    }
  });

  useEffect(() => {
    if (!virtualized) return;
    const parent = scrollParentOf(listRef.current as HTMLElement);
    const readScroll = (): number =>
      parent === window ? window.scrollY : (parent as HTMLElement).scrollTop;
    const readViewport = (): number =>
      parent === window ? window.innerHeight || 768 : (parent as HTMLElement).clientHeight || 768;
    setViewportPx(readViewport());
    const onScroll = (): void => {
      // One geometry decision per frame (§5.7 / domain-api §6: rAF coalescing).
      if (rafFrame.current !== null) return;
      rafFrame.current = requestAnimationFrame(() => {
        rafFrame.current = null;
        setScrollTop(readScroll());
      });
    };
    setScrollTop(readScroll());
    parent.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      parent.removeEventListener('scroll', onScroll);
      if (rafFrame.current !== null) {
        cancelAnimationFrame(rafFrame.current);
        rafFrame.current = null;
      }
    };
  }, [virtualized, rows.length]);

  const currentIndexOf = (id: string | null): number =>
    id === null ? -1 : rows.findIndex((row) => row.type === 'task' && row.task.id === id);

  // DERIVED pin (§5.7 a11y contract): the cursor row is ALWAYS materialized —
  // focus can't live on a node the window destroyed, so the window math simply
  // includes the current row (domain-api §6 `pin`).
  const currentIndex = currentIndexOf(currentId);
  const window_ = virtualized
    ? computeWindow({
        count: rows.length,
        heightAt: (index) => {
          const row = rows[index];
          const key = row === undefined ? '' : row.type === 'task' ? row.task.id : row.key;
          return heights.current.get(key) ?? estimate;
        },
        viewportPx: viewportPx > 0 ? viewportPx : 768,
        scrollTop,
        ...(currentIndex >= 0 ? { pin: [currentIndex] } : {}),
      })
    : { start: 0, end: rows.length, padTop: 0, padBottom: 0 };

  // Keep the cursor on a live row: default to the first row, and when the current row
  // vanishes (deleted here or in another tab) take over the neighbour's position —
  // but only pull DOM focus when nothing else holds it (never steal typing focus).
  useEffect(() => {
    const previous = previousIds.current;
    previousIds.current = ids;

    if (ids.length === 0) {
      if (currentId !== null) setCurrentId(null);
      return;
    }
    if (currentId !== null && ids.includes(currentId)) return;

    const goneAt = currentId === null ? -1 : previous.indexOf(currentId);
    const next = ids[goneAt >= 0 ? Math.min(goneAt, ids.length - 1) : 0];
    if (next === undefined) return;

    const active = document.activeElement;
    const focusIsFree = active === null || active === document.body;
    setCurrentId(next);
    if (goneAt >= 0 && focusIsFree) {
      // The derived pin materializes the row on the next commit; the pendingFocus
      // effect then pulls DOM focus onto it (focus is never dropped on the body).
      pendingFocusRef.current = next;
    }
  }, [ids.join(','), currentId]);

  /** Move DOM focus onto `id` (the derived pin materializes it on the next commit). */
  const pendingFocusRef = useRef<string | null>(null);
  const focusRow = (id: string): void => {
    setCurrentId(id);
    pendingFocusRef.current = id;
    const el = rowElement(id);
    if (el !== null) {
      pendingFocusRef.current = null;
      el.focus();
      if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
    }
  };

  // The derived pin guarantees the cursor row exists after the commit that moved
  // the cursor; apply DOM focus once it materializes (§5.7: "the focused row must
  // be materialized before it can hold focus").
  useEffect(() => {
    const id = pendingFocusRef.current;
    if (id === null) return;
    if (!ids.includes(id)) {
      pendingFocusRef.current = null; // row vanished — nothing to focus
      return;
    }
    const el = rowElement(id);
    if (el === null) return;
    pendingFocusRef.current = null;
    if (document.activeElement !== el) el.focus();
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  });

  const onRowFocus = (id: string): void => {
    setCurrentId(id);
  };

  // After a reorder (§8.2 "focus stays on the moved row") the row usually keeps
  // focus by itself (same DOM node). In a virtualized list a top/bottom jump can
  // push it out of the window, destroying the node and dropping focus on the
  // body — restore it on the materialized row, and ONLY then (never steal focus
  // that is already somewhere real).
  const refocusRef = useRef<string | null>(null);
  useEffect(() => {
    const id = refocusRef.current;
    if (id === null) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const el = rowElement(id);
    if (el === null) return;
    refocusRef.current = null;
    setCurrentId(id);
    el.focus();
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [ids.join(','), window_.start, window_.end]);

  const onRowKeyDown = (event: TargetedEvent<HTMLElement, KeyboardEvent>): void => {
    const index = currentId === null ? -1 : ids.indexOf(currentId);
    if (index < 0) return;
    const at = (next: number): void => {
      const clamped = Math.max(0, Math.min(ids.length - 1, next));
      const target = ids[clamped];
      if (target !== undefined) focusRow(target);
    };

    // §8.2 keyboard reorder — one position per press (or to an edge); the handle
    // routes the identical commands (§9.1 inner-control map).
    if (
      event.altKey &&
      onMove !== undefined &&
      currentId !== null &&
      (event.key === 'ArrowUp' ||
        event.key === 'ArrowDown' ||
        event.key === 'Home' ||
        event.key === 'End')
    ) {
      event.preventDefault();
      const delta: MoveDelta =
        event.key === 'ArrowUp'
          ? -1
          : event.key === 'ArrowDown'
            ? 1
            : event.key === 'Home'
              ? 'top'
              : 'bottom';
      refocusRef.current = currentId;
      onMove(currentId, delta);
      return;
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        at(index + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        at(index - 1);
        return;
      case 'Home':
        event.preventDefault();
        at(0);
        return;
      case 'End':
        event.preventDefault();
        at(ids.length - 1);
        return;
      case 'PageDown':
        event.preventDefault();
        at(index + 10);
        return;
      case 'PageUp':
        event.preventDefault();
        at(index - 10);
        return;
      case ' ': {
        // Space on the row toggles complete and must not scroll the page (§9.1).
        event.preventDefault();
        const row = rows.find(
          (r): r is Extract<ViewRow, { type: 'task' }> =>
            r.type === 'task' && r.task.id === currentId,
        );
        if (row !== undefined) onToggle(row.task, row.task.status === 'open');
        return;
      }
      case 'Enter': {
        event.preventDefault();
        if (currentId !== null) onOpen(currentId);
        return;
      }
      case 'Delete': {
        event.preventDefault();
        if (currentId !== null) onDelete(currentId);
        return;
      }
      default:
    }
  };

  /* ----------------------------------- drag ---------------------------------- */

  const sessionRef = useRef<ReturnType<typeof beginPointerDrag> | null>(null);
  useEffect(
    () => () => {
      sessionRef.current?.dispose();
      sessionRef.current = null;
      setDropHoverListId(null);
    },
    [],
  );

  const onHandleDragStart = (
    _event: TargetedEvent<HTMLButtonElement, PointerEvent>,
    taskId: string,
  ): void => {
    if (!reorderable || onMoveTo === undefined) return;
    sessionRef.current?.dispose();
    sessionRef.current = beginPointerDrag({
      taskId,
      readRows: () => renderedRowRects(listRef.current),
      readLists: () => (onDropOnList === undefined ? [] : sidebarListRects()),
      onHover: (intent) => {
        setDrag({ taskId, intent });
        setDropHoverListId(intent.kind === 'list' ? intent.listId : null);
      },
      onDrop: (intent) => {
        sessionRef.current = null;
        setDrag(null);
        setDropHoverListId(null);
        if (intent.kind === 'list') {
          onDropOnList?.(taskId, intent.listId);
          return;
        }
        const position = positionForIntent(intent, ids);
        if (position !== null) {
          refocusRef.current = taskId;
          onMoveTo(taskId, position);
        }
      },
      onCancel: () => {
        sessionRef.current = null;
        setDrag(null);
        setDropHoverListId(null);
        onDragCancel?.();
      },
      scrollBy: (deltaY) => {
        const parent = listRef.current === null ? window : scrollParentOf(listRef.current);
        if (parent === window) {
          window.scrollTo({ top: window.scrollY + deltaY });
        } else {
          (parent as HTMLElement).scrollTop += deltaY;
        }
      },
    });
    // Keep the cursor on the dragged row (focus follows the gesture for AT).
    setCurrentId(taskId);
  };

  const dragStateFor = (id: string): 'dragging' | 'drop-before' | 'drop-after' | undefined => {
    if (drag === null || drag.taskId === id) return drag === null ? undefined : 'dragging';
    const intent = drag.intent;
    if (intent.kind === 'before' && intent.rowId === id) return 'drop-before';
    if (intent.kind === 'after-last' && intent.rowId === id) return 'drop-after';
    return undefined;
  };

  const listName = (id: string): string | null => lists.find((l) => l.id === id)?.name ?? null;
  const firstTaskId = ids[0];
  const lastTaskId = ids[ids.length - 1];
  const visibleRows = rows.slice(window_.start, window_.end);

  const renderRow = (row: ViewRow): JSX.Element => {
    if (row.type === 'group') {
      return (
        <li class="group-row" role="presentation" key={row.key}>
          <h2 class="group-header">
            <span class="group-title">
              {groupTitle(
                row.label,
                row.count,
                today,
                row.label.kind === 'list' ? listName(row.label.listId) : null,
              )}
            </span>
          </h2>
        </li>
      );
    }
    const setSize = ids.length;
    const posInSet = ids.indexOf(row.task.id) + 1;
    const dragState = dragStateFor(row.task.id);
    return (
      <TaskRow
        key={row.task.id}
        task={row.task}
        overdue={row.flags.overdue}
        depth={row.depth}
        current={row.task.id === currentId}
        showListBadge={showListBadge}
        listName={listName(row.task.listId)}
        today={today}
        retained={retainedIds?.includes(row.task.id) === true}
        {...(highlight !== undefined ? { highlight } : {})}
        reorderable={reorderable}
        moveDisabled={{
          up: row.task.id === firstTaskId,
          down: row.task.id === lastTaskId,
        }}
        moved={row.task.id === movedId}
        {...(dragState !== undefined ? { dragState } : {})}
        posInSet={posInSet}
        setSize={setSize}
        onToggle={onToggle}
        onOpen={onOpen}
        onDelete={onDelete}
        {...(onMove !== undefined ? { onMove } : {})}
        {...(onMoveToList !== undefined ? { onMoveToList } : {})}
        {...(reorderable ? { onHandleDragStart } : {})}
        onRowFocus={onRowFocus}
        onRowKeyDown={onRowKeyDown}
      />
    );
  };

  return (
    <ul
      class="task-list"
      aria-label={ariaLabel}
      ref={listRef}
      data-virtualized={virtualized ? 'true' : undefined}
    >
      {window_.padTop > 0 ? (
        <li
          class="task-list-pad"
          role="presentation"
          aria-hidden="true"
          style={{ height: `${String(window_.padTop)}px` }}
        />
      ) : null}
      {virtualized ? visibleRows.map((row) => renderRow(row)) : rows.map((row) => renderRow(row))}
      {window_.padBottom > 0 ? (
        <li
          class="task-list-pad"
          role="presentation"
          aria-hidden="true"
          style={{ height: `${String(window_.padBottom)}px` }}
        />
      ) : null}
    </ul>
  );
}
