/**
 * Move-to-list dialog (design F11, §9.6, checklist item 35) — the "move into"
 * command for every view (D2: flat model, no nesting — moving into a list is a
 * membership change: one single-record write, ADR-003 Decision 4).
 *
 * Semantics: a real radio group (native radios in a labelled group) so `↑`/`↓`
 * move + select and `Enter` picks the focused option (§9.6); the options are
 * rendered by the browser's own radio keyboard model (same as S7.2's
 * disposition group). The task's CURRENT list is marked as current and is not
 * a target (F11.1). Initial focus lands on the first option (`data-autofocus`);
 * `Escape`/scrim/Cancel close; focus returns to the row menu trigger (Dialog).
 * On confirm the task moves to the chosen list at the end of its order and
 * `a11y.taskMovedToList {title} {list}` is announced (F11.2).
 */

import { useId, useState } from 'preact/hooks';
import type { JSX } from 'preact';

import { t } from '../../app/i18n';
import { Dialog } from '../../components/Dialog';
import type { List, Task } from '../../domain/model';

export interface MoveToListDialogProps {
  readonly task: Task;
  readonly lists: readonly List[];
  readonly onMove: (targetListId: string) => void;
  readonly onCancel: () => void;
}

export function MoveToListDialog({
  task,
  lists,
  onMove,
  onCancel,
}: MoveToListDialogProps): JSX.Element {
  const groupId = useId();
  const targets = lists.filter((list) => list.id !== task.listId);
  const [targetId, setTargetId] = useState<string>(targets[0]?.id ?? '');
  const currentName = lists.find((list) => list.id === task.listId)?.name ?? '';

  const footer = (
    <>
      <button
        type="button"
        class="button button-secondary"
        onClick={() => {
          onCancel();
        }}
      >
        {t('common.cancel')}
      </button>
      <button
        type="button"
        class="button button-primary"
        disabled={targetId === ''}
        onClick={() => {
          if (targetId !== '') onMove(targetId);
        }}
      >
        {t('task.action.moveToList')}
      </button>
    </>
  );

  return (
    <Dialog title={t('task.action.moveToList')} onClose={onCancel} footer={footer}>
      <div class="disposition" role="radiogroup" aria-labelledby={groupId}>
        <span id={groupId} class="visually-hidden">
          {t('confirm.deleteList.moveTarget')}
        </span>
        {targets.map((list, index) => (
          <label key={list.id} class="disposition-option">
            <input
              type="radio"
              name={groupId}
              value={list.id}
              checked={targetId === list.id}
              {...(index === 0 ? { 'data-autofocus': '' } : {})}
              onChange={() => {
                setTargetId(list.id);
              }}
            />
            <span class="list-dot" style={{ background: list.color }} aria-hidden="true" />
            <span>{list.name}</span>
          </label>
        ))}
        {currentName !== '' ? (
          <p class="field-hint">{`${t('confirm.deleteList.moveTarget')}: ${currentName}`}</p>
        ) : null}
        {targets.length === 0 ? <p class="field-hint">{t('confirm.deleteList.noTarget')}</p> : null}
      </div>
    </Dialog>
  );
}
