/**
 * Reminder field (V1 S5) — sets the task's `reminderAt` instant, the only real
 * instant in the model (ADR-003). Native `datetime-local` so keyboard and locale
 * behaviour stay the platform's (same rationale as the due-date field, §9.5).
 *
 * Setting a reminder counts as FIRST USE of the reminder feature: the reminder
 * dialog (`ReminderDialog`) calls `noteReminderFirstUse()` on save (never at
 * boot — binding decision on t_ee8ecb0b).
 */

import { useId } from 'preact/hooks';
import type { JSX } from 'preact';

import { t } from '../../app/i18n';

/** `epoch ms` → `YYYY-MM-DDTHH:mm` in LOCAL time (datetime-local's format). */
export function toLocalInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear()).padStart(4, '0')}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `YYYY-MM-DDTHH:mm` (local) → `epoch ms`, or `null` when unparseable/empty. */
export function parseLocalInputValue(value: string): number | null {
  if (value.trim() === '') return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export interface ReminderFieldProps {
  readonly value: number | null;
  readonly onChange: (value: number | null) => void;
}

export function ReminderField({ value, onChange }: ReminderFieldProps): JSX.Element {
  const id = useId();
  return (
    <div class="field reminder-field">
      <label class="field-label" htmlFor={id}>
        {t('composer.label.reminder')}
      </label>
      <input
        id={id}
        class="input"
        type="datetime-local"
        value={value === null ? '' : toLocalInputValue(value)}
        onChange={(event) => {
          onChange(parseLocalInputValue(event.currentTarget.value));
        }}
      />
      <div class="chip-row">
        <button
          type="button"
          class="chip"
          data-testid="reminder-clear"
          disabled={value === null}
          onClick={() => {
            onChange(null);
          }}
        >
          {t('date.chip.clear')}
        </button>
      </div>
      <p class="field-hint">{t('reminder.help')}</p>
    </div>
  );
}
