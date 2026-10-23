/**
 * i18n runtime (M15) — English + Thai at MVP (PO Q9).
 *
 * The API is FIXED by decomposition card t_1b9ee0e6 and is not this card's to redesign:
 *
 *   t(key: string, params?: Record<string, string | number>): string
 *   setLocale('en' | 'th') — lazy-loads the locale bundle via dynamic import and sets
 *                             document.documentElement.lang (§8: this also switches
 *                             screen-reader pronunciation)
 *
 * Catalogs: `en.json` (source of truth) + `th.json` (PO-validated content), flat dotted keys,
 * `{name}` interpolation. Each locale ships as its own lazily imported pack (`locale-en.ts` /
 * `locale-th.ts`), so NO locale sits in the initial JS closure (§9.2 `locales` + `locales-lazy`
 * gates; the E1 manifest-key convention `^src/i18n/` with the tag taken from `locale-<tag>`).
 * English is loaded alongside any other locale because it is the fallback catalog.
 *
 * Missing key → English → the key itself, logged locally ONCE per key via `console.warn`
 * (§7.2: local log only — NO telemetry, ever).
 *
 * Reactivity: `t()` reads a Preact signal, so every component that renders `t(...)` during
 * render re-renders when the catalog changes — call sites need no hooks or context.
 *
 * Persistence: locale is durable in the ADR-002 `settings.locale` field (IndexedDB) behind the
 * injectable `LocalePersistence` port below; localStorage is NOT used because ADR-002
 * Decision 7's allowed key list has no locale key. Without a registered port the locale is
 * session-only, which keeps unit tests independent of storage.
 */

import { signal } from '@preact/signals';

import { resolveMessage, type Messages } from './format';

/** Locales shipped at MVP; `en` is the boot locale (index.html `lang="en"`). */
export type Locale = 'en' | 'th';

export const LOCALES: readonly Locale[] = ['en', 'th'];
export const DEFAULT_LOCALE: Locale = 'en';

/** Runtime guard — storage and options carry `string`, not `Locale`. */
export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'th';
}

/** One lazy pack per locale — the ONLY place locale catalogs are imported. */
const LOADERS: Readonly<Record<Locale, () => Promise<{ readonly default: Messages }>>> = {
  en: () => import('./locale-en'),
  th: () => import('./locale-th'),
};

/** Durable locale storage (ADR-002 `settings.locale`); `null` = session-only. */
export interface LocalePersistence {
  /** Stored locale, or `null` when unset/unavailable/invalid. Must not throw. */
  load(): Promise<Locale | null>;
  /** Persist the active locale. Failures are logged, never user-facing. */
  save(locale: Locale): Promise<void>;
}

const locale = signal<Locale>(DEFAULT_LOCALE);
const messages = signal<Messages>({});

/** English catalog, loaded once — the fallback source for every other locale. */
let english: Messages = {};
/** Locale whose catalog is applied, or `null` before the first successful load. */
let applied: Locale | null = null;
/** Monotonic switch counter: a slower, earlier switch never clobbers a newer one. */
let switchSeq = 0;
const packs = new Map<Locale, Promise<Messages>>();
const warnedKeys = new Set<string>();
const warnedParams = new Set<string>();
let persistence: LocalePersistence | null = null;

/** Wire the durable locale backend (`src/i18n/settingsPersistence` in the app boot path). */
export function registerLocalePersistence(next: LocalePersistence | null): void {
  persistence = next;
}

/** Diagnostic: has the locale pack for `next` been fetched (or is being fetched)? */
export function isLocaleLoaded(next: Locale): boolean {
  return packs.has(next);
}

function warnOnce(seen: Set<string>, id: string, message: string): void {
  if (seen.has(id)) return;
  seen.add(id);
  console.warn(message);
}

function loadPack(next: Locale): Promise<Messages> {
  const inflight = packs.get(next);
  if (inflight !== undefined) return inflight;
  const promise = LOADERS[next]()
    .then((mod) => {
      const catalog = mod.default;
      if (next === 'en') english = catalog;
      return catalog;
    })
    .catch((error: unknown) => {
      packs.delete(next); // a failed fetch must not poison later retries
      throw error;
    });
  packs.set(next, promise);
  return promise;
}

function applyDocumentLang(next: Locale): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = next;
}

function persist(next: Locale, previous: Locale | null): void {
  if (persistence === null || previous === next) return;
  void persistence.save(next).then(undefined, (error: unknown) => {
    console.warn('i18n: could not persist the locale', error);
  });
}

/**
 * Translate `key` in the active locale.
 *
 * Falls back to English, then to the key itself; logs locally once per problem. Reading the
 * catalog signal here is what subscribes rendering components to locale changes.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const active = messages.value;
  const resolution = resolveMessage(active, english, key, params);

  if (resolution.source === 'key') {
    warnOnce(
      warnedKeys,
      `missing:${key}`,
      `i18n: missing key "${key}" in locale "${locale.value}" and in English — showing the key`,
    );
  } else if (resolution.source === 'english' && locale.value !== 'en') {
    warnOnce(
      warnedKeys,
      `fallback:${key}:${locale.value}`,
      `i18n: missing key "${key}" in locale "${locale.value}" — falling back to English`,
    );
  }
  if (resolution.missingParams.length > 0) {
    warnOnce(
      warnedParams,
      `params:${key}:${[...resolution.missingParams].sort().join(',')}`,
      `i18n: missing param(s) ${resolution.missingParams.join(', ')} for key "${key}"`,
    );
  }
  return resolution.text;
}

/** The active locale (plain read; use `useLocale()` inside components that must re-render). */
export function getLocale(): Locale {
  return locale.value;
}

/** Reactive read — calling this during a component's render subscribes it to switches. */
export function useLocale(): Locale {
  return locale.value;
}

/**
 * Switch the active locale: load its pack lazily (plus English for fallback), apply the
 * catalog, set `document.documentElement.lang`, and persist through the port.
 *
 * Rejects only for an invalid locale argument or a pack that fails to load — in both cases
 * the active locale and catalog are left untouched, so the UI keeps rendering correctly.
 */
export async function setLocale(next: Locale): Promise<void> {
  if (!isLocale(next)) {
    throw new TypeError(`i18n: unsupported locale "${String(next)}"`);
  }

  const seq = ++switchSeq;
  const [catalog] = await Promise.all([loadPack(next), loadPack(DEFAULT_LOCALE)]);
  if (seq !== switchSeq) return; // superseded by a newer switch while loading

  const previous = applied;
  messages.value = catalog;
  locale.value = next;
  applied = next;
  applyDocumentLang(next);
  persist(next, previous);
}

export interface InitLocaleOptions {
  /**
   * Upper bound for boot: if the stored locale (or its pack) is slow or stuck, boot continues
   * without a catalog and the strings self-heal when the pack lands. Default 3000 ms.
   */
  readonly timeoutMs?: number;
}

const DEFAULT_INIT_TIMEOUT_MS = 3000;

/**
 * Boot the i18n layer: read the persisted locale through the port (if any), load that pack,
 * and set `document.documentElement.lang`. Never rejects — a broken backend or a missing pack
 * degrades to the boot locale, and a stuck backend degrades to a bounded wait.
 */
export async function initLocale(options: InitLocaleOptions = {}): Promise<Locale> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;

  const work = (async (): Promise<Locale> => {
    let stored: Locale | null = null;
    if (persistence !== null) {
      try {
        stored = await persistence.load();
      } catch (error: unknown) {
        console.warn('i18n: locale persistence load failed', error);
      }
    }
    const target = isLocale(stored) ? stored : DEFAULT_LOCALE;
    try {
      await setLocale(target);
    } catch (error: unknown) {
      console.warn(`i18n: could not load the "${target}" locale pack`, error);
      if (target !== DEFAULT_LOCALE) {
        try {
          await setLocale(DEFAULT_LOCALE);
        } catch (fallbackError: unknown) {
          console.warn('i18n: could not load the default locale pack', fallbackError);
        }
      }
    }
    return locale.value;
  })();

  // A rejected boot must neither reject initLocale nor dangle as an unhandled rejection.
  const safeWork = work.catch((error: unknown) => {
    console.warn('i18n: locale boot failed unexpectedly', error);
    return locale.value;
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, timeoutMs);
  });

  const settled = await Promise.race([safeWork, bounded]);
  if (timer !== undefined) clearTimeout(timer);
  return settled ?? locale.value;
}
