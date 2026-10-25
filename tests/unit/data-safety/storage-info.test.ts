import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  estimateSupported,
  looksEphemeral,
  persistSupported,
  persistenceError,
  persistenceState,
  PERSIST_SETTLE_TIMEOUT_MS,
  refreshPersistence,
  refreshQuota,
  requestPersist,
  resetStorageInfo,
  quotaState,
} from '../../../src/features/data-safety/storageInfo';
import {
  isPersistGateOpen,
  noteFirstMeaningfulWrite,
  resetPersistGate,
} from '../../../src/features/data-safety/persistGate';
import { currentDialog, resetDialogs } from '../../../src/features/data-safety/notices';
import {
  hasPriorData,
  markPrivateWarned,
  resetFlags,
} from '../../../src/features/data-safety/flags';

type StorageMock = {
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
  persist?: () => Promise<boolean>;
  persisted?: () => Promise<boolean>;
};

const originalDescriptor = Object.getOwnPropertyDescriptor(navigator, 'storage');

function installStorage(mock: StorageMock | undefined): void {
  if (mock === undefined) {
    Reflect.deleteProperty(navigator, 'storage');
    return;
  }
  Object.defineProperty(navigator, 'storage', { value: mock, configurable: true });
}

afterEach(() => {
  if (originalDescriptor === undefined) {
    Reflect.deleteProperty(navigator, 'storage');
  } else {
    Object.defineProperty(navigator, 'storage', originalDescriptor);
  }
  resetStorageInfo();
  resetPersistGate();
  resetDialogs();
  window.localStorage.clear();
  resetFlags();
});

describe('StorageManager feature detection (§9.4)', () => {
  it('degrades to unknown/unsupported when navigator.storage is missing entirely', async () => {
    installStorage(undefined);
    expect(estimateSupported()).toBe(false);
    expect(persistSupported()).toBe(false);

    const quota = await refreshQuota();
    expect(quota).toEqual({ usedBytes: 0, totalBytes: null, supported: false, loading: false });
    expect(await refreshPersistence()).toBe('unsupported');
    expect(await requestPersist()).toBe('unsupported');
  });

  it('reads a healthy estimate into the meter state', async () => {
    installStorage({
      estimate: async () => ({ usage: 43_000_000, quota: 2 * 1024 * 1024 * 1024 }),
    });
    const quota = await refreshQuota();
    expect(quota.usedBytes).toBe(43_000_000);
    expect(quota.totalBytes).toBe(2 * 1024 * 1024 * 1024);
    expect(quota.supported).toBe(true);
    expect(quotaState.value.loading).toBe(false);
  });

  it('falls back to the unknown state when estimate() rejects', async () => {
    installStorage({ estimate: async () => Promise.reject(new Error('SecurityError')) });
    const quota = await refreshQuota();
    expect(quota.supported).toBe(false);
    expect(quota.loading).toBe(false);
  });

  it('supports a partial estimate (usage without quota → unknown tier)', async () => {
    installStorage({ estimate: async () => ({ usage: 1024 }) });
    const quota = await refreshQuota();
    expect(quota.usedBytes).toBe(1024);
    expect(quota.totalBytes).toBeNull();
    expect(quota.supported).toBe(false);
  });
});

describe('persistence grant states (§4.3, §10.3)', () => {
  it('reports not-requested before anyone asks, denied after a refusal', async () => {
    installStorage({ persist: async () => false, persisted: async () => false });
    expect(await refreshPersistence()).toBe('not-requested');
    expect(await requestPersist()).toBe('denied');
    // Once requested, persisted() === false now means "denied", not "not requested".
    expect(await refreshPersistence()).toBe('denied');
    expect(persistenceState.value).toBe('denied');
  });

  it('reports granted when the browser grants', async () => {
    installStorage({ persist: async () => true, persisted: async () => true });
    expect(await requestPersist()).toBe('granted');
    expect(await refreshPersistence()).toBe('granted');
  });

  it('captures a throwing persist() as the §10.5 error state without rejecting', async () => {
    installStorage({
      persist: async () => Promise.reject(new Error('blocked')),
      persisted: async () => false,
    });
    expect(await requestPersist()).toBe('denied');
    expect(persistenceError.value).toBe(true);
  });
});

describe('never-settling persist() — the §9.4 best-effort bound (nightly t_e20c2adb)', () => {
  // Firefox resolves persist() ONLY when the user answers its permission prompt, which in an
  // unattended/automated window may be never (repro: Playwright firefox, 25 s+ pending). An
  // unbounded await would hang the first-write gate forever — the exact nightly failure.
  afterEach(() => {
    vi.useRealTimers();
  });

  it('requestPersist() reports the persisted() truth after the settle bound instead of hanging', async () => {
    vi.useFakeTimers();
    installStorage({
      persist: () => new Promise<boolean>(() => undefined), // never settles
      persisted: async () => false,
    });

    const pending = requestPersist();
    await vi.advanceTimersByTimeAsync(PERSIST_SETTLE_TIMEOUT_MS);

    expect(await pending).toBe('denied');
    expect(persistenceState.value).toBe('denied');
    // The browser never answered — §10.5 "This browser wouldn't say." is the honest copy.
    expect(persistenceError.value).toBe(true);
  });

  it('adopts a late answer once the prompt is finally answered (row never stays a lie)', async () => {
    vi.useFakeTimers();
    let grantLate: ((granted: boolean) => void) | undefined;
    installStorage({
      persist: () =>
        new Promise<boolean>((resolve) => {
          grantLate = resolve;
        }),
      persisted: async () => false,
    });

    const pending = requestPersist();
    await vi.advanceTimersByTimeAsync(PERSIST_SETTLE_TIMEOUT_MS);
    expect(await pending).toBe('denied');
    expect(persistenceError.value).toBe(true);

    grantLate?.(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(persistenceState.value).toBe('granted');
    expect(persistenceError.value).toBe(false);
  });

  it('the first-write gate always completes and runs exactly once, even when persist() hangs', async () => {
    vi.useFakeTimers();
    const persist = vi.fn(() => new Promise<boolean>(() => undefined));
    installStorage({
      persist,
      persisted: async () => false,
      estimate: async () => ({ quota: 2 * 1024 * 1024 * 1024 }),
    });
    window.localStorage.clear();
    resetFlags();

    const gate = noteFirstMeaningfulWrite();
    await vi.advanceTimersByTimeAsync(PERSIST_SETTLE_TIMEOUT_MS);
    await gate;

    expect(isPersistGateOpen()).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persistenceState.value).toBe('denied');
    // Ordinary quota → no private-browsing dialog, and the durable prior-data mark still landed.
    expect(currentDialog()).toBeNull();
    expect(hasPriorData()).toBe(true);
  });
});

describe('ephemeral-storage heuristic (§3.5)', () => {
  it('is NOT ephemeral when storage is persisted', async () => {
    installStorage({
      persisted: async () => true,
      estimate: async () => ({ quota: 1_000_000 }),
    });
    expect(await looksEphemeral()).toBe(false);
  });

  it('flags a tiny quota behind a denied persist() as ephemeral', async () => {
    installStorage({
      persisted: async () => false,
      estimate: async () => ({ quota: 10 * 1024 * 1024 }),
    });
    expect(await looksEphemeral()).toBe(true);
  });

  it('does not flag an ordinary quota', async () => {
    installStorage({
      persisted: async () => false,
      estimate: async () => ({ quota: 2 * 1024 * 1024 * 1024 }),
    });
    expect(await looksEphemeral()).toBe(false);
  });

  it('flags a localStorage write failure (classic private-mode signature)', async () => {
    installStorage({
      persisted: async () => false,
      estimate: async () => ({ quota: 2 * 1024 * 1024 * 1024 }),
    });
    const broken = {
      setItem() {
        throw new Error('QuotaExceededError');
      },
      removeItem() {
        /* unreachable */
      },
    };
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    try {
      Object.defineProperty(globalThis, 'localStorage', { value: broken, configurable: true });
      expect(await looksEphemeral()).toBe(true);
    } finally {
      if (descriptor === undefined) {
        Reflect.deleteProperty(globalThis, 'localStorage');
      } else {
        Object.defineProperty(globalThis, 'localStorage', descriptor);
      }
    }
    // The real store is back for the rest of the run.
    expect(window.localStorage).toBeDefined();
  });
});

describe('first-meaningful-use gate (§5.5 + §3.5)', () => {
  it('requests persist() exactly once and opens the private-browsing dialog when ephemeral', async () => {
    const persist = vi.fn(async () => false);
    installStorage({
      persist,
      persisted: async () => false,
      estimate: async () => ({ quota: 8_000_000 }),
    });
    window.localStorage.clear();
    resetFlags();

    await noteFirstMeaningfulWrite();
    await noteFirstMeaningfulWrite();

    expect(isPersistGateOpen()).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persistenceState.value).toBe('denied');
    expect(currentDialog()?.request.kind).toBe('private-browsing');
  });

  it('records the durable "this profile now holds rows" mark on the first task write (§3.4)', async () => {
    installStorage({
      persist: async () => true,
      persisted: async () => true,
      estimate: async () => ({ quota: 8_000_000 }),
    });
    window.localStorage.clear();
    resetFlags();
    expect(hasPriorData()).toBe(false);

    await noteFirstMeaningfulWrite();

    // The evidence has to exist from the moment data exists: if IndexedDB is evicted before
    // the next boot, this flag is the only thing that can still say "rows were lost".
    expect(hasPriorData()).toBe(true);
    expect(window.localStorage.getItem('todo:prefs:v1:dismissedBanners')).toContain('had-data');
  });

  it('warns at most once per profile', async () => {
    installStorage({
      persist: async () => false,
      persisted: async () => false,
      estimate: async () => ({ quota: 8_000_000 }),
    });
    markPrivateWarned();

    await noteFirstMeaningfulWrite();

    expect(currentDialog()).toBeNull();
  });

  it('never opens the warning when the browser grants persistence', async () => {
    installStorage({
      persist: async () => true,
      persisted: async () => true,
      estimate: async () => ({ quota: 8_000_000 }),
    });

    await noteFirstMeaningfulWrite();

    expect(currentDialog()).toBeNull();
    expect(persistenceState.value).toBe('granted');
  });
});
