/**
 * Lock lifecycle (ADR-007 Decision 5): `LockState` as a Preact signal for UI
 * binding + the idle re-lock timer (default 15 min, 5/15/30/60 only — "never"
 * is not offered, Decision 5.2) with the 60-second pre-lock toast.
 *
 * Idle = no `pointerdown` / `keydown` / `scroll` / `visibilitychange -> visible`
 * (cheap throttled listeners reset the timer). "Lock now" is always available;
 * tab close/refresh locks for free (the key is memory-only).
 */

import { signal, type Signal } from '@preact/signals';

/** Decision 5.1 — the UI-facing lock model. */
export type LockState =
  | { status: 'disabled' }
  | { status: 'unlocked'; keyIds: string[] }
  | { status: 'locked'; since: number };

export const PRE_LOCK_TOAST_MS = 60_000;
export const LOCK_MINUTES_CHOICES = [5, 15, 30, 60] as const;
export const DEFAULT_LOCK_MINUTES = 15;

export type IdleTimerEnv = {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Subscribe to user activity; returns an unsubscribe function. */
  onActivity: (fn: () => void) => () => void;
};

export function defaultIdleTimerEnv(): IdleTimerEnv {
  return {
    now: () => Date.now(),
    setTimer: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimer: (handle) => {
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
    onActivity: (fn) => {
      if (typeof document === 'undefined' || typeof window === 'undefined') return () => undefined;
      const events = ['pointerdown', 'keydown', 'scroll'] as const;
      let last = 0;
      const handler = (): void => {
        // Cheap throttle: one `touch` per 250 ms of burst activity.
        const now = Date.now();
        if (now - last < 250) return;
        last = now;
        fn();
      };
      const onVisible = (): void => {
        if (document.visibilityState === 'visible') fn();
      };
      for (const ev of events) window.addEventListener(ev, handler, { passive: true });
      document.addEventListener('visibilitychange', onVisible);
      return () => {
        for (const ev of events) window.removeEventListener(ev, handler);
        document.removeEventListener('visibilitychange', onVisible);
      };
    },
  };
}

export type IdleTimerCallbacks = {
  /** Fired PRE_LOCK_TOAST_MS before the lock ("Locking soon — keep working?"). */
  onPreLock: () => void;
  onLock: () => void;
};

/**
 * The idle timer. `configure` arms it, `touch` resets it (user activity),
 * `stop` disarms it (locked/disabled). Timer math is injectable for tests.
 */
export class IdleTimer {
  readonly #env: IdleTimerEnv;
  readonly #callbacks: IdleTimerCallbacks;
  #minutes = DEFAULT_LOCK_MINUTES;
  #armed = false;
  #preLockHandle: unknown = null;
  #lockHandle: unknown = null;
  #unsubscribe: (() => void) | null = null;

  constructor(env: IdleTimerEnv, callbacks: IdleTimerCallbacks) {
    this.#env = env;
    this.#callbacks = callbacks;
  }

  get minutes(): number {
    return this.#minutes;
  }

  /** Arm for `minutes` (5|15|30|60) and start listening for activity. */
  configure(minutes: number): void {
    this.#minutes = minutes;
    if (!this.#armed) {
      this.#armed = true;
      this.#unsubscribe = this.#env.onActivity(() => {
        this.touch();
      });
    }
    this.touch();
  }

  /** Reset the idle window (any user activity). */
  touch(): void {
    if (!this.#armed) return;
    this.#clear();
    const total = this.#minutes * 60_000;
    const preLockIn = total - PRE_LOCK_TOAST_MS;
    if (preLockIn > 0) {
      this.#preLockHandle = this.#env.setTimer(() => {
        this.#preLockHandle = null;
        this.#callbacks.onPreLock();
      }, preLockIn);
    }
    this.#lockHandle = this.#env.setTimer(() => {
      this.#lockHandle = null;
      this.#armed = false;
      this.#unsubscribe?.();
      this.#unsubscribe = null;
      this.#callbacks.onLock();
    }, total);
  }

  /** Disarm (locked / disabled / teardown). */
  stop(): void {
    this.#armed = false;
    this.#clear();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  #clear(): void {
    if (this.#preLockHandle !== null) {
      this.#env.clearTimer(this.#preLockHandle);
      this.#preLockHandle = null;
    }
    if (this.#lockHandle !== null) {
      this.#env.clearTimer(this.#lockHandle);
      this.#lockHandle = null;
    }
  }
}

/** The session-wide lock state signal (per tab — Decision 5.1). */
export const lockState: Signal<LockState> = signal<LockState>({ status: 'disabled' });

/**
 * Pre-lock warning (Decision 5.2's 60-second pre-lock toast): non-null = the
 * toast fired at that instant ("Locking soon — keep working?").
 */
export const preLockWarning: Signal<number | null> = signal<number | null>(null);

/**
 * Lock-drop registry (Decision 5.2: "drop decrypted caches and the search
 * index"). Consumers (e.g. the search-index cache) register at module init.
 */
const lockDrops = new Set<() => void>();

export function onLockDrop(cb: () => void): () => void {
  lockDrops.add(cb);
  return () => {
    lockDrops.delete(cb);
  };
}

export function fireLockDrops(): void {
  for (const cb of lockDrops) cb();
}
