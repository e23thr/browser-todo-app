/**
 * S10 `<StoragePanel>` import-button routing (§9.4):
 *  - Chromium (open picker installed): the SYSTEM open dialog runs inside the
 *    click gesture and the picked File goes to `onImport` — no hidden input.
 *  - User cancels the dialog: nothing happens (a cancel is not an error, and
 *    the upload fallback must NOT double-prompt).
 *  - No picker (Safari/Firefox): the visible button drives the hidden input —
 *    the universal upload path, still keyboard-reachable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fireEvent, render, screen } from '@testing-library/preact';

import { StoragePanel } from '../../src/features/data-safety/StoragePanel';
import { resetFlags } from '../../src/features/data-safety/flags';
import { setLocale } from '../../src/i18n';

type Globals = { showOpenFilePicker?: unknown };
const g = globalThis as Globals;

let inputClicks = 0;
let originalInputClick: unknown;

function captured(target: object, key: string): unknown {
  return Reflect.get(target, key);
}

function abortError(): Error {
  const e = new Error('The user aborted a request.');
  e.name = 'AbortError';
  return e;
}

beforeEach(async () => {
  window.localStorage.clear();
  resetFlags();
  await setLocale('en');
  inputClicks = 0;
  // The hidden input's click is what the fallback path calls — count it.
  originalInputClick = captured(HTMLInputElement.prototype, 'click');
  Reflect.set(HTMLInputElement.prototype, 'click', function click(this: unknown) {
    inputClicks += 1;
  });
});

afterEach(() => {
  Reflect.set(HTMLInputElement.prototype, 'click', originalInputClick);
  delete g.showOpenFilePicker;
  vi.restoreAllMocks();
});

function renderPanel(onImport: (file: File) => void) {
  return render(
    <StoragePanel
      quota={{ usedBytes: 1, totalBytes: 100 }}
      persistence="granted"
      lastBackupAt={null}
      snapshots={[]}
      onRequestPersist={() => undefined}
      onExport={() => undefined}
      onImport={onImport}
      onRestoreSnapshot={() => undefined}
      onDownloadSnapshot={() => undefined}
      onDeleteAll={() => undefined}
    />,
  );
}

function importButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Import…' });
}

describe('<StoragePanel> S10 import routing', () => {
  it('Chromium: the open dialog runs in the gesture and its File reaches onImport', async () => {
    const picked = { name: 'todo.txt' } as unknown as File;
    const api = vi.fn(async () => [{ getFile: async () => picked }]);
    g.showOpenFilePicker = api;
    const onImport = vi.fn();
    renderPanel(onImport);

    fireEvent.click(importButton());
    await vi.waitFor(() => {
      expect(onImport).toHaveBeenCalledWith(picked);
    });
    expect(api).toHaveBeenCalledOnce();
    expect(inputClicks).toBe(0); // the hidden input never fired — no double prompt
  });

  it('user cancels the open dialog: no import, no fallback prompt', async () => {
    g.showOpenFilePicker = vi.fn(async () => Promise.reject(abortError()));
    const onImport = vi.fn();
    renderPanel(onImport);

    fireEvent.click(importButton());
    await vi.waitFor(() => {
      expect(g.showOpenFilePicker).toHaveBeenCalled();
    });
    // Give the .then() chain a beat to prove no fallback fired afterwards.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onImport).not.toHaveBeenCalled();
    expect(inputClicks).toBe(0);
  });

  it('no picker (Safari/Firefox): the button drives the hidden input fallback', () => {
    const onImport = vi.fn();
    renderPanel(onImport);

    fireEvent.click(importButton());
    expect(inputClicks).toBe(1);
    expect(onImport).not.toHaveBeenCalled();
  });

  it('picker errors fall back to the hidden input (universal upload path)', async () => {
    g.showOpenFilePicker = vi.fn(async () => Promise.reject(new Error('not allowed')));
    const onImport = vi.fn();
    renderPanel(onImport);

    fireEvent.click(importButton());
    await vi.waitFor(() => {
      expect(inputClicks).toBe(1);
    });
    expect(onImport).not.toHaveBeenCalled();
  });
});
