/**
 * Task screen (design §7 S2) — the frame every task view renders inside.
 *
 * Owns: the view header (h1 + count), the wide-screen inline composer, the
 * empty/loading/error state matrix (§14), the row/dialog interaction set (open editor,
 * confirm delete), the complete/uncomplete flow with its 900 ms retention (F3), and the
 * announcements of §5.5 for every action this surface performs.
 *
 * Grouping, membership and ordering come from the domain's `selectView` (ADR-003 — the
 * UI adapts and localizes, it never re-derives view semantics). The ONLY thing added
 * here is the just-completed row's 900 ms stay-behind: the row keeps its position
 * (anchored to the row/group that preceded it) while checked, then collapses out.
 *
 * Reorder (Alt+↑/↓, handles) and search belong to the M5/M6 card; this frame exposes
 * `data-task-id` rows and the row menu they extend.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';

import { announce } from '../../app/announce';
import { t } from '../../app/i18n';
import { useMediaQuery, WIDE_QUERY } from '../../app/media';
import { startQuickAdd } from '../../app/quickAdd';
import { EmptyState, View } from '../../components/View';
import type { Task } from '../../domain/model';
import type { TaskPosition, TaskRemoveDisposition } from '../../domain/ports';
import { selectView, type ViewId, type ViewRow } from '../../domain/views';
import type { IconName } from '../../app/icons';
import { Composer } from './Composer';
import { BootErrorPanel } from './BootErrorPanel';
import { MoveToListDialog } from './MoveToListDialog';
import type { MoveDelta } from './TaskRow';
import { TaskDeleteDialog } from './TaskDeleteDialog';
import { TaskEditor } from './TaskEditor';
import { TaskList } from './TaskList';
import { TagsManageDialog } from './TagsManageDialog';
import {
  allTags,
  deleteTask,
  liveLists,
  moveTaskTo,
  setTaskDone,
  sortMode,
  state,
  status,
  tagFilter,
  today,
} from './store';

/** Rows just completed stay visible this long so the user sees what they checked (F3). */
export const RETAIN_COMPLETED_MS = 900;

/** Post-drop "moved" highlight (§8.1; visual only — skipped under reduced motion). */
export const MOVED_HIGHLIGHT_MS = 600;

type Retained = { readonly id: string; readonly anchor: string | null };

/**
 * The open editor's anchor: the task id plus the LAST KNOWN image of that task.
 *
 * The image is what makes the §14 `error.taskGone` state reachable in situ (E2 F-3):
 * a concurrent delete (another tab, a list-removal disposition) evicts the row from
 * store state, and rendering the dialog off `tasks.get(id)` alone would unmount it and
 * drop the user's unsaved edits with no message. Holding the last known task keeps the
 * dialog mounted; `<TaskEditor>` then flips to its `gone` state (row + Save disabled)
 * against the record it was already editing.
 *
 * Exported because the search screen composes the same dialog over the same contract.
 */
export interface EditingTask {
  readonly id: string;
  readonly task: Task;
}

export interface TaskScreenProps {
  readonly view: ViewId;
  readonly title: string;
  readonly emptyIcon: IconName;
  readonly emptyTitle: string;
  readonly emptyBody: string;
  /** `false` hides the row list while a deep link resolves (unknown list id). */
  readonly listResolved?: boolean;
}

function rowKey(row: ViewRow): string {
  return row.type === 'group' ? row.key : row.task.id;
}

/** Re-insert retained rows at their pre-completion anchor (F3 "stays visible"). */
function withRetained(
  rows: ViewRow[],
  retained: readonly Retained[],
  tasks: ReadonlyMap<string, Task>,
): ViewRow[] {
  if (retained.length === 0) return rows;
  const present = new Set(rows.flatMap((row) => (row.type === 'task' ? [row.task.id] : [])));
  const out = [...rows];
  for (const entry of retained) {
    if (present.has(entry.id)) continue;
    const task = tasks.get(entry.id);
    if (task === undefined) continue;
    const synthetic: ViewRow = {
      type: 'task',
      task,
      depth: 0,
      flags: { overdue: task.status === 'open' && (task.dueDate ?? '') < today.value },
    };
    const at = entry.anchor === null ? -1 : out.findIndex((row) => rowKey(row) === entry.anchor);
    if (at >= 0) out.splice(at + 1, 0, synthetic);
    else out.unshift(synthetic);
  }
  return out;
}

function SkeletonList(): JSX.Element {
  return (
    <div class="skeleton" aria-busy="true" data-testid="skeleton">
      <p role="status" class="visually-hidden">
        {t('a11y.loading')}
      </p>
      <div class="skeleton-row" />
      <div class="skeleton-row" />
      <div class="skeleton-row" />
    </div>
  );
}

export function TaskScreen({
  view,
  title,
  emptyIcon,
  emptyTitle,
  emptyBody,
  listResolved = true,
}: TaskScreenProps): JSX.Element {
  const wide = useMediaQuery(WIDE_QUERY);
  const [editing, setEditing] = useState<EditingTask | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [movedId, setMovedId] = useState<string | null>(null);
  const [managingTags, setManagingTags] = useState(false);
  const [retained, setRetained] = useState<readonly Retained[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const storeState = state.value;
  const phase = status.value;
  const day = today.value;
  const lists = liveLists(storeState);

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) clearTimeout(timer);
      map.clear();
    };
  }, []);

  const result = selectView(storeState, view, {
    today: day,
    ...(tagFilter.value !== null ? { tag: tagFilter.value } : {}),
    ...(sortMode.value === 'priority' ? { sortBy: 'priority' as const } : {}),
  });
  const rows = withRetained(result.rows, retained, storeState.tasks);
  const taskCount = rows.flatMap((row) => (row.type === 'task' ? [row] : [])).length;
  const showListBadge = view.kind !== 'list';
  // The live row wins; the held image is the §14 fallback once a concurrent delete
  // has evicted it (see `EditingTask`) — never a silent unmount over unsaved edits.
  const editingTask =
    editing === null ? undefined : (storeState.tasks.get(editing.id) ?? editing.task);
  const confirmingTask = confirmingId === null ? undefined : storeState.tasks.get(confirmingId);
  const movingTask = movingId === null ? undefined : storeState.tasks.get(movingId);

  /* ------------------------------ interactions ------------------------------ */

  const onToggle = (task: Task, done: boolean): void => {
    if (done) {
      // Anchor BEFORE the optimistic apply removes the row from this view.
      const index = rows.findIndex((row) => row.type === 'task' && row.task.id === task.id);
      const anchor = index > 0 ? rowKey(rows[index - 1] as ViewRow) : null;
      const openView = view.kind !== 'completed';
      if (openView) {
        setRetained((current) => [...current, { id: task.id, anchor }]);
        const timer = setTimeout(() => {
          setRetained((current) => current.filter((entry) => entry.id !== task.id));
          timers.current.delete(task.id);
        }, RETAIN_COMPLETED_MS);
        timers.current.set(task.id, timer);
      }
      announce(t('a11y.taskCompleted'));
    } else {
      announce(t('a11y.taskReopened'));
    }
    void setTaskDone(task.id, done);
  };

  const onOpen = (id: string): void => {
    const task = storeState.tasks.get(id);
    if (task === undefined) return;
    setEditing({ id, task });
  };

  const onDelete = (id: string): void => {
    setConfirmingId(id);
  };

  const confirmDelete = (disposition: TaskRemoveDisposition): void => {
    const task = confirmingTask;
    setConfirmingId(null);
    if (task === undefined) return;
    // Drop any retention immediately: the row is gone for good.
    const timer = timers.current.get(task.id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(task.id);
    }
    setRetained((current) => current.filter((entry) => entry.id !== task.id));
    setEditing(null);
    void deleteTask(task.id, disposition).then((result) => {
      if (result.ok) announce(t('a11y.taskDeleted'));
    });
  };

  /* ------------------------------- reorder (M6) ------------------------------- */

  /**
   * The displayed task rows (manual per-list order, D1). Reorder is legal ONLY
   * in a per-list view (§8.2); every other view hears `a11y.reorderUnavailable`.
   */
  const taskIds = rows.flatMap((row) => (row.type === 'task' ? [row.task.id] : []));

  const flashMoved = (id: string): void => {
    setMovedId(id);
    const timer = timers.current.get(`moved:${id}`);
    if (timer !== undefined) clearTimeout(timer);
    const next = setTimeout(() => {
      setMovedId((current) => (current === id ? null : current));
      timers.current.delete(`moved:${id}`);
    }, MOVED_HIGHLIGHT_MS);
    timers.current.set(`moved:${id}`, next);
  };

  const announceMoved = (id: string): void => {
    // Read the POST-move rows from the live signal — the write is optimistic, so
    // by the time the promise settles the store already shows the new order.
    const latest = selectView(state.value, view, { today: today.value });
    const idsNow = latest.rows.flatMap((row) => (row.type === 'task' ? [row.task.id] : []));
    const position = idsNow.indexOf(id) + 1;
    const listName = state.value.lists.get(view.kind === 'list' ? view.listId : '')?.name ?? '';
    announce(t('a11y.taskMoved', { position, total: idsNow.length, list: listName }));
    flashMoved(id);
  };

  /** Keyboard/menu move (§8.2): one position per press; boundaries announce, never move. */
  const onMove = (id: string, delta: MoveDelta): void => {
    if (view.kind !== 'list' || sortMode.value === 'priority') {
      // D1: aggregate/search views derive their order — the alternative is Move to
      // list. Priority sort is equally derived (S3), so manual reorder is off there.
      announce(t('a11y.reorderUnavailable'));
      return;
    }
    const index = taskIds.indexOf(id);
    if (index < 0) return;
    const target =
      delta === 'top'
        ? 0
        : delta === 'bottom'
          ? taskIds.length - 1
          : Math.max(0, Math.min(taskIds.length - 1, index + delta));
    if (target === index) {
      announce(
        t('a11y.reorderBoundary', {
          edge: delta === -1 || delta === 'top' ? t('common.top') : t('common.bottom'),
        }),
      );
      return;
    }
    // One order-key write for the new position (§5.7 — never a renumbering).
    const position: TaskPosition =
      delta === 'top'
        ? 'first'
        : delta === 'bottom'
          ? 'last'
          : delta === -1
            ? taskIds[index - 2] === undefined
              ? 'first'
              : { afterId: taskIds[index - 2] as string }
            : { afterId: taskIds[index + 1] as string };
    void moveTaskTo(id, view.listId, position).then((result) => {
      if (result.ok) announceMoved(id);
    });
  };

  /** Drag drop onto a row position (§8.1) — same single write + announcement. */
  const onMoveTo = (id: string, position: TaskPosition): void => {
    if (view.kind !== 'list') return;
    void moveTaskTo(id, view.listId, position).then((result) => {
      if (result.ok) announceMoved(id);
    });
  };

  /** Desktop drag onto a sidebar list (§8.1 extra) = move-to-list (F11 via pointer). */
  const onDropOnList = (id: string, listId: string): void => {
    const task = storeState.tasks.get(id);
    const target = storeState.lists.get(listId);
    if (task === undefined || target === undefined) return;
    // §8.1 says the sidebar drop "executes F11 semantics", and F11 excludes the
    // task's CURRENT list as a target (F11.1 / §16-35): dropping on it changes
    // nothing — a cancel, never a reorder to the bottom of its own list
    // (review R1 B2; the drag layer already withholds the highlight).
    if (task.listId === listId) {
      announce(t('a11y.reorderCancelled'));
      return;
    }
    void moveTaskTo(id, listId, 'last').then((result) => {
      if (result.ok) {
        announce(
          t('a11y.taskMovedToList', {
            title: task.title,
            list: target.name,
          }),
        );
      }
    });
  };

  const confirmMoveToList = (targetListId: string): void => {
    const task = movingId === null ? undefined : storeState.tasks.get(movingId);
    setMovingId(null);
    if (task === undefined) return;
    const target = storeState.lists.get(targetListId);
    if (target === undefined) return;
    void moveTaskTo(task.id, targetListId, 'last').then((result) => {
      if (result.ok) {
        announce(t('a11y.taskMovedToList', { title: task.title, list: target.name }));
        // No selector interpolation for the id (review N6) — scan the dataset.
        const row = [...document.querySelectorAll<HTMLElement>('[data-task-id]')].find(
          (element) => element.dataset['taskId'] === task.id,
        );
        row?.focus();
      }
    });
  };

  /* --------------------------------- chrome --------------------------------- */

  const header = (
    <View title={title}>
      {phase === 'ready' && view.kind !== 'search' ? (
        <p class="view-count">
          {t('view.count', { count: view.kind === 'completed' ? taskCount : result.counts.open })}
        </p>
      ) : null}
    </View>
  );

  // S1 tag filter + S3 sort toolbar (choices are session-scoped store signals so
  // they survive view switches; `resetTaskStore` clears them).
  const tagUsage = allTags(storeState);
  const toolbar =
    phase === 'ready' && view.kind !== 'search' && listResolved ? (
      <div class="view-toolbar" data-testid="view-toolbar">
        <label class="view-toolbar-field">
          <span class="field-label">{t('tags.filter.label')}</span>
          <select
            class="select"
            data-testid="tag-filter"
            value={tagFilter.value ?? ''}
            onChange={(event) => {
              const next = event.currentTarget.value;
              tagFilter.value = next === '' ? null : next;
            }}
          >
            <option value="">{t('tags.filter.all')}</option>
            {tagUsage.map((tag) => (
              <option key={tag.name} value={tag.name}>
                {`${tag.name} (${String(tag.count)})`}
              </option>
            ))}
          </select>
        </label>
        <label class="view-toolbar-field">
          <span class="field-label">{t('sort.label')}</span>
          <select
            class="select"
            data-testid="sort-mode"
            value={sortMode.value}
            onChange={(event) => {
              sortMode.value = event.currentTarget.value === 'priority' ? 'priority' : 'manual';
            }}
          >
            <option value="manual">{t('sort.manual')}</option>
            <option value="priority">{t('sort.priority')}</option>
          </select>
        </label>
        <button
          type="button"
          class="button button-secondary"
          onClick={() => {
            setManagingTags(true);
          }}
        >
          {t('tags.manage')}
        </button>
      </div>
    ) : null;

  let body: JSX.Element;
  if (phase === 'loading' || phase === 'idle') {
    body = <SkeletonList />;
  } else if (phase === 'error') {
    body = <BootErrorPanel />;
  } else if (!listResolved) {
    body = <SkeletonList />;
  } else if (taskCount === 0) {
    body = (
      <EmptyState
        icon={emptyIcon}
        title={emptyTitle}
        body={emptyBody}
        actionLabel={t('task.action.add')}
        onAction={() => {
          // Route through the same seam as the FAB: focus the inline composer (wide)
          // or open the sheet (compact).
          startQuickAdd();
        }}
      />
    );
  } else {
    body = (
      <TaskList
        rows={rows}
        ariaLabel={title}
        today={day}
        lists={lists}
        showListBadge={showListBadge}
        retainedIds={retained.map((entry) => entry.id)}
        reorderable={view.kind === 'list' && sortMode.value !== 'priority'}
        movedId={movedId}
        onToggle={onToggle}
        onOpen={onOpen}
        onDelete={onDelete}
        onMove={onMove}
        onMoveTo={onMoveTo}
        onMoveToList={(id) => {
          setMovingId(id);
        }}
        onDropOnList={onDropOnList}
        onDragCancel={() => {
          announce(t('a11y.reorderCancelled'));
        }}
      />
    );
  }

  return (
    <>
      {header}
      {toolbar}
      {phase === 'ready' && wide && listResolved ? <Composer variant="inline" /> : null}
      {body}

      {editingTask !== undefined ? (
        <TaskEditor
          key={editingTask.id}
          task={editingTask}
          lists={lists}
          onNavigate={onOpen}
          onClose={() => {
            setEditing(null);
          }}
        />
      ) : null}

      {movingTask !== undefined ? (
        <MoveToListDialog
          task={movingTask}
          lists={lists}
          onMove={confirmMoveToList}
          onCancel={() => {
            setMovingId(null);
          }}
        />
      ) : null}

      {confirmingTask !== undefined ? (
        <TaskDeleteDialog
          task={confirmingTask}
          onConfirm={confirmDelete}
          onCancel={() => {
            setConfirmingId(null);
          }}
        />
      ) : null}

      {managingTags ? (
        <TagsManageDialog
          onClose={() => {
            setManagingTags(false);
          }}
        />
      ) : null}
    </>
  );
}

/** Small helper so the list view can flip its own resolution state. */
export function useResolvedList(listId: string): boolean {
  const storeState = state.value;
  const phase = status.value;
  const exists = storeState.lists.has(listId);
  const [resolved, setResolved] = useState(true);

  // Deep link to a list that does not exist (or was deleted concurrently): redirect to
  // Today with a polite announcement (§14 per-list error row).
  useEffect(() => {
    if (phase !== 'ready' || exists) return;
    // Guard: only redirect while THIS route is still the active hash — the user may
    // already have navigated on between render and this effect (never stomp a new route).
    if (!window.location.hash.includes(encodeURIComponent(listId))) return;
    setResolved(false);
    announce(t('error.taskGone'));
    window.location.hash = '#/today';
  }, [phase, exists, listId]);

  return resolved;
}
