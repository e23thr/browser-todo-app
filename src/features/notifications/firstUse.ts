/**
 * Permission-timing policy (binding decision on t_ee8ecb0b): notification
 * permission is requested at FIRST USE of the reminder feature, never at boot.
 *
 * "First use" is exactly two user gestures:
 *   1. turning the reminders toggle ON in Settings (`NotificationsSettings`),
 *   2. saving a task with a reminder from the task editor (`TaskEditor`).
 *
 * Nothing else may call `requestPermission` — not the boot path, not the
 * scheduler, not the palette. One request per session while the state is
 * `'default'`: if the user dismisses the prompt we do not nag again. A denied or
 * unsupported platform is returned as-is so callers can degrade SILENTLY to the
 * in-app due-date indicators (E11) — this module never throws and never logs.
 */

import { currentPermission, requestPermission, type NotificationPermissionState } from './api';

let requestedThisSession = false;

/**
 * First-use entry point: ask once (only when the state is still `'default'`),
 * resolve to the effective permission state. Idempotent and total.
 */
export async function noteReminderFirstUse(): Promise<NotificationPermissionState> {
  const before = currentPermission();
  if (before !== 'default') return before;
  if (requestedThisSession) return currentPermission();
  requestedThisSession = true;
  return requestPermission();
}

/** Test seam: forget the session's request (component tests). */
export function resetFirstUseForTest(): void {
  requestedThisSession = false;
}
