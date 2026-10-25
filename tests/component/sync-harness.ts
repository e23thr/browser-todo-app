/**
 * Shared rig for the E8 sync-UI component suites (S9).
 *
 * Real `SyncEngine` over the engine fixtures (`bootDb` + `makeFakeWebDav`), a
 * deterministic `SchedulerEnv`, the core-UI store/region harness for the task
 * store and live regions, and a structural `fakeEngine` for pure render paths
 * (notice/error copy) that need no database at all.
 */

import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';

import { resetResolvedConflicts } from '../../src/features/sync/conflicts';
import {
  bindSyncEngineForTest,
  resetSyncHost,
  type SyncHostEngine,
} from '../../src/features/sync/syncHost';
import { SyncEngine } from '../../src/sync';
import type { FetchLike, SchedulerEnv, SyncState } from '../../src/sync';
import { resetBootSingleton } from '../../src/storage/boot';
import type { AppDB } from '../../src/storage/db';
import {
  bootDb,
  makeFakeWebDav,
  stateOf,
  type FakeDavFaults,
  type FakeDavState,
} from '../unit/sync/fixtures';
import { regions, seed, setUpCoreUi, tearDownCoreUi } from './core-ui-harness';

export { regions, seed };
export type { FakeDavFaults, FakeDavState };

/* ------------------------------- scheduler env ------------------------------- */

export type FakeEnv = SchedulerEnv & {
  fire: (type: 'online' | 'visibilitychange') => void;
  setOnline: (value: boolean) => void;
  /** Intervals the engine registered but has not cleared (auto-sync armed). */
  activeIntervals: () => number;
};

export function envStub(initial: { online?: boolean } = {}): FakeEnv {
  const listeners = new Map<string, (() => void)[]>();
  const live = new Set<unknown>();
  const env: FakeEnv = {
    setInterval: (fn) => {
      const handle = { fn };
      live.add(handle);
      return handle;
    },
    clearInterval: (handle) => {
      live.delete(handle);
    },
    addEventListener: (type, fn) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener: (type, fn) => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((entry) => entry !== fn),
      );
    },
    isOnline: () => initial.online ?? true,
    isVisible: () => true,
    saveData: () => false,
    fire: (type) => {
      for (const fn of listeners.get(type) ?? []) fn();
    },
    setOnline: (value) => {
      initial.online = value;
    },
    activeIntervals: () => live.size,
  };
  return env;
}

/* --------------------------------- engine rig -------------------------------- */

export interface EngineRig {
  readonly db: AppDB;
  readonly fake: ReturnType<typeof makeFakeWebDav>;
  readonly env: FakeEnv;
  readonly engine: SyncEngine;
}

/**
 * A fresh unconfigured engine over a booted database and the fake WebDAV
 * server. `await stateOf(db)` lets the constructor's hydration settle first
 * (same-connection FIFO), so `configure()` can never lose the race.
 */
export async function makeEngine(
  options: { online?: boolean; fetch?: FetchLike; fake?: ReturnType<typeof makeFakeWebDav> } = {},
): Promise<EngineRig> {
  const db = await bootDb();
  const fake = options.fake ?? makeFakeWebDav();
  const env = envStub({ online: options.online ?? true });
  const engine = new SyncEngine({ db, fetch: options.fetch ?? fake.fetch, env });
  await stateOf(db);
  return { db, fake, env, engine };
}

/** Same rig with setup already completed (the status-surface suites start here). */
export async function configuredEngine(
  options: { online?: boolean; fetch?: FetchLike; fake?: ReturnType<typeof makeFakeWebDav> } = {},
): Promise<EngineRig> {
  const rig = await makeEngine(options);
  const configured = await rig.engine.configure({
    remoteUrl: rig.fake.baseUrl,
    user: 'alice',
    password: 'app-pw',
  });
  if (!configured.ok) throw new Error(`configure failed: ${configured.error.code}`);
  bindSyncEngineForTest(rig.engine, rig.db);
  return rig;
}

/** Bind an unconfigured engine into the host (the wizard suite starts here). */
export function bindUnconfigured(rig: EngineRig): void {
  bindSyncEngineForTest(rig.engine, rig.db);
}

/* ------------------------- structural fake engine ---------------------------- */

/**
 * A `SyncHostEngine` with a hand-set state signal — for pure render paths
 * (error-code copy, notices) where a real run would only add noise.
 */
export function fakeEngine(init: { state: SyncState }): {
  engine: SyncHostEngine;
  state: Signal<SyncState>;
} {
  const state = signal<SyncState>(init.state);
  const engine: SyncHostEngine = {
    configure: () => {
      throw new Error('fake engine: configure is not wired');
    },
    probe: () => {
      throw new Error('fake engine: probe is not wired');
    },
    runSync: () => {
      throw new Error('fake engine: runSync is not wired');
    },
    state: () => state,
    listConflicts: () => [],
    acknowledgeConflicts: () => {
      /* noop — render-path tests never resolve conflicts */
    },
    setAutoSync: () => {
      /* noop */
    },
    forgetCredentials: () => {
      throw new Error('fake engine: forgetCredentials is not wired');
    },
    dispose: () => {
      /* noop */
    },
  };
  return { engine, state };
}

/* --------------------------------- lifecycle --------------------------------- */

/** Fresh live regions + task store, and no engine left over from a prior test. */
export function setUpSync(): void {
  setUpCoreUi();
  resetSyncHost();
  resetResolvedConflicts();
}

export function tearDownSync(): void {
  resetSyncHost();
  resetResolvedConflicts();
  tearDownCoreUi();
  resetBootSingleton();
}
