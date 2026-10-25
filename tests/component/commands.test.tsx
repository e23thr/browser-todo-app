/**
 * S8 keyboard shortcuts + command palette — component contract tests.
 *
 * Covers the card's acceptance criteria:
 *  - the shortcut map is documented in the help dialog, one row per binding,
 *    rendered from the same table the layer matches against;
 *  - every binding fires its action and the suppression rules hold (typing,
 *    modal dialog, IME composition, auto-repeat) — no browser/AT shadowing;
 *  - the palette covers the core loop (add, complete, move, search, settings)
 *    end-to-end with KEYBOARD EVENTS ONLY (no pointer events anywhere);
 *  - quick add captures a task in well under the 5-second budget (measured).
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';

import { App } from '../../src/app/App';
import { registerSettingsPersistence } from '../../src/app/settings';
import { CommandPalette } from '../../src/features/commands/CommandPalette';
import { SHORTCUTS, formatCombo } from '../../src/features/commands/keymap';
import { installShortcutLayer } from '../../src/features/commands/shortcutLayer';
import { ShortcutsHelpDialog } from '../../src/features/commands/ShortcutsHelpDialog';
import { addList, state, status as storeStatus } from '../../src/features/tasks/store';
import { writeEvidence } from '../evidence';
import { makeList, makeTask, seed, setUpCoreUi, tearDownCoreUi } from './core-ui-harness';

const timings: string[] = [];

function press(init: KeyboardEventInit & { key: string }): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  setUpCoreUi();
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
  registerSettingsPersistence(null);
});

afterEach(() => {
  tearDownCoreUi();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('shortcut layer (S8)', () => {
  it('fires one handler per binding and suppresses everything else', () => {
    const calls: string[] = [];
    const dispose = installShortcutLayer({
      palette: () => calls.push('palette'),
      quickAdd: () => calls.push('quickAdd'),
      search: () => calls.push('search'),
      help: () => calls.push('help'),
    });

    press({ key: 'F', ctrlKey: true, shiftKey: true });
    press({ key: 'e', metaKey: true, shiftKey: true });
    press({ key: 'S', ctrlKey: true, shiftKey: true });
    press({ key: '?', shiftKey: true });
    // Nothing else fires: plain letters, plain modifiers, wrong chords.
    press({ key: 'f' });
    press({ key: 'F', ctrlKey: true });
    press({ key: 'x', ctrlKey: true, shiftKey: true });
    expect(calls).toEqual(['palette', 'quickAdd', 'search', 'help']);

    dispose();
    press({ key: 'F', ctrlKey: true, shiftKey: true });
    expect(calls).toHaveLength(4);
  });

  it('never fires while a text field has focus (typing wins)', () => {
    const calls: string[] = [];
    const dispose = installShortcutLayer({
      help: () => calls.push('help'),
      palette: () => calls.push('palette'),
    });
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();

    fireEvent.keyDown(input, { key: '?', shiftKey: true });
    expect(calls).toEqual([]);
    // The modifier chord is safe while typing but suppressed here too only for
    // the unmodified family — the chord still fires (documented policy).
    fireEvent.keyDown(input, { key: 'F', ctrlKey: true, shiftKey: true });
    expect(calls).toEqual(['palette']);
    dispose();
    input.remove();
  });

  it('stays silent while a modal dialog is open, during IME composition and on repeat', () => {
    const calls: string[] = [];
    const dispose = installShortcutLayer({ palette: () => calls.push('palette') });

    const dialog = document.createElement('div');
    dialog.className = 'dialog-layer';
    document.body.append(dialog);
    press({ key: 'F', ctrlKey: true, shiftKey: true });
    expect(calls).toEqual([]);
    dialog.remove();

    press({ key: 'F', ctrlKey: true, shiftKey: true, isComposing: true });
    expect(calls).toEqual([]);
    press({ key: 'F', ctrlKey: true, shiftKey: true, repeat: true });
    expect(calls).toEqual([]);

    press({ key: 'F', ctrlKey: true, shiftKey: true });
    expect(calls).toEqual(['palette']);
    dispose();
  });

  it('leave default browser behavior alone unless a handler runs', () => {
    const dispose = installShortcutLayer({});
    const unhandled = press({ key: 'F', ctrlKey: true, shiftKey: true });
    expect(unhandled.defaultPrevented).toBe(false);
    dispose();

    const dispose2 = installShortcutLayer({ palette: () => undefined });
    const handled = press({ key: 'F', ctrlKey: true, shiftKey: true });
    expect(handled.defaultPrevented).toBe(true);
    dispose2();
  });
});

describe('shortcuts help dialog (discoverability)', () => {
  it('documents every binding from the live map with its formatted combo', () => {
    render(<ShortcutsHelpDialog onClose={() => undefined} />);
    const map = screen.getByTestId('shortcut-map');
    for (const binding of SHORTCUTS) {
      const row = map.querySelector(`[data-shortcut-id="${binding.id}"]`);
      expect(row, binding.id).not.toBeNull();
      expect(row?.textContent ?? '').toContain(formatCombo(binding.combo));
      expect(row?.textContent ?? '').not.toContain(binding.labelKey); // resolved t(), not raw key
    }
    // The widget-level map (M6 reorder, editor save, Escape) is documented too.
    expect(screen.getByText('Move the focused task', { exact: true })).toBeTruthy();
    expect(screen.getByText('Escape', { exact: true })).toBeTruthy();
  });

  it('closes on Escape and hands the palette action over', () => {
    const onClose = vi.fn();
    render(<ShortcutsHelpDialog onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('command palette (S8 core loop, keyboard-only)', () => {
  async function openPalette() {
    await seed({
      lists: [makeList({ id: 'L1', name: 'Work' }), makeList({ id: 'L2', name: 'Home' })],
      tasks: [
        makeTask({ id: 'T1', listId: 'L1', title: 'Buy milk' }),
        makeTask({ id: 'T2', listId: 'L2', title: 'Call mom' }),
      ],
    });
    const handlers = {
      onClose: vi.fn(),
      onOpenHelp: vi.fn(),
      onMoveTask: vi.fn(),
      onSetReminder: vi.fn(),
    };
    render(<CommandPalette {...handlers} />);
    const input = screen.getByRole('combobox');
    return { input, handlers };
  }

  it('fuzzy-filters actions and tasks and runs the highlighted entry with Enter', async () => {
    const { input, handlers } = await openPalette();

    fireEvent.input(input, { target: { value: 'milk' } });
    const option = await screen.findByRole('option', { name: /Buy milk/ });
    expect(option.getAttribute('data-kind')).toBe('task');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(handlers.onClose).not.toHaveBeenCalled(); // stage 2 opens first
    expect(await screen.findByRole('option', { name: /Open task/ })).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter' }); // "Open task" -> close + navigate
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it('covers the core loop: add, complete, move, search, settings', async () => {
    const { input, handlers } = await openPalette();

    // add
    fireEvent.input(input, { target: { value: 'add a' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(handlers.onClose).toHaveBeenCalledTimes(1);

    // search + settings are actions reached by fuzzy query
    fireEvent.input(input, { target: { value: 'sear' } });
    expect(await screen.findByRole('option', { name: /Search tasks/ })).toBeTruthy();
    fireEvent.input(input, { target: { value: 'settings' } });
    expect(await screen.findByRole('option', { name: /Open settings/ })).toBeTruthy();

    // complete + move on a task (stage 2)
    fireEvent.input(input, { target: { value: 'mom' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // Open -> Mark complete
    fireEvent.keyDown(input, { key: 'Enter' }); // runs + closes
    await waitFor(() => {
      expect(state.value.tasks.get('T2')?.status).toBe('done');
    });
    fireEvent.keyDown(input, { key: 'Escape' }); // task stage -> root
    fireEvent.input(input, { target: { value: 'mom' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // -> Move to list…
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(handlers.onMoveTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'T2' }));
  });

  it('moves the active option with arrows (aria-activedescendant) and steps back with Escape', async () => {
    const { input, handlers } = await openPalette();

    fireEvent.input(input, { target: { value: '' } });
    const first = input.getAttribute('aria-activedescendant');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).not.toBe(first);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.getAttribute('aria-activedescendant')).toBe(first);

    fireEvent.input(input, { target: { value: 'milk' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByRole('option', { name: /Set reminder…/ })).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Escape' }); // stage 2 -> root
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(await screen.findByRole('option', { name: /Add a task/ })).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Escape' }); // root -> close
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });
});

describe('quick add via shortcut (P4 JTBD: < 5 seconds)', () => {
  it('captures a typed task from the shortcut with keyboard only', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Today' });
    // The composer is disabled without a list (checklist item 16) — a real user
    // has one; seed the booted store through its own write path.
    await waitFor(() => {
      expect(storeStatus.value).toBe('ready');
    });
    await addList({ name: 'Inbox', color: '#2e6fd9' });

    const started = performance.now();
    press({ key: 'E', ctrlKey: true, shiftKey: true });
    const sheet = await screen.findByRole('dialog');
    const title = within(sheet).getByLabelText('Title', { exact: true });
    fireEvent.input(title, { target: { value: 'Water the plants' } });
    fireEvent.keyDown(title, { key: 'Enter' });

    await waitFor(() => {
      expect(
        [...state.value.tasks.values()].some((task) => task.title === 'Water the plants'),
      ).toBe(true);
    });
    const elapsed = performance.now() - started;
    timings.push(`quick add shortcut -> captured task: ${elapsed.toFixed(0)} ms (budget 5000 ms)`);
    expect(elapsed).toBeLessThan(5000);
  });
});

afterAll(() => {
  writeEvidence(
    'e9-quickadd-timing.md',
    [
      '# E9 quick-add interaction timing (jsdom)',
      '',
      ...timings,
      '',
      'Note: jsdom wall-clock for the scripted keyboard interaction (shortcut -> type ->',
      'Enter -> task in store). The human-scale measure belongs to the E9 test card.',
    ].join('\n'),
  );
});
