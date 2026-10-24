/**
 * Search field (design §7 S5, §10 `SearchFieldProps`, §9.7 keyboard map).
 *
 * A real `type="search"` input with a real label (`search.label`) and a clear
 * button (`search.clear`, 44 px target). Filtering is synchronous on `input`
 * (no submit, no debounce — D5); the count announcement is debounced 300 ms by
 * the view (§5.5). Keys (§9.7): `Escape` clears the query (first press) and
 * closes/returns focus (second press); `↑`/`↓` move into the results list.
 */

import type { JSX, TargetedEvent } from 'preact';

import { t } from '../../app/i18n';
import { Icon } from '../../app/icons';

export interface SearchFieldProps {
  readonly value: string;
  readonly onInput: (value: string) => void;
  readonly onClear: () => void;
  /** Escape with an EMPTY query — the "second press": close / return focus. */
  readonly onEscape: () => void;
  /** `↑`/`↓` from the field: move the row cursor into the results (§9.7). */
  readonly onArrowIntoResults?: (direction: -1 | 1) => void;
}

export function SearchField({
  value,
  onInput,
  onClear,
  onEscape,
  onArrowIntoResults,
}: SearchFieldProps): JSX.Element {
  const onKeyDown = (event: TargetedEvent<HTMLInputElement, KeyboardEvent>): void => {
    switch (event.key) {
      case 'Escape':
        // First press clears the query; with an empty query it is the second
        // press (F8.3): close the search screen / return focus to the trigger.
        event.preventDefault();
        event.stopPropagation();
        if (value === '') onEscape();
        else onClear();
        return;
      case 'ArrowDown':
      case 'ArrowUp': {
        if (onArrowIntoResults === undefined) return;
        event.preventDefault();
        onArrowIntoResults(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      default:
    }
  };

  return (
    <div class="search-field">
      <Icon name="search" size={20} class="search-field-icon" />
      <input
        type="search"
        class="input search-input"
        // The route-change focus contract prefers this marker (F8.1 auto-focus).
        data-autofocus=""
        value={value}
        aria-label={t('search.label')}
        placeholder={t('search.placeholder')}
        onInput={(event) => {
          onInput(event.currentTarget.value);
        }}
        onKeyDown={onKeyDown}
      />
      {value !== '' ? (
        <button
          type="button"
          class="icon-button search-clear"
          aria-label={t('search.clear')}
          onClick={() => {
            onClear();
          }}
        >
          <Icon name="x" size={18} />
        </button>
      ) : null}
    </div>
  );
}
