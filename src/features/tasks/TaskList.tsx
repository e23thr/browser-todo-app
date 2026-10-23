/**
 * Task list (design §7 S2 + §9.1 focus model).
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
 * Reorder keys (`Alt+↑/↓`) and drag handles belong to the M6 card (D1: per-list views
 * only); this list exposes the seams (`data-task-id`, row menu) they build on.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX, TargetedEvent } from 'preact';

import type { List, Task } from '../../domain/model';
import type { ViewRow } from '../../domain/views';
import { groupTitle } from './labels';
import { TaskRow } from './TaskRow';

export interface TaskListProps {
  readonly rows: readonly ViewRow[];
  readonly ariaLabel: string;
  readonly today: string;
  readonly lists: readonly List[];
  readonly showListBadge: boolean;
  readonly onToggle: (task: Task, done: boolean) => void;
  readonly onOpen: (id: string) => void;
  readonly onDelete: (id: string) => void;
}

function taskIdsOf(rows: readonly ViewRow[]): string[] {
  return rows.flatMap((row) => (row.type === 'task' ? [row.task.id] : []));
}

function rowElement(id: string): HTMLLIElement | null {
  for (const el of document.querySelectorAll<HTMLElement>('[data-task-id]')) {
    if (el.dataset['task-id'] === id && el.closest('ul.task-list') !== null) return el as HTMLLIElement;
  }
  return null;
}

function focusViewHeading(): void {
  document.querySelector<HTMLElement>('main [data-view-title]')?.focus();
}

export function TaskList({
  rows,
  ariaLabel,
  today,
  lists,
  showListBadge,
  onToggle,
  onOpen,
  onDelete,
}: TaskListProps): JSX.Element {
  const ids = taskIdsOf(rows);
  const [currentId, setCurrentId] = useState<string | null>(ids[0] ?? null);
  const previousIds = useRef<string[]>(ids);

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
      queueMicrotask(() => {
        const el = rowElement(next);
        if (el !== null) el.focus();
        else focusViewHeading();
      });
    }
  }, [ids.join(','), currentId]);

  const focusRow = (id: string): void => {
    setCurrentId(id);
    const el = rowElement(id);
    el?.focus();
    el?.scrollIntoView({ block: 'nearest' });
  };

  const onRowFocus = (id: string): void => {
    setCurrentId(id);
  };

  const onRowKeyDown = (event: TargetedEvent<HTMLLIElement, KeyboardEvent>): void => {
    const index = currentId === null ? -1 : ids.indexOf(currentId);
    if (index < 0) return;
    const at = (next: number): void => {
      const clamped = Math.max(0, Math.min(ids.length - 1, next));
      const target = ids[clamped];
      if (target !== undefined) focusRow(target);
    };

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
        const row = rows.find((r): r is Extract<ViewRow, { type: 'task' }> =>
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

  const listName = (id: string): string | null => lists.find((l) => l.id === id)?.name ?? null;

  return (
    <ul class="task-list" aria-label={ariaLabel}>
      {rows.map((row) => {
        if (row.type === 'group') {
          return (
            <li class="group-row" role="presentation" key={row.key}>
              <h2 class="group-header">
                <span class="group-title">{groupTitle(row.label, row.count, today, row.label.kind === 'list' ? listName(row.label.listId) : null)}</span>
              </h2>
            </li>
          );
        }
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
            onToggle={onToggle}
            onOpen={onOpen}
            onDelete={onDelete}
            onRowFocus={onRowFocus}
            onRowKeyDown={onRowKeyDown}
          />
        );
      })}
    </ul>
  );
}
