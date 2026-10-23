import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fireEvent, render, screen, waitFor } from '@testing-library/preact';

import { registerLiveRegions } from '../../src/app/announce';
import { getLocale, setLocale } from '../../src/i18n';
import SettingsView from '../../src/features/settings/SettingsView';

/**
 * M15 acceptance at the component level: the settings language switcher drives the REAL
 * i18n runtime — lazy pack load, `document.documentElement.lang` (§8 screen-reader language),
 * a signal-driven re-render of every visible string, and the §11.2 polite announcement.
 */

let polite: HTMLElement;

beforeEach(async () => {
  await setLocale('en');
  polite = document.createElement('div');
  document.body.append(polite);
  registerLiveRegions({ polite, assertive: null });
});

afterEach(() => {
  registerLiveRegions({ polite: null, assertive: null });
});

describe('language switcher (settings, design §4.9 item 2)', () => {
  it('switches to Thai: html[lang], Thai catalog and the controlled radio together', async () => {
    render(<SettingsView />);

    const thaiRadio = screen.getByRole<HTMLInputElement>('radio', { name: 'ไทย' });
    expect(thaiRadio.checked).toBe(false);

    fireEvent.click(thaiRadio);

    // Wait on the runtime state, not the DOM: jsdom flips `checked` natively on click,
    // before Preact applies the controlled value from the re-rendered catalog.
    await waitFor(() => {
      expect(getLocale()).toBe('th');
    });
    expect(document.documentElement.lang).toBe('th');
    expect(thaiRadio.checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'English' }).checked).toBe(false);
  });

  it('re-renders the whole screen from the Thai catalog after the switch', async () => {
    render(<SettingsView />);

    fireEvent.click(screen.getByRole('radio', { name: 'ไทย' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'การตั้งค่า' })).toBeTruthy();
    });
    expect(screen.getByRole('heading', { level: 2, name: 'ภาษา' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'การแสดงผล' })).toBeTruthy();
    // Endonyms are never translated in either locale (the label text lives in the <label>).
    const englishLabel = screen.getByRole('radio', { name: 'English' }).closest('label');
    expect(englishLabel?.textContent).toContain('English');
  });

  it('announces the switch politely (§11.2 message pattern)', async () => {
    render(<SettingsView />);

    fireEvent.click(screen.getByRole('radio', { name: 'ไทย' }));

    await waitFor(() => {
      expect(polite.textContent).toBe('เปลี่ยนภาษาเป็น ไทย แล้ว');
    });
  });

  it('switches back to English', async () => {
    render(<SettingsView />);

    fireEvent.click(screen.getByRole('radio', { name: 'ไทย' }));
    await waitFor(() => {
      expect(getLocale()).toBe('th');
    });

    fireEvent.click(screen.getByRole('radio', { name: 'English' }));
    await waitFor(() => {
      expect(getLocale()).toBe('en');
    });
    expect(document.documentElement.lang).toBe('en');
    expect(screen.getByRole('heading', { level: 2, name: 'Language' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
  });
});
