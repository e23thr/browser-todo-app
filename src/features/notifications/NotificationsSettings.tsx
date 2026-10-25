/**
 * Reminders & notifications settings row (V1 S5) — the master switch for local
 * notifications (`settings.notificationsEnabled`) plus an honest, quiet status
 * line for the E11 degrade paths.
 *
 * Permission-timing discipline (binding decision on t_ee8ecb0b): turning this
 * toggle ON is one of exactly two first-use gestures that may call
 * `noteReminderFirstUse()`. Nothing here ever prompts at boot, and a denied or
 * unsupported platform is reported as TEXT ONLY — no toasts, no announcements,
 * no re-prompts (E11: silent degrade to the in-app due-date indicators).
 */

import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';

import { t } from '../../app/i18n';
import { currentPermission, type NotificationPermissionState } from './api';
import { noteReminderFirstUse } from './firstUse';
import { rescheduleReminders } from './reminders';
import { patchSettings, state } from '../tasks/store';

function statusKey(permission: NotificationPermissionState, enabled: boolean): string {
  if (permission === 'unsupported') return 'settings.notifications.status.unsupported';
  if (permission === 'denied') return 'settings.notifications.status.denied';
  if (permission === 'granted') {
    return enabled ? 'settings.notifications.status.granted' : 'settings.notifications.status.off';
  }
  return 'settings.notifications.status.default';
}

/**
 * Live permission state for the status line: seeded from `currentPermission()`
 * and kept fresh while the row is on screen, because the user can flip the
 * permission in the browser's own UI without touching the app (review N4). The
 * Permissions API drives the refresh where available; window focus /
 * visibilitychange is the total fallback (older Safari and jsdom included).
 * Silent either way — E11 never logs.
 */
function usePermissionState(): [
  NotificationPermissionState,
  (next: NotificationPermissionState) => void,
] {
  const [permission, setPermission] = useState<NotificationPermissionState>(currentPermission());
  useEffect(() => {
    const refresh = (): void => {
      setPermission(currentPermission());
    };
    let status: PermissionStatus | null = null;
    let cancelled = false;
    const permissions = (navigator as { permissions?: Permissions }).permissions;
    if (permissions !== undefined) {
      void permissions
        .query({ name: 'notifications' })
        .then((result) => {
          if (cancelled) return;
          status = result;
          status.onchange = refresh;
        })
        .catch(() => {
          // No notification permission surface — the focus listeners below
          // still refresh the line. Never an error surface (E11).
        });
    }
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      cancelled = true;
      if (status !== null) status.onchange = null;
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  return [permission, setPermission];
}

export function NotificationsSettings(): JSX.Element {
  const enabled = state.value.settings?.notificationsEnabled === true;
  const [permission, setPermission] = usePermissionState();

  const toggle = (next: boolean): void => {
    void patchSettings({ notificationsEnabled: next }).then(() => {
      if (!next) {
        rescheduleReminders();
        return;
      }
      // First use of the reminder feature: ask ONCE, then re-plan whatever the
      // answer was. 'denied'/'unsupported' change nothing else — silent degrade.
      void noteReminderFirstUse().then((result) => {
        setPermission(result);
        rescheduleReminders();
      });
    });
  };

  return (
    <div class="field notifications-field">
      <label class="checkbox-row" for="settings-notifications">
        <input
          id="settings-notifications"
          type="checkbox"
          checked={enabled}
          onChange={(event) => {
            toggle(event.currentTarget.checked);
          }}
        />
        <span>{t('settings.notifications.enable')}</span>
      </label>
      <p class="field-hint" role="note" data-testid="notifications-status">
        {t(statusKey(permission, enabled))}
      </p>
    </div>
  );
}
