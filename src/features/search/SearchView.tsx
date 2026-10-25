/**
 * Search (M5, design §7 S5, flow F8) — instant find over title + notes.
 *
 * Filtering is SYNCHRONOUS on `input` through the domain's maintained
 * `SearchIndex` (word-prefix AND, D5; `searchIndexCache` builds lazily on first
 * open and syncs incrementally — no re-scan per keystroke, §5.7 budget < 50 ms
 * at 10k tasks). Results render in the shared `TaskList` with `<mark>`
 * highlighting and the list badge; result rows are fully interactive (complete,
 * edit, delete, `Move to list`) but NEVER reorderable (D1) — `Alt+↑/↓` hears
 * `a11y.reorderUnavailable`.
 *
 * States (§14 + S5): loading skeleton / boot error panel; `idle` (empty query →
 * `search.hint`), `results` (rows + debounced `a11y.searchResults` count, §5.5),
 * `no-results` (`search.empty.title {query}`). `Escape` clears the query, the
 * second press closes the screen (mobile) / returns focus to the trigger
 * (desktop); `↑`/`↓` from the field move into the results (§9.7).
 */

import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';

import { announce } from '../../app/announce';
import { t } from '../../app/i18n';
import { useMediaQuery, WIDE_QUERY } from '../../app/media';
import { EmptyState, View } from '../../components/View';
import type { Task } from '../../domain/model';
import { selectView } from '../../domain/views';
import { TaskEditor } from '../tasks/TaskEditor';
import { MoveToListDialog } from '../tasks/MoveToListDialog';
import { TaskDeleteDialog } from '../tasks/TaskDeleteDialog';
import { TaskList } from '../tasks/TaskList';
import type { EditingTask } from '../tasks/TaskScreen';
import {
  deleteTask,
  liveLists,
  moveTaskTo,
  setTaskDone,
  state,
  status,
  tagFilter,
  today,
} from '../tasks/store';
import { SearchField } from './SearchField';
import { searchIndexFor } from './searchIndexCache';

/** Result-count announcement debounce (§5.5: "debounced 300 ms"). */
export const SEARCH_ANNOUNCE_MS = 300;

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
    </div>
  );
}

export function SearchView(): JSX.Element {
  const wide = useMediaQuery(WIDE_QUERY);
  const storeState = state.value;
  const phase = status.value;
  const day = today.value;
  const lists = liveLists(storeState);

  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<EditingTask | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);

  const trimmed = query.trim();
  const searching = trimmed !== '';
  // One synchronous indexed query per render (D5); the index is maintained
  // incrementally by `searchIndexFor` (build happens lazily on first open).
  const result = searching
    ? selectView(
        storeState,
        { kind: 'search', query: trimmed },
        {
          today: day,
          index: searchIndexFor(storeState),
          // S1: the tag filter chosen on the task screens also narrows search hits.
          ...(tagFilter.value !== null ? { tag: tagFilter.value } : {}),
        },
      )
    : null;
  const count =
    result === null ? 0 : result.rows.flatMap((row) => (row.type === 'task' ? [1] : [])).length;

  // §5.5: the count is announced politely, debounced 300 ms after typing stops.
  useEffect(() => {
    if (!searching) return;
    const timer = setTimeout(() => {
      announce(t('a11y.searchResults', { count, query: trimmed }));
    }, SEARCH_ANNOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [trimmed, count]);

  // Same contract as TaskScreen (§14 `error.taskGone`, E2 F-3): the held last-known task
  // keeps the editor mounted when a concurrent delete evicts the result row, so the dialog
  // flips to its `gone` state instead of unmounting over the user's unsaved edits.
  const editingTask =
    editing === null ? undefined : (storeState.tasks.get(editing.id) ?? editing.task);
  const confirmingTask = confirmingId === null ? undefined : storeState.tasks.get(confirmingId);
  const movingTask = movingId === null ? undefined : storeState.tasks.get(movingId);

  const focusFirstRow = (): void => {
    const row = document.querySelector<HTMLElement>('ul.task-list [data-task-id]');
    row?.focus();
    if (typeof row?.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
  };

  /** F8.3: second Escape — close the pushed screen (mobile) / focus the trigger. */
  const closeSearch = (): void => {
    if (wide) {
      document.querySelector<HTMLElement>('a[href="#/search"]')?.focus();
      return;
    }
    if (window.history.length > 1) window.history.back();
    else window.location.hash = '#/today';
  };

  const header = <View title={t('view.search')} />;

  let body: JSX.Element;
  if (phase === 'loading' || phase === 'idle') {
    body = <SkeletonList />;
  } else if (phase === 'error') {
    body = <ErrorPanel />;
  } else if (!searching) {
    body = <EmptyState icon="search" title={t('view.search')} body={t('search.hint')} />;
  } else if (count === 0) {
    body = (
      <EmptyState
        icon="search"
        title={t('search.empty.title', { query: trimmed })}
        body={t('search.hint')}
      />
    );
  } else {
    body = (
      <TaskList
        rows={result?.rows ?? []}
        ariaLabel={t('search.results.count', { count })}
        today={day}
        lists={lists}
        showListBadge
        highlight={trimmed}
        onToggle={(task: Task, done: boolean) => {
          announce(done ? t('a11y.taskCompleted') : t('a11y.taskReopened'));
          void setTaskDone(task.id, done);
        }}
        onOpen={(id) => {
          const task = storeState.tasks.get(id);
          if (task === undefined) return;
          setEditing({ id, task });
        }}
        onDelete={(id) => {
          setConfirmingId(id);
        }}
        onMove={() => {
          // D1: search results derive their order — the alternative is Move to list.
          announce(t('a11y.reorderUnavailable'));
        }}
        onMoveToList={(id) => {
          setMovingId(id);
        }}
      />
    );
  }

  return (
    <>
      {header}
      {phase === 'ready' ? (
        <SearchField
          value={query}
          onInput={setQuery}
          onClear={() => {
            setQuery('');
          }}
          onEscape={closeSearch}
          onArrowIntoResults={() => {
            focusFirstRow();
          }}
        />
      ) : null}
      {body}

      {editingTask !== undefined ? (
        <TaskEditor
          key={editingTask.id}
          task={editingTask}
          lists={lists}
          onNavigate={(id) => {
            const task = storeState.tasks.get(id);
            if (task === undefined) return;
            setEditing({ id, task });
          }}
          onClose={() => {
            setEditing(null);
          }}
        />
      ) : null}

      {movingTask !== undefined ? (
        <MoveToListDialog
          task={movingTask}
          lists={lists}
          onMove={(targetListId) => {
            const task = movingTask;
            const target = storeState.lists.get(targetListId);
            setMovingId(null);
            if (target === undefined) return;
            void moveTaskTo(task.id, targetListId, 'last').then((moveResult) => {
              if (moveResult.ok) {
                announce(t('a11y.taskMovedToList', { title: task.title, list: target.name }));
              }
            });
          }}
          onCancel={() => {
            setMovingId(null);
          }}
        />
      ) : null}

      {confirmingTask !== undefined ? (
        <TaskDeleteDialog
          task={confirmingTask}
          onConfirm={(disposition) => {
            const task = confirmingTask;
            setConfirmingId(null);
            void deleteTask(task.id, disposition).then((result) => {
              if (result.ok) announce(t('a11y.taskDeleted'));
            });
          }}
          onCancel={() => {
            setConfirmingId(null);
          }}
        />
      ) : null}
    </>
  );
}
