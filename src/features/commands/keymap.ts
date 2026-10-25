/**
 * Global keyboard shortcut map (V1 S8 — PROJECT_ANALYSIS §4 S8, §8).
 *
 * Conflict policy (binding decision on t_ee8ecb0b: "shortcuts must not shadow
 * browser/screen-reader combos"). The map was RE-AUDITED browser-by-browser
 * after review B2 (t_8f41af00) — per-browser evidence with one cited source per
 * browser lives in `docs/dev/commands-notify.md` §1.1:
 *
 *  1. Nothing unmodified. Screen readers (NVDA/JAWS/VoiceOver browse mode) bind
 *     bare letters for quick-nav, and Firefox binds `/` and `'` to quick find —
 *     so the ONLY unmodified-family binding is `?`, matched on the produced
 *     CHARACTER (some layouts type `?` unshifted — the shift state is not part
 *     of that chord).
 *  2. Nothing on `Ctrl/⌘ + <letter>` or `Ctrl/⌘ + Shift + <letter>` except `F`.
 *     The re-audit shows the four §9.4 floor browsers (Chrome/Edge/Firefox/
 *     Safari) between them bind EVERY `Ctrl/⌘+Shift+letter` except `F`:
 *     `S` = Firefox "Take a screenshot" / Edge Screenshot (Web Capture) /
 *     macOS ⇧⌘S "Save As"; `E` = Firefox "Network" / Edge "Open search in
 *     sidebar"; and so on for every other letter (table in the doc). The one
 *     cleared chord, `Ctrl/⌘+Shift+F`, is owned by the palette (Firefox's
 *     Style-Editor "Replace" is toolbox-scoped and never reaches the page), so
 *     the two remaining actions moved to the digit family — `Ctrl/⌘+Shift+1/2`
 *     — which no floor browser binds (macOS ⌘⇧3/4/5/6 are system screenshots
 *     and are reserved below).
 *  3. Nothing on `Alt+…` (OS menu accelerators, browser back/forward/home) and
 *     nothing on `Ctrl/⌘+Alt+…` or Insert/CapsLock (screen-reader reserved).
 *     `Alt+↑/↓` stay owned by the M6 reorder layer (core-domain §8.2) and are
 *     documented in the help dialog, not rebound here.
 *  4. A composition (Thai IME) in progress suppresses every binding.
 *
 * `RESERVED_COMBOS` below is the executable form of rules 1–3: the unit suite
 * asserts the shipped map has an empty intersection with it, so a future binding
 * cannot silently re-enter reserved territory. Every entry carries the vendor
 * evidence recorded in `docs/dev/commands-notify.md` §1.1 (review B2: the old
 * list omitted `Ctrl+Shift+S`, which is exactly how that conflict shipped).
 */

export type ShortcutId = 'palette' | 'quickAdd' | 'search' | 'help';

export interface Combo {
  /** `true` = Ctrl on Windows/Linux, ⌘ on macOS. */
  readonly mod: boolean;
  readonly shift: boolean;
  /** `KeyboardEvent.key` to match (lowercase letters / digits / punctuation). */
  readonly key: string;
  /** `KeyboardEvent.code` fallback for layout-dependent keys (e.g. `?`, digits). */
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
    combo: { mod: true, shift: true, key: '1', code: 'Digit1' },
    labelKey: 'shortcuts.quickAdd',
    descriptionKey: 'shortcuts.quickAdd.desc',
  },
  {
    id: 'search',
    combo: { mod: true, shift: true, key: '2', code: 'Digit2' },
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
 * Combos no binding may use — browser, OS or screen-reader reserved (policy
 * rules 1–3). Kept as data so `tests/unit/commands/keymap.test.ts` can enforce
 * the policy mechanically. `mod` combos cover Ctrl/⌘ families.
 */
export const RESERVED_COMBOS: readonly Combo[] = [
  // Browser file/window/edit surface (Ctrl/Cmd + letter).
  ...[
    'a',
    'b',
    'c',
    'd',
    'e',
    'f',
    'g',
    'h',
    'i',
    'j',
    'k',
    'l',
    'm',
    'n',
    'o',
    'p',
    'q',
    'r',
    's',
    't',
    'u',
    'v',
    'w',
    'x',
    'y',
    'z',
  ].map((key) => ({ mod: true, shift: false, key })),
  // Ctrl/Cmd + digit: tab switching (Chrome/Edge/Firefox), zoom reset.
  ...['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].map((key) => ({
    mod: true,
    shift: false,
    key,
  })),
  // Ctrl/Cmd+Shift + letter: the floor browsers between them bind every letter
  // EXCEPT `F` (the single chord the re-audit cleared — the palette owns it).
  // Verbatim: `S` = Firefox "Take a screenshot" / Edge "Screenshot (previously
  // named Web Capture)" / macOS ⇧⌘S "Save As"; `E` = Firefox "Network" / Edge
  // "Open search in sidebar". Per-browser table: docs/dev/commands-notify.md §1.1.
  ...[
    'a',
    'b',
    'c',
    'd',
    'e',
    'g',
    'h',
    'i',
    'j',
    'k',
    'l',
    'm',
    'n',
    'o',
    'p',
    'q',
    'r',
    's',
    't',
    'u',
    'v',
    'w',
    'x',
    'y',
    'z',
  ].map((key) => ({ mod: true, shift: true, key })),
  // macOS system screenshots (support.apple.com/en-us/102650): ⇧⌘3/⇧⌘4 capture
  // the screen, ⇧⌘5 the screenshot toolbar, ⇧⌘6 the same system family.
  ...['3', '4', '5', '6'].map((key) => ({ mod: true, shift: true, key })),
  // Tab/window/page chords on the non-letter keys (Chrome/Edge/Firefox lists).
  ...['tab', 'pageup', 'pagedown', 'home', 'end', 'enter', 'delete'].map((key) => ({
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
    if (event.shiftKey !== combo.shift) return false;
    // `key` first (letters), then the `code` fallback for keys whose `key`
    // value is layout-shifted (the digit row arrives as `!`/`"`/… on some
    // layouts while `code` stays `Digit1`/`Digit2`).
    return (
      normalizedKey(event) === combo.key || (combo.code !== undefined && event.code === combo.code)
    );
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  const key = normalizedKey(event);
  if (key === combo.key) {
    // `?` matches on the produced CHARACTER: some layouts type `?` unshifted
    // and that keystroke must still open help (review N2). Every other combo
    // keeps the strict shift match.
    return combo.key === '?' || event.shiftKey === combo.shift;
  }
  // Physical-key fallback for layouts whose `key` value differs from the map
  // (e.g. `?` reported as `/` on Shift+Slash). Shift stays part of the chord
  // here so a bare `/` — Firefox quick-find territory — is never ours.
  return combo.code !== undefined && event.code === combo.code && event.shiftKey === combo.shift;
}

function normalizedKey(event: KeyLike): string {
  return event.key.toLowerCase();
}

/** The binding this event triggers, or `null`. Pure — context rules live in `shortcutLayer`. */
export function matchShortcut(event: KeyLike): ShortcutBinding | null {
  for (const binding of SHORTCUTS) {
    if (comboMatches(event, binding.combo)) return binding;
  }
  return null;
}

/** Human-readable combo for the help dialog: `Ctrl/⌘ + Shift + F`, `Ctrl/⌘ + Shift + 1`, `?`. */
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
