/**
 * Durable locale persistence over the ADR-002 `settings` singleton record (IndexedDB).
 *
 * Why IndexedDB and not localStorage: ADR-002 Decision 7 scopes localStorage to a closed key
 * list (`todo:prefs:v1:{theme,dismissedBanners,onboardingStep}`) — locale is deliberately NOT
 * on it; `settings.locale` (Decision 3.4) is the durable source of truth. Reads go through the
 * storage wrapper's repository API (UI never touches IndexedDB directly).
 *
 * Read-modify-write touches ONLY the `locale` field so concurrent settings writers (theme,
 * week start, default list) never clobber each other's fields. Every failure degrades to
 * session-only locale (§7.2: local `console.warn`, never telemetry).
 */

import { readThemePref } from '../app/theme';
import { bootCodec } from '../app/bootCodec';
import { DEFAULT_SETTINGS } from '../domain/model';
import { boot } from '../storage/boot';
import { SETTINGS_KEY } from '../storage/schema';
import type { Settings } from '../storage/types';
import { isLocale, type Locale, type LocalePersistence } from './index';

/**
 * Row created when none exists yet (first locale write on a fresh profile).
 *
 * Every field but the two below comes from the domain model's `DEFAULT_SETTINGS` — the ONE
 * literal default (ADR-003 Decision 1.2), so this row is exactly what a fresh profile gets
 * (QA defect D1: a `weekStart` literal here used to drift from it).
 *
 * `theme` is seeded from the pre-paint boot mirror, never from a literal: ADR-002 §3.4 makes
 * `settings.theme` the durable source of truth, so a fabricated `'system'` here would win over
 * the user's stored preference at the very next boot and silently reset it. The mirror is the
 * only boot-time record of what the user actually chose.
 */
function defaultSettingsRow(locale: Locale): Settings {
  return {
    ...DEFAULT_SETTINGS,
    id: SETTINGS_KEY,
    theme: readThemePref(),
    locale,
  };
}

export function createSettingsLocalePersistence(): LocalePersistence {
  return {
    async load(): Promise<Locale | null> {
      try {
        // ADR-004 codec on every boot() call — see `src/app/bootCodec.ts`.
        const db = await boot({ codec: await bootCodec() });
        if (!db.ok) {
          // QA N1: the silent branch — a storage failure used to look identical to "no
          // stored locale", hiding the D2 reset-on-reload failure class. Local warn only.
          console.warn(
            'i18n: could not read the stored locale (storage unavailable)',
            db.error.code,
          );
          return null;
        }
        const row = await db.value.get('settings', SETTINGS_KEY);
        if (!row.ok) {
          console.warn('i18n: could not read the stored locale (read failed)', row.error.code);
          return null;
        }
        if (row.value === undefined) return null; // first run — nothing stored yet, not an error
        return isLocale(row.value.locale) ? row.value.locale : null;
      } catch (error: unknown) {
        console.warn('i18n: could not read the stored locale', error);
        return null;
      }
    },

    async save(next: Locale): Promise<void> {
      try {
        const db = await boot({ codec: await bootCodec() });
        if (!db.ok) {
          console.warn('i18n: locale not persisted (storage unavailable)', db.error.code);
          return;
        }
        const current = await db.value.get('settings', SETTINGS_KEY);
        const row = current.ok && current.value !== undefined ? current.value : null;
        const merged: Settings = row === null ? defaultSettingsRow(next) : { ...row, locale: next };
        const written = await db.value.put('settings', merged);
        if (!written.ok) {
          console.warn('i18n: locale not persisted (write failed)', written.error.code);
        }
      } catch (error: unknown) {
        console.warn('i18n: locale persistence threw', error);
      }
    },
  };
}
