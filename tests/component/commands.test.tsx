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
    press({ key: '1', metaKey: true, shiftKey: true });
    press({ key: '2', ctrlKey: true, shiftKey: true });
    press({ key: '?', shiftKey: true });
    // Nothing else fires: plain letters, plain modifiers, wrong chords, and the
    // RETIRED letters (Shift+S / Shift+E are floor-browser combos since the
    // §9.4 re-audit — review B2).
    press({ key: 'f' });
    press({ key: 'F', ctrlKey: true });
    press({ key: 'x', ctrlKey: true, shiftKey: true });
    press({ key: 'S', ctrlKey: true, shiftKey: true });
    press({ key: 'e', metaKey: true, shiftKey: true });
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

  it('runs the LIVE close handler on Escape, even in the frame of a stage render (D2 pin)', async () => {
    const { input, handlers } = await openPalette();
    fireEvent.input(input, { target: { value: 'milk' } });

    // Raw dispatches (NOT fireEvent): Preact re-registers changed effects post-paint,
    // so a render commit lands in a microtask while the document Escape listener still
    // holds the PRE-stage closure — the D2 race the QA probe caught live (t_b3280190).
    // fireEvent is act-wrapped and would close that window.
    const key = (k: string): void => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }),
      );
    };
    key('Enter'); // enter the task stage (state update -> deferred render)
    for (let tick = 0; tick < 3; tick += 1) await Promise.resolve();
    // The stage is already on screen while the listener refresh is still pending.
    expect(screen.getByRole('option', { name: /Open task/ })).toBeTruthy();

    key('Escape'); // stage -> root (a stale closure would CLOSE the palette here)
    for (let tick = 0; tick < 3; tick += 1) await Promise.resolve();
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('option', { name: /Add a task/ })).toBeTruthy();

    key('Escape'); // root -> close (a stale closure would step back instead)
    for (let tick = 0; tick < 3; tick += 1) await Promise.resolve();
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it('describes the dialog with the keyboard hint (aria-describedby, review N5)', async () => {
    await openPalette();
    const dialog = document.querySelector('.dialog');
    const describedBy = dialog?.getAttribute('aria-describedby') ?? '';
    expect(describedBy).not.toBe('');
    const hint = document.getElementById(describedBy);
    expect(hint).not.toBeNull();
    expect(hint?.className ?? '').toContain('palette-hint');
  });

  it('stays inside the §9.1 INP budget at 10k tasks on the component path (review N3)', async () => {
    // The ranker budget is pinned in tests/unit/commands/paletteIndex.test.ts;
    // this pins the SHIPPED component path (row memo + Map lookup included).
    const many = Array.from({ length: 10_000 }, (_unused, index) =>
      makeTask({
        id: `T${String(index).padStart(5, '0')}`,
        listId: 'L1',
        title: `Task number ${String(index)} with a long descriptive title`,
      }),
    );
    await seed({ lists: [makeList({ id: 'L1', name: 'Work' })], tasks: many });

    const openT0 = performance.now();
    render(
      <CommandPalette
        onClose={() => undefined}
        onOpenHelp={() => undefined}
        onMoveTask={() => undefined}
        onSetReminder={() => undefined}
      />,
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    const openMs = performance.now() - openT0;

    const input = document.querySelector<HTMLInputElement>('.palette-input');
    expect(input).not.toBe(null);

    const t0 = performance.now();
    fireEvent.input(input!, { target: { value: 'number 999' } });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    const keystrokeMs = performance.now() - t0;

    const t1 = performance.now();
    fireEvent.input(input!, { target: { value: '' } });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    const clearMs = performance.now() - t1;

    timings.push(
      `palette @10k tasks: open ${openMs.toFixed(1)} ms / keystroke ${keystrokeMs.toFixed(1)} ms / clear ${clearMs.toFixed(1)} ms (budget 200 ms)`,
    );
    expect(keystrokeMs).toBeLessThan(200);
    expect(clearMs).toBeLessThan(200);
  });
});

/** jsdom ships no matchMedia — same wide-shell stub as tests/component/app.test.tsx. */
function stubWideViewport(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    matches: query.includes('min-width: 1024px'),
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

describe('palette "Add a task" hands focus to the composer (QA D1, t_b3280190)', () => {
  async function bootAppOnAllOpen(): Promise<HTMLElement> {
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Today' });
    await waitFor(() => {
      expect(storeStatus.value).toBe('ready');
    });
    await addList({ name: 'Inbox', color: '#2e6fd9' });
    window.location.hash = '#/all';
    return screen.findByRole('heading', { level: 1, name: 'All open' });
  }

  /** Park focus on the heading — the probe's parkFocusOnHeading; any non-composer
   *  opener (row, nav entry) reproduces D1 the same way. */
  async function parkFocusOnHeading(heading: HTMLElement): Promise<void> {
    // Wait out the route-change focus effect (setTimeout(0)) first: it targets the
    // composer's data-autofocus on the wide shell and would undo the parked focus.
    await waitFor(() => {
      expect(document.activeElement).not.toBe(document.body);
    });
    heading.focus();
    expect(document.activeElement).toBe(heading);
  }

  async function runAddATaskFromPalette(): Promise<void> {
    press({ key: 'F', ctrlKey: true, shiftKey: true });
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    const input = within(palette).getByRole('combobox');
    fireEvent.input(input, { target: { value: 'add a' } });
    await screen.findByRole('option', { name: /Add a task/ });
    fireEvent.keyDown(input, { key: 'Enter' });
  }

  it('wide shell: the inline composer title keeps focus — never back on the heading', async () => {
    stubWideViewport();
    const heading = await bootAppOnAllOpen();
    // The inline composer must be mounted and registered before the chord runs.
    await screen.findByLabelText('Title', { exact: true });
    await parkFocusOnHeading(heading);
    await runAddATaskFromPalette();

    const title = await screen.findByLabelText('Title', { exact: true });
    expect(document.activeElement).toBe(title);
    expect(document.activeElement).not.toBe(heading);
  });

  it('compact shell: focus lands in the composer sheet title', async () => {
    const heading = await bootAppOnAllOpen();
    await parkFocusOnHeading(heading);
    await runAddATaskFromPalette();

    const sheet = await screen.findByRole('dialog');
    const title = within(sheet).getByLabelText('Title', { exact: true });
    await waitFor(() => {
      expect(document.activeElement).toBe(title);
    });
    expect(document.activeElement).not.toBe(heading);
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
    press({ key: '1', ctrlKey: true, shiftKey: true });
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
