/**
 * Idle re-lock timer math (ADR-007 Decision 5.2) — injectable clock/timers:
 * the 60-second pre-lock toast, the lock at N minutes of idleness, `touch`
 * resets, and the lock-drop registry (decrypted caches never outlive the
 * unlocked session).
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LOCK_MINUTES,
  IdleTimer,
  PRE_LOCK_TOAST_MS,
  fireLockDrops,
  onLockDrop,
  preLockWarning,
} from '../../../src/crypto/lock';

type Scheduled = { at: number; fn: () => void; cancelled: boolean };

function fakeEnv() {
  let now = 1_000_000;
  const scheduled: Scheduled[] = [];
  const activity: (() => void)[] = [];
  const env = {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const entry: Scheduled = { at: now + ms, fn, cancelled: false };
      scheduled.push(entry);
      return entry;
    },
    clearTimer: (handle: unknown) => {
      (handle as Scheduled).cancelled = true;
    },
    onActivity: (fn: () => void) => {
      activity.push(fn);
      return () => undefined;
    },
  };
  const fire = (ms: number): void => {
    now += ms;
    for (const entry of [...scheduled]) {
      if (!entry.cancelled && entry.at <= now) {
        entry.cancelled = true;
        entry.fn();
      }
    }
  };
  return {
    env,
    fire,
    activity,
    get now() {
      return now;
    },
  };
}

describe('IdleTimer (Decision 5.2)', () => {
  it('pre-lock toast at N-60s, lock at N minutes, both reset by activity', () => {
    const { env, fire, activity } = fakeEnv();
    let preLocks = 0;
    let locks = 0;
    const timer = new IdleTimer(env, {
      onPreLock: () => {
        preLocks += 1;
      },
      onLock: () => {
        locks += 1;
      },
    });
    timer.configure(DEFAULT_LOCK_MINUTES); // 15 min
    fire(DEFAULT_LOCK_MINUTES * 60_000 - PRE_LOCK_TOAST_MS - 1);
    expect(preLocks).toBe(0);
    fire(1);
    expect(preLocks).toBe(1); // 60s before the lock
    expect(locks).toBe(0);

    // User activity resets the whole window.
    activity[0]?.();
    fire(DEFAULT_LOCK_MINUTES * 60_000 - PRE_LOCK_TOAST_MS - 1);
    expect(locks).toBe(0);
    fire(PRE_LOCK_TOAST_MS + 1);
    expect(locks).toBe(1);
  });

  it('5-minute setting locks after exactly 5 idle minutes; stop() disarms', () => {
    const { env, fire } = fakeEnv();
    let locks = 0;
    const timer = new IdleTimer(env, {
      onPreLock: () => undefined,
      onLock: () => {
        locks += 1;
      },
    });
    timer.configure(5);
    fire(5 * 60_000 - 1);
    expect(locks).toBe(0);
    fire(1);
    expect(locks).toBe(1);

    timer.configure(5);
    timer.stop();
    fire(10 * 60_000);
    expect(locks).toBe(1); // disarmed — no double lock
  });
});

describe('lock-drop registry (Decision 5.2: decrypted caches dropped on lock)', () => {
  it('fires registered drops and unsubscribes cleanly', () => {
    let dropped = 0;
    const off = onLockDrop(() => {
      dropped += 1;
    });
    fireLockDrops();
    expect(dropped).toBe(1);
    off();
    fireLockDrops();
    expect(dropped).toBe(1);
  });

  it('pre-lock warning signal starts null', () => {
    expect(preLockWarning.value).toBeNull();
  });
});
