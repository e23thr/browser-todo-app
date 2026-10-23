/**
 * Theme system (M7) — preference storage, resolution and live system tracking.
 *
 * Contracts:
 * - The preference mirror lives in localStorage under the ADR-002 Decision 7 namespace
 *   (`todo:prefs:v1:theme`) because it must be readable synchronously before first paint.
 * - The pre-paint read happens in the hashed inline `#theme-boot` snippet in index.html
 *   (§7.2: the only inline script this app's CSP permits); this module is the runtime half.
 * - localStorage writes are fire-and-forget behind a `try` guard: Safari private mode throws,
 *   and the app must keep working for the session (ADR-002 Decision 7, design §5.2).
 * - `system` tracks `prefers-color-scheme` live via a matchMedia listener (design §5.1).
 */

/** The three user-facing theme choices (design §5.1). */
export type ThemePref = 'light' | 'dark' | 'system';

/** The two themes actually painted onto `<html data-theme>` (design §5.1). */
export type ResolvedTheme = 'light' | 'dark';

/** ADR-002 Decision 7 — the only localStorage key this system touches. */
export const THEME_PREF_KEY = 'todo:prefs:v1:theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** The slice of `Storage` the theme code needs (injectable for tests). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    // Accessing the property itself can throw (hardened/private browsing → SecurityError).
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
  } catch {
    // Storage access itself can throw (hardened/private browsing).
    return null;
  }
}

/** `true` when `value` is one of the three storable preferences. */
export function isThemePref(value: unknown): value is ThemePref {
  return value === 'light' || value === 'dark' || value === 'system';
}

/**
 * Read the mirrored preference. Absent, invalid or unreadable values all mean `system`,
 * which is exactly how the inline boot snippet treats them.
 */
export function readThemePref(storage: StorageLike | null = defaultStorage()): ThemePref {
  if (storage === null) return 'system';
  try {
    const raw = storage.getItem(THEME_PREF_KEY);
    return isThemePref(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
}

/** Mirror the preference for pre-paint boot. Never throws (ADR-002: fire-and-forget). */
export function writeThemePref(
  pref: ThemePref,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (storage === null || !isThemePref(pref)) return;
  try {
    storage.setItem(THEME_PREF_KEY, pref);
  } catch {
    // Private mode: the session keeps working, the next load falls back to `system`.
  }
}

/** Current `prefers-color-scheme`, `false` when the API is unavailable. */
export function prefersDark(): boolean {
  const matchMediaFn = globalThis.matchMedia;
  if (typeof matchMediaFn !== 'function') return false;
  try {
    return matchMediaFn(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

/** Resolve a preference against the current system preference (design §5.1). */
export function resolveTheme(pref: ThemePref, systemPrefersDark: boolean): ResolvedTheme {
  if (pref === 'light' || pref === 'dark') return pref;
  return systemPrefersDark ? 'dark' : 'light';
}

/**
 * Paint the resolved theme onto the document: `<html data-theme>` plus `color-scheme`, so
 * native controls (scrollbars, form controls, the caret) follow the theme (design §5.1).
 */
export function applyTheme(resolved: ResolvedTheme, doc: Document = document): void {
  doc.documentElement.dataset['theme'] = resolved;
  doc.documentElement.style.colorScheme = resolved;
}

/**
 * Track `prefers-color-scheme` live while the preference is `system`.
 *
 * The preference reader is injected so this module stays free of any store dependency
 * (the settings store passes its own getter).
 *
 * @returns a disposer that removes the listener.
 */
export function startThemeTracking(readPref: () => ThemePref): () => void {
  const matchMediaFn = globalThis.matchMedia;
  if (typeof matchMediaFn !== 'function') return () => undefined;

  let mediaQuery: MediaQueryList;
  try {
    mediaQuery = matchMediaFn(DARK_QUERY);
  } catch {
    return () => undefined;
  }

  const onChange = (): void => {
    if (readPref() !== 'system') return;
    applyTheme(resolveTheme('system', mediaQuery.matches));
  };

  mediaQuery.addEventListener('change', onChange);
  return () => {
    mediaQuery.removeEventListener('change', onChange);
  };
}
