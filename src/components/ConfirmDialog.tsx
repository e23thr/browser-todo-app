/**
 * Confirm dialog (design core-domain S7 — S7.1 delete task, S7.2 delete list with
 * task disposition, S7.3 discard changes).
 *
 * Shared shell per §7: title `h2`, body `aria-describedby`, actions right-aligned
 * (stacked full-width on mobile), **initial focus on Cancel** for destructive confirms,
 * `Escape`/scrim = Cancel, focus trap (Dialog), focus returns to the trigger on close.
 * Confirm buttons always carry a verb label (never a bare "OK").
 *
 * `extra="delete-list-disposition"` renders the required radio group of F6/S7.2:
 * option A ("Move tasks to another list" + nested target select) and option B
 * ("Also delete N tasks", danger tone). Confirm stays disabled until the disposition
 * is valid — option A needs a live target that is not the list being deleted.
 */

import { useId, useState } from 'preact/hooks';
import type { JSX } from 'preact';

import { t } from '../app/i18n';
import { Dialog } from './Dialog';

/** What the caller must execute when the disposition dialog confirms. */
export type DispositionValue =
  { readonly mode: 'move'; readonly targetListId: string } | { readonly mode: 'delete' };

export interface ConfirmDialogProps {
  readonly titleKey: string;
  readonly bodyKey: string;
  readonly params?: Readonly<Record<string, string | number>>;
  readonly confirmKey: string;
  readonly cancelKey?: string;
  readonly tone: 'danger' | 'neutral';
  readonly initialFocus?: 'cancel' | 'confirm';
  readonly extra?: 'delete-list-disposition';
  /** Live lists offered as move targets (already excludes the list being deleted). */
  readonly lists?: readonly { readonly id: string; readonly name: string }[];
  /** Total tasks affected by disposition option B (`confirm.deleteList.deleteTasks`). */
  readonly deleteCount?: number;
  /** Confirm in flight (S7 loading: confirm disabled while the transaction runs). */
  readonly busy?: boolean;
  readonly onConfirm: (value?: DispositionValue) => void;
  readonly onCancel: () => void;
}

export function ConfirmDialog({
  titleKey,
  bodyKey,
  params,
  confirmKey,
  cancelKey,
  tone,
  initialFocus = 'cancel',
  extra,
  lists,
  deleteCount = 0,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): JSX.Element {
  const bodyId = useId();
  const groupName = useId();

  // S7.2: option A (move) is the default WHEN another list exists; otherwise the only
  // valid choice is option B, preselected so Confirm is never permanently disabled.
  const targets = lists ?? [];
  const [mode, setMode] = useState<'move' | 'delete'>(targets.length > 0 ? 'move' : 'delete');
  const [targetId, setTargetId] = useState<string>(targets[0]?.id ?? '');

  const disposition = extra === 'delete-list-disposition';
  const valid =
    !disposition ||
    mode === 'delete' ||
    (targetId !== '' && targets.some((l) => l.id === targetId));

  const bodyParams: Readonly<Record<string, string | number>> = {
    ...(params ?? {}),
    ...(disposition ? { count: deleteCount } : {}),
  };

  const confirm = (): void => {
    if (!valid || busy) return;
    onConfirm(
      disposition ? (mode === 'move' ? { mode, targetListId: targetId } : { mode }) : undefined,
    );
  };

  const footer = (
    <>
      <button
        type="button"
        class="button button-secondary"
        {...(initialFocus === 'cancel' ? { 'data-autofocus': '' } : {})}
        onClick={onCancel}
      >
        {cancelKey === undefined ? t('common.cancel') : t(cancelKey)}
      </button>
      <button
        type="button"
        class={tone === 'danger' ? 'button button-danger' : 'button button-primary'}
        disabled={!valid || busy}
        {...(initialFocus === 'confirm' ? { 'data-autofocus': '' } : {})}
        onClick={confirm}
      >
        {t(confirmKey, bodyParams)}
      </button>
    </>
  );

  return (
    <Dialog title={t(titleKey)} describedById={bodyId} onClose={onCancel} footer={footer}>
      <p id={bodyId} class="dialog-text">
        {t(bodyKey, bodyParams)}
      </p>

      {disposition ? (
        <div class="disposition">
          <label class={`disposition-option${targets.length === 0 ? ' is-disabled' : ''}`}>
            <input
              type="radio"
              name={groupName}
              value="move"
              checked={mode === 'move'}
              disabled={targets.length === 0}
              onChange={() => {
                setMode('move');
              }}
            />
            <span>{t('confirm.deleteList.moveTasks')}</span>
          </label>

          {mode === 'move' && targets.length > 0 ? (
            <label class="field disposition-target">
              <span class="field-label">{t('confirm.deleteList.moveTarget')}</span>
              <select
                class="select"
                value={targetId}
                onChange={(event) => {
                  setTargetId(event.currentTarget.value);
                }}
              >
                {targets.map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label class="disposition-option disposition-option-danger">
            <input
              type="radio"
              name={groupName}
              value="delete"
              checked={mode === 'delete'}
              onChange={() => {
                setMode('delete');
              }}
            />
            <span>{t('confirm.deleteList.deleteTasks', { count: deleteCount })}</span>
          </label>

          {targets.length === 0 ? (
            <p class="field-hint">{t('confirm.deleteList.noTarget')}</p>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
