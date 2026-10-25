/**
 * Reminder dialog (V1 S5) — the V1 surface that writes the task's `reminderAt`
 * instant, reachable from the command palette (S8) and therefore from the
 * keyboard alone. The task-editor field is tracked as a follow-up (the editor
 * was under concurrent E7 reconstruction when this card landed — see the
 * hotspot note on t_ee8ecb0b).
 *
 * First-use discipline (binding decision): saving a NON-EMPTY reminder counts
 * as first use of the reminder feature — permission is requested here (once per
 * session), never at boot, and `notificationsEnabled` flips on with it so a
 * reminder the user just set actually fires. Saving an empty value just clears
 * the reminder and asks for nothing.
 */

import { useState } from 'preact/hooks';
import type { JSX } from 'preact';

import { announce } from '../../app/announce';
import { t } from '../../app/i18n';
import { Dialog } from '../../components/Dialog';
import type { Task } from '../../domain/model';
import { noteReminderFirstUse } from './firstUse';
import { ReminderField } from './ReminderField';
import { patchSettings, setTaskReminder, state } from '../tasks/store';

export interface ReminderDialogProps {
  readonly task: Task;
  readonly onClose: () => void;
}

export function ReminderDialog({ task, onClose }: ReminderDialogProps): JSX.Element {
  const [value, setValue] = useState<number | null>(task.reminderAt ?? null);
  const [saving, setSaving] = useState(false);

  const save = (): void => {
    if (saving) return;
    setSaving(true);
    void setTaskReminder(task.id, value).then((result) => {
      setSaving(false);
      if (!result.ok) return; // the store already reported + offered Retry
      if (value === null) {
        announce(t('a11y.reminderCleared'));
        onClose();
        return;
      }
      // First use of the reminder feature (user gesture — never boot).
      if (state.value.settings?.notificationsEnabled !== true) {
        void patchSettings({ notificationsEnabled: true });
      }
      void noteReminderFirstUse();
      announce(t('a11y.reminderSaved'));
      onClose();
    });
  };

  return (
    <Dialog
      title={t('reminder.title')}
      panelClass="reminder-dialog"
      onClose={onClose}
      footer={
        <>
          <button type="button" class="button button-secondary" onClick={onClose}>
            {t('editor.cancel')}
          </button>
          <button type="button" class="button button-primary" disabled={saving} onClick={save}>
            {saving ? t('editor.saving') : t('editor.save')}
          </button>
        </>
      }
    >
      <p class="reminder-task-title">{task.title}</p>
      <ReminderField value={value} onChange={setValue} />
    </Dialog>
  );
}
