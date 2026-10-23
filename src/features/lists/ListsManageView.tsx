/**
 * Lists management (design §7 S6, flows F5/F6) — create, rename, reorder, delete
 * with task disposition.
 *
 * Keyboard (§8.2, first-class): each list row is focusable; `Alt+↑`/`Alt+↓` move it one
 * position with an `a11y.listMoved` announcement, boundaries are no-ops announced as
 * `a11y.reorderBoundary`, and the row menu's Move up / Move down items mirror the same
 * commands as 44 px buttons (`aria-disabled` at the ends). Reorder writes a single
 * record through the domain pipeline (one order-key write per move).
 *
 * Delete (F6 / S7.2) is the required confirm: counts, a disposition radio group
 * (move tasks to another list / delete them too), one transaction, then
 * `a11y.listDeleted {count}` and focus back on the heading or the next row.
 *
 * Rename: wide screens get the ListDialog (F5.2), compact screens rename inline
 * (Enter/blur saves, Escape cancels, D10 errors shown in place).
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX, TargetedEvent } from 'preact';

import { announce } from '../../app/announce';
import { t } from '../../app/i18n';
import { useMediaQuery, WIDE_QUERY } from '../../app/media';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState, View } from '../../components/View';
import type { List } from '../../domain/model';
import { ListDialog, makeListNameValidator } from './ListDialog';
import { RowMenu } from '../tasks/RowMenu';
import {
  addList,
  canMoveList,
  liveLists,
  moveList,
  recolorList,
  removeList,
  renameList,
  state,
  status,
} from '../tasks/store';

type TaskLike = { readonly listId: string; readonly status: string };

function countWhere(
  storeState: { readonly tasks: ReadonlyMap<string, TaskLike> },
  listId: string,
  statusWanted: string,
): number {
  let count = 0;
  for (const task of storeState.tasks.values()) {
    if (task.listId === listId && task.status === statusWanted) count += 1;
  }
  return count;
}

function focusViewHeading(): void {
  document.querySelector<HTMLElement>('main [data-view-title]')?.focus();
}

type DialogState =
  { readonly kind: 'create' } | { readonly kind: 'rename'; readonly id: string } | null;

export function ListsManageView(): JSX.Element {
  const wide = useMediaQuery(WIDE_QUERY);
  const storeState = state.value;
  const phase = status.value;
  const lists: List[] = liveLists(storeState);

  const [dialog, setDialog] = useState<DialogState>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmDone = useRef(false);

  const confirming =
    confirmingId === null ? null : (lists.find((l) => l.id === confirmingId) ?? null);

  // Focus follows the deletion: heading when the list is gone, otherwise stays put (F6.3).
  useEffect(() => {
    if (confirmingId === null && confirmDone.current) {
      confirmDone.current = false;
      focusViewHeading();
    }
  }, [confirmingId]);

  const doMove = (id: string, delta: -1 | 1): void => {
    if (!canMoveList(id, delta)) {
      announce(
        t('a11y.reorderBoundary', { edge: delta === -1 ? t('common.top') : t('common.bottom') }),
      );
      return;
    }
    void moveList(id, delta).then((result) => {
      if (result.ok) announce(t('a11y.listMoved'));
      document.querySelector<HTMLElement>(`[data-list-id="${id}"]`)?.focus();
    });
  };

  const onListKeyDown =
    (id: string) =>
    (event: TargetedEvent<HTMLLIElement, KeyboardEvent>): void => {
      if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault();
        doMove(id, event.key === 'ArrowUp' ? -1 : 1);
      }
    };

  const header = <View title={t('list.manage')} />;

  if (phase === 'loading' || phase === 'idle') {
    return (
      <>
        {header}
        <div class="skeleton" aria-busy="true" data-testid="skeleton">
          <p role="status" class="visually-hidden">
            {t('a11y.loading')}
          </p>
          <div class="skeleton-row" />
          <div class="skeleton-row" />
          <div class="skeleton-row" />
        </div>
      </>
    );
  }

  if (phase === 'error') {
    return (
      <>
        {header}
        <div class="error-panel" role="alert" data-testid="boot-error">
          <h2>{t('error.boot.title')}</h2>
          <p>{t('error.boot.body')}</p>
        </div>
      </>
    );
  }

  const renameTarget =
    dialog?.kind === 'rename' ? (lists.find((l) => l.id === dialog.id) ?? undefined) : undefined;
  const openCount = confirming === null ? 0 : countWhere(storeState, confirming.id, 'open');
  const doneCount = confirming === null ? 0 : countWhere(storeState, confirming.id, 'done');

  return (
    <>
      {header}

      <div class="list-actions">
        <button
          type="button"
          class="button button-primary"
          onClick={() => {
            setDialog({ kind: 'create' });
          }}
        >
          {t('list.action.new')}
        </button>
      </div>

      {lists.length === 0 ? (
        <EmptyState
          icon="folder"
          title={t('list.empty.title')}
          body={t('list.empty.body')}
          actionLabel={t('list.action.new')}
          onAction={() => {
            setDialog({ kind: 'create' });
          }}
        />
      ) : (
        <ul class="list-manager" aria-label={t('list.manage')}>
          {lists.map((list) => {
            const count = countWhere(storeState, list.id, 'open');
            return (
              // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- §8.2: keyboard reorder (Alt+↑/↓) lives on the list row itself.
              <li
                key={list.id}
                class="list-row"
                data-list-id={list.id}
                // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- §8.2: every list row is a keyboard-reorder target.
                tabIndex={0}
                onKeyDown={onListKeyDown(list.id)}
              >
                {renamingId === list.id ? (
                  <InlineRename
                    list={list}
                    validator={makeListNameValidator(lists, list.id)}
                    onSave={(value) => {
                      setRenamingId(null);
                      void renameList(list.id, value.name).then((result) => {
                        if (result.ok) announce(t('a11y.listRenamed', { list: value.name }));
                      });
                    }}
                    onCancel={() => {
                      setRenamingId(null);
                      document.querySelector<HTMLElement>(`[data-list-id="${list.id}"]`)?.focus();
                    }}
                  />
                ) : (
                  <>
                    <span class="list-dot" style={{ background: list.color }} aria-hidden="true" />
                    <a class="list-row-link" href={`#/list/${encodeURIComponent(list.id)}`}>
                      <span class="list-row-name">{list.name}</span>
                      <span class="list-row-count">{t('list.item.count', { count })}</span>
                    </a>
                    <RowMenu
                      class="row-actions"
                      label={t('task.rowMenu', { title: list.name })}
                      items={[
                        {
                          key: 'rename',
                          label: t('list.action.rename'),
                          onSelect: () => {
                            if (wide) setDialog({ kind: 'rename', id: list.id });
                            else setRenamingId(list.id);
                          },
                        },
                        {
                          key: 'move-up',
                          label: t('list.action.moveUp'),
                          disabled: !canMoveList(list.id, -1),
                          onSelect: () => {
                            doMove(list.id, -1);
                          },
                        },
                        {
                          key: 'move-down',
                          label: t('list.action.moveDown'),
                          disabled: !canMoveList(list.id, 1),
                          onSelect: () => {
                            doMove(list.id, 1);
                          },
                        },
                        {
                          key: 'delete',
                          label: t('list.action.delete'),
                          danger: true,
                          onSelect: () => {
                            setConfirmingId(list.id);
                          },
                        },
                      ]}
                    />
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {dialog?.kind === 'create' ? (
        <ListDialog
          mode="create"
          validate={makeListNameValidator(lists)}
          onSave={(value) => {
            setDialog(null);
            void addList(value).then((result) => {
              if (result.ok) announce(t('a11y.listCreated', { list: value.name }));
            });
          }}
          onCancel={() => {
            setDialog(null);
          }}
        />
      ) : null}

      {renameTarget !== undefined ? (
        <ListDialog
          mode="rename"
          initial={{ name: renameTarget.name, color: renameTarget.color }}
          validate={makeListNameValidator(lists, renameTarget.id)}
          onSave={(value) => {
            const target = renameTarget;
            setDialog(null);
            void renameList(target.id, value.name).then((result) => {
              if (result.ok) announce(t('a11y.listRenamed', { list: value.name }));
            });
            if (value.color !== target.color) void recolorList(target.id, value.color);
          }}
          onCancel={() => {
            setDialog(null);
          }}
        />
      ) : null}

      {confirming !== null ? (
        <ConfirmDialog
          titleKey="confirm.deleteList.title"
          bodyKey="confirm.deleteList.body"
          params={{ list: confirming.name, openCount, doneCount }}
          confirmKey="confirm.deleteList.confirm"
          tone="danger"
          {...(openCount + doneCount > 0
            ? {
                extra: 'delete-list-disposition' as const,
                lists: lists
                  .filter((l) => l.id !== confirming.id)
                  .map((l) => ({ id: l.id, name: l.name })),
                deleteCount: openCount + doneCount,
              }
            : {})}
          busy={busy}
          onConfirm={(value) => {
            setBusy(true);
            const target = confirming;
            const disposition =
              value !== undefined && value.mode === 'move'
                ? ({ mode: 'move', targetListId: value.targetListId } as const)
                : ({ mode: 'tombstone' } as const);
            void removeList(target.id, disposition).then((result) => {
              setBusy(false);
              confirmDone.current = true;
              setConfirmingId(null);
              if (result.ok) {
                announce(
                  t('a11y.listDeleted', { list: target.name, count: openCount + doneCount }),
                );
              }
            });
          }}
          onCancel={() => {
            if (busy) return;
            setConfirmingId(null);
          }}
        />
      ) : null}
    </>
  );
}

/** Inline rename row (compact, F5.2): Enter/blur saves, Escape cancels. */
function InlineRename({
  list,
  validator,
  onSave,
  onCancel,
}: {
  readonly list: List;
  readonly validator: (name: string) => string | null;
  readonly onSave: (value: { name: string; color: string }) => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const [value, setValue] = useState(list.name);
  const closed = useRef(false);
  const error = validator(value);

  const save = (): void => {
    if (closed.current) return;
    if (error !== null) return; // keep editing: the inline error explains why
    closed.current = true;
    onSave({ name: value.trim(), color: list.color });
  };

  const cancel = (): void => {
    if (closed.current) return;
    closed.current = true;
    onCancel();
  };

  return (
    <div class="inline-rename">
      <input
        class="input"
        type="text"
        maxlength={60}
        value={value}
        aria-label={t('list.dialog.name')}
        aria-invalid={error !== null ? 'true' : undefined}
        onInput={(event) => {
          setValue(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            save();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            cancel();
          }
        }}
        onBlur={() => {
          save();
        }}
      />
      {error !== null ? (
        <p class="field-error" role="alert">
          {t(error)}
        </p>
      ) : null}
    </div>
  );
}
