/**
 * Shared form fields for the composer (S3) and the task editor (S4).
 *
 * Field labels come from the `composer.label.*` register (design §13) — the register has
 * exactly one set of field labels, so both surfaces use it; English source strings live
 * only in the i18n catalog. The due-date field keeps the native `input[type=date]` so
 * keyboard and locale behaviour stay the platform's (§9.5).
 */

import { useId, useState } from 'preact/hooks';
import type { JSX } from 'preact';

import { t, getLocale } from '../../app/i18n';
import { Icon } from '../../app/icons';
import type { Priority, Recurrence } from '../../domain/model';

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
  { value: 'P1', labelKey: 'priority.p1' },
  { value: 'P2', labelKey: 'priority.p2' },
  { value: 'P3', labelKey: 'priority.p3' },
  { value: 'P4', labelKey: 'priority.p4' },
];

/** Priority radio group (S3 four levels; default `P4` = no priority). */
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

export interface RecurrenceFieldProps {
  readonly value: Recurrence | undefined;
  /** `null` clears the rule ("Repeat: Never"). */
  readonly onChange: (value: Recurrence | null) => void;
}

const REPEAT_OPTIONS: readonly { readonly value: Recurrence['freq']; readonly labelKey: string }[] =
  [
    { value: 'daily', labelKey: 'repeat.daily' },
    { value: 'weekly', labelKey: 'repeat.weekly' },
    { value: 'monthly', labelKey: 'repeat.monthly' },
    { value: 'weekdays', labelKey: 'repeat.weekdays' },
  ];

/** `interval` stays an integer >= 1 (the RESERVED recurrence format, ADR-002 §3). */
function clampInterval(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(365, Math.max(1, parsed));
}

/**
 * S4 repeat field: the RRULE-lite rule (`{ freq, interval >= 1, until? }`) —
 * a frequency select, an interval, and an OPTIONAL end date. No exceptions and
 * no end-count (R4: out of V1). "Never" clears the field entirely.
 */
export function RecurrenceField({ value, onChange }: RecurrenceFieldProps): JSX.Element {
  const id = useId();
  const freq = value?.freq ?? '';
  const interval = value?.interval ?? 1;
  const until = value?.until ?? null;

  const emit = (next: {
    freq: Recurrence['freq'];
    interval: number;
    until: string | null;
  }): void => {
    onChange({
      freq: next.freq,
      interval: next.interval,
      ...(next.until !== null ? { until: next.until } : {}),
    });
  };

  return (
    <div class="field">
      <label class="field-label" htmlFor={`${id}-repeat`}>
        {t('composer.label.repeat')}
      </label>
      <select
        id={`${id}-repeat`}
        class="select"
        data-testid="repeat-freq"
        value={freq}
        onChange={(event) => {
          const next = event.currentTarget.value;
          if (next === '') {
            onChange(null);
            return;
          }
          emit({ freq: next as Recurrence['freq'], interval, until });
        }}
      >
        <option value="">{t('repeat.never')}</option>
        {REPEAT_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {t(option.labelKey)}
          </option>
        ))}
      </select>
      {freq !== '' ? (
        <>
          <label class="field-label" htmlFor={`${id}-interval`}>
            {t('repeat.every')}
          </label>
          <input
            id={`${id}-interval`}
            class="input"
            type="number"
            inputmode="numeric"
            min={1}
            max={365}
            data-testid="repeat-interval"
            value={String(interval)}
            onInput={(event) => {
              emit({
                freq: freq as Recurrence['freq'],
                interval: clampInterval(event.currentTarget.value),
                until,
              });
            }}
          />
          <label class="field-label" htmlFor={`${id}-until`}>
            {t('repeat.until')}
          </label>
          <input
            id={`${id}-until`}
            class="input"
            type="date"
            data-testid="repeat-until"
            value={until ?? ''}
            onChange={(event) => {
              const next = event.currentTarget.value;
              emit({
                freq: freq as Recurrence['freq'],
                interval,
                until: next === '' ? null : next,
              });
            }}
          />
          <p class="field-hint">{t('repeat.hint')}</p>
        </>
      ) : null}
    </div>
  );
}

export interface TagsFieldProps {
  readonly value: readonly string[];
  readonly onChange: (tags: string[]) => void;
  /** Every tag currently in use — offered as `<datalist>` suggestions (S1). */
  readonly suggestions?: readonly string[];
}

/** Tag name rules (ADR-004 §6.2): 1..100 chars, non-blank when trimmed. */
export function isValidTagName(name: string): boolean {
  return name.length >= 1 && name.length <= 100 && name.trim().length >= 1;
}

/**
 * Tags chip editor (S1): type a name + Enter/Add to attach, Backspace on the
 * empty input removes the last chip, each chip carries its own remove button.
 * Creating a tag = attaching a new name to a task (the model is denormalized,
 * ADR-002 §3.5 — there is no separate tag record).
 */
export function TagsField({ value, onChange, suggestions = [] }: TagsFieldProps): JSX.Element {
  const id = useId();
  const [draft, setDraft] = useState('');
  const trimmed = draft.trim();

  const add = (): void => {
    if (!isValidTagName(trimmed)) return;
    if (value.includes(trimmed)) {
      setDraft('');
      return;
    }
    onChange([...value, trimmed]);
    setDraft('');
  };

  return (
    <div class="field">
      <label class="field-label" htmlFor={id}>
        {t('composer.label.tags')}
      </label>
      {value.length > 0 ? (
        <ul class="tag-chips" aria-label={t('composer.label.tags')}>
          {value.map((tag) => (
            <li key={tag} class="tag-chip">
              <span>{tag}</span>
              <button
                type="button"
                class="tag-chip-remove"
                aria-label={t('tags.remove', { name: tag })}
                onClick={() => {
                  onChange(value.filter((entry) => entry !== tag));
                }}
              >
                <Icon name="x" size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div class="tag-input-row">
        <input
          id={id}
          class="input"
          type="text"
          maxlength={100}
          list={`${id}-tags`}
          placeholder={t('tags.placeholder')}
          value={draft}
          onInput={(event) => {
            setDraft(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            } else if (event.key === 'Backspace' && draft === '' && value.length > 0) {
              onChange(value.slice(0, -1));
            }
          }}
        />
        <datalist id={`${id}-tags`}>
          {suggestions
            .filter((tag) => !value.includes(tag))
            .map((tag) => (
              <option key={tag} value={tag} />
            ))}
        </datalist>
        <button
          type="button"
          class="button button-secondary"
          disabled={!isValidTagName(trimmed)}
          onClick={add}
        >
          {t('tags.add')}
        </button>
      </div>
    </div>
  );
}
