/**
 * Message resolution + `{name}` interpolation — the pure, testable core of the i18n runtime.
 *
 * No DOM, no module state, no logging in here (logging is a runtime concern, see `index.ts`).
 * The contract is fixed by decomposition card t_1b9ee0e6:
 *
 *   t(key: string, params?: Record<string, string | number>): string
 *
 * Resolution order for a key: active catalog → English catalog → the key itself. The
 * `source` field tells the caller which branch fired so it can log locally (§7.2: local log
 * only, NEVER telemetry).
 */

/** A locale catalog: flat dotted keys → template strings with `{name}` placeholders. */
export type Messages = Readonly<Record<string, string>>;

/** Where a resolved message came from. */
export type MessageSource = 'active' | 'english' | 'key';

export interface Resolution {
  /** The final string to render (interpolated, or the key itself when unresolved). */
  readonly text: string;
  /** Which catalog supplied the template — drives fallback logging. */
  readonly source: MessageSource;
  /** Placeholders the caller did not supply a value for (kept literal in `text`). */
  readonly missingParams: readonly string[];
}

/** `{name}` placeholder tokens — deliberately `\w+` so `first_name`-style names work. */
const PLACEHOLDER = /\{(\w+)\}/gu;

/**
 * Resolve `key` against the active catalog with English fallback, then interpolate
 * `{name}` placeholders from `params`.
 *
 * A placeholder with no matching param (or with `params` omitted entirely) is left literal
 * and reported in `missingParams` — a visible placeholder is a defect signal in QA, and the
 * runtime logs it once per key.
 */
export function resolveMessage(
  active: Messages,
  english: Messages,
  key: string,
  params?: Readonly<Record<string, string | number>>,
): Resolution {
  const activeText = active[key];
  const englishText = english[key];
  const template = activeText ?? englishText;
  const source: MessageSource =
    activeText !== undefined ? 'active' : englishText !== undefined ? 'english' : 'key';
  const raw = template ?? key;

  if (!raw.includes('{')) {
    return { text: raw, source, missingParams: [] };
  }

  const missingParams: string[] = [];
  const text = raw.replace(PLACEHOLDER, (match, name: string) => {
    const value = params?.[name];
    if (value === undefined) {
      if (!missingParams.includes(name)) missingParams.push(name);
      return match;
    }
    return String(value);
  });
  return { text, source, missingParams };
}
