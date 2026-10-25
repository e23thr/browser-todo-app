/**
 * Global keyboard shortcut map (V1 S8 — PROJECT_ANALYSIS §4 S8, §8).
 *
 * Conflict policy (binding decision on t_ee8ecb0b: "shortcuts must not shadow
 * browser/screen-reader combos"):
 *
 *  1. Nothing unmodified. Screen readers (NVDA/JAWS/VoiceOver browse mode) bind
 *     bare letters for quick-nav, and Firefox binds `/` and `'` to quick find —
 *     so the ONLY unmodified-family binding is `?` (`Shift+/`), which no browser
 *     and no screen-reader quick-nav set binds.
 *  2. Nothing on `Ctrl/⌘ + <letter>` or `Ctrl/⌘ + Shift + <reserved letter>`.
 *     Browsers reserve Ctrl/Cmd + {A,B,D,E,F,G,H,J,K,L,N,O,P,Q,R,S,T,U,W,X,Y,Z,
 *     0-9} and most of Ctrl/⌘+Shift+{A,B,D,G,I,J,K,M,N,O,P,R,T,W} (new window,
 *     find-next, devtools, bookmark manager, private window, hard reload, …).
 *     The letters F/E/S are free under Shift on the supported browsers
 *     (§9.4 floor: last 2 majors of Chrome/Edge/Firefox/Safari), which is why
 *     the map reads Ctrl+Shift+F / E / S — the natural letters (A/C/N) are all
 *     browser-reserved.
 *  3. Nothing on `Alt+…` (OS menu accelerators, browser back/forward/home) and
 *     nothing on `Ctrl/⌘+Alt+…` or Insert/CapsLock (screen-reader reserved).
 *     `Alt+↑/↓` stay owned by the M6 reorder layer (core-domain §8.2) and are
 *     documented in the help dialog, not rebound here.
 *  4. A composition (Thai IME) in progress suppresses every binding.
 *
 * `RESERVED_COMBOS` below is the executable form of rules 1–3: the unit suite
 * asserts the shipped map has an empty intersection with it, so a future binding
 * cannot silently re-enter reserved territory.
 */

export type ShortcutId = 'palette' | 'quickAdd' | 'search' | 'help';

export interface Combo {
  /** `true` = Ctrl on Windows/Linux, ⌘ on macOS. */
  readonly mod: boolean;
  readonly shift: boolean;
  /** `KeyboardEvent.key` to match (lowercase letters / punctuation). */
  readonly key: string;
  /** `KeyboardEvent.code` fallback for layout-dependent punctuation (e.g. `?`). */
  readonly code?: string;
}

export interface ShortcutBinding {
  readonly id: ShortcutId;
  readonly combo: Combo;
  /** i18n key for the action name (help dialog + tests). */
  readonly labelKey: string;
  /** i18n key for the one-line description (help dialog). */
  readonly descriptionKey: string;
}

/** The shipped map. Every binding is documented in `ShortcutsHelpDialog` from THIS table. */
export const SHORTCUTS: readonly ShortcutBinding[] = [
  {
    id: 'palette',
    combo: { mod: true, shift: true, key: 'f' },
    labelKey: 'shortcuts.palette',
    descriptionKey: 'shortcuts.palette.desc',
  },
  {
    id: 'quickAdd',
    combo: { mod: true, shift: true, key: 'e' },
    labelKey: 'shortcuts.quickAdd',
    descriptionKey: 'shortcuts.quickAdd.desc',
  },
  {
    id: 'search',
    combo: { mod: true, shift: true, key: 's' },
    labelKey: 'shortcuts.search',
    descriptionKey: 'shortcuts.search.desc',
  },
  {
    id: 'help',
    combo: { mod: false, shift: true, key: '?', code: 'Slash' },
    labelKey: 'shortcuts.help',
    descriptionKey: 'shortcuts.help.desc',
  },
];

/**
 * Combos no binding may use — browser or screen-reader reserved (policy rules
 * 1–3). Kept as data so `tests/unit/commands/keymap.test.ts` can enforce the
 * policy mechanically. `mod` combos cover Ctrl/⌘ families.
 */
export const RESERVED_COMBOS: readonly Combo[] = [
  // Browser file/window/edit surface (Ctrl/Cmd + letter).
  ...[
    'a',
    'b',
    'd',
    'e',
    'f',
    'g',
    'h',
    'j',
    'k',
    'l',
    'n',
    'o',
    'p',
    'q',
    'r',
    's',
    't',
    'u',
    'w',
  ].map((key) => ({ mod: true, shift: false, key })),
  // Browser/IDE-reserved Ctrl/Cmd+Shift families (incognito, devtools, bookmark
  // manager, private window, reopen tab, hard reload, find previous, tab search…).
  ...['a', 'b', 'd', 'g', 'i', 'j', 'k', 'm', 'n', 'o', 'p', 'r', 't', 'w'].map((key) => ({
    mod: true,
    shift: true,
    key,
  })),
  // Firefox quick find + link find.
  { mod: false, shift: false, key: '/' },
  { mod: false, shift: false, key: "'" },
  // Browser back/forward/home and OS menu accelerators.
  { mod: false, shift: false, key: 'arrowleft' },
  { mod: false, shift: false, key: 'arrowright' },
  { mod: false, shift: false, key: 'home' },
];

/** A keydown-shaped input the matcher accepts (real events and test doubles). */
export interface KeyLike {
  readonly key: string;
  readonly code?: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

function comboMatches(event: KeyLike, combo: Combo): boolean {
  if (combo.mod) {
    // Exactly one of Ctrl / ⌘ — a chord carrying both (or neither) is not ours.
    if (event.ctrlKey === event.metaKey) return false;
    if (event.altKey) return false;
    return event.shiftKey === combo.shift && normalizedKey(event) === combo.key;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (event.shiftKey !== combo.shift) return false;
  return (
    normalizedKey(event) === combo.key ||
    (combo.code !== undefined && event.code === combo.code && event.shiftKey)
  );
}

function normalizedKey(event: KeyLike): string {
  return event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase();
}

/** The binding this event triggers, or `null`. Pure — context rules live in `shortcutLayer`. */
export function matchShortcut(event: KeyLike): ShortcutBinding | null {
  for (const binding of SHORTCUTS) {
    if (comboMatches(event, binding.combo)) return binding;
  }
  return null;
}

/** Human-readable combo for the help dialog: `Ctrl/⌘ + Shift + F`, `?`. */
export function formatCombo(combo: Combo): string {
  const parts: string[] = [];
  if (combo.mod) parts.push('Ctrl/⌘');
  if (combo.shift && combo.key !== '?') parts.push('Shift');
  parts.push(combo.key === '?' ? '?' : combo.key.toUpperCase());
  return parts.join(' + ');
}

/** `input` / `textarea` / `select` / contenteditable — typing must always win. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  // `unknown` compare: jsdom returns `undefined` for `isContentEditable`, and this
  // predicate must be total (never `undefined`) in every environment.
  const contentEditable: unknown = target.isContentEditable;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || contentEditable === true;
}
