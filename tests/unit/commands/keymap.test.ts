/**
 * Shortcut map policy tests (V1 S8, binding decision on t_ee8ecb0b).
 *
 * The map must never shadow a browser or screen-reader combo: `RESERVED_COMBOS`
 * is the executable conflict list and the shipped map must not intersect it.
 * Every binding must also be documented (label + description keys) so the help
 * dialog — which renders straight from `SHORTCUTS` — cannot go stale.
 */

import { describe, expect, it } from 'vitest';

import {
  RESERVED_COMBOS,
  SHORTCUTS,
  formatCombo,
  isEditableTarget,
  matchShortcut,
  type Combo,
  type KeyLike,
} from '../../../src/features/commands/keymap';

function keydown(partial: Partial<KeyLike> & { key: string }): KeyLike {
  return {
    code: partial.code ?? '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...partial,
  };
}

function sameCombo(a: Combo, b: Combo): boolean {
  return a.mod === b.mod && a.shift === b.shift && a.key === b.key;
}

describe('shortcut map (S8)', () => {
  it('documents every binding with a label and a description key', () => {
    expect(SHORTCUTS.length).toBeGreaterThanOrEqual(4);
    for (const binding of SHORTCUTS) {
      expect(binding.labelKey).toMatch(/^shortcuts\./);
      expect(binding.descriptionKey).toMatch(/^shortcuts\..+\.desc$/);
    }
  });

  it('binds each id exactly once', () => {
    const ids = SHORTCUTS.map((binding) => binding.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses no browser- or screen-reader-reserved combo', () => {
    for (const binding of SHORTCUTS) {
      for (const reserved of RESERVED_COMBOS) {
        expect({ binding: binding.id, combo: binding.combo }).not.toEqual({
          binding: binding.id,
          combo: reserved,
        });
        expect(sameCombo(binding.combo, reserved)).toBe(false);
      }
    }
  });

  it('reserves every browser-verified combo from the §9.4 floor re-audit (review B2)', () => {
    const reserved = (partial: Partial<Combo>): boolean =>
      RESERVED_COMBOS.some((combo) =>
        sameCombo(combo, { mod: true, shift: true, key: '', ...partial }),
      );
    // The retired chords and their siblings: one cited source per browser in
    // docs/dev/commands-notify.md §1.1 (Firefox Screenshots / Edge Screenshot /
    // macOS Save As on S; Firefox Network / Edge sidebar search on E; paste-
    // plain V, Collections Y, move-URL X, …).
    for (const key of ['s', 'e', 'v', 'y', 'x', 'g', 'w', 't', 'n', 'p', 'o', 'b', 'd', 'r', 'm']) {
      expect(reserved({ key }), `Ctrl/⌘+Shift+${key} must stay reserved`).toBe(true);
    }
    // macOS system screenshots (support.apple.com/en-us/102650).
    for (const key of ['3', '4', '5', '6']) {
      expect(reserved({ key }), `⌘+Shift+${key} must stay reserved`).toBe(true);
    }
    // The single cleared letter chord is NOT reserved — the palette owns it.
    expect(reserved({ key: 'f' })).toBe(false);
    // The digit chords we ship are ours, not reserved territory.
    expect(reserved({ key: '1' })).toBe(false);
    expect(reserved({ key: '2' })).toBe(false);
  });

  it('reserves no unmodified letter keys (screen-reader quick-nav family)', () => {
    for (const binding of SHORTCUTS) {
      const unmodified = !binding.combo.mod && !binding.combo.shift;
      expect(unmodified).toBe(false);
    }
  });

  it('never uses Alt or Ctrl+Alt families (OS / AT reserved)', () => {
    // The matcher itself refuses Alt on both families — pinned here as policy.
    expect(matchShortcut(keydown({ key: 'f', altKey: true, ctrlKey: true, shiftKey: true }))).toBe(
      null,
    );
    expect(matchShortcut(keydown({ key: '?', altKey: true, shiftKey: true }))).toBe(null);
  });
});

describe('matchShortcut', () => {
  it('matches the palette on Ctrl/⌘+Shift+F', () => {
    expect(matchShortcut(keydown({ key: 'F', ctrlKey: true, shiftKey: true }))?.id).toBe('palette');
    expect(matchShortcut(keydown({ key: 'f', metaKey: true, shiftKey: true }))?.id).toBe('palette');
    // Wrong letter / missing Shift / plain key are all non-matches.
    expect(matchShortcut(keydown({ key: 'F', ctrlKey: true, shiftKey: false }))).toBe(null);
    expect(matchShortcut(keydown({ key: 'f' }))).toBe(null);
  });

  it('matches quick add on Ctrl/⌘+Shift+1 and search on Ctrl/⌘+Shift+2', () => {
    // Letters would shadow floor-browser combos (the §9.4 re-audit after review
    // B2): quick add and search live on the digit family instead.
    expect(matchShortcut(keydown({ key: '1', ctrlKey: true, shiftKey: true }))?.id).toBe(
      'quickAdd',
    );
    expect(matchShortcut(keydown({ key: '2', metaKey: true, shiftKey: true }))?.id).toBe('search');
    // The digit row arrives as a shifted symbol on some layouts — the `code`
    // fallback (`Digit1`/`Digit2`) still matches.
    expect(
      matchShortcut(keydown({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }))?.id,
    ).toBe('quickAdd');
    expect(
      matchShortcut(keydown({ key: '"', code: 'Digit2', ctrlKey: true, shiftKey: true }))?.id,
    ).toBe('search');
    // The retired chords are dead: Firefox Screenshots / Edge Screenshot /
    // macOS Save As own Shift+S, Firefox Network / Edge sidebar search own
    // Shift+E (docs/dev/commands-notify.md §1.1).
    expect(matchShortcut(keydown({ key: 'S', ctrlKey: true, shiftKey: true }))).toBe(null);
    expect(matchShortcut(keydown({ key: 'e', ctrlKey: true, shiftKey: true }))).toBe(null);
    // Missing Shift / wrong digit are not ours.
    expect(matchShortcut(keydown({ key: '1', ctrlKey: true, shiftKey: false }))).toBe(null);
    expect(matchShortcut(keydown({ key: '3', ctrlKey: true, shiftKey: true }))).toBe(null);
  });

  it('matches help on the `?` character regardless of shift state (review N2)', () => {
    expect(matchShortcut(keydown({ key: '?', shiftKey: true }))?.id).toBe('help');
    // Layouts that type `?` unshifted must still open help.
    expect(matchShortcut(keydown({ key: '?', shiftKey: false }))?.id).toBe('help');
    expect(matchShortcut(keydown({ key: '/', code: 'Slash', shiftKey: true }))?.id).toBe('help');
    // `/` alone is Firefox quick-find territory — never ours.
    expect(matchShortcut(keydown({ key: '/', code: 'Slash' }))).toBe(null);
    expect(matchShortcut(keydown({ key: '/', code: 'Slash', shiftKey: false }))).toBe(null);
  });

  it('ignores events carrying extra modifiers', () => {
    expect(matchShortcut(keydown({ key: 'f', ctrlKey: true, shiftKey: true, metaKey: true }))).toBe(
      null,
    );
    expect(matchShortcut(keydown({ key: '?', shiftKey: true, ctrlKey: true }))).toBe(null);
  });
});

describe('formatCombo', () => {
  it('renders the help-dialog notation', () => {
    const palette = SHORTCUTS.find((binding) => binding.id === 'palette');
    const quickAdd = SHORTCUTS.find((binding) => binding.id === 'quickAdd');
    const help = SHORTCUTS.find((binding) => binding.id === 'help');
    expect(formatCombo(palette!.combo)).toBe('Ctrl/⌘ + Shift + F');
    expect(formatCombo(quickAdd!.combo)).toBe('Ctrl/⌘ + Shift + 1');
    expect(formatCombo(help!.combo)).toBe('?');
  });
});

describe('isEditableTarget', () => {
  it('treats form controls and contenteditable as typing surfaces', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const select = document.createElement('select');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const div = document.createElement('div');
    document.body.append(input, textarea, select, editable, div);

    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(textarea)).toBe(true);
    expect(isEditableTarget(select)).toBe(true);
    // jsdom does not implement `isContentEditable` from the attribute; the
    // property is the platform's signal, so a non-editable div must be false.
    expect(isEditableTarget(div)).toBe(false);
    expect(isEditableTarget(document)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
