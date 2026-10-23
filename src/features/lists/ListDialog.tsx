/**
 * List dialog (design §7 S6.3) — create or rename a list: name + 8 colour swatches.
 *
 * Validation (D10): trimmed 1–60 chars, unique case-insensitively. The caller passes
 * `validate`, which returns an i18n error KEY (or `null`), so this component never
 * hardcodes copy or business rules. Swatches are radio inputs WITH text labels —
 * colour is never the only signal (§5.3).
 */

import { useId, useState } from 'preact/hooks';
import type { JSX } from 'preact';

import { t } from '../../app/i18n';
import { Dialog } from '../../components/Dialog';

/** The 8 preset list colours (`list.color.*`, decorative; labels carry the meaning). */
export const LIST_COLORS: readonly { readonly key: string; readonly value: string }[] = [
  { key: 'list.color.red', value: '#d92d20' },
  { key: 'list.color.orange', value: '#e8833a' },
  { key: 'list.color.yellow', value: '#d4a72c' },
  { key: 'list.color.green', value: '#2e9d5b' },
  { key: 'list.color.blue', value: '#2e6fd9' },
  { key: 'list.color.purple', value: '#8247c9' },
  { key: 'list.color.gray', value: '#7a8699' },
  { key: 'list.color.teal', value: '#12a594' },
];

export const DEFAULT_LIST_COLOR = '#2e6fd9';

export interface ListDialogProps {
  readonly mode: 'create' | 'rename';
  readonly initial?: { readonly name: string; readonly color: string };
  /** Returns an i18n error KEY for the current name, or `null` when it is valid. */
  readonly validate: (name: string) => string | null;
  readonly onSave: (value: { name: string; color: string }) => void;
  readonly onCancel: () => void;
}

export function ListDialog({
  mode,
  initial,
  validate,
  onSave,
  onCancel,
}: ListDialogProps): JSX.Element {
  const titleId = useId();
  const errorId = useId();
  const [name, setName] = useState(initial?.name ?? '');
  const [color, setColor] = useState(
    initial?.color ?? LIST_COLORS.find((c) => c.value === DEFAULT_LIST_COLOR)?.value ?? DEFAULT_LIST_COLOR,
  );
  const [touched, setTouched] = useState(false);
  const nameError = validate(name);
  const showError = touched && nameError !== null;

  const save = (): void => {
    setTouched(true);
    if (nameError !== null) return;
    onSave({ name: name.trim(), color });
  };

  return (
    <Dialog
      title={mode === 'create' ? t('list.action.new') : t('list.action.rename')}
      onClose={onCancel}
      footer={
        <>
          <button type="button" class="button button-secondary" onClick={onCancel}>
            {t('list.dialog.cancel')}
          </button>
          <button
            type="button"
            class="button button-primary"
            disabled={nameError !== null}
            onClick={save}
          >
            {t('list.dialog.save')}
          </button>
        </>
      }
    >
      <form
        class="stack"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <div class="field">
          <label class="field-label" htmlFor={`${titleId}-name`}>
            {t('list.dialog.name')}
          </label>
          <input
            id={`${titleId}-name`}
            class="input"
            type="text"
            maxlength={60}
            data-autofocus=""
            value={name}
            aria-describedby={showError ? errorId : undefined}
            aria-invalid={showError ? 'true' : undefined}
            onInput={(event) => {
              setName((event.currentTarget).value);
            }}
            onBlur={() => {
              setTouched(true);
            }}
          />
          {showError ? (
            <p class="field-error" id={errorId} role="alert">
              {t(nameError)}
            </p>
          ) : null}
        </div>

        <fieldset class="field color-field">
          <legend class="field-label">{t('list.dialog.color')}</legend>
          <div class="color-row">
            {LIST_COLORS.map((preset) => (
              <label key={preset.value} class="color-swatch">
                <input
                  type="radio"
                  name={`${titleId}-color`}
                  checked={color === preset.value}
                  onChange={() => {
                    setColor(preset.value);
                  }}
                />
                <span class="color-dot" style={{ background: preset.value }} aria-hidden="true" />
                <span>{t(preset.key)}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {/* Enter submits the form even when focus is in the name input. */}
        <button type="submit" class="visually-hidden" tabIndex={-1} aria-hidden="true">
          {t('list.dialog.save')}
        </button>
      </form>
    </Dialog>
  );
}

/**
 * D10 name rules over the CURRENT lists (case-insensitive uniqueness). Returns an
 * i18n error KEY or `null`; the `except` id keeps a rename of an unchanged name valid.
 */
export function makeListNameValidator(
  names: readonly { readonly id: string; readonly name: string }[],
  exceptId?: string,
): (name: string) => string | null {
  return (raw: string) => {
    const name = raw.trim();
    if (name === '') return 'list.error.nameRequired';
    if (name.length > 60) return 'list.error.nameTooLong';
    const clash = names.some(
      (list) => list.id !== exceptId && list.name.trim().toLowerCase() === name.toLowerCase(),
    );
    return clash ? 'list.error.duplicateName' : null;
  };
}
