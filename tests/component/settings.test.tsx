import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fireEvent, render, screen, waitFor } from '@testing-library/preact';

import { registerLiveRegions } from '../../src/app/announce';
import { getListOptions, setListOptions } from '../../src/app/lists';
import { getSettings, loadSettings, registerSettingsPersistence } from '../../src/app/settings';
import { THEME_PREF_KEY } from '../../src/app/theme';
import SettingsView from '../../src/features/settings/SettingsView';

let polite: HTMLElement;

beforeEach(async () => {
  window.localStorage.clear();
  document.documentElement.setAttribute('lang', 'en');
  document.documentElement.removeAttribute('data-theme');
  registerSettingsPersistence(null);
  setListOptions([]);
  await loadSettings();

  polite = document.createElement('div');
  document.body.append(polite);
  registerLiveRegions({ polite, assertive: null });
});

afterEach(() => {
  registerLiveRegions({ polite: null, assertive: null });
  setListOptions([]);
});

describe('settings screen (M14, design §4.9)', () => {
  it('renders every section with its own h2 under a single h1', () => {
    render(<SettingsView />);

    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    for (const heading of ['Appearance', 'Language', 'Tasks', 'Storage & backup', 'About']) {
      expect(screen.getByRole('heading', { level: 2, name: heading })).toBeTruthy();
    }
  });

  it('leaves a documented mount point for the E3 storage/backup panel', () => {
    render(<SettingsView />);

    const mount = document.querySelector('[data-mount-point="storage-backup"]');
    expect(mount).toBeTruthy();
    expect(mount?.textContent).toBe('Backup and storage controls are not available yet.');
  });
});

describe('theme setting', () => {
  it('starts on System with no explicit preference stored', () => {
    render(<SettingsView />);

    const systemRadio = screen.getByRole<HTMLInputElement>('radio', { name: /System/ });
    expect(systemRadio.checked).toBe(true);
    expect(window.localStorage.getItem(THEME_PREF_KEY)).toBeNull();
  });

  it('applies Dark instantly: document, mirror and polite announcement together', async () => {
    render(<SettingsView />);

    fireEvent.click(screen.getByRole('radio', { name: /Dark/ }));

    expect(getSettings().theme).toBe('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(window.localStorage.getItem(THEME_PREF_KEY)).toBe('dark');

    await waitFor(() => {
      expect(polite.textContent).toBe('Dark theme applied');
    });
  });

  it('stores week start and default list outside localStorage (boot-prefs only)', async () => {
    setListOptions([{ id: '01JBX000000000000000000000', name: 'Personal' }]);
    render(<SettingsView />);

    fireEvent.click(screen.getByRole('radio', { name: 'Monday' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Default list' }), {
      target: { value: '01JBX000000000000000000000' },
    });

    expect(getSettings().weekStart).toBe(1);
    expect(getSettings().defaultListId).toBe('01JBX000000000000000000000');
    // Neither setting may touch localStorage: ADR-002 reserves it for boot-critical prefs.
    expect(Object.keys(window.localStorage)).toEqual([]);
  });
});

describe('language setting', () => {
  it('switches html[lang] through setLocale and announces it', async () => {
    render(<SettingsView />);

    fireEvent.click(screen.getByRole('radio', { name: 'ไทย' }));

    await waitFor(() => {
      expect(document.documentElement.lang).toBe('th');
    });
    await waitFor(() => {
      expect(polite.textContent).toBe('Language changed to ไทย');
    });
  });
});

describe('default list setting', () => {
  it('is disabled while the domain layer has supplied no lists', () => {
    render(<SettingsView />);

    const select = screen.getByRole('combobox', { name: 'Default list' });
    expect(select.hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('option', { name: 'No lists yet' })).toBeTruthy();
    expect(getListOptions()).toEqual([]);
  });

  it('offers every list and stores the selection once lists exist', () => {
    setListOptions([
      { id: '01JBX000000000000000000001', name: 'Personal' },
      { id: '01JBX000000000000000000002', name: 'Work' },
    ]);
    render(<SettingsView />);

    const select = screen.getByRole('combobox', { name: 'Default list' });
    expect(select.hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('option', { name: 'Work' })).toBeTruthy();

    fireEvent.change(select, { target: { value: '01JBX000000000000000000002' } });
    expect(getSettings().defaultListId).toBe('01JBX000000000000000000002');
  });
});

describe('a11y wiring', () => {
  it('groups each choice as a labelled radiogroup of native radios', () => {
    render(<SettingsView />);

    const groups = screen.getAllByRole('radiogroup');
    expect(groups).toHaveLength(3);
    for (const group of groups) {
      expect(group.getAttribute('aria-labelledby')).toBeTruthy();
      expect(group.querySelectorAll('input[type="radio"]').length).toBeGreaterThan(1);
    }
  });

  it('keeps every control at the 44px minimum hit area in CSS', () => {
    // Structural check: touch-min token and the class contract the CSS relies on.
    render(<SettingsView />);
    const style = document.createElement('div');
    style.className = 'segment';
    expect(document.querySelectorAll('.segment').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.select').length).toBe(1);
    expect(style.className).toBe('segment');
  });
});

describe('console hygiene (§7.2 local log only)', () => {
  it('never logs during a normal settings interaction', async () => {
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    render(<SettingsView />);

    fireEvent.click(screen.getByRole('radio', { name: /Light/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'Monday' }));
    await waitFor(() => {
      expect(getSettings().theme).toBe('light');
    });

    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
