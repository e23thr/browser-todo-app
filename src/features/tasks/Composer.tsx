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
import type { FlushOutcome } from '../../app/update';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import type { List, Priority } from '../../domain/model';
import { ListDialog } from '../lists/ListDialog';
import { DateField, ListSelect, PriorityField, TagsField } from './fields';
import { useEditSession } from './editSession';
import { addList, addTask, lastUsedListId, liveLists, state } from './store';
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
  const [priority, setPriority] = useState<Priority>('P4');
  const [tags, setTags] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [creatingList, setCreatingList] = useState(false);

  const storeState = state.value;
  const lists: List[] = liveLists(storeState);
  const hasLists = lists.length > 0;

  // Default list (F1.4 / §16-14): the durable `defaultListId`, else the LAST-USED list,
  // else the first live list — each only while it still exists (a deleted default or a
  // last-used list from before a wipe must not win over a live one).
  const configuredDefault = storeState.settings?.defaultListId ?? null;
  const fallbackListId =
    [configuredDefault, lastUsedListId.value].find(
      (candidate) => candidate !== null && lists.some((list) => list.id === candidate),
    ) ??
    lists[0]?.id ??
    '';
  const [listId, setListId] = useState<string | null>(null);
  const effectiveListId =
    listId !== null && lists.some((list) => list.id === listId) ? listId : fallbackListId;

  const contentDirty =
    title.trim() !== '' ||
    notes.trim() !== '' ||
    due !== null ||
    priority !== 'P4' ||
    tags.length > 0;
  // A LIST-ONLY pick is a draft too (review N2): the S7.3 close paths must ask before
  // dropping it. It cannot be flushed (no title), so the discard confirm is its exit.
  const dirty = contentDirty || (listId !== null && listId !== fallbackListId);

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
    setPriority('P4');
    setTags([]);
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
      tags,
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

  /**
   * Durable commit of the in-flight draft (ADR-005 Decision 7 rule 2): the update flow's
   * Apply awaits this ADR-002 write BEFORE its single deliberate reload, and a failure
   * aborts that reload with the draft untouched. `addTask` resolves when the committing
   * transaction has acked `Ok` or rolled back — that ack IS the `edit-persisted` boundary;
   * unlike `submit` (D6: clear synchronously so Enter stays capture-speed) this path never
   * optimistically clears: the fields are emptied only after the durable ack, so there is
   * no window in which the typed draft exists nowhere. A draft with no title cannot become
   * a task, so it is refused (`{ok:false}`) rather than dropped under the reload.
   */
  const commitDraft = async (): Promise<FlushOutcome> => {
    const trimmed = title.trim();
    if (trimmed === '' || !hasLists) return { ok: false };
    const result = await addTask({
      title: trimmed,
      notes: notes.trim() === '' ? null : notes,
      dueDate: due,
      listId: effectiveListId,
      priority,
      tags,
    });
    if (!result.ok) return { ok: false };
    resetFields();
    setError(null);
    announce(t('a11y.taskAdded', { title: trimmed }));
    return { ok: true };
  };

  // A dirty draft IS an in-flight edit (Decision 7): it ends when the draft is committed
  // (flush or Enter), discarded, or the composer unmounts — all of which make it clean.
  useEditSession(dirty, commitDraft);

  const performClose = (): void => {
    resetFields();
    setError(null);
    setExpanded(false);
    setDiscarding(false);
    // The explicit list pick goes back to the fallback too, or a discarded list-only
    // draft would stay dirty and re-ask on the next close (review N2).
    setListId(null);
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

      <TagsField value={tags} onChange={setTags} />
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
      // §16-17 / S7.3: a composer close discards a DRAFT, so it asks the register's
      // `confirm.discardDraft` variant (review N2 — it was never used before).
      titleKey="confirm.discard.discardDraft"
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
          {!hasLists ? noLists : null}
          {titleField}
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
          {!hasLists ? noLists : null}
          {titleField}
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
