import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E5 QA drill (card t_8e3c7e08): does the selected locale survive a page reload?
 *
 * A browser reload keeps the IndexedDB contents but resets every JS module and the
 * storage boot singleton. This suite simulates exactly that: pick Thai in "session 1",
 * then reset the module registry + boot singleton and re-run the boot path in
 * "session 2" against the SAME fake-indexeddb instance.
 *
 * Verdict mapping (QA report docs/qa/e5-i18n.md):
 *   - initLocale() must come back with 'th' in session 2 (M15: lang switching incl.
 *     screen-reader language must survive reload — a locale that silently reverts to
 *     English every reload also reverts document.documentElement.lang).
 *   - The stored row must still carry locale 'th' afterwards (no silent clobber).
 */

async function session(): Promise<{
  i18n: typeof import('../../src/i18n');
  settingsPersistence: typeof import('../../src/i18n/settingsPersistence');
  boot: typeof import('../../src/storage/boot');
}> {
  const i18n = await import('../../src/i18n');
  const settingsPersistence = await import('../../src/i18n/settingsPersistence');
  const boot = await import('../../src/storage/boot');
  return { i18n, settingsPersistence, boot };
}

/** Raw row read straight from the underlying DB (bypasses the wrapper's denylist). */
async function rawSettingsRow(): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('local-first-todo');
    req.onerror = () => {
      reject(req.error ?? new Error('indexedDB.open failed'));
    };
    req.onsuccess = () => {
      const db = req.result;
      const get = db.transaction('settings', 'readonly').objectStore('settings').get('settings');
      get.onerror = () => {
        reject(get.error ?? new Error('settings get failed'));
      };
      get.onsuccess = () => {
        resolve(get.result as Record<string, unknown> | undefined);
        db.close();
      };
    };
  });
}

describe('E5 QA — locale durability across a simulated reload', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('restores Thai from settings.locale after the reload and does not clobber the row', async () => {
    // ---- session 1: boot, then the user picks Thai ----
    const s1 = await session();
    s1.i18n.registerLocalePersistence(s1.settingsPersistence.createSettingsLocalePersistence());
    await s1.i18n.initLocale();
    await s1.i18n.setLocale('th');

    expect(s1.i18n.getLocale()).toBe('th');
    expect(document.documentElement.lang).toBe('th');
    await vi.waitFor(async () => {
      expect((await rawSettingsRow())?.['locale']).toBe('th');
    });

    // ---- simulated reload: modules and the boot singleton reset, DB contents survive ----
    s1.boot.resetBootSingleton();
    vi.resetModules();

    const s2 = await session();
    s2.i18n.registerLocalePersistence(s2.settingsPersistence.createSettingsLocalePersistence());
    const restored = await s2.i18n.initLocale();

    // The locale must come back as Thai...
    expect(restored).toBe('th');
    expect(s2.i18n.getLocale()).toBe('th');
    expect(document.documentElement.lang).toBe('th');
    // ...and the stored row must still say Thai (a boot-time English write clobbers it).
    expect((await rawSettingsRow())?.['locale']).toBe('th');
  });

  it('diagnostic: the persistence port reads Thai back in session 2', async () => {
    const s1 = await session();
    s1.i18n.registerLocalePersistence(s1.settingsPersistence.createSettingsLocalePersistence());
    await s1.i18n.initLocale();
    await s1.i18n.setLocale('th');
    await vi.waitFor(async () => {
      expect((await rawSettingsRow())?.['locale']).toBe('th');
    });

    s1.boot.resetBootSingleton();
    vi.resetModules();

    const s2 = await session();
    const loaded = await s2.settingsPersistence.createSettingsLocalePersistence().load();
    expect(loaded).toBe('th');
  });

  it('diagnostic: the settings row is visible to wrapper reads in session 2 (not denylisted)', async () => {
    const s1 = await session();
    s1.i18n.registerLocalePersistence(s1.settingsPersistence.createSettingsLocalePersistence());
    await s1.i18n.initLocale();
    await s1.i18n.setLocale('th');
    await vi.waitFor(async () => {
      expect((await rawSettingsRow())?.['locale']).toBe('th');
    });

    s1.boot.resetBootSingleton();
    vi.resetModules();

    const s2 = await session();
    const db = await s2.boot.boot();
    expect(db.ok).toBe(true);
    if (db.ok) {
      // A quarantined (boot-validation-denied) row reads back as ok(undefined) while
      // the raw record is still on disk — that mismatch is what hides the locale.
      const viaWrapper = await db.value.get('settings', 'settings');
      const raw = await rawSettingsRow();
      expect(raw?.['locale']).toBe('th');
      expect(viaWrapper.ok).toBe(true);
      expect(viaWrapper.ok && viaWrapper.value !== undefined).toBe(true);
    }
  });
});
