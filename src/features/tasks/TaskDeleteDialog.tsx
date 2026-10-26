/**
 * Task-delete confirm (S7.1 + E7 S2 subtask disposition) — the ONE delete flow
 * for a task, shared by the row-menu path (TaskScreen) and the editor's Delete
 * button. S7.1 binding (t_1b9ee0e6): the plain confirm is REPLACED by the undo
 * toast — callers delete straight through when `needsDeleteDisposition` is
 * false. A parent with live subtasks still gets the disposition radio group
 * (consistent with the list-deletion UX): promote its direct subtasks to the
 * list's top level, or delete them too — a structural choice no toast can ask.
 */

import type { JSX } from 'preact';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import type { Task } from '../../domain/model';
import type { TaskRemoveDisposition } from '../../domain/ports';
import { state } from './store';

export interface TaskDeleteDialogProps {
  readonly task: Task;
  readonly onConfirm: (disposition: TaskRemoveDisposition) => void;
  readonly onCancel: () => void;
}

/** Live direct subtasks of `id` (S2 is single-level — there are no grandchildren). */
export function liveSubtasks(id: string): Task[] {
  return [...state.value.tasks.values()].filter(
    (task) => task.parentTaskId === id && task.deletedAt === null,
  );
}

/**
 * Does this delete still need the dialog? Only when live subtasks exist — the
 * disposition (promote vs cascade) is a decision no toast can ask. Otherwise
 * the caller deletes straight through and the 10 s undo toast IS the confirm.
 */
export function needsDeleteDisposition(id: string): boolean {
  return liveSubtasks(id).length > 0;
}

export function TaskDeleteDialog({
  task,
  onConfirm,
  onCancel,
}: TaskDeleteDialogProps): JSX.Element {
  const subtasks = liveSubtasks(task.id);
  if (subtasks.length === 0) {
    return (
      <ConfirmDialog
        titleKey="confirm.deleteTask.title"
        bodyKey="confirm.deleteTask.body"
        params={{ title: task.title }}
        confirmKey="confirm.deleteTask.confirm"
        tone="danger"
        onConfirm={() => {
          onConfirm({ mode: 'cascade' });
        }}
        onCancel={onCancel}
      />
    );
  }
  return (
    <ConfirmDialog
      titleKey="confirm.deleteTask.title"
      bodyKey="confirm.deleteTask.subtaskBody"
      params={{ title: task.title }}
      confirmKey="confirm.deleteTask.confirm"
      tone="danger"
      extra="delete-task-disposition"
      subtaskCount={subtasks.length}
      onConfirm={(value) => {
        onConfirm(value?.mode === 'promote' ? { mode: 'promote' } : { mode: 'cascade' });
      }}
      onCancel={onCancel}
    />
  );
}
