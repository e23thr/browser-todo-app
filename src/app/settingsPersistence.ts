/**
 * Durable settings persistence — the ADR-002 `settings` singleton record, IndexedDB edition.
 *
 * Owns only the three fields this card is responsible for (`theme`, `weekStart`,
 * `defaultListId`) and merges them into the full record, so the record's other fields
 * (`locale`, `lastBackupAt`, …) are preserved for the features that own them.
 *
 * Everything goes through the storage card's public surface (`boot`, `get`, `put`,
 * `validateSettings`) — this module never touches `idb` or a raw `IDBDatabase` (ADR-002 §1).
 */

import { boot, err, ok, SETTINGS_KEY, validateSettings } from '../storage';
import type { AppDB, Result, Settings as SettingsRecord, StorageError } from '../storage';
import type { AppSettings, SettingsPersistence } from './settings';

async function withDb<T>(
  fn: (db: AppDB) => Promise<Result<T, StorageError>>,
): Promise<Result<T, StorageError>> {
  const booted = await boot();
  if (!booted.ok) return err(booted.error);
  return fn(booted.value);
}

/** Create the IndexedDB-backed implementation of the settings persistence port. */
export function createIdbSettingsPersistence(): SettingsPersistence {
  return {
    load: () =>
      withDb(async (db) => {
        const record = await db.get('settings', SETTINGS_KEY);
        if (!record.ok) return err(record.error);
        const settings = record.value;
        if (settings === undefined) return ok(null);

        const validation = validateSettings(settings);
        if (!validation.ok) {
          return err({ code: 'INVALID_RECORD', store: 'settings', issues: validation.issues });
        }
        return ok({
          theme: settings.theme,
          weekStart: settings.weekStart,
          defaultListId: settings.defaultListId,
        });
      }),

    save: (settings: AppSettings) =>
      withDb(async (db) => {
        const existing = await db.get('settings', SETTINGS_KEY);
        if (!existing.ok) return err(existing.error);

        const merged: SettingsRecord = {
          id: 'settings',
          theme: settings.theme,
          locale: existing.value?.locale ?? 'en',
          weekStart: settings.weekStart,
          defaultListId: settings.defaultListId,
          notificationsEnabled: existing.value?.notificationsEnabled ?? false,
          lastBackupAt: existing.value?.lastBackupAt ?? null,
        };

        const validation = validateSettings(merged);
        if (!validation.ok) {
          return err({ code: 'INVALID_RECORD', store: 'settings', issues: validation.issues });
        }
        return db.put('settings', merged);
      }),
  };
}
