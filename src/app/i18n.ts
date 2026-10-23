/**
 * The shell's single import site for i18n (M15 contract, fixed by decomposition card t_1b9ee0e6).
 *
 * The implementation lives in `src/i18n`, owned by the i18n card t_5696ea45, running in
 * parallel with this card:
 *
 *   t(key: string, params?: Record<string, string | number>): string
 *   setLocale('en' | 'th') — lazily imports the locale pack and sets
 *                             document.documentElement.lang (§8: screen-reader language)
 *
 * Components import from HERE (`../app/i18n`), never from `../i18n` directly: the shell's
 * dependency on the runtime stays in one file, so a future runtime swap would not touch a
 * single component.
 *
 * While the runtime was still landing, this file carried the shell's 78 English strings as a
 * contract-shaped local implementation; those keys were merged verbatim into
 * `src/i18n/en.json` (and translated in `th.json`) by the i18n card, so this is now a pure
 * re-export — there is exactly one catalog.
 *
 * Reactivity: `t()` reads a Preact signal, so a locale switch re-renders every component that
 * calls it during render — no context, no hooks, no observers at the call site.
 */

export {
  DEFAULT_LOCALE,
  LOCALES,
  getLocale,
  initLocale,
  isLocale,
  setLocale,
  t,
  useLocale,
} from '../i18n';
export type { Locale } from '../i18n';
