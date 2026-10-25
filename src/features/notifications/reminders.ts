/**
 * Reminder engine (V1 S5) — page-timer scheduling for local notifications.
 *
 * Contract (PROJECT_ANALYSIS §4 S5, §10 E11, §12 Q6; binding decisions on
 * t_ee8ecb0b):
 *  - LOCAL only. There is no push (no backend): a reminder fires from a timer
 *    while the app is open. Missed instants never replay — `scheduler.ts` only
 *    ever plans future instants.
 *  - The engine runs ONLY when `settings.notificationsEnabled` is true AND
 *    `Notification.permission` is `'granted'`. Everything else is a SILENT
 *    degrade to the in-app due-date indicators (E11): no toasts, no
 *    announcements, no console errors — the schedule is simply empty.
 *  - Permission is requested ONLY from first-use user gestures (`firstUse.ts`);
 *    this module reads state, it never prompts.
 *  - One armed timer at a time (the earliest planned instant); every state
 *    change, visibilitychange and fire re-plans.
 *
 * Timers are throttled in background tabs by the platform, so an exact-time
 * fire is best-effort — the in-app due-date indicators (E11) are the guaranteed
 * surface. `tests/component/notifications.test.tsx` pins the granted / denied /
 * unsupported / timing paths against a mocked Notification API.
 */

import { t } from '../../app/i18n';
import type { Task } from '../../domain/model';
import { state } from '../tasks/store';
import { currentPermission, showNotification } from './api';
import { planReminders, type ReminderPlanItem } from './scheduler';

/** Platform `setTimeout` ceiling (~24.8 days) — longer waits re-plan on wake. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

let timer: ReturnType<typeof setTimeout> | null = null;
let unsubscribeState: (() => void) | null = null;
let onVisibility: (() => void) | null = null;
/** `taskId@fireAt` keys already fired this session (double-arm guard). */
const fired = new Set<string>();

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

function remindersOn(): boolean {
  if (currentPermission() !== 'granted') return false;
  return state.value.settings?.notificationsEnabled === true;
}

function fire(item: ReminderPlanItem): void {
  const key = `${item.taskId}@${String(item.fireAt)}`;
  if (fired.has(key)) return;
  const task: Task | undefined = state.value.tasks.get(item.taskId);
  // Still due as planned: open, reminder not cleared, not pushed later (E11:
  // a stale plan must never fire a reminder the user already moved or removed).
  if (
    task === undefined ||
    task.status !== 'open' ||
    task.deletedAt !== null ||
    task.reminderAt === undefined ||
    task.reminderAt > item.fireAt
  ) {
    replan();
    return;
  }
  fired.add(key);
  showNotification({
    title: task.title,
    body: t('notify.reminder.body'),
    tag: task.id,
  });
  replan();
}

function replan(): void {
  clearTimer();
  if (!remindersOn()) return;
  // Only FUTURE instants are ever planned (scheduler contract), so a fired
  // instant can never be re-armed; the `fired` set in `fire()` is the
  // double-arm guard for the same-tick edge.
  const plan = planReminders(state.value.tasks.values(), Date.now());
  const first = plan[0];
  if (first === undefined) return;
  const delay = Math.min(Math.max(first.fireAt - Date.now(), 0), MAX_TIMEOUT_MS);
  timer = setTimeout(() => {
    timer = null;
    fire(first);
  }, delay);
}

/**
 * Re-plan now (call after a permission or settings change that did not flow
 * through the domain state, e.g. right after a first-use permission grant).
 */
export function rescheduleReminders(): void {
  replan();
}

/** Start the engine. Returns a disposer (App shell lifetime). */
export function startReminders(): () => void {
  stopReminders();
  unsubscribeState = state.subscribe(() => {
    replan();
  });
  onVisibility = (): void => {
    if (document.visibilityState === 'visible') replan();
  };
  document.addEventListener('visibilitychange', onVisibility);
  replan();
  return stopReminders;
}

/** Stop the engine and drop all timers (also the test seam). */
export function stopReminders(): void {
  clearTimer();
  unsubscribeState?.();
  unsubscribeState = null;
  if (onVisibility !== null) {
    document.removeEventListener('visibilitychange', onVisibility);
    onVisibility = null;
  }
}

/** Test seam: stop AND forget fired instants. */
export function resetRemindersForTest(): void {
  stopReminders();
  fired.clear();
}
