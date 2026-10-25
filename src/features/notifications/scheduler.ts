/**
 * Reminder scheduling (V1 S5) — pure planning, no timers, no DOM, no Notification
 * API. `reminders.ts` owns the timers and the silent-degrade policy.
 *
 * Scheduling is local (binding decision on t_ee8ecb0b): the fire time of a task
 * is its `reminderAt` instant (the model's only real instant — ADR-003 §"dueDate
 * is a day label"). When the task carries `recurrence` (S4's RRULE-lite subset)
 * and its reminder instant has passed, the next occurrence is computed from the
 * recurrence semantics — daily / weekly / monthly / weekdays with `interval`,
 * capped by `until`. `count` needs the full occurrence history (S4 owns it), so
 * it is deliberately not consulted here; see docs/dev/commands-notify.md.
 *
 * Past-due reminders of non-recurring tasks NEVER fire late and are never
 * rewritten: the plan only ever contains future instants, so a task arriving
 * after its reminder instant stays silent (E11 spirit — no error spam).
 */

import { todayStr } from '../../domain/dates';
import type { Recurrence, Task } from '../../domain/model';

/** Upper bound on roll-forward iterations before giving up (safety valve). */
const MAX_STEPS = 2000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isWeekday(date: Date): boolean {
  const day = date.getDay();
  return day !== 0 && day !== 6;
}

/** One recurrence step from `at` (epoch ms), in ms units via calendar math. */
function stepOnce(at: number, recurrence: Recurrence): number {
  const interval = Math.max(1, Math.trunc(recurrence.interval));
  const date = new Date(at);
  switch (recurrence.freq) {
    case 'daily':
      return at + interval * MS_PER_DAY;
    case 'weekly':
      return at + interval * 7 * MS_PER_DAY;
    case 'monthly': {
      // Calendar-month step with day clamping (Jan 31 + 1 month = Feb 28/29).
      const targetDay = date.getDate();
      date.setDate(1);
      date.setMonth(date.getMonth() + interval);
      const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
      date.setDate(Math.min(targetDay, lastDay));
      return date.getTime();
    }
    case 'weekdays': {
      // `interval` counts WEEKDAY occurrences, not calendar days.
      let remaining = interval;
      let next = at;
      while (remaining > 0) {
        next += MS_PER_DAY;
        if (isWeekday(new Date(next))) remaining -= 1;
      }
      return next;
    }
  }
}

/**
 * The next fire instant for `task` strictly after `now`, or `null`.
 *
 * `reminderAt` in the future fires as-is; a past one rolls forward through
 * `recurrence` when present, otherwise never fires. `recurrence.until`
 * (`YYYY-MM-DD`, local day label) caps the roll.
 */
export function nextFireTime(task: Task, now: number): number | null {
  if (task.status !== 'open' || task.deletedAt !== null) return null;
  const base = task.reminderAt;
  if (base === undefined) return null;

  let at = base;
  for (let steps = 0; at <= now; steps += 1) {
    const recurrence = task.recurrence;
    if (recurrence === undefined || steps >= MAX_STEPS) return null;
    const stepped = stepOnce(at, recurrence);
    if (!Number.isFinite(stepped) || stepped <= at) return null;
    at = stepped;
  }

  const until = task.recurrence?.until;
  if (until !== undefined && todayStr(() => at) > until) return null;
  return at;
}

export interface ReminderPlanItem {
  readonly taskId: string;
  readonly title: string;
  readonly fireAt: number;
}

/**
 * The full schedule: every open, undeleted task's NEXT fire instant after `now`,
 * earliest first. One item per task — a recurring task is re-planned after each
 * fire, never pre-scheduled in bulk.
 */
export function planReminders(tasks: Iterable<Task>, now: number): ReminderPlanItem[] {
  const plan: ReminderPlanItem[] = [];
  for (const task of tasks) {
    const fireAt = nextFireTime(task, now);
    if (fireAt !== null) plan.push({ taskId: task.id, title: task.title, fireAt });
  }
  plan.sort((a, b) => a.fireAt - b.fireAt);
  return plan;
}
