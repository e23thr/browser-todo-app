/**
 * S5 local reminders/notifications — component contract tests over a MOCKED
 * Notification API (PROJECT_ANALYSIS §4 S5, §10 E11, §12 Q6; acceptance
 * criterion "granted, denied, unsupported paths (E11 degrade evidenced)").
 *
 * E11 evidence here means: on the denied and unsupported paths NOTHING fires —
 * no Notification, no toast, no announcement, no console error — while the
 * in-app due-date indicators (E2's DueBadge) are untouched. The permission is
 * requested ONLY from the two documented first-use gestures (settings toggle ON,
 * reminder save) — never from the boot/scheduling path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/preact';

import { NotificationsSettings } from '../../src/features/notifications/NotificationsSettings';
import { ReminderDialog } from '../../src/features/notifications/ReminderDialog';
import { resetFirstUseForTest } from '../../src/features/notifications/firstUse';
import { resetRemindersForTest, startReminders } from '../../src/features/notifications/reminders';
import { patchSettings, setTaskReminder, state } from '../../src/features/tasks/store';
import { toasts } from '../../src/features/tasks/toasts';
import { makeList, makeTask, regions, seed, setUpCoreUi, tearDownCoreUi } from './core-ui-harness';

const MINUTE = 60_000;
const NOW = new Date(2026, 0, 10, 10, 0, 0).getTime(); // January anchor (no DST anywhere)

interface Fired {
  title: string;
  options: { body?: string; tag?: string } | undefined;
}
let fired: Fired[] = [];
let permissionRequests = 0;
let permission: 'default' | 'granted' | 'denied' = 'granted';

function mockNotification(state_: 'default' | 'granted' | 'denied' | 'unsupported'): void {
  fired = [];
  permissionRequests = 0;
  if (state_ === 'unsupported') {
    vi.stubGlobal('Notification', undefined);
    Reflect.deleteProperty(globalThis, 'Notification');
    return;
  }
  permission = state_;
  class MockNotification {
    static permission = state_;
    static requestPermission = vi.fn(async () => {
      permissionRequests += 1;
      return permission;
    });
    onclick: (() => void) | null = null;
    constructor(title: string, options?: { body?: string; tag?: string }) {
      fired.push({ title, options });
    }
  }
  vi.stubGlobal('Notification', MockNotification);
}

async function seedAndEnable(tasks: ReturnType<typeof makeTask>[]): Promise<void> {
  await seed({
    lists: [makeList({ id: 'L1', name: 'Work' })],
    tasks,
  });
  await patchSettings({ notificationsEnabled: true });
}

beforeEach(() => {
  setUpCoreUi();
  resetRemindersForTest();
  resetFirstUseForTest();
});

afterEach(() => {
  resetRemindersForTest();
  tearDownCoreUi();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, 'Notification');
});

/** Fake clock for the scheduling suites only (`waitFor` needs real timers). */
function freezeClock(): void {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
}

describe('granted path (Q6: local only — fires from a page timer)', () => {
  it('fires one notification at reminderAt with the task title', async () => {
    freezeClock();
    mockNotification('granted');
    await seedAndEnable([
      makeTask({ id: 'T1', title: 'Water the plants', reminderAt: NOW + 2 * MINUTE }),
    ]);
    startReminders();

    await vi.advanceTimersByTimeAsync(2 * MINUTE + 10);
    expect(fired).toEqual([
      {
        title: 'Water the plants',
        options: expect.objectContaining({ tag: 'T1' }),
      },
    ]);
  });

  it('plans the earliest reminder first and re-arms after each fire', async () => {
    freezeClock();
    mockNotification('granted');
    await seedAndEnable([
      makeTask({ id: 'T2', title: 'Later', reminderAt: NOW + 30 * MINUTE }),
      makeTask({ id: 'T1', title: 'Sooner', reminderAt: NOW + 1 * MINUTE }),
    ]);
    startReminders();

    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(fired.map((n) => n.title)).toEqual(['Sooner']);
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(fired.map((n) => n.title)).toEqual(['Sooner', 'Later']);
  });

  it('never fires a reminder that was moved away or cleared before its instant', async () => {
    freezeClock();
    mockNotification('granted');
    await seedAndEnable([makeTask({ id: 'T1', title: 'Movable', reminderAt: NOW + 2 * MINUTE })]);
    startReminders();

    await vi.advanceTimersByTimeAsync(1 * MINUTE);
    await setTaskReminder('T1', NOW + 60 * MINUTE); // pushed away
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(fired.map((n) => n.title)).toEqual(['Movable']);
  });

  it('rolls a recurring task forward after firing (recurrence semantics)', async () => {
    freezeClock();
    mockNotification('granted');
    await seedAndEnable([
      makeTask({
        id: 'T1',
        title: 'Daily standup',
        reminderAt: NOW + 1 * MINUTE,
        recurrence: { freq: 'daily', interval: 1 },
      }),
    ]);
    startReminders();

    await vi.advanceTimersByTimeAsync(1 * MINUTE + 10);
    expect(fired).toHaveLength(1);
    // Next occurrence is +1 day — nothing more within the hour.
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(fired).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(24 * 60 * MINUTE);
    expect(fired).toHaveLength(2);
  });
});

describe('E11 silent degrade (denied / unsupported)', () => {
  it('denied: fires nothing and reports nothing (no toast, no announcement)', async () => {
    freezeClock();
    mockNotification('denied');
    await seedAndEnable([
      makeTask({ id: 'T1', title: 'Quiet task', reminderAt: NOW + 1 * MINUTE }),
    ]);
    startReminders();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);

    expect(fired).toEqual([]);
    expect(toasts.value).toEqual([]);
    expect(regions.polite?.textContent ?? '').toBe('');
    expect(regions.assertive?.textContent ?? '').toBe('');
  });

  it('unsupported: same silent degrade (no Notification API at all)', async () => {
    freezeClock();
    mockNotification('unsupported');
    await seedAndEnable([
      makeTask({ id: 'T1', title: 'Quiet task', reminderAt: NOW + 1 * MINUTE }),
    ]);
    startReminders();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);

    expect(fired).toEqual([]);
    expect(toasts.value).toEqual([]);
    expect(regions.polite?.textContent ?? '').toBe('');
  });

  it('fires nothing while notificationsEnabled is off, regardless of permission', async () => {
    freezeClock();
    mockNotification('granted');
    await seed({
      lists: [makeList({ id: 'L1', name: 'Work' })],
      tasks: [makeTask({ id: 'T1', title: 'Muted', reminderAt: NOW + 1 * MINUTE })],
    });
    startReminders();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(fired).toEqual([]);
  });
});

describe('permission timing (first use only — never at boot)', () => {
  it('boot + scheduling never prompt', async () => {
    freezeClock();
    mockNotification('default');
    await seedAndEnable([makeTask({ id: 'T1', title: 'T', reminderAt: NOW + 1 * MINUTE })]);
    startReminders();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(permissionRequests).toBe(0);
  });

  it('the settings toggle is a first-use gesture (asks once per session)', async () => {
    mockNotification('default');
    await seed({ lists: [makeList({ id: 'L1', name: 'Work' })], tasks: [] });
    render(<NotificationsSettings />);

    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => {
      expect(permissionRequests).toBe(1);
    });
    // Turning it off and on again does not nag twice in one session.
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => {
      expect(state.value.settings?.notificationsEnabled).toBe(true);
    });
    expect(permissionRequests).toBe(1);
  });

  it('saving a reminder is the other first-use gesture and flips the master switch on', async () => {
    mockNotification('default');
    await seed({
      lists: [makeList({ id: 'L1', name: 'Work' })],
      tasks: [makeTask({ id: 'T1', title: 'T', reminderAt: NOW + 1 * MINUTE })],
    });
    render(<ReminderDialog task={state.value.tasks.get('T1')!} onClose={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(permissionRequests).toBe(1);
    });
    await waitFor(() => {
      expect(state.value.settings?.notificationsEnabled).toBe(true);
    });
  });

  it('a denied first use degrades silently — status text only, no error spam', async () => {
    mockNotification('denied');
    await seed({ lists: [makeList({ id: 'L1', name: 'Work' })], tasks: [] });
    render(<NotificationsSettings />);
    fireEvent.click(screen.getByRole('checkbox'));

    await waitFor(() => {
      expect(screen.getByTestId('notifications-status').textContent).toContain('blocked');
    });
    expect(toasts.value).toEqual([]);
    expect(regions.assertive?.textContent ?? '').toBe('');
    // A denied platform is never re-prompted (no nagging) — the prompt count
    // stays at zero and the quiet status line is the only surface (E11).
    expect(permissionRequests).toBe(0);
  });

  it('granted from the reminder dialog → the reminder the user just saved fires (review B1)', async () => {
    // Real timers: the prompt is answered AFTER this save's own replans (a human
    // takes seconds), so the engine arms only through the post-grant
    // rescheduleReminders() in ReminderDialog.save. This is probe A of the
    // t_8f41af00 review, folded into the shipped suite (it failed as shipped).
    fired = [];
    permissionRequests = 0;
    const GRANT_DELAY = 150;
    class MockNotification {
      static permission: NotificationPermission = 'default';
      static requestPermission = vi.fn(async () => {
        permissionRequests += 1;
        await new Promise((resolve) => {
          setTimeout(resolve, GRANT_DELAY);
        });
        MockNotification.permission = 'granted';
        return 'granted';
      });
      onclick: (() => void) | null = null;
      constructor(title: string, options?: { body?: string; tag?: string }) {
        fired.push({ title, options });
      }
    }
    vi.stubGlobal('Notification', MockNotification);

    await seed({
      lists: [makeList({ id: 'L1', name: 'Work' })],
      tasks: [makeTask({ id: 'T1', title: 'Granted reminder', reminderAt: Date.now() + 1000 })],
    });
    startReminders();
    render(<ReminderDialog task={state.value.tasks.get('T1')!} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(permissionRequests).toBe(1);
    });
    await waitFor(() => {
      expect(state.value.settings?.notificationsEnabled).toBe(true);
    });
    await waitFor(
      () => {
        expect(fired.map((entry) => entry.title)).toEqual(['Granted reminder']);
      },
      { timeout: 8000 },
    );
  });

  it('the status line tracks a permission changed in the browser UI (review N4)', async () => {
    mockNotification('denied');
    await seed({ lists: [makeList({ id: 'L1', name: 'Work' })], tasks: [] });
    render(<NotificationsSettings />);
    expect(screen.getByTestId('notifications-status').textContent).toContain('blocked');

    // The user allows notifications in the browser's own UI while the row stays
    // on screen — the line must not go stale.
    mockNotification('granted');
    window.dispatchEvent(new Event('focus'));

    await waitFor(() => {
      expect(screen.getByTestId('notifications-status').textContent).toContain(
        'Reminders are saved but nothing is shown',
      );
    });
  });
});
