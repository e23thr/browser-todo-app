/**
 * Task editor (design §7 S4, flow F2, keyboard §9.5).
 *
 * Full-field editing in a modal dialog (560 px wide / full-screen sheet on compact via
 * CSS): title, plain-text notes (≤ 20,000 — never markdown-rendered), due date with
 * Today/Tomorrow/Clear chips, list select with "New list…", priority radio group, and —
 * for completed tasks — read-only completion info while staying fully editable.
 *
 * States: pristine / dirty (Save enables) / invalid (`form.error.titleRequired`, Save
 * disabled) / saving (`editor.saving`) / error (dialog stays open; the store's assertive
 * toast carries `error.save.title` + Retry and the text is preserved) / completed-task /
 * taskGone (`error.taskGone`, Save disabled — the task was deleted in another tab).
 *
 * Interaction: Save persists and returns focus to the originating row (Dialog restores
 * it to the trigger); Cancel/Escape while dirty asks the S7.3 discard confirm; Delete
 * opens the S7.1 confirm. `Enter` saves from single-line inputs, `Ctrl/Cmd+Enter` from
 * the notes textarea (§9.5).
 */

import { useEffect, useId, useState } from 'preact/hooks';
import type { JSX, TargetedEvent } from 'preact';

import { announce } from '../../app/announce';
import { t, getLocale } from '../../app/i18n';
import type { FlushOutcome } from '../../app/update';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Dialog } from '../../components/Dialog';
import type { List, Priority, Task } from '../../domain/model';
import { DateField, ListSelect, PriorityField } from './fields';
import { useEditSession } from './editSession';
import { ListDialog } from '../lists/ListDialog';
import { addList, deleteTask, saveTask, state } from './store';

export interface TaskEditorProps {
  readonly task: Task;
  readonly lists: readonly List[];
  readonly onClose: () => void;
}

function sameDay(a: string | null, b: string | undefined): boolean {
  return (a ?? undefined) === b;
}

export function TaskEditor({ task, lists, onClose }: TaskEditorProps): JSX.Element {
  const uid = useId();

  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes ?? '');
  const [due, setDue] = useState<string | null>(task.dueDate ?? null);
  const [listId, setListId] = useState(task.listId);
  const [priority, setPriority] = useState<Priority>(task.priority);
  const [saving, setSaving] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [creatingList, setCreatingList] = useState(false);

  const gone = !state.value.tasks.has(task.id);
  const trimmed = title.trim();
  const invalid = trimmed === '' || trimmed.length > 200;
  const dirty =
    trimmed !== task.title ||
    notes !== (task.notes ?? '') ||
    !sameDay(due, task.dueDate) ||
    listId !== task.listId ||
    priority !== task.priority;

  /**
   * Durable commit of the in-flight edit (ADR-005 Decision 7 rule 2): the update flow's
   * Apply awaits this ADR-002 write BEFORE its single deliberate reload. The store's
   * mutation promise resolves when the committing transaction has acked `Ok` or rolled
   * back, so awaiting it IS the Decision 7 `edit-persisted` boundary.
   *
   * A draft that cannot be saved (empty title — Save is disabled for it) or whose write
   * fails returns `{ok:false}`: the ADR leaves the uncommittable case implicit, and
   * refusing the reload is its E9-safe reading — the edit stays intact in the DOM instead
   * of being destroyed by a reload nothing flushed.
   */
  const commitEdit = async (): Promise<FlushOutcome> => {
    if (invalid || saving || gone) return { ok: false };
    const result = await saveTask(task.id, {
      title: trimmed,
      notes: notes.trim() === '' ? null : notes,
      dueDate: due,
      listId,
      priority,
    });
    return result.ok ? { ok: true } : { ok: false };
  };

  // A dirty edit IS an in-flight edit (Decision 7): it ends when the dialog closes —
  // after a save ack (`Ok`), a discard confirm, or the user confirming the task's
  // removal — all of which make the editor unmount; a failed flush keeps the dialog
  // open with the edit in flight. A task that VANISHES under the dialog (concurrent
  // delete) does NOT end it: the composed screen holds this dialog open in its §14
  // `error.taskGone` state (E2 F-3), so the draft stays visible and still refuses to
  // commit (`commitEdit` returns `{ok:false}` while `gone`), which is exactly the
  // "never flush a write that cannot land" reading of Decision 7.
  useEditSession(dirty, commitEdit);

  // §14 / E2 F-3: this state is reachable in situ because the composed screen keeps the
  // dialog mounted across a concurrent delete. Render the row AND say it in the shell's
  // assertive region (§5.5) — the inline `role="alert"` row is only heard when assistive
  // tech is parked inside the dialog, and the PM decision on F-3 requires the feedback to
  // reach the global alert region. The effect runs on the false→true flip, so a single
  // concurrent delete announces exactly once; a delete the user confirmed from here
  // closes the dialog first and never reaches this branch.
  useEffect(() => {
    if (!gone) return;
    announce(t('error.taskGone'), 'assertive');
  }, [gone]);

  const save = (): void => {
    if (invalid || saving || gone) return;
    setSaving(true);
    void saveTask(task.id, {
      title: trimmed,
      notes: notes.trim() === '' ? null : notes,
      dueDate: due,
      listId,
      priority,
    }).then((result) => {
      setSaving(false);
      if (result.ok) {
        announce(t('a11y.taskSaved'));
        onClose();
      }
      // Failure: keep the dialog open with the user's text (S4 error state); the
      // store already raised the assertive toast with Retry.
    });
  };

  const requestClose = (): void => {
    if (saving) return;
    if (dirty) {
      setDiscarding(true);
      return;
    }
    onClose();
  };

  const onTitleEnter = (event: TargetedEvent<HTMLInputElement, KeyboardEvent>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      save();
    }
  };

  const onNotesEnter = (event: TargetedEvent<HTMLTextAreaElement, KeyboardEvent>): void => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      save();
    }
  };

  const footer = (
    <>
      <button
        type="button"
        class="button button-danger button-start"
        // §14 `error.taskGone`: a remove write on a record that is already evicted can
        // only come back as a false "Your change was undone" — the honest answer is to
        // offer no destructive action at all, alongside the disabled Save.
        disabled={gone}
        onClick={() => {
          setConfirmingDelete(true);
        }}
      >
        {t('editor.delete')}
      </button>
      <button type="button" class="button button-secondary" onClick={requestClose}>
        {t('editor.cancel')}
      </button>
      <button
        type="button"
        class="button button-primary"
        disabled={invalid || saving || gone}
        onClick={save}
      >
        {saving ? t('editor.saving') : t('editor.save')}
      </button>
    </>
  );

  return (
    <>
      <Dialog
        title={t('editor.title.edit')}
        panelClass="task-editor"
        onClose={requestClose}
        footer={footer}
      >
        <form
          class="stack"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          {gone ? (
            <p class="field-error" role="alert">
              {t('error.taskGone')}
            </p>
          ) : null}

          {task.status === 'done' && task.completedAt !== undefined ? (
            <p class="editor-completed" data-testid="completed-on">
              {t('task.completedOn', {
                date: new Intl.DateTimeFormat(getLocale(), {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                }).format(new Date(task.completedAt)),
              })}
            </p>
          ) : null}

          <div class="field">
            <label class="field-label" htmlFor={`${uid}-title`}>
              {t('composer.label.title')}
            </label>
            <input
              id={`${uid}-title`}
              class="input"
              type="text"
              maxlength={200}
              data-autofocus=""
              value={title}
              aria-invalid={invalid ? 'true' : undefined}
              aria-describedby={invalid ? `${uid}-title-err` : undefined}
              onInput={(event) => {
                setTitle(event.currentTarget.value);
              }}
              onKeyDown={onTitleEnter}
            />
            {invalid ? (
              <p class="field-error" id={`${uid}-title-err`} role="alert">
                {trimmed === '' ? t('form.error.titleRequired') : t('form.error.titleTooLong')}
              </p>
            ) : null}
          </div>

          <div class="field">
            <label class="field-label" htmlFor={`${uid}-notes`}>
              {t('composer.label.notes')}
            </label>
            <textarea
              id={`${uid}-notes`}
              class="input textarea"
              rows={5}
              maxlength={20000}
              value={notes}
              onInput={(event) => {
                setNotes(event.currentTarget.value);
              }}
              onKeyDown={onNotesEnter}
            />
          </div>

          <DateField value={due} onChange={setDue} />

          <ListSelect
            lists={lists}
            value={listId}
            onChange={setListId}
            onCreateList={() => {
              setCreatingList(true);
            }}
          />

          <PriorityField value={priority} onChange={setPriority} />

          {/* Hidden submit so Enter in any single-line field saves (§9.5). */}
          <button type="submit" class="visually-hidden" tabIndex={-1} aria-hidden="true">
            {t('editor.save')}
          </button>
        </form>
      </Dialog>

      {discarding ? (
        <ConfirmDialog
          titleKey="confirm.discard.title"
          bodyKey="confirm.discard.body"
          confirmKey="confirm.discard.confirm"
          cancelKey="confirm.discard.keepEditing"
          tone="danger"
          onConfirm={onClose}
          onCancel={() => {
            setDiscarding(false);
          }}
        />
      ) : null}

      {confirmingDelete ? (
        <ConfirmDialog
          titleKey="confirm.deleteTask.title"
          bodyKey="confirm.deleteTask.body"
          params={{ title: task.title }}
          confirmKey="confirm.deleteTask.confirm"
          tone="danger"
          onConfirm={() => {
            setConfirmingDelete(false);
            // Close BEFORE the optimistic remove evicts the row: the composed screen now
            // keeps this dialog mounted across a concurrent delete (§14 error.taskGone),
            // so closing in the same tick is what stops a delete the user just confirmed
            // from rendering — or announcing — the "task no longer exists" state on the
            // way out. Outcome is unchanged: S7 closes the confirm on either leg, and
            // `Task deleted` still only announces on the ok leg.
            onClose();
            void deleteTask(task.id).then((result) => {
              if (result.ok) announce(t('a11y.taskDeleted'));
            });
          }}
          onCancel={() => {
            setConfirmingDelete(false);
          }}
        />
      ) : null}

      {creatingList ? (
        <ListDialog
          mode="create"
          validate={(name) => {
            const value = name.trim();
            if (value === '') return 'list.error.nameRequired';
            if (value.length > 60) return 'list.error.nameTooLong';
            const clash = lists.some(
              (list) => list.name.trim().toLowerCase() === value.toLowerCase(),
            );
            return clash ? 'list.error.duplicateName' : null;
          }}
          onSave={(value) => {
            setCreatingList(false);
            void addList(value).then((result) => {
              if (result.ok) setListId(result.value.id);
            });
          }}
          onCancel={() => {
            setCreatingList(false);
          }}
        />
      ) : null}
    </>
  );
}
