/**
 * Reminder scheduling tests (V1 S5) — pure planning over the model's
 * `reminderAt` instant plus the RRULE-lite roll-forward ("next due time computed
 * from the recurrence semantics where present", binding decision on t_ee8ecb0b).
 *
 * Anchors live in January 2026 and February 2026 — calendar months with no DST
 * transition in any supported region — so ms arithmetic on the anchors cannot
 * drift with the runner's timezone. `until` assertions use `todayStr` labels so
 * they hold in every timezone.
 */

import { describe, expect, it } from 'vitest';

import { todayStr } from '../../../src/domain/dates';
import type { Recurrence, Task } from '../../../src/domain/model';
import { nextFireTime, planReminders } from '../../../src/features/notifications/scheduler';

const NOW = new Date(2026, 0, 10, 10, 0, 0).getTime(); // local 2026-01-10 10:00
const DAY = 24 * 60 * 60 * 1000;

function task(overrides: Partial<Task> = {}): Task {
  const base: Task = {
    id: 'task-1',
    listId: 'list-1',
    title: 'Water the plants',
    notes: null,
    status: 'open',
    priority: 1,
    tags: [],
    sortOrder: 'a0',
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    deletedAt: null,
    deviceId: 'dev-1',
    ...overrides,
  };
  return base;
}

describe('nextFireTime', () => {
  it('fires at a future reminderAt as-is', () => {
    expect(nextFireTime(task({ reminderAt: NOW + 5 * 60_000 }), NOW)).toBe(NOW + 5 * 60_000);
  });

  it('never fires a past reminder of a non-recurring task (no late replay)', () => {
    expect(nextFireTime(task({ reminderAt: NOW - 1 }), NOW)).toBe(null);
  });

  it('ignores tasks without a reminder, done tasks and tombstones', () => {
    expect(nextFireTime(task(), NOW)).toBe(null);
    expect(nextFireTime(task({ reminderAt: NOW + 10, status: 'done' }), NOW)).toBe(null);
    expect(nextFireTime(task({ reminderAt: NOW + 10, deletedAt: NOW }), NOW)).toBe(null);
  });

  it('rolls a past daily reminder forward by interval', () => {
    const recurrence: Recurrence = { freq: 'daily', interval: 2 };
    // Anchor 3 days ago; +2d steps land on -1d (past) then +1d (future).
    expect(nextFireTime(task({ reminderAt: NOW - 3 * DAY, recurrence }), NOW)).toBe(NOW + 1 * DAY);
  });

  it('rolls a past weekly reminder forward by interval', () => {
    const recurrence: Recurrence = { freq: 'weekly', interval: 1 };
    // Anchor 8 days ago; +7d is still past, the next +7d lands +6d from now.
    expect(nextFireTime(task({ reminderAt: NOW - 8 * DAY, recurrence }), NOW)).toBe(NOW + 6 * DAY);
  });

  it('rolls monthly with day clamping (Jan 31 -> Feb 28)', () => {
    const recurrence: Recurrence = { freq: 'monthly', interval: 1 };
    const jan31 = new Date(2026, 0, 31, 9, 0, 0).getTime();
    const feb28 = new Date(2026, 1, 28, 9, 0, 0).getTime();
    expect(nextFireTime(task({ reminderAt: jan31, recurrence }), feb28 - DAY)).toBe(feb28);
  });

  it('rolls weekdays by weekday occurrences, skipping the weekend', () => {
    const recurrence: Recurrence = { freq: 'weekdays', interval: 1 };
    // Friday 2026-01-02 09:00 -> next weekday is Monday 2026-01-05 09:00.
    const friday = new Date(2026, 0, 2, 9, 0, 0).getTime();
    const monday = new Date(2026, 0, 5, 9, 0, 0).getTime();
    expect(nextFireTime(task({ reminderAt: friday, recurrence }), friday + 1)).toBe(monday);
  });

  it('caps the roll at recurrence.until (local day label)', () => {
    const reminderAt = NOW - 5 * DAY;
    const daily: Recurrence = { freq: 'daily', interval: 1 };
    const fire = nextFireTime(task({ reminderAt, recurrence: daily }), NOW);
    expect(fire).not.toBe(null);

    // Allowed when the fire day is on/before `until`...
    const allowed = nextFireTime(
      task({ reminderAt, recurrence: { ...daily, until: todayStr(() => fire as number) } }),
      NOW,
    );
    expect(allowed).toBe(fire);
    // ...and impossible when the next occurrence falls after `until`.
    const blocked = nextFireTime(
      task({ reminderAt, recurrence: { ...daily, until: todayStr(() => NOW) } }),
      NOW,
    );
    expect(blocked).toBe(null);
  });

  it('clamps interval 0 to 1 and gives up safely on a non-finite interval', () => {
    // interval 0 is clamped to 1 by the stepper (safe, documented) — it rolls.
    const zero: Recurrence = { freq: 'daily', interval: 0 };
    // Reminder yesterday, stepped by the clamped interval: lands tomorrow (the
    // roll runs while `at <= now`, so an exact `now` hit keeps stepping).
    expect(nextFireTime(task({ reminderAt: NOW - DAY, recurrence: zero }), NOW)).toBe(NOW + DAY);
    // A non-finite step can never produce an instant: refuse instead of looping.
    const broken = { freq: 'daily', interval: Number.NaN } as unknown as Recurrence;
    expect(nextFireTime(task({ reminderAt: NOW - DAY, recurrence: broken }), NOW)).toBe(null);
  });
});

describe('planReminders', () => {
  it('plans one future instant per open task, earliest first', () => {
    const tasks = [
      task({ id: 'a', title: 'A', reminderAt: NOW + 2 * DAY }),
      task({ id: 'b', title: 'B', reminderAt: NOW + 1 * DAY }),
      task({ id: 'c', title: 'C' }), // no reminder
      task({ id: 'd', title: 'D', reminderAt: NOW - DAY }), // past, non-recurring
      task({ id: 'e', title: 'E', reminderAt: NOW + 3 * DAY, status: 'done' }),
    ];
    expect(planReminders(tasks, NOW)).toEqual([
      { taskId: 'b', title: 'B', fireAt: NOW + 1 * DAY },
      { taskId: 'a', title: 'A', fireAt: NOW + 2 * DAY },
    ]);
  });
});
