/**
 * Settings store (M14) — theme, week start, default list.
 *
 * Persistence split (ADR-002, the single decider for storage contracts):
 * - `theme` is mirrored synchronously into localStorage under `todo:prefs:v1:theme` so the
 *   hashed inline boot snippet can paint the right theme before first paint (Decision 7).
 * - The durable source of truth for ALL settings is the ADR-002 `settings` singleton record in
 *   IndexedDB, reached through the injectable `SettingsPersistence` port below. The app never
 *   writes task/list/settings data to localStorage.
 * - At boot the durable record wins over the mirror and the mirror is rewritten when they
 *   disagree (ADR-002 §3.4 "theme duplication rule").
 *
 * The port exists because the storage wrapper (`src/storage`) is landing in parallel; wiring
 * the IndexedDB adapter is a one-line `registerSettingsPersistence(...)` call and the store,
 * the view and the theme runtime are already written against the port.
 */

import { signal } from '@preact/signals';

import { DEFAULT_SETTINGS as RECORD_DEFAULTS } from '../domain/model';
import type { Result, StorageError } from '../storage/errors';
import {
  applyTheme,
  prefersDark,
  readThemePref,
  resolveTheme,
  startThemeTracking,
  writeThemePref,
  type ThemePref,
} from './theme';

/** `0` = Sunday, `1` = Monday — matches `Date#getDay` (ADR-002 §3.4). */
export type WeekStart = 0 | 1;

/** The settings this card owns, a subset of the ADR-002 `Settings` record. */
export interface AppSettings {
  readonly theme: ThemePref;
  readonly weekStart: WeekStart;
  readonly defaultListId: string | null;
}

/**
 * Defaults for the three fields this card owns, DERIVED from the domain model's
 * `DEFAULT_SETTINGS` — the single literal definition of the settings default
 * (ADR-003 Decision 1.2: the canonical record home).
 *
 * ADR-002 defines these FIELDS (shape + `0 | 1` union); the default VALUES come from the
 * domain record, so a fresh profile, "Delete all data" and this store can never disagree
 * (QA defect D1: `weekStart` used to be Monday here vs Sunday there).
 */
export const DEFAULT_SETTINGS: AppSettings = {
  theme: RECORD_DEFAULTS.theme,
  weekStart: RECORD_DEFAULTS.weekStart,
  defaultListId: RECORD_DEFAULTS.defaultListId,
};

/**
 * Durable persistence port for the ADR-002 `settings` record.
 * Implementations merge these three fields into the full record — they must not clobber the
 * record's other fields (`locale`, `lastBackupAt`, …), which belong to their own features.
 */
export interface SettingsPersistence {
  load(): Promise<Result<Partial<AppSettings> | null, StorageError>>;
  save(settings: AppSettings): Promise<Result<void, StorageError>>;
}

const settings = signal<AppSettings>(DEFAULT_SETTINGS);

let persistence: SettingsPersistence | null = null;
let stopThemeTracking: (() => void) | null = null;

/** Current settings (components read `.value` through `useSettings()` for reactivity). */
export function getSettings(): AppSettings {
  return settings.value;
}

/** Reactive accessor for components — reading the signal inside render subscribes them. */
export function useSettings(): AppSettings {
  return settings.value;
}

/** Wire the durable backend. Pass `null` to fall back to session-only settings. */
export function registerSettingsPersistence(next: SettingsPersistence | null): void {
  persistence = next;
}

function applyToDocument(state: AppSettings): void {
  applyTheme(resolveTheme(state.theme, prefersDark()));
}

function persist(state: AppSettings): void {
  if (persistence === null) return;
  void persistence.save(state).then(
    (result) => {
      if (!result.ok) console.warn('settings: durable save failed', result.error.code);
    },
    (error: unknown) => {
      console.warn('settings: durable save threw', error);
    },
  );
}

function withoutUndefined(patch: Partial<AppSettings>): Partial<AppSettings> {
  const out: { -readonly [K in keyof AppSettings]?: AppSettings[K] } = {};
  if (patch.theme !== undefined) out.theme = patch.theme;
  if (patch.weekStart !== undefined) out.weekStart = patch.weekStart;
  if (patch.defaultListId !== undefined) out.defaultListId = patch.defaultListId;
  return out;
}

/**
 * Boot the store: paint from the mirror immediately, then let the durable record win
 * (rewriting the mirror if it disagrees), then start live `system` tracking.
 *
 * Never rejects: a broken backend degrades to the mirror + session-only settings.
 */
export async function loadSettings(): Promise<void> {
  const mirrored: AppSettings = { ...DEFAULT_SETTINGS, theme: readThemePref() };
  settings.value = mirrored;
  applyToDocument(mirrored);

  if (persistence !== null) {
    try {
      const result = await persistence.load();
      if (result.ok) {
        const merged: AppSettings = { ...mirrored, ...withoutUndefined(result.value ?? {}) };
        settings.value = merged;
        if (merged.theme !== mirrored.theme) writeThemePref(merged.theme);
        applyToDocument(merged);
      } else {
        console.warn('settings: durable load failed', result.error.code);
      }
    } catch (error: unknown) {
      console.warn('settings: durable load threw', error);
    }
  }

  stopThemeTracking?.();
  stopThemeTracking = startThemeTracking(() => settings.value.theme);
}

/** Change the theme preference (design §5.3: instant apply + mirror write). */
export function setThemePref(pref: ThemePref): void {
  const next: AppSettings = { ...settings.value, theme: pref };
  settings.value = next;
  writeThemePref(pref);
  applyToDocument(next);
  persist(next);
}

/** Change the week start (0 = Sunday, 1 = Monday). */
export function setWeekStart(weekStart: WeekStart): void {
  const next: AppSettings = { ...settings.value, weekStart };
  settings.value = next;
  persist(next);
}

/** Change the default list (`null` = the "no default" option). */
export function setDefaultListId(defaultListId: string | null): void {
  const next: AppSettings = { ...settings.value, defaultListId };
  settings.value = next;
  persist(next);
}
