import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSettingsLocalePersistence } from '../../src/i18n/settingsPersistence';
import { DEFAULT_SETTINGS } from '../../src/domain/model';
import { boot, resetBootSingleton } from '../../src/storage/boot';
import { SETTINGS_KEY } from '../../src/storage/schema';
import type { Settings } from '../../src/storage/types';

/**
 * ADR-002 locale persistence: `settings.locale` is the durable source of truth (Decision 3.4),
 * localStorage is deliberately NOT used (Decision 7's closed key list), and writes must touch
 * only the `locale` field so concurrent settings owners never clobber each other.
 */

async function readSettings(): Promise<Settings | undefined> {
  const db = await boot();
  if (!db.ok) return undefined;
  const row = await db.value.get('settings', SETTINGS_KEY);
  return row.ok ? row.value : undefined;
}

async function seedSettings(patch: Partial<Settings>): Promise<void> {
  const db = await boot();
  if (!db.ok) throw new Error('boot failed in test setup');
  const current = await db.value.get('settings', SETTINGS_KEY);
  const base: Settings =
    current.ok && current.value !== undefined
      ? current.value
      : {
          id: SETTINGS_KEY,
          theme: 'system',
          locale: 'en',
          weekStart: 0,
          defaultListId: null,
          notificationsEnabled: false,
          lastBackupAt: null,
        };
  const written = await db.value.put('settings', { ...base, ...patch });
  if (!written.ok) throw new Error('seed write failed');
}

beforeEach(() => {
  resetBootSingleton();
});

afterEach(() => {
  resetBootSingleton();
  vi.restoreAllMocks();
});

describe('createSettingsLocalePersistence — load', () => {
  it('returns null while no settings row exists (first run)', async () => {
    await expect(createSettingsLocalePersistence().load()).resolves.toBeNull();
  });

  it('returns the stored locale once a row carries one', async () => {
    await seedSettings({ locale: 'th' });
    await expect(createSettingsLocalePersistence().load()).resolves.toBe('th');
  });

  it('ignores a stored value that is not a shipped locale (C5 future-proofing)', async () => {
    await seedSettings({ locale: 'fr' });
    await expect(createSettingsLocalePersistence().load()).resolves.toBeNull();
  });

  it('degrades to session-only when IndexedDB is unavailable', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true });
    try {
      await expect(createSettingsLocalePersistence().load()).resolves.toBeNull();
    } finally {
      if (original !== undefined) Object.defineProperty(globalThis, 'indexedDB', original);
    }
  });

  it('logs the silent error branch instead of hiding it (QA N1)', async () => {
    const warn = vi.spyOn(console, 'warn');
    const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true });
    try {
      await expect(createSettingsLocalePersistence().load()).resolves.toBeNull();
      const messages = warn.mock.calls.map((call) => String(call[0] ?? ''));
      // The failure must be observable (D2 class) — previously this returned null silently.
      expect(messages.some((m) => m.includes('could not read the stored locale'))).toBe(true);
    } finally {
      if (original !== undefined) Object.defineProperty(globalThis, 'indexedDB', original);
    }
  });
});

describe('createSettingsLocalePersistence — save', () => {
  it('creates the settings row from the single-sourced fresh defaults on the first switch', async () => {
    // Earlier tests in this file share the same fake-indexeddb instance — drop any row so the
    // CREATE path (defaultSettingsRow) is what is actually under test here.
    const booted = await boot();
    if (!booted.ok) throw new Error('boot failed in test setup');
    const dropped = await booted.value.delete('settings', SETTINGS_KEY);
    if (!dropped.ok) throw new Error('settings row delete failed');

    const persistence = createSettingsLocalePersistence();
    await persistence.save('th');

    const row = await readSettings();
    // Every field except the two this port owns comes straight from the domain model's
    // `DEFAULT_SETTINGS` — the one literal default (QA D1: `weekStart` used to drift to 0).
    expect(row).toEqual({ ...DEFAULT_SETTINGS, theme: 'system', locale: 'th' });
    expect(await persistence.load()).toBe('th');
  });

  it('touches ONLY the locale field — other settings owners are never clobbered', async () => {
    const persistence = createSettingsLocalePersistence();
    await persistence.save('th');

    // Simulate the settings card writing its own fields through storage.
    const db = await boot();
    if (!db.ok) throw new Error('boot failed in test');
    const row = await db.value.get('settings', SETTINGS_KEY);
    if (!row.ok || row.value === undefined) throw new Error('row missing');
    await db.value.put('settings', {
      ...row.value,
      theme: 'dark',
      weekStart: 1,
      defaultListId: '01JBX00000000000000000000',
    });

    await persistence.save('en');

    const after = await readSettings();
    expect(after?.locale).toBe('en');
    expect(after?.theme).toBe('dark');
    expect(after?.weekStart).toBe(1);
    expect(after?.defaultListId).toBe('01JBX00000000000000000000');
  });

  it('logs and returns (never throws) when storage is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn');
    const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true });
    try {
      await expect(createSettingsLocalePersistence().save('th')).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0]?.[0])).toContain('not persisted');
    } finally {
      if (original !== undefined) Object.defineProperty(globalThis, 'indexedDB', original);
    }
  });
});
