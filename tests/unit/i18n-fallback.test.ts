import { afterEach, describe, expect, it, vi } from 'vitest';

import { getLocale, setLocale, t } from '../../src/i18n';

/**
 * Missing-key fallback at runtime (t_5696ea45 contract): active locale → English → key,
 * logged locally exactly once per key — no telemetry, no console spam (§7.2).
 *
 * The Thai pack is mocked to a deliberately partial catalog so the English fallback path is
 * reachable even though `npm run i18n:check` keeps the real catalogs key-complete.
 */

vi.mock('../../src/i18n/locale-th', () => ({
  default: {
    'nav.today': 'วันนี้',
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('English fallback for a key the active locale lacks', () => {
  it('renders the English string, warns once locally, and stays deduped', async () => {
    await setLocale('th');
    expect(getLocale()).toBe('th');

    const warn = vi.spyOn(console, 'warn');

    expect(t('nav.settings')).toBe('Settings');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('falling back to English');

    // Re-rendering the same missing key must not spam the log.
    expect(t('nav.settings')).toBe('Settings');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('still resolves keys the active locale does have', async () => {
    await setLocale('th');
    expect(t('nav.today')).toBe('วันนี้');
  });

  it('never claims a fallback for a key the active locale has', async () => {
    await setLocale('th');
    const warn = vi.spyOn(console, 'warn');
    expect(t('nav.today')).toBe('วันนี้');
    expect(warn).not.toHaveBeenCalled();
  });
});
