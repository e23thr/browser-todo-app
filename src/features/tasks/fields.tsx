/**
 * Shared form fields for the composer (S3) and the task editor (S4).
 *
 * Field labels come from the `composer.label.*` register (design §13) — the register has
 * exactly one set of field labels, so both surfaces use it; English source strings live
 * only in the i18n catalog. The due-date field keeps the native `input[type=date]` so
 * keyboard and locale behaviour stay the platform's (§9.5).
 */

import { useId } from 'preact/hooks';
import type { JSX } from 'preact';

import { t, getLocale } from '../../app/i18n';
import type { Priority } from '../../domain/model';

/** `YYYY-MM-DD` → a localized medium date (never `toISOString`, E6). */
export function formatDueDate(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return dateStr;
  return new Intl.DateTimeFormat(getLocale(), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(year, month - 1, day));
}

/** Today/Tomorrow relative to the store's local day (D9). */
export function relativeDay(dateStr: string, today: string): 'today' | 'tomorrow' | null {
  if (dateStr === today) return 'today';
  const [y, m, d] = today.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) return null;
  const tomorrow = new Date(y, m - 1, d + 1);
  const pad = (n: number): string => (n < 10 ? `0${String(n)}` : String(n));
  const tomorrowStr = `${String(tomorrow.getFullYear()).padStart(4, '0')}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;
  return dateStr === tomorrowStr ? 'tomorrow' : null;
}

export interface DateFieldProps {
  readonly value: string | null;
  readonly onChange: (value: string | null) => void;
}

/** Due date: native date input + Today / Tomorrow / Clear chips (§7 S4). */
export function DateField({ value, onChange }: DateFieldProps): JSX.Element {
  const id = useId();

  return (
    <div class="field date-field">
      <label class="field-label" htmlFor={id}>
        {t('composer.label.due')}
      </label>
      <input
        id={id}
        class="input"
        type="date"
        value={value ?? ''}
        onChange={(event) => {
          const next = event.currentTarget.value;
          onChange(next === '' ? null : next);
        }}
      />
      <div class="chip-row">
        <button
          type="button"
          class="chip"
          data-testid="chip-today"
          onClick={() => {
            onChange(todayIso());
          }}
        >
          {t('date.chip.today')}
        </button>
        <button
          type="button"
          class="chip"
          data-testid="chip-tomorrow"
          onClick={() => {
            onChange(tomorrowIso());
          }}
        >
          {t('date.chip.tomorrow')}
        </button>
        <button
          type="button"
          class="chip"
          data-testid="chip-clear"
          disabled={value === null}
          onClick={() => {
            onChange(null);
          }}
        >
          {t('date.chip.clear')}
        </button>
      </div>
    </div>
  );
}

function pad2(n: number): string {
  return n < 10 ? `0${String(n)}` : String(n);
}

function todayIso(): string {
  const d = new Date();
  return `${String(d.getFullYear()).padStart(4, '0')}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function tomorrowIso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${String(d.getFullYear()).padStart(4, '0')}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export interface ListSelectProps {
  readonly lists: readonly { readonly id: string; readonly name: string }[];
  readonly value: string;
  readonly onChange: (id: string) => void;
  /** Chosen "New list…" — the caller opens the list dialog and re-selects the result. */
  readonly onCreateList: () => void;
}

/** List picker with a trailing "New list…" option (§16 item 14). */
export function ListSelect({ lists, value, onChange, onCreateList }: ListSelectProps): JSX.Element {
  const id = useId();
  const NEW = '__new__';
  return (
    <div class="field">
      <label class="field-label" htmlFor={id}>
        {t('composer.label.list')}
      </label>
      <select
        id={id}
        class="select"
        value={value}
        onChange={(event) => {
          const next = event.currentTarget.value;
          if (next === NEW) {
            onCreateList();
            return;
          }
          onChange(next);
        }}
      >
        {lists.map((list) => (
          <option key={list.id} value={list.id}>
            {list.name}
          </option>
        ))}
        <option value={NEW}>{t('list.action.new')}</option>
      </select>
    </div>
  );
}

export interface PriorityFieldProps {
  readonly value: Priority;
  readonly onChange: (priority: Priority) => void;
}

const PRIORITIES: readonly { readonly value: Priority; readonly labelKey: string }[] = [
  { value: 0, labelKey: 'priority.low' },
  { value: 1, labelKey: 'priority.medium' },
  { value: 2, labelKey: 'priority.high' },
];

/** Priority radio group (D4: always the current value, default low). */
export function PriorityField({ value, onChange }: PriorityFieldProps): JSX.Element {
  const name = useId();
  return (
    <fieldset class="field priority-field">
      <legend class="field-label">{t('composer.label.priority')}</legend>
      <div class="priority-row">
        {PRIORITIES.map((option) => (
          <label key={option.value} class="priority-option">
            <input
              type="radio"
              name={name}
              checked={value === option.value}
              onChange={() => {
                onChange(option.value);
              }}
            />
            <span>{t(option.labelKey)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
