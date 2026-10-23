/**
 * i18n import site for the shell (M15 contract).
 *
 * The API is FIXED by decomposition card t_1b9ee0e6 and is not this card's to redesign:
 *
 *   t(key: string, params?: Record<string, string | number>): string
 *   setLocale('en' | 'th')  — lazy-loads the locale bundle and sets document.documentElement.lang
 *
 * The i18n infrastructure card (t_5696ea45) owns `src/i18n/{en,th}.json` + the runtime, and is
 * running in parallel with this card. Until its module lands, this file is a contract-shaped
 * local implementation carrying the shell's English strings, so the shell can be built and
 * tested against the real API shape. Integration = re-point this one file at `../i18n` and
 * merge the keys below into the locale bundles — no component changes its imports.
 *
 * Missing keys fall back to English and log locally (never telemetry) — §7.2.
 */

export type Locale = 'en' | 'th';

/** Shell + settings English strings (source of truth; Thai comes from the i18n card). */
const EN: Readonly<Record<string, string>> = {
  // App chrome -------------------------------------------------------------------
  'app.name': 'Todo',
  'app.tagline': 'A local-first todo app — your data stays in this browser.',
  'a11y.skipToContent': 'Skip to main content',
  'a11y.navLabel': 'Views and lists',
  'a11y.openMenu': 'Open navigation menu',
  'a11y.closeMenu': 'Close navigation menu',
  'a11y.viewChanged': 'View: {view}',
  'a11y.themeApplied': '{theme} theme applied',
  'a11y.languageChanged': 'Language changed to {language}',
  'nav.menu': 'Menu',
  'nav.today': 'Today',
  'nav.next7days': 'Next 7 days',
  'nav.allOpen': 'All open',
  'nav.completed': 'Completed',
  'nav.more': 'More',
  'nav.search': 'Search',
  'nav.settings': 'Settings',
  'nav.lists': 'Lists',

  // Views ------------------------------------------------------------------------
  'view.today': 'Today',
  'view.next7days': 'Next 7 days',
  'view.allOpen': 'All open',
  'view.completed': 'Completed',
  'view.search': 'Search',
  'view.settings': 'Settings',
  'view.list': 'List',
  'view.count': '{count} tasks',
  'task.action.add': 'Add task',
  'list.action.new': 'New list',
  'common.retry': 'Try again',
  'shell.loading': 'Loading…',
  'error.viewLoad.title': 'This view failed to load.',
  'error.viewLoad.body': 'Try refreshing the page, or ',
  'error.viewLoad.back': 'go back to Today',

  // Empty states -----------------------------------------------------------------
  'today.empty.title': 'Nothing due today',
  'today.empty.body': 'Enjoy the clear space, or add something.',
  'next7.empty.title': 'Nothing due in the next 7 days',
  'next7.empty.body': 'Nothing is scheduled in this window yet.',
  'all.empty.title': 'No open tasks',
  'all.empty.body': 'Tasks you add will show up here.',
  'completed.empty.title': 'Nothing completed yet',
  'completed.empty.body': 'Completed tasks will collect here.',
  'list.empty.title': 'No lists yet',
  'list.empty.tasks': 'Nothing in this list yet.',
  'search.hint': 'Type to search your tasks (titles and notes).',
  'search.label': 'Search tasks',
  'search.placeholder': 'Search titles and notes…',

  // Not found --------------------------------------------------------------------
  'notFound.title': 'Page not found',
  'notFound.body': 'Nothing is routed at {path}.',
  'notFound.back': 'Go to Today',

  // Settings (M14) ---------------------------------------------------------------
  'settings.title': 'Settings',
  'settings.appearance': 'Appearance',
  'settings.theme': 'Theme',
  'settings.theme.light': 'Light',
  'settings.theme.dark': 'Dark',
  'settings.theme.system': 'System',
  'settings.language': 'Language',
  'settings.language.english': 'English',
  'settings.language.thai': 'ไทย',
  'settings.tasks': 'Tasks',
  'settings.weekStart': 'Week starts on',
  'settings.weekStart.monday': 'Monday',
  'settings.weekStart.sunday': 'Sunday',
  'settings.defaultList': 'Default list',
  'settings.defaultList.none': 'No lists yet',
  'settings.defaultList.unset': 'No default list',
  'settings.storage': 'Storage & backup',
  'settings.storage.pending': 'Backup and storage controls are not available yet.',
  'settings.about': 'About',
};

const BUNDLES: Record<Locale, Readonly<Record<string, string>>> = { en: EN, th: {} };

let current: Locale = 'en';

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/gu, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/** Translate `key` in the active locale, falling back to English, then to the key itself. */
export function t(key: string, params?: Record<string, string | number>): string {
  const value = BUNDLES[current][key] ?? BUNDLES.en[key];
  if (value === undefined) {
    // Local log only — §7.2 forbids anything that phones home.
    console.warn(`i18n: missing key "${key}"`);
    return key;
  }
  return interpolate(value, params);
}

/** The active locale. */
export function getLocale(): Locale {
  return current;
}

/**
 * Switch locale. Sets `document.documentElement.lang`, which is what switches screen-reader
 * pronunciation (§8) and what the shell observes to re-render every string.
 */
export function setLocale(locale: Locale): Promise<void> {
  current = locale;
  document.documentElement.lang = locale;
  return Promise.resolve();
}
