/**
 * SettingsRepo — `SettingsPort` adapter over `AppDB`. The settings singleton
 * (fixed key `'settings'`) is read-modify-write stamped like every other write;
 * before the first `update()` the returned record is `DEFAULT_SETTINGS` (not
 * persisted until something actually changes).
 */

import { err, ok, type AppError, type Result } from '../../domain/kernel';
import { DEFAULT_SETTINGS, type Settings } from '../../domain/model';
import type { SettingsPort } from '../../domain/ports';
import { invalidRecord } from '../errors';
import { SETTINGS_KEY } from '../schema';
import { validateSettings } from '../validate';
import { txApp, type RepoDeps } from './support';

export class SettingsRepo implements SettingsPort {
  readonly #deps: RepoDeps;

  constructor(deps: RepoDeps) {
    this.#deps = deps;
  }

  get(): Promise<Result<Settings, AppError>> {
    return txApp(this.#deps.db, ['settings'], 'readonly', async (t) => {
      const row = await t.get('settings', SETTINGS_KEY);
      return ok(row ?? DEFAULT_SETTINGS);
    });
  }

  update(patch: Partial<Omit<Settings, 'id'>>): Promise<Result<Settings, AppError>> {
    return txApp(this.#deps.db, ['settings'], 'readwrite', async (t) => {
      const row = await t.get('settings', SETTINGS_KEY);
      const merged: Settings = { ...(row ?? DEFAULT_SETTINGS), ...patch, id: 'settings' };
      const v = validateSettings(merged);
      if (!v.ok) return err(invalidRecord('settings', v.issues, SETTINGS_KEY));
      await t.put('settings', merged);
      return ok(merged);
    });
  }
}
