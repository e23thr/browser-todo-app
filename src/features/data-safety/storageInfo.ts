/**
 * StorageManager access (§9.4 feature detection + graceful degradation).
 *
 * Every call in here is optional-chain guarded: Safari < 15.2, hardened privacy settings and
 * some embedded webviews expose NO `navigator.storage` at all. When the API is missing the
 * surface does not break and does not lie — the meter shows its `unknown` state ("Your browser
 * doesn't report storage use here.") and the persistence row shows `unsupported`.
 *
 * Nothing here throws across the boundary: failures resolve to the degraded state, because a
 * broken quota probe must never stop the app from working (§9.4).
 */

import { signal } from '@preact/signals';

import { PREFS_KEYS } from './constants';

/** §5.3 `PersistenceRowProps.state` — the four states of the persistence row. */
export type PersistenceState = 'granted' | 'denied' | 'unsupported' | 'not-requested';

/** §5.2 `QuotaMeterProps` inputs; `totalBytes: null` = the browser reports no total. */
export interface QuotaState {
  readonly usedBytes: number;
  readonly totalBytes: number | null;
  /** `false` = the API is missing or threw → the meter's `unknown` visual state. */
  readonly supported: boolean;
  /** `true` while the first estimate is in flight (the meter's `loading` state). */
  readonly loading: boolean;
}

const INITIAL_QUOTA: QuotaState = {
  usedBytes: 0,
  totalBytes: null,
  supported: false,
  loading: true,
};

export const quotaState = signal<QuotaState>(INITIAL_QUOTA);
export const persistenceState = signal<PersistenceState>('not-requested');
/** §10.5 PersistenceRow `error`: persist() threw — "This browser wouldn't say." */
export const persistenceError = signal<boolean>(false);

/** `true` once this session called `persist()` (distinguishes denied from not-requested). */
let requested = false;

/**
 * Settle bound for the `persist()` round trip (§9.4 best-effort discipline).
 *
 * Firefox resolves `navigator.storage.persist()` only when the user answers its permission
 * prompt — in an unattended or automated window that answer may never arrive (measured: pending
 * 25 s+ in Playwright firefox while chromium/webkit settle in ~0 ms). The first-write gate and
 * the "Ask again" button both `await` this call, so without a bound a single hung promise hangs
 * the whole data-safety surface forever (nightly failure t_e20c2adb: firefox `persist()` probe
 * test timeout). After the bound the row reports the browser's REAL `persisted()` read and a
 * late prompt answer is adopted as soon as it lands, so the row never stays a lie.
 */
export const PERSIST_SETTLE_TIMEOUT_MS = 3000;

/** Test seam: forget session state (requested flag) without touching the DOM. */
export function resetStorageInfo(): void {
  requested = false;
  quotaState.value = INITIAL_QUOTA;
  persistenceState.value = 'not-requested';
  persistenceError.value = false;
}

function storage(): StorageManager | null {
  try {
    // `navigator.storage` is typed as always present but is genuinely absent in older and
    // hardened browsers (§9.4) — read it as optional so the whole module stays feature-detected.
    const manager = (navigator as { storage?: StorageManager }).storage;
    return manager ?? null;
  } catch {
    return null;
  }
}

/** Does this browser expose a usable `estimate()`? */
export function estimateSupported(): boolean {
  return typeof storage()?.estimate === 'function';
}

/** Does this browser expose `persist()` / `persisted()`? */
export function persistSupported(): boolean {
  const manager = storage();
  return typeof manager?.persist === 'function' && typeof manager.persisted === 'function';
}

/**
 * Refresh the quota meter. Degrades to `{supported:false}` when the API is missing or rejects
 * (§4.3: indeterminate track + "Your browser doesn't report storage use here.").
 */
export async function refreshQuota(): Promise<QuotaState> {
  const manager = storage();
  if (manager === null || typeof manager.estimate !== 'function') {
    quotaState.value = { usedBytes: 0, totalBytes: null, supported: false, loading: false };
    return quotaState.value;
  }
  try {
    const estimate = await manager.estimate();
    const usage = typeof estimate.usage === 'number' ? estimate.usage : 0;
    const quota = typeof estimate.quota === 'number' ? estimate.quota : null;
    quotaState.value = {
      usedBytes: usage,
      totalBytes: quota,
      supported: quota !== null,
      loading: false,
    };
  } catch {
    quotaState.value = { usedBytes: 0, totalBytes: null, supported: false, loading: false };
  }
  return quotaState.value;
}

/**
 * Read `persisted()` into the row. A denied grant only becomes `denied` after this session
 * actually asked (§4.3: not-requested and denied are different states with different copy).
 */
export async function refreshPersistence(): Promise<PersistenceState> {
  const manager = storage();
  if (manager === null || typeof manager.persisted !== 'function') {
    persistenceState.value = 'unsupported';
    return 'unsupported';
  }
  try {
    const persisted = await manager.persisted();
    if (persisted) {
      persistenceState.value = 'granted';
    } else {
      persistenceState.value = requested ? 'denied' : 'not-requested';
    }
  } catch {
    persistenceState.value = requested ? 'denied' : 'not-requested';
  }
  return persistenceState.value;
}

/**
 * Ask for persistent storage (the "Ask again" button, §4.3). Returns the resulting state and
 * records an error state when the call throws (§10.5).
 *
 * Bounded by `PERSIST_SETTLE_TIMEOUT_MS`: a `persist()` that never settles (Firefox's permission
 * prompt left unanswered) must not hang the caller — see the constant's doc for the nightly
 * evidence. On timeout the REAL `persisted()` read decides the state and a late prompt answer is
 * adopted as soon as it lands.
 */
export async function requestPersist(): Promise<PersistenceState> {
  const manager = storage();
  if (manager === null || typeof manager.persist !== 'function') {
    persistenceState.value = 'unsupported';
    return 'unsupported';
  }
  requested = true;
  persistenceError.value = false;
  try {
    const answer = manager.persist();
    const outcome = await Promise.race([
      answer.then((granted) => ({ status: 'answered' as const, granted })),
      new Promise<{ status: 'timed-out' }>((resolve) => {
        const timer = setTimeout(() => {
          resolve({ status: 'timed-out' });
        }, PERSIST_SETTLE_TIMEOUT_MS);
        // When the answer wins the race the timer must not linger (test runners / timers).
        void answer.then(
          () => {
            clearTimeout(timer);
          },
          () => {
            clearTimeout(timer);
          },
        );
      }),
    ]);
    if (outcome.status === 'answered') {
      persistenceState.value = outcome.granted ? 'granted' : 'denied';
      return persistenceState.value;
    }

    // Timed out: the browser hasn't said. Report the REAL persisted() read (that promise
    // answers promptly — measured on firefox) and adopt the pending answer whenever it lands.
    let persistedNow = false;
    try {
      persistedNow = typeof manager.persisted === 'function' ? await manager.persisted() : false;
    } catch {
      persistedNow = false;
    }
    persistenceState.value = persistedNow ? 'granted' : 'denied';
    persistenceError.value = !persistedNow;
    void answer.then(
      (grantedLate) => {
        persistenceState.value = grantedLate ? 'granted' : 'denied';
        persistenceError.value = false;
      },
      () => {
        persistenceState.value = 'denied';
        persistenceError.value = true;
      },
    );
    return persistenceState.value;
  } catch {
    persistenceError.value = true;
    persistenceState.value = 'denied';
    return 'denied';
  }
}

/**
 * §3.5 ephemeral-storage heuristic — best effort, never a hard gate:
 * `persist()` is not granted AND (the quota is tiny OR a localStorage probe throws, which is
 * the classic private-mode signature). Used by the first-write private-browsing dialog.
 */
export async function looksEphemeral(): Promise<boolean> {
  const manager = storage();
  if (manager === null) return false;

  let granted = false;
  if (typeof manager.persisted === 'function') {
    try {
      granted = await manager.persisted();
    } catch {
      granted = false;
    }
  }
  if (granted) return false;

  if (typeof manager.estimate === 'function') {
    try {
      const estimate = await manager.estimate();
      if (
        typeof estimate.quota === 'number' &&
        estimate.quota > 0 &&
        estimate.quota < 50 * 1024 * 1024
      ) {
        return true;
      }
    } catch {
      // Fall through to the localStorage probe.
    }
  }
  return localStorageProbeFails();
}

/**
 * `true` when localStorage rejects a write — hardened/private contexts do exactly that.
 *
 * N2 (ADR-002 Decision 7): that decision closes the localStorage key list at three
 * boot-critical prefs, so a throwaway `todo:prefs:v1:probe` key is NOT allowed. The probe
 * therefore writes an ALLOWED key with the value it already holds: an existing
 * `dismissedBanners` list is rewritten byte-for-byte (no change to what the app reads) and an
 * absent one is created as `[]` — which is exactly what "absent" means — then removed again.
 * A private-mode `setItem` rejection still throws here, so §3.5's signature is unchanged.
 */
function localStorageProbeFails(): boolean {
  try {
    const store = (globalThis as { localStorage?: Storage }).localStorage;
    if (store === undefined) return false;
    const key = PREFS_KEYS.dismissed;
    const before = store.getItem(key);
    store.setItem(key, before ?? '[]');
    if (before === null) store.removeItem(key);
    return false;
  } catch {
    return true;
  }
}
