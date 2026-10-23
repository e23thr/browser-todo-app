import type { JSX } from 'preact';

import { announce } from '../../app/announce';
import { Icon, type IconName } from '../../app/icons';
import { setLocale, t, useLocale, type Locale } from '../../app/i18n';
import { useListOptions } from '../../app/lists';
import {
  setDefaultListId,
  setThemePref,
  setWeekStart,
  useSettings,
  type WeekStart,
} from '../../app/settings';
import { View } from '../../components/View';

/** One choice inside a radio row. */
interface Choice {
  readonly value: string;
  readonly label: string;
  readonly icon?: IconName;
}

interface RadioRowProps {
  readonly id: string;
  readonly legend: string;
  readonly value: string;
  readonly choices: readonly Choice[];
  readonly onChange: (value: string, label: string) => void;
}

/**
 * Radio row (design §6.5): native radios visually restyled as a segmented control — the design
 * spec's preferred option, because native radios bring the arrow-key model, the group
 * semantics and the checked state (never colour alone) for free.
 */
function RadioRow({ id, legend, value, choices, onChange }: RadioRowProps): JSX.Element {
  const legendId = `${id}-legend`;
  return (
    <fieldset class="field-group">
      <legend class="field-legend" id={legendId}>
        {legend}
      </legend>
      <div class="segmented" role="radiogroup" aria-labelledby={legendId}>
        {choices.map((choice) => (
          <label class="segment" key={choice.value}>
            <input
              type="radio"
              name={id}
              value={choice.value}
              checked={value === choice.value}
              onChange={() => {
                onChange(choice.value, choice.label);
              }}
            />
            {choice.icon === undefined ? null : (
              <Icon name={choice.icon} size={18} class="segment-icon" />
            )}
            <span class="segment-label">{choice.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Settings (M14, design §4.9) — loaded as the app's lazy route chunk (§9.2).
 *
 * Sections: Appearance (theme, persisted through the ADR-002 boot-prefs mirror + settings
 * store), Language, Tasks (week start + default list), Storage & backup — the documented
 * mount point the E3 data-safety card fills in; this card owns only the section heading —
 * and About.
 */
export default function SettingsView(): JSX.Element {
  const settings = useSettings();
  const lists = useListOptions();
  const locale = useLocale();

  const themeChoices: readonly Choice[] = [
    { value: 'light', label: t('settings.theme.light'), icon: 'sun' },
    { value: 'dark', label: t('settings.theme.dark'), icon: 'moon' },
    { value: 'system', label: t('settings.theme.system'), icon: 'monitor' },
  ];

  const languageChoices: readonly Choice[] = [
    { value: 'en', label: t('settings.language.english') },
    { value: 'th', label: t('settings.language.thai') },
  ];

  const weekStartChoices: readonly Choice[] = [
    { value: '1', label: t('settings.weekStart.monday') },
    { value: '0', label: t('settings.weekStart.sunday') },
  ];

  return (
    <View title={t('settings.title')} class="settings">
      <section class="settings-section" aria-labelledby="settings-appearance">
        <h2 class="settings-heading" id="settings-appearance">
          {t('settings.appearance')}
        </h2>
        <RadioRow
          id="settings-theme"
          legend={t('settings.theme')}
          value={settings.theme}
          choices={themeChoices}
          onChange={(value, label) => {
            setThemePref(value as 'light' | 'dark' | 'system');
            announce(t('a11y.themeApplied', { theme: label }));
          }}
        />
      </section>

      <section class="settings-section" aria-labelledby="settings-language">
        <h2 class="settings-heading" id="settings-language">
          {t('settings.language')}
        </h2>
        <RadioRow
          id="settings-locale"
          legend={t('settings.language')}
          value={locale}
          choices={languageChoices}
          onChange={(value, label) => {
            void setLocale(value as Locale)
              .then(() => {
                announce(t('a11y.languageChanged', { language: label }));
              })
              .catch(() => {
                // Pack failed to load (offline / evicted cache): the active locale is left
                // untouched (the radio is controlled by it), so just say so — assertively.
                announce(t('settings.language.error'), 'assertive');
              });
          }}
        />
      </section>

      <section class="settings-section" aria-labelledby="settings-tasks">
        <h2 class="settings-heading" id="settings-tasks">
          {t('settings.tasks')}
        </h2>
        <RadioRow
          id="settings-week-start"
          legend={t('settings.weekStart')}
          value={String(settings.weekStart)}
          choices={weekStartChoices}
          onChange={(value) => {
            setWeekStart(Number(value) as WeekStart);
          }}
        />

        <div class="field">
          <label class="field-label" for="settings-default-list">
            {t('settings.defaultList')}
          </label>
          <select
            class="select"
            id="settings-default-list"
            value={settings.defaultListId ?? ''}
            disabled={lists.length === 0}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setDefaultListId(next === '' ? null : next);
            }}
          >
            {lists.length === 0 ? (
              <option value="">{t('settings.defaultList.none')}</option>
            ) : (
              <>
                <option value="">{t('settings.defaultList.unset')}</option>
                {lists.map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.name}
                  </option>
                ))}
              </>
            )}
          </select>
        </div>
      </section>

      {/*
        Storage & backup mount point (M14): the E3 data-safety card renders the quota bar,
        persistence status, export/import and delete-all controls here. This card owns the
        section heading only ("do not build its contents").
      */}
      <section class="settings-section" aria-labelledby="settings-storage">
        <h2 class="settings-heading" id="settings-storage">
          {t('settings.storage')}
        </h2>
        <p class="settings-pending" data-mount-point="storage-backup">
          {t('settings.storage.pending')}
        </p>
      </section>

      <section class="settings-section" aria-labelledby="settings-about">
        <h2 class="settings-heading" id="settings-about">
          {t('settings.about')}
        </h2>
        <p class="settings-pending">
          <strong>{t('app.name')}</strong> — {t('app.tagline')}
        </p>
      </section>
    </View>
  );
}
