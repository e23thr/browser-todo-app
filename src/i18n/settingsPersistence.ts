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
import { boot } from '../storage/boot';
import { SETTINGS_KEY } from '../storage/schema';
import type { Settings } from '../storage/types';
import { isLocale, type Locale, type LocalePersistence } from './index';

/**
 * Row created when none exists yet (first locale write on a fresh profile).
 *
 * `theme` is seeded from the pre-paint boot mirror, never from a literal: ADR-002 §3.4 makes
 * `settings.theme` the durable source of truth, so a fabricated `'system'` here would win over
 * the user's stored preference at the very next boot and silently reset it. The mirror is the
 * only boot-time record of what the user actually chose.
 */
function defaultSettingsRow(locale: Locale): Settings {
  return {
    id: SETTINGS_KEY,
    theme: readThemePref(),
    locale,
    weekStart: 0,
    defaultListId: null,
    notificationsEnabled: false,
    lastBackupAt: null,
  };
}

export function createSettingsLocalePersistence(): LocalePersistence {
  return {
    async load(): Promise<Locale | null> {
      try {
        const db = await boot();
        if (!db.ok) return null;
        const row = await db.value.get('settings', SETTINGS_KEY);
        if (!row.ok || row.value === undefined) return null;
        return isLocale(row.value.locale) ? row.value.locale : null;
      } catch {
        return null;
      }
    },

    async save(next: Locale): Promise<void> {
      try {
        const db = await boot();
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
