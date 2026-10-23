import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_LOCALE,
  getLocale,
  initLocale,
  isLocale,
  isLocaleLoaded,
  LOCALES,
  registerLocalePersistence,
  setLocale,
  t,
  type Locale,
  type LocalePersistence,
} from '../../src/i18n';

/**
 * M15 runtime: switching, lazy per-locale loading, `document.documentElement.lang`,
 * interpolation, local-only logging (§7.2), and ADR-002 persistence behind the port.
 * `tests/setup.ts` primes the boot catalog (`en`) before every test.
 */

function recordingPersistence(initial: Locale | null = null) {
  const saved: Locale[] = [];
  let stored = initial;
  const persistence: LocalePersistence = {
    load: async () => stored,
    save: async (next) => {
      saved.push(next);
      stored = next;
    },
  };
  return { persistence, saved };
}

beforeEach(() => {
  registerLocalePersistence(null);
});

afterEach(() => {
  registerLocalePersistence(null);
  vi.restoreAllMocks();
});

describe('locale surface', () => {
  it('ships exactly English and Thai at MVP (PO Q9) with a strict guard', () => {
    expect(LOCALES).toEqual(['en', 'th']);
    expect(DEFAULT_LOCALE).toBe('en');
    expect(isLocale('en')).toBe(true);
    expect(isLocale('th')).toBe(true);
    expect(isLocale('de')).toBe(false);
    expect(isLocale(null)).toBe(false);
  });

  it('keeps the Thai pack unloaded until it is first selected (per-locale lazy load)', () => {
    // setup only primes the boot locale — the other locale must not be fetched eagerly.
    expect(isLocaleLoaded('en')).toBe(true);
    expect(isLocaleLoaded('th')).toBe(false);
  });
});

describe('setLocale — switching', () => {
  it('applies the Thai catalog, html[lang] and back again', async () => {
    await setLocale('th');

    expect(getLocale()).toBe('th');
    expect(document.documentElement.lang).toBe('th');
    expect(isLocaleLoaded('th')).toBe(true);
    expect(t('nav.today')).toBe('วันนี้');
    expect(t('view.count', { count: 3 })).toBe('3 งาน');
    expect(t('settings.language.english')).toBe('English'); // endonyms stay untranslated

    await setLocale('en');

    expect(getLocale()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(t('nav.today')).toBe('Today');
    expect(t('view.count', { count: 3 })).toBe('3 tasks');
  });

  it('rejects an unsupported locale and leaves the active locale untouched', async () => {
    await expect(setLocale('de' as Locale)).rejects.toThrow(/unsupported locale/u);
    expect(getLocale()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(t('nav.today')).toBe('Today');
  });
});

describe('t() — interpolation and local logging', () => {
  it('interpolates params into the active catalog', async () => {
    const body = t('confirm.deleteList.body', {
      list: 'Work',
      openCount: 2,
      doneCount: 3,
    });
    expect(body).toContain('Work');
    expect(body).toContain('2');
    expect(body).toContain('3');

    await setLocale('th');
    const thai = t('confirm.deleteList.body', { list: 'Work', openCount: 2, doneCount: 3 });
    expect(thai).toContain('Work');
    expect(thai).toContain('2');
  });

  it('logs a missing param once and keeps the placeholder visible', () => {
    const warn = vi.spyOn(console, 'warn');

    expect(t('view.count')).toBe('{count} tasks');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('missing param');

    expect(t('view.count')).toBe('{count} tasks');
    expect(warn).toHaveBeenCalledTimes(1); // deduped — a render loop must not spam the console
  });

  it('logs a key missing from every catalog once and shows the key', () => {
    const warn = vi.spyOn(console, 'warn');

    expect(t('no.such.key')).toBe('no.such.key');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('missing key');

    expect(t('no.such.key')).toBe('no.such.key');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('never logs for keys that exist (§7.2 console hygiene)', () => {
    const warn = vi.spyOn(console, 'warn');
    t('nav.today');
    t('settings.title');
    t('a11y.taskAdded', { title: 'Milk' });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('initLocale — boot', () => {
  it('applies the persisted locale from the port', async () => {
    const { persistence } = recordingPersistence('th');
    registerLocalePersistence(persistence);

    await expect(initLocale()).resolves.toBe('th');
    expect(getLocale()).toBe('th');
    expect(document.documentElement.lang).toBe('th');
    expect(t('nav.today')).toBe('วันนี้');
  });

  it('boots on English when nothing is stored or the stored value is invalid', async () => {
    const empty = recordingPersistence(null);
    registerLocalePersistence(empty.persistence);
    await expect(initLocale()).resolves.toBe('en');

    const invalid = recordingPersistence('fr' as unknown as Locale);
    registerLocalePersistence(invalid.persistence);
    await expect(initLocale()).resolves.toBe('en');
    expect(getLocale()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('persists only real user switches, not an unchanged locale', async () => {
    const { persistence, saved } = recordingPersistence('en');
    registerLocalePersistence(persistence);

    await setLocale('en'); // already active — no write
    expect(saved).toEqual([]);

    await setLocale('th');
    expect(saved).toEqual(['th']);

    await setLocale('en');
    expect(saved).toEqual(['th', 'en']);
  });

  it('bounds boot when the persistence backend hangs (never blocks paint)', async () => {
    const hung: LocalePersistence = {
      load: () => new Promise<Locale | null>(() => undefined),
      save: async () => undefined,
    };
    registerLocalePersistence(hung);

    const startedAt = Date.now();
    await expect(initLocale({ timeoutMs: 50 })).resolves.toBe('en');
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(getLocale()).toBe('en');
  });
});

describe('boot resilience against a broken locale pack', () => {
  it('falls back to English when the persisted pack fails to load', async () => {
    vi.resetModules();
    vi.doMock('../../src/i18n/locale-th', () => {
      throw new Error('simulated pack failure');
    });

    const fresh = await import('../../src/i18n');
    const warn = vi.spyOn(console, 'warn');
    fresh.registerLocalePersistence({
      load: async () => 'th',
      save: async () => undefined,
    });

    await expect(fresh.initLocale({ timeoutMs: 2000 })).resolves.toBe('en');
    expect(fresh.getLocale()).toBe('en');
    expect(fresh.t('nav.today')).toBe('Today');
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[warn.mock.calls.length - 1]?.[0])).toContain('could not load');
  });
});
