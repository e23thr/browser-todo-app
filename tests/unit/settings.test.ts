import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SETTINGS,
  getSettings,
  loadSettings,
  registerSettingsPersistence,
  setDefaultListId,
  setThemePref,
  setWeekStart,
  type AppSettings,
  type SettingsPersistence,
} from '../../src/app/settings';
import { THEME_PREF_KEY } from '../../src/app/theme';
import { ok, err, type StorageError } from '../../src/storage/errors';

function memoryPersistence(initial: Partial<AppSettings> | null = null) {
  const saved: AppSettings[] = [];
  let stored = initial;
  const persistence: SettingsPersistence = {
    load: async () => ok(stored),
    save: async (settings) => {
      saved.push(settings);
      stored = settings;
      return ok(undefined);
    },
  };
  return {
    persistence,
    saved,
    get stored(): Partial<AppSettings> | null {
      return stored;
    },
    set stored(value: Partial<AppSettings> | null) {
      stored = value;
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  registerSettingsPersistence(null);
  // Reset the store to defaults sourced from an empty mirror.
  return loadSettings();
});

afterEach(() => {
  registerSettingsPersistence(null);
  vi.restoreAllMocks();
});

describe('settings store defaults', () => {
  it('boots from the empty mirror with the ADR-002 defaults', async () => {
    await loadSettings();
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.weekStart).toBe(0);
    expect(getSettings().defaultListId).toBeNull();
  });

  it('applies the resolved theme to the document on load', async () => {
    window.localStorage.setItem(THEME_PREF_KEY, 'dark');
    await loadSettings();
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });
});

describe('theme changes', () => {
  it('updates the signal, the document and the pre-paint mirror together', async () => {
    await loadSettings();
    setThemePref('light');

    expect(getSettings().theme).toBe('light');
    expect(document.documentElement.dataset['theme']).toBe('light');
    expect(window.localStorage.getItem(THEME_PREF_KEY)).toBe('light');
  });

  it('never stores week start or default list in localStorage (boot-prefs only)', async () => {
    await loadSettings();
    setThemePref('dark');
    setWeekStart(1);
    setDefaultListId('list-1');

    expect([...Object.keys(window.localStorage)]).toEqual([THEME_PREF_KEY]);
    expect(window.localStorage.getItem(THEME_PREF_KEY)).toBe('dark');
  });
});

describe('durable persistence (ADR-002 settings record)', () => {
  it('saves every change through the persistence port', async () => {
    const store = memoryPersistence();
    registerSettingsPersistence(store.persistence);
    await loadSettings();

    setWeekStart(1);
    setDefaultListId('list-42');

    expect(store.saved).toEqual([
      { ...DEFAULT_SETTINGS, weekStart: 1 },
      { ...DEFAULT_SETTINGS, weekStart: 1, defaultListId: 'list-42' },
    ]);
  });

  it('lets the durable record win at boot and rewrites the mirror when they disagree', async () => {
    const store = memoryPersistence({ theme: 'dark', weekStart: 1, defaultListId: 'list-9' });
    registerSettingsPersistence(store.persistence);
    window.localStorage.setItem(THEME_PREF_KEY, 'light');

    await loadSettings();

    expect(getSettings()).toEqual({
      theme: 'dark',
      weekStart: 1,
      defaultListId: 'list-9',
    });
    expect(window.localStorage.getItem(THEME_PREF_KEY)).toBe('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });

  it('keeps the session working when the durable load fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    registerSettingsPersistence({
      load: async () => err({ code: 'UNAVAILABLE' } satisfies StorageError),
      save: async () => ok(undefined),
    });
    window.localStorage.setItem(THEME_PREF_KEY, 'light');

    await loadSettings();

    expect(getSettings().theme).toBe('light');
    expect(warn).toHaveBeenCalled();
  });

  it('reports a failed save without throwing and keeps the in-memory value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    registerSettingsPersistence({
      load: async () => ok(null),
      save: async () => err({ code: 'QUOTA_EXCEEDED' } satisfies StorageError),
    });
    await loadSettings();

    setWeekStart(1);

    expect(getSettings().weekStart).toBe(1);
    await Promise.resolve();
    expect(warn).toHaveBeenCalled();
  });

  it('tolerates a persistence port that rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    registerSettingsPersistence({
      load: async () => {
        throw new Error('boom');
      },
      save: async () => ok(undefined),
    });

    await expect(loadSettings()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
  });
});
