/**
 * QA probe (h_reviewer, t_46150118) — direct coverage of the REAL IndexedDB settings adapter
 * (src/app/settingsPersistence.ts), which the card's unit tests only exercise through a mock
 * port. Runs against fake-indexeddb with the real storage wrapper + real settings store.
 */
import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  getSettings,
  loadSettings,
  registerSettingsPersistence,
  setDefaultListId,
  setThemePref,
  setWeekStart,
} from '../../src/app/settings';
import { createIdbSettingsPersistence } from '../../src/app/settingsPersistence';
import { THEME_PREF_KEY } from '../../src/app/theme';
import { DB_NAME, SETTINGS_KEY } from '../../src/storage/schema';

async function rawRecord(): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onerror = () => reject(new Error('open failed'));
    req.onsuccess = () => {
      const db = req.result;
      const get = db.transaction('settings', 'readonly').objectStore('settings').get(SETTINGS_KEY);
      get.onsuccess = () => {
        resolve(get.result as Record<string, unknown> | undefined);
        db.close();
      };
      get.onerror = () => reject(new Error('get failed'));
    };
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForRecord(pred: (r: Record<string, unknown> | undefined) => boolean): Promise<Record<string, unknown> | undefined> {
  const start = Date.now();
  for (;;) {
    const record = await rawRecord();
    if (pred(record)) return record;
    if (Date.now() - start > 2000) throw new Error('timed out waiting for durable save');
    await sleep(25);
  }
}

beforeEach(async () => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  registerSettingsPersistence(createIdbSettingsPersistence());
  await loadSettings();
});

describe('real IDB settings adapter (createIdbSettingsPersistence)', () => {
  it('persists theme, weekStart and defaultListId into the ADR-002 settings record', async () => {
    setThemePref('dark');
    setWeekStart(1);
    setDefaultListId('01ARZ3NDEKTSV4RRFFQ69G5FAV');

    const record = await waitForRecord(
      (r) => r !== undefined && r['theme'] === 'dark' && r['defaultListId'] === '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    );

    expect(record).toMatchObject({
      id: 'settings',
      theme: 'dark',
      weekStart: 1,
      defaultListId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    });
  });

  it('merges without clobbering fields owned by other features (locale, lastBackupAt)', async () => {
    // Seed a record carrying fields this card does NOT own, then save through the adapter.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME);
      req.onerror = () => reject(new Error('open failed'));
      req.onsuccess = () => {
        const db = req.result;
        const put = db
          .transaction('settings', 'readwrite')
          .objectStore('settings')
          .put({
            id: 'settings',
            theme: 'system',
            locale: 'th',
            weekStart: 0,
            defaultListId: null,
            notificationsEnabled: true,
            lastBackupAt: 1700000000000,
          });
        put.onsuccess = () => {
          resolve();
          db.close();
        };
        put.onerror = () => reject(new Error('put failed'));
      };
    });

    registerSettingsPersistence(createIdbSettingsPersistence());
    await loadSettings();
    setWeekStart(1);
    await sleep(150);

    const record = await rawRecord();
    expect(record).toMatchObject({
      locale: 'th', // preserved, not reset to 'en'
      notificationsEnabled: true, // preserved
      lastBackupAt: 1700000000000, // preserved
      weekStart: 1,
    });
  });

  it('restores all three fields on a fresh boot (durable record is the source of truth)', async () => {
    setThemePref('dark');
    setWeekStart(1);
    setDefaultListId('01BX5ZZKBKACTAV9WEVGEMMVRY');
    await sleep(150);

    // Fresh session: new adapter instance, empty mirror except the poisoned value.
    window.localStorage.clear();
    window.localStorage.setItem(THEME_PREF_KEY, 'light');
    registerSettingsPersistence(createIdbSettingsPersistence());
    await loadSettings();

    expect(getSettings()).toEqual({ theme: 'dark', weekStart: 1, defaultListId: '01BX5ZZKBKACTAV9WEVGEMMVRY' });
    // ADR-002 §3.4: durable wins and the mirror is rewritten.
    expect(window.localStorage.getItem(THEME_PREF_KEY)).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
