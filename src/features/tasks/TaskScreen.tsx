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
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState, View } from '../../components/View';
import type { Task } from '../../domain/model';
import { selectView, type ViewId, type ViewRow } from '../../domain/views';
import type { IconName } from '../../app/icons';
import { Composer } from './Composer';
import { TaskEditor } from './TaskEditor';
import { TaskList } from './TaskList';
import {
  deleteTask,
  liveLists,
  setTaskDone,
  state,
  status,
  today,
  bootError,
  startTaskStore,
} from './store';
import { resetBootSingleton } from '../../storage/boot';

/** Rows just completed stay visible this long so the user sees what they checked (F3). */
export const RETAIN_COMPLETED_MS = 900;

type Retained = { readonly id: string; readonly anchor: string | null };

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

function ErrorPanel(): JSX.Element {
  return (
    <div class="error-panel" role="alert" data-testid="boot-error">
      <h2>{t('error.boot.title')}</h2>
      <p>{t('error.boot.body')}</p>
      <div class="error-actions">
        <button
          type="button"
          class="button button-primary"
          onClick={() => {
            resetBootSingleton();
            void startTaskStore();
          }}
        >
          {t('common.retry')}
        </button>
        <a class="button button-secondary" href="#/settings">
          {t('settings.storage')}
        </a>
      </div>
      {bootError.value !== null ? (
        <p class="error-code" data-testid="boot-error-code">
          {bootError.value.code}
        </p>
      ) : null}
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
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

  const result = selectView(storeState, view, { today: day });
  const rows = withRetained(result.rows, retained, storeState.tasks);
  const taskCount = rows.flatMap((row) => (row.type === 'task' ? [row] : [])).length;
  const showListBadge = view.kind !== 'list';
  const editingTask = editingId === null ? undefined : storeState.tasks.get(editingId);
  const confirmingTask = confirmingId === null ? undefined : storeState.tasks.get(confirmingId);

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
    setEditingId(id);
  };

  const onDelete = (id: string): void => {
    setConfirmingId(id);
  };

  const confirmDelete = (): void => {
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
    setEditingId(null);
    void deleteTask(task.id).then((result) => {
      if (result.ok) announce(t('a11y.taskDeleted'));
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

  let body: JSX.Element;
  if (phase === 'loading' || phase === 'idle') {
    body = <SkeletonList />;
  } else if (phase === 'error') {
    body = <ErrorPanel />;
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
        onToggle={onToggle}
        onOpen={onOpen}
        onDelete={onDelete}
      />
    );
  }

  return (
    <>
      {header}
      {phase === 'ready' && wide && listResolved ? <Composer variant="inline" /> : null}
      {body}

      {editingTask !== undefined ? (
        <TaskEditor
          task={editingTask}
          lists={lists}
          onClose={() => {
            setEditingId(null);
          }}
        />
      ) : null}

      {confirmingTask !== undefined ? (
        <ConfirmDialog
          titleKey="confirm.deleteTask.title"
          bodyKey="confirm.deleteTask.body"
          params={{ title: confirmingTask.title }}
          confirmKey="confirm.deleteTask.confirm"
          tone="danger"
          onConfirm={confirmDelete}
          onCancel={() => {
            setConfirmingId(null);
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
    setResolved(false);
    announce(t('error.taskGone'));
    window.location.hash = '#/today';
  }, [phase, exists]);

  return resolved;
}
