/**
 * Quick-add composer (design §7 S3, flow F1, keyboard §9.4).
 *
 * Capture-speed contract (JTBD "< 5 seconds"): `Enter` saves and STAYS ready (D6) —
 * the title field clears synchronously so exactly one task is created per keypress and
 * the next capture can start before the write settles (optimistic, §5.6). `Shift+Enter`
 * (title, expanded) saves and collapses; `Escape` collapses/clears, asking the discard
 * confirm (S7.3) when the draft is dirty.
 *
 * Variants: `inline` (wide screens — the block at the top of the main pane) and `sheet`
 * (compact — the bottom sheet the FAB opens; a real modal Dialog with a sticky action
 * row so `Add` stays reachable above the on-screen keyboard). Both render the same
 * fields; only the chrome differs.
 *
 * States: collapsed / expanded / focused / submitting (invisible ≤ 3 s) / error
 * (`form.error.titleRequired` linked with `aria-describedby`) / disabled (zero lists —
 * inputs off, `composer.needsList` hint + a `list.action.new` button).
 */

import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { JSX, TargetedEvent } from 'preact';

import { announce } from '../../app/announce';
import { t } from '../../app/i18n';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import type { List, Priority } from '../../domain/model';
import { ListDialog } from '../lists/ListDialog';
import { DateField, ListSelect, PriorityField } from './fields';
import { addList, addTask, liveLists, state } from './store';
import { Dialog } from '../../components/Dialog';

/**
 * Seam for the shell's quick-add entry points (FAB, empty-state actions): the inline
 * composer registers its focus routine while mounted on a wide screen, so
 * `startQuickAdd()` focuses the real input instead of opening the sheet.
 */
export const inlineComposerFocus: { current: (() => void) | null } = { current: null };

export interface ComposerProps {
  readonly variant: 'inline' | 'sheet';
  /** Sheet only: close the sheet (its own close paths call this). */
  readonly onClose?: () => void;
}

export function Composer({ variant, onClose }: ComposerProps): JSX.Element {
  const uid = useId();
  const errId = `${uid}-err`;
  const titleId = `${uid}-title`;
  const titleRef = useRef<HTMLInputElement | null>(null);

  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [due, setDue] = useState<string | null>(null);
  const [priority, setPriority] = useState<Priority>(0);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [creatingList, setCreatingList] = useState(false);

  const storeState = state.value;
  const lists: List[] = liveLists(storeState);
  const hasLists = lists.length > 0;

  // Default list: the durable default-list setting, else the first live list (F1.4).
  const configuredDefault = storeState.settings?.defaultListId ?? null;
  const [listId, setListId] = useState<string | null>(null);
  const effectiveListId =
    listId !== null && lists.some((list) => list.id === listId)
      ? listId
      : configuredDefault !== null && lists.some((list) => list.id === configuredDefault)
        ? configuredDefault
        : (lists[0]?.id ?? '');

  const dirty = title.trim() !== '' || notes.trim() !== '' || due !== null || priority !== 0;

  // Wide screens: the quick-add seam points at THIS input (FAB/empty-state → focus,
  // no sheet). Compact screens register nothing, so quick-add opens the sheet instead.
  useEffect(() => {
    if (variant !== 'inline') return;
    inlineComposerFocus.current = () => {
      titleRef.current?.focus();
    };
    return () => {
      inlineComposerFocus.current = null;
    };
  }, [variant]);

  const resetFields = (): void => {
    setTitle('');
    setNotes('');
    setDue(null);
    setPriority(0);
  };

  const focusTitle = (): void => {
    titleRef.current?.focus();
  };

  const submit = (collapse: boolean): void => {
    const trimmed = title.trim();
    if (trimmed === '') {
      setError('form.error.titleRequired');
      return;
    }
    if (!hasLists) return;

    const input = {
      title: trimmed,
      notes: notes.trim() === '' ? null : notes,
      dueDate: due,
      listId: effectiveListId,
      priority,
    };
    const typedTitle = trimmed;
    const typedNotes = input.notes;

    // Clear synchronously: one Enter = one task, and the field is ready again now.
    resetFields();
    setError(null);
    if (collapse) setExpanded(false);

    void addTask(input).then((result) => {
      if (result.ok) {
        announce(t('a11y.taskAdded', { title: typedTitle }));
        focusTitle();
        return;
      }
      // Failure: the pipeline rolled the row back — preserve what was typed (S3 error
      // state) unless the user has already started the next capture.
      setTitle((current) => (current === '' ? typedTitle : current));
      setNotes((current) => (current === '' && typedNotes !== null ? typedNotes : current));
      focusTitle();
    });
  };

  const performClose = (): void => {
    resetFields();
    setError(null);
    setExpanded(false);
    setDiscarding(false);
    onClose?.();
  };

  const requestClose = (): void => {
    if (dirty) {
      setDiscarding(true);
      return;
    }
    performClose();
  };

  const onTitleKeyDown = (event: TargetedEvent<HTMLInputElement, KeyboardEvent>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit(event.shiftKey && expanded);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (dirty) setDiscarding(true);
      else if (expanded) setExpanded(false);
      else onClose?.();
    }
  };

  const titleField = (
    <div class="field composer-title-field">
      <label class="field-label" htmlFor={titleId}>
        {t('composer.label.title')}
      </label>
      <input
        id={titleId}
        ref={titleRef}
        class="input"
        type="text"
        maxlength={200}
        placeholder={t('composer.placeholder')}
        value={title}
        disabled={!hasLists}
        data-autofocus=""
        aria-describedby={error !== null ? errId : undefined}
        aria-invalid={error !== null ? 'true' : undefined}
        onInput={(event) => {
          setTitle(event.currentTarget.value);
          if (error !== null) setError(null);
        }}
        onKeyDown={onTitleKeyDown}
      />
      {error !== null ? (
        <p class="field-error" id={errId} role="alert">
          {t(error)}
        </p>
      ) : null}
    </div>
  );

  const detailFields = expanded ? (
    <>
      <div class="field">
        <label class="field-label" htmlFor={`${uid}-notes`}>
          {t('composer.label.notes')}
        </label>
        <textarea
          id={`${uid}-notes`}
          class="input textarea"
          rows={3}
          maxlength={20000}
          value={notes}
          disabled={!hasLists}
          onInput={(event) => {
            setNotes(event.currentTarget.value);
          }}
        />
      </div>

      <DateField value={due} onChange={setDue} />

      <ListSelect
        lists={lists}
        value={effectiveListId}
        onChange={setListId}
        onCreateList={() => {
          setCreatingList(true);
        }}
      />

      <PriorityField value={priority} onChange={setPriority} />
    </>
  ) : null;

  const addButton = (
    <button
      type="button"
      class="button button-primary composer-add"
      disabled={!hasLists || title.trim() === ''}
      onClick={() => {
        submit(false);
      }}
    >
      {t('composer.add')}
    </button>
  );

  const expander = (
    <button
      type="button"
      class="button button-ghost composer-expander"
      aria-expanded={expanded}
      disabled={!hasLists}
      onClick={() => {
        setExpanded((was) => !was);
      }}
    >
      {expanded ? t('composer.hideDetails') : t('composer.details')}
    </button>
  );

  const noLists = (
    <div class="composer-nolist">
      <p role="status">{t('composer.needsList')}</p>
      <button
        type="button"
        class="button button-secondary"
        onClick={() => {
          setCreatingList(true);
        }}
      >
        {t('list.action.new')}
      </button>
    </div>
  );

  const discardConfirm = discarding ? (
    <ConfirmDialog
      titleKey="confirm.discard.title"
      bodyKey="confirm.discard.body"
      confirmKey="confirm.discard.confirm"
      cancelKey="confirm.discard.keepEditing"
      tone="danger"
      onConfirm={performClose}
      onCancel={() => {
        setDiscarding(false);
        focusTitle();
      }}
    />
  ) : null;

  const listDialog = creatingList ? (
    <ListDialog
      mode="create"
      validate={(name) => {
        const trimmed = name.trim();
        if (trimmed === '') return 'list.error.nameRequired';
        if (trimmed.length > 60) return 'list.error.nameTooLong';
        const clash = lists.some(
          (list) => list.name.trim().toLowerCase() === trimmed.toLowerCase(),
        );
        return clash ? 'list.error.duplicateName' : null;
      }}
      onSave={(value) => {
        setCreatingList(false);
        void addList(value).then((result) => {
          if (result.ok) {
            setListId(result.value.id);
            announce(t('a11y.listCreated', { list: result.value.name }));
            focusTitle();
          }
        });
      }}
      onCancel={() => {
        setCreatingList(false);
        focusTitle();
      }}
    />
  ) : null;

  if (variant === 'sheet') {
    return (
      <>
        <Dialog
          label={t('task.action.add')}
          panelClass="composer-sheet"
          onClose={requestClose}
          footer={
            <>
              {expander}
              {addButton}
            </>
          }
        >
          {!hasLists ? noLists : titleField}
          {detailFields}
        </Dialog>
        {discardConfirm}
        {listDialog}
      </>
    );
  }

  return (
    <section class="composer composer-inline" aria-label={t('task.action.add')}>
      <div class="composer-row">
        <div class="composer-fields">
          {!hasLists ? noLists : titleField}
          {detailFields}
        </div>
        {expander}
        {addButton}
      </div>
      {discardConfirm}
      {listDialog}
    </section>
  );
}
