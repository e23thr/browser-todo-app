import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyTheme,
  prefersDark,
  readThemePref,
  resolveTheme,
  startThemeTracking,
  THEME_PREF_KEY,
  writeThemePref,
  type ThemePref,
} from '../../src/app/theme';

/** Minimal storage double: records writes and can be made to throw like Safari private mode. */
class FakeStorage {
  readonly entries = new Map<string, string>();
  throws = false;

  getItem(key: string): string | null {
    if (this.throws) throw new Error('storage disabled');
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.throws) throw new Error('storage disabled');
    this.entries.set(key, value);
  }
}

/** matchMedia double driven by the test so the "system" preference can flip at will. */
const media = (() => {
  let dark = false;
  const listeners = new Set<(event: { matches: boolean }) => void>();
  return {
    setDark(value: boolean): void {
      dark = value;
      for (const listener of listeners) listener({ matches: dark });
    },
    matcher: (query: string): MediaQueryList => {
      const isDarkQuery = query.includes('prefers-color-scheme: dark');
      const entry = {
        media: query,
        get matches(): boolean {
          return isDarkQuery && dark;
        },
        onchange: null,
        addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => {
          listeners.add(listener);
        },
        removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => {
          listeners.delete(listener);
        },
        addListener: (listener: (event: { matches: boolean }) => void) => {
          listeners.add(listener);
        },
        removeListener: (listener: (event: { matches: boolean }) => void) => {
          listeners.delete(listener);
        },
        dispatchEvent: () => false,
      };
      return entry as unknown as MediaQueryList;
    },
    get listenerCount(): number {
      return listeners.size;
    },
  };
})();

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.colorScheme = '';
  media.setDark(false);
  vi.stubGlobal('matchMedia', media.matcher);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('theme preference storage (ADR-002 Decision 7)', () => {
  it('reads the ADR-002 namespaced key and defaults to system', () => {
    expect(readThemePref(new FakeStorage())).toBe('system');
    expect(THEME_PREF_KEY).toBe('todo:prefs:v1:theme');
  });

  it('reads every valid preference and treats anything else as system', () => {
    const storage = new FakeStorage();
    for (const value of ['light', 'dark', 'system', 'sepia', ''] as const) {
      storage.setItem(THEME_PREF_KEY, value);
      const expected: ThemePref = value === 'light' || value === 'dark' ? value : 'system';
      expect(readThemePref(storage)).toBe(expected);
    }
  });

  it('writes only the theme mirror key', () => {
    const storage = new FakeStorage();
    writeThemePref('dark', storage);
    expect([...storage.entries.keys()]).toEqual([THEME_PREF_KEY]);
    expect(storage.getItem(THEME_PREF_KEY)).toBe('dark');
  });

  it('survives a throwing storage (private mode) on read and write', () => {
    const storage = new FakeStorage();
    storage.throws = true;
    expect(readThemePref(storage)).toBe('system');
    expect(() => {
      writeThemePref('light', storage);
    }).not.toThrow();
  });

  it('survives localStorage access itself throwing', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    expect(readThemePref()).toBe('system');
    expect(() => {
      writeThemePref('dark');
    }).not.toThrow();
  });
});

describe('resolveTheme', () => {
  it('honours explicit preferences regardless of the system', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('follows prefers-color-scheme for the system preference', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

describe('prefersDark', () => {
  it('is false when matchMedia is unavailable', () => {
    vi.unstubAllGlobals();
    expect(prefersDark()).toBe(false);
  });

  it('reads the dark media query', () => {
    expect(prefersDark()).toBe(false);
    media.setDark(true);
    expect(prefersDark()).toBe(true);
  });
});

describe('applyTheme', () => {
  it('sets data-theme and color-scheme together', () => {
    applyTheme('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');

    applyTheme('light');
    expect(document.documentElement.dataset['theme']).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
  });
});

describe('startThemeTracking (system preference, live)', () => {
  it('re-applies the theme when prefers-color-scheme flips in system mode', () => {
    const pref: ThemePref = 'system';
    const stop = startThemeTracking(() => pref);

    applyTheme(resolveTheme(pref, prefersDark()));
    expect(document.documentElement.dataset['theme']).toBe('light');

    media.setDark(true);
    expect(document.documentElement.dataset['theme']).toBe('dark');

    media.setDark(false);
    expect(document.documentElement.dataset['theme']).toBe('light');

    stop();
    expect(media.listenerCount).toBe(0);
  });

  it('ignores system flips once an explicit theme is chosen', () => {
    const pref: ThemePref = 'dark';
    const stop = startThemeTracking(() => pref);
    applyTheme(resolveTheme(pref, prefersDark()));
    expect(document.documentElement.dataset['theme']).toBe('dark');

    media.setDark(true);
    expect(document.documentElement.dataset['theme']).toBe('dark');

    media.setDark(false);
    expect(document.documentElement.dataset['theme']).toBe('dark');

    stop();
  });

  it('is a no-op when matchMedia is unavailable', () => {
    vi.unstubAllGlobals();
    expect(() => {
      const stop = startThemeTracking(() => 'system');
      stop();
    }).not.toThrow();
  });
});
