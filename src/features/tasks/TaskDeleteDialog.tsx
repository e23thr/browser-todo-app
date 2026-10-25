/**
 * Task-delete confirm (S7.1 + E7 S2 subtask disposition) — the ONE delete flow
 * for a task, shared by the row-menu path (TaskScreen) and the editor's Delete
 * button. A task WITHOUT live subtasks keeps the plain S7.1 confirm; a parent
 * offers the disposition radio group (consistent with the list-deletion UX):
 * promote its direct subtasks to the list's top level, or delete them too.
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
