/**
 * Task row (design §7 S2) — checkbox, title, badges, actions menu.
 *
 * Anatomy: `checkbox | title | badges | menu` with a metadata line beneath (mobile;
 * collapses on wide screens where the badges carry the same information inline).
 *
 * Semantics (§5.3): a native `<input type="checkbox">` whose accessible name is the
 * full toggle sentence including the visible title (label-in-name ✓), the title is a
 * real button (opens the editor), badges that are icons-only carry `aria-label`/`role=img`
 * text, and status is never colour alone (overdue = text + `!` marker, priority = shape).
 *
 * M5/M6 additions (checklist items 11, 25, 31–35): search results highlight the query
 * with `<mark>` (plus a clamped notes excerpt when the match came from notes), per-list
 * rows carry a `ReorderHandle` (drag entry point, §8.1) and the row menu gains
 * `Move to list…` + per-list `Move up`/`Move down` (`aria-disabled` at the ends, §8.2).
 */

import type { JSX, TargetedEvent } from 'preact';

import { getLocale, t } from '../../app/i18n';
import { Icon } from '../../app/icons';
import type { Task } from '../../domain/model';
import { highlightSegments, notesExcerptNeeded, queryTokens } from '../search/highlight';
import { dueBadge } from './labels';
import { ReorderHandle } from './ReorderHandle';
import { RowMenu } from './RowMenu';

/** Keyboard/menu move delta: one step, or to an edge (§8.2 Alt+Home/End). */
export type MoveDelta = -1 | 1 | 'top' | 'bottom';

export interface TaskRowProps {
  readonly task: Task;
  readonly overdue: boolean;
  readonly depth: 0 | 1;
  /** Roving cursor: exactly one row in the list is tabbable (§9.1). */
  readonly current: boolean;
  readonly showListBadge: boolean;
  readonly listName: string | null;
  readonly today: string;
  /** A just-completed row held in place for 900 ms before it collapses out (F3). */
  readonly retained?: boolean;
  /** Search query (S5): segments the title into `<mark>` runs + notes excerpt. */
  readonly highlight?: string;
  /** Per-list view only (D1): render the ReorderHandle + Move up/down items (§8). */
  readonly reorderable?: boolean;
  /** Menu Move up/Move down `aria-disabled` at the list ends (§8.2). */
  readonly moveDisabled?: { readonly up: boolean; readonly down: boolean };
  /** 600 ms post-drop highlight (§8.1; skipped visually under reduced motion). */
  readonly moved?: boolean;
  /** Live drag state (§8.1): ghost, insertion line before this row / after the last. */
  readonly dragState?: 'dragging' | 'drop-before' | 'drop-after';
  /** Virtualization a11y: real position in the FULL list, not just the window. */
  readonly posInSet?: number;
  readonly setSize?: number;
  readonly onToggle: (task: Task, done: boolean) => void;
  readonly onOpen: (id: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onMove?: (id: string, delta: MoveDelta) => void;
  readonly onMoveToList?: (id: string) => void;
  readonly onHandleDragStart?: (
    event: TargetedEvent<HTMLButtonElement, PointerEvent>,
    id: string,
  ) => void;
  readonly onRowFocus: (id: string) => void;
  readonly onRowKeyDown: (event: TargetedEvent<HTMLElement, KeyboardEvent>) => void;
}

const PRIORITY_ICON = { 1: 'flag-medium', 2: 'flag-high' } as const;
const PRIORITY_KEY = { 1: 'priority.medium', 2: 'priority.high' } as const;

/** Render `text` with `<mark>` around every query-token occurrence (S5). */
function SegmentedText({
  text,
  query,
}: {
  readonly text: string;
  readonly query: string;
}): JSX.Element {
  const segments = highlightSegments(text, queryTokens(query));
  return (
    <>
      {segments.map((segment, index) =>
        segment.hit ? (
          <mark key={index}>{segment.text}</mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

export function TaskRow({
  task,
  overdue,
  depth,
  current,
  showListBadge,
  listName,
  today,
  retained = false,
  highlight,
  reorderable = false,
  moveDisabled,
  moved = false,
  dragState,
  posInSet,
  setSize,
  onToggle,
  onOpen,
  onDelete,
  onMove,
  onMoveToList,
  onHandleDragStart,
  onRowFocus,
  onRowKeyDown,
}: TaskRowProps): JSX.Element {
  const done = task.status === 'done';
  const badge = done ? null : dueBadge(task.dueDate, today);
  const innerTabIndex = current ? 0 : -1;
  const priorityKey =
    task.priority === 2 ? PRIORITY_KEY[2] : task.priority === 1 ? PRIORITY_KEY[1] : null;
  const priorityIcon =
    task.priority === 2 ? PRIORITY_ICON[2] : task.priority === 1 ? PRIORITY_ICON[1] : null;
  const tokens = highlight === undefined ? [] : queryTokens(highlight);
  const showNotesExcerpt = notesExcerptNeeded(task.title, task.notes, tokens);

  const metaText = done
    ? task.completedAt === undefined
      ? ''
      : t('task.completedOn', {
          date: new Intl.DateTimeFormat(getLocale(), {
            day: 'numeric',
            month: 'short',
          }).format(new Date(task.completedAt)),
        })
    : [badge?.text ?? '', showListBadge ? (listName ?? '') : '']
        .filter((part) => part !== '')
        .join(' · ');

  const onRowKey = (event: TargetedEvent<HTMLLIElement, KeyboardEvent>): void => {
    // Escape from any inner control returns focus to the row container (§9.1).
    if (event.key === 'Escape' && event.target !== event.currentTarget) {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.focus();
      return;
    }
    if (event.target !== event.currentTarget) return;
    onRowKeyDown(event);
  };

  // §16 item 11: Edit, Move to list…, Move up, Move down (per-list; aria-disabled at
  // the ends), Delete — in that order; Delete in danger tone.
  const menuItems = [
    {
      key: 'edit',
      label: t('task.action.edit'),
      onSelect: () => {
        onOpen(task.id);
      },
    },
    {
      key: 'move-to-list',
      label: t('task.action.moveToList'),
      onSelect: () => {
        onMoveToList?.(task.id);
      },
    },
    ...(reorderable && onMove !== undefined
      ? ([
          {
            key: 'move-up',
            label: t('task.action.moveUp'),
            disabled: moveDisabled?.up ?? false,
            onSelect: () => {
              onMove(task.id, -1);
            },
          },
          {
            key: 'move-down',
            label: t('task.action.moveDown'),
            disabled: moveDisabled?.down ?? false,
            onSelect: () => {
              onMove(task.id, 1);
            },
          },
        ] as const)
      : []),
    {
      key: 'delete',
      label: t('task.action.delete'),
      danger: true,
      onSelect: () => {
        onDelete(task.id);
      },
    },
  ];

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- design §9.1: one composite widget; the row carries the roving cursor keys.
    <li
      class="task-row"
      data-task-id={task.id}
      data-depth={String(depth)}
      data-done={done ? 'true' : undefined}
      data-retained={retained ? 'true' : undefined}
      data-overdue={overdue ? 'true' : undefined}
      data-moved={moved ? 'true' : undefined}
      data-dragging={dragState === 'dragging' ? 'true' : undefined}
      data-drop-before={dragState === 'drop-before' ? 'true' : undefined}
      data-drop-after={dragState === 'drop-after' ? 'true' : undefined}
      {...(posInSet !== undefined ? { 'aria-posinset': posInSet } : {})}
      {...(setSize !== undefined ? { 'aria-setsize': setSize } : {})}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- design §9.1 roving tabindex on a real li.
      tabIndex={current ? 0 : -1}
      onFocus={(event) => {
        if (event.target === event.currentTarget) onRowFocus(task.id);
      }}
      onKeyDown={onRowKey}
    >
      <div class="row-main">
        <input
          type="checkbox"
          class="task-check"
          checked={done}
          aria-label={
            done
              ? t('a11y.untoggleTask', { title: task.title })
              : t('a11y.toggleTask', { title: task.title })
          }
          tabIndex={innerTabIndex}
          onChange={(event) => {
            // The native control's post-click state IS the desired state (F3).
            onToggle(task, event.currentTarget.checked);
          }}
        />

        <button
          type="button"
          class="task-title"
          tabIndex={innerTabIndex}
          title={task.title}
          onClick={() => {
            onOpen(task.id);
          }}
        >
          <span class="task-title-text">
            {highlight === undefined ? (
              task.title
            ) : (
              <SegmentedText text={task.title} query={highlight} />
            )}
          </span>
        </button>

        <span class="row-badges">
          {badge !== null ? (
            <span
              class={`due-badge${badge.overdue ? ' due-badge-overdue' : ''}`}
              data-overdue={badge.overdue ? 'true' : undefined}
            >
              {badge.overdue ? (
                <span class="due-marker" aria-hidden="true">
                  !
                </span>
              ) : null}
              {badge.text}
            </span>
          ) : null}

          {priorityKey !== null && priorityIcon !== null ? (
            <span
              class="priority-badge"
              role="img"
              aria-label={t(priorityKey)}
              title={t(priorityKey)}
            >
              <Icon name={priorityIcon} size={16} />
            </span>
          ) : null}

          {task.notes !== null && task.notes !== '' ? (
            <span class="notes-badge" role="img" aria-label={t('a11y.hasNotes')}>
              <Icon name="notes" size={16} />
            </span>
          ) : null}

          {showListBadge && listName !== null ? (
            <span class="list-badge">
              <span class="list-dot" aria-hidden="true" />
              {listName}
            </span>
          ) : null}
        </span>

        <RowMenu
          class="row-actions"
          label={t('task.rowMenu', { title: task.title })}
          tabIndex={innerTabIndex}
          items={menuItems}
        />

        {reorderable && onHandleDragStart !== undefined ? (
          <ReorderHandle
            taskId={task.id}
            title={task.title}
            tabIndex={innerTabIndex}
            onDragStart={(event) => {
              onHandleDragStart(event, task.id);
            }}
            onMoveKey={(event) => {
              // §9.1 inner-control map: the handle performs the SAME move commands.
              onRowKeyDown(event);
            }}
          />
        ) : null}
      </div>

      {showNotesExcerpt && task.notes !== null ? (
        <p class="row-meta row-notes-excerpt">
          <SegmentedText text={task.notes} query={highlight ?? ''} />
        </p>
      ) : null}

      {metaText !== '' ? <p class="row-meta">{metaText}</p> : null}
    </li>
  );
}
