/**
 * Notification API seam (V1 S5 — PROJECT_ANALYSIS §4 S5, §10 E11, §12 Q6).
 *
 * Local notifications only: there is no backend, so there is no push — a
 * reminder fires from a page timer while the app is open. Everything here is a
 * thin, total wrapper over `globalThis.Notification`:
 *
 *  - unsupported browsers report `'unsupported'` and every call is a silent no-op,
 *  - `showNotification` never throws (a denied-by-policy `new Notification` is
 *    caught and reported as `false` — E11 degrade is SILENT, never error spam),
 *  - `requestPermission` is called ONLY from user-gesture first-use paths
 *    (`firstUse.ts`), never from boot or the scheduler.
 */

export type NotificationPermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

type NotificationCtor = {
  new (title: string, options?: NotificationOptions): Notification;
  permission: NotificationPermission;
  /** Legacy callback-style implementations are absorbed by `Promise.resolve`. */
  requestPermission(): unknown;
};

function ctor(): NotificationCtor | null {
  const candidate = (globalThis as { Notification?: unknown }).Notification;
  return typeof candidate === 'function' ? (candidate as NotificationCtor) : null;
}

/** `'unsupported'` when the platform has no Notification API (E11 path). */
export function currentPermission(): NotificationPermissionState {
  const api = ctor();
  if (api === null) return 'unsupported';
  return api.permission;
}

export function notificationsSupported(): boolean {
  return ctor() !== null;
}

/**
 * Ask for permission. Resolves to the resulting state (legacy callback-style
 * implementations included). `'unsupported'` resolves without prompting.
 * Callers must be first-use user gestures — see `firstUse.ts`.
 */
export async function requestPermission(): Promise<NotificationPermissionState> {
  const api = ctor();
  if (api === null) return 'unsupported';
  try {
    const result = await Promise.resolve(api.requestPermission());
    return result === 'granted' || result === 'denied' ? result : 'default';
  } catch {
    return currentPermission();
  }
}

export interface ReminderNotice {
  readonly title: string;
  readonly body: string;
  /** Groups repeat fires of one task in the OS notification centre. */
  readonly tag: string;
}

/**
 * Show one notification. `false` = it did not show (unsupported / denied /
 * failed) — the caller degrades silently to the in-app due-date indicators.
 * `onclick` focuses the app window when the platform delivers the click.
 */
export function showNotification(notice: ReminderNotice): boolean {
  const api = ctor();
  if (api === null || api.permission !== 'granted') return false;
  try {
    const instance = new api(notice.title, { body: notice.body, tag: notice.tag });
    instance.onclick = (): void => {
      window.focus();
    };
    return true;
  } catch {
    return false;
  }
}
