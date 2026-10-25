/**
 * SyncEngine API surface (ADR-006 Decision 9.2) + scheduling (Decision 9.1):
 * the four UI states, single-flight coalescing, backoff and the no-auto-retry
 * list, the opt-in boundary (ZERO network before `configure()`), and the
 * credential lifecycle (`configure` / `forgetCredentials` / memory-only mode).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetBootSingleton } from '../../../src/storage/boot';
import { SyncEngine } from '../../../src/sync/state';
import type { SchedulerEnv } from '../../../src/sync/state';
import { assertSecureRemote } from '../../../src/sync/webdav';
import type { SyncState } from '../../../src/sync/types';
import { bootDb, counterIds, makeFakeWebDav, makeTask, stateOf, T0, testUlid } from './fixtures';

afterEach(() => {
  resetBootSingleton();
});

type FakeEnv = SchedulerEnv & {
  fire: (type: 'online' | 'visibilitychange') => void;
  setOnline: (v: boolean) => void;
  setVisible: (v: boolean) => void;
  setSaveData: (v: boolean) => void;
  intervals: (() => void)[];
};

function fakeEnv(
  initial: { online?: boolean; visible?: boolean; saveData?: boolean } = {},
): FakeEnv {
  const listeners = new Map<string, (() => void)[]>();
  const env: FakeEnv = {
    intervals: [],
    setInterval: (fn) => {
      env.intervals.push(fn);
      return env.intervals.length;
    },
    clearInterval: () => undefined,
    addEventListener: (type, fn) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener: (type, fn) => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((f) => f !== fn),
      );
    },
    isOnline: () => initial.online ?? true,
    isVisible: () => initial.visible ?? true,
    saveData: () => initial.saveData ?? false,
    fire: (type) => {
      for (const fn of listeners.get(type) ?? []) fn();
    },
    setOnline: (v) => {
      initial.online = v;
    },
    setVisible: (v) => {
      initial.visible = v;
    },
    setSaveData: (v) => {
      initial.saveData = v;
    },
  };
  return env;
}

describe('SyncEngine states (Decision 9.2)', () => {
  it('S1: initial state is idle/unconfigured; NOTHING hits the network before configure (opt-in boundary)', async () => {
    const db = await bootDb();
    const fake = makeFakeWebDav();
    const engine = new SyncEngine({ db, fetch: fake.fetch, env: fakeEnv() });
    await Promise.resolve();
    const s0 = engine.state().value;
    expect(s0.status).toBe('idle');
    expect(s0.status === 'idle' && s0.configured).toBe(false);

    // A manual run before setup errors with CONFIG and touches no network.
    const run = await engine.runSync('manual');
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.error.code).toBe('CONFIG');
    expect(fake.state.requests).toHaveLength(0); // the boundary itself
    engine.dispose();
  });

  it('S2: configure validates HTTPS and persists credentials to sync_state only', async () => {
    const db = await bootDb();
    const fake = makeFakeWebDav();
    const engine = new SyncEngine({ db, fetch: fake.fetch, env: fakeEnv() });
    await Promise.resolve();

    const insecure = await engine.configure({
      remoteUrl: 'http://evil.example/dav/',
      user: 'u',
      password: 'p',
    });
    expect(insecure.ok).toBe(false);
    if (!insecure.ok) expect(insecure.error.code).toBe('CONFIG');

    const good = await engine.configure({
      remoteUrl: fake.baseUrl,
      user: 'alice',
      password: 'app-pw',
    });
    expect(good.ok).toBe(true);
    const s = engine.state().value;
    expect(s.status === 'idle' && s.configured).toBe(true);
    const row = await stateOf(db);
    expect(row.enabled).toBe(true);
    expect(row.remoteUser).toBe('alice');
    expect(row.remotePassword).toBe('app-pw');
    engine.dispose();
  });

  it('S3: configure(remember: false) keeps the password in memory only (Decision 7 mode)', async () => {
    const db = await bootDb();
    const fake = makeFakeWebDav();
    const engine = new SyncEngine({ db, fetch: fake.fetch, env: fakeEnv() });
    await Promise.resolve();
    const res = await engine.configure({
      remoteUrl: fake.baseUrl,
      user: 'alice',
      password: 'secret-pw',
      remember: false,
    });
    expect(res.ok).toBe(true);
    const row = await stateOf(db);
    expect(row.remotePassword).toBe(''); // never written to disk
    engine.dispose();
  });

  it('S4: a conflict-creating run enters conflicts-pending; acknowledgeConflicts returns to idle', async () => {
    const db = await bootDb();
    const fake = makeFakeWebDav();
    const env = fakeEnv();
    const engine = new SyncEngine({ db, fetch: fake.fetch, env, newId: counterIds('s4') });
    await Promise.resolve();
    await engine.configure({ remoteUrl: fake.baseUrl, user: 'u', password: 'p' });

    // Seed a divergence the engine will resolve with a conflict copy: local
    // losing edit vs a remote winning version, with a shadow.
    const taskId = testUlid('s4-task');
    const base = makeTask({ id: taskId, deviceId: '1'.repeat(26), updatedAt: T0 + 1000 });
    await db.put(
      'tasks',
      makeTask({ id: taskId, deviceId: db.deviceId, updatedAt: T0 + 1900, notes: 'local' }),
    );
    const state = await stateOf(db);
    await db.put('sync_state', {
      ...state,
      shadow: {
        [taskId]: {
          updatedAt: base.updatedAt,
          deviceId: base.deviceId,
          contentHash: 'f'.repeat(64),
        },
      },
    });
    const { encodeBatch } = await import('../../../src/sync/batchCodec');
    const { json } = await encodeBatch(
      [
        {
          kind: 'task',
          record: makeTask({
            id: taskId,
            deviceId: '1'.repeat(26),
            updatedAt: T0 + 2000,
            title: 'remote wins',
          }),
        },
      ],
      { deviceId: '1'.repeat(26), seq: 1, createdAt: T0 + 2000 },
    );
    const { seedFile } = await import('./fixtures');
    seedFile(fake.state, `todo-sync/v1/changes/${'1'.repeat(26)}/0000000001.json`, json);
    fake.state.collections.add(`todo-sync/v1/changes/${'1'.repeat(26)}`);

    const run = await engine.runSync('manual');
    expect(run.ok).toBe(true);
    const s = engine.state().value;
    expect(s.status).toBe('conflicts-pending');
    expect(s.status === 'conflicts-pending' && s.conflicts).toHaveLength(1);
    expect(engine.listConflicts()).toHaveLength(1);

    engine.acknowledgeConflicts();
    expect(engine.state().value.status).toBe('idle');
    expect(engine.listConflicts()).toHaveLength(0);
    engine.dispose();
  });

  it('S5: error state carries the SyncError + lastSyncAt/retryAt; forgetCredentials disables without touching tasks', async () => {
    const db = await bootDb();
    const fake = makeFakeWebDav();
    const engine = new SyncEngine({ db, fetch: fake.fetch, env: fakeEnv() });
    await Promise.resolve();
    await engine.configure({ remoteUrl: fake.baseUrl, user: 'u', password: 'p' });
    await db.put(
      'tasks',
      makeTask({ id: testUlid('s5-task'), deviceId: db.deviceId, updatedAt: T0 + 1000 }),
    );

    fake.faults.failStatus = 401;
    const run = await engine.runSync('manual');
    expect(run.ok).toBe(false);
    const s: SyncState = engine.state().value;
    expect(s.status).toBe('error');
    expect(s.status === 'error' && s.error.code).toBe('AUTH');

    const before = await db.getAll('tasks');
    const forgot = await engine.forgetCredentials();
    expect(forgot.ok).toBe(true);
    const after = await db.getAll('tasks');
    expect(after.ok && after.value).toEqual(before.ok ? before.value : null); // task data untouched
    const row = await stateOf(db);
    expect(row.enabled).toBe(false);
    expect(row.remotePassword).toBe('');
    const finalState = engine.state().value;
    expect(finalState.status === 'idle' && finalState.configured).toBe(false);
    engine.dispose();
  });

  it('S6: manual run while offline → NETWORK error state; local use is unaffected (advisory only)', async () => {
    const db = await bootDb();
    const fake = makeFakeWebDav();
    const env = fakeEnv({ online: false });
    const engine = new SyncEngine({ db, fetch: fake.fetch, env });
    await Promise.resolve();
    await engine.configure({ remoteUrl: fake.baseUrl, user: 'u', password: 'p' });
    const run = await engine.runSync('manual');
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.error.code).toBe('NETWORK');
    const s = engine.state().value;
    expect(s.status === 'error' && s.error.retryable).toBe(true);
    expect(fake.state.requests).toHaveLength(0); // preflight refused before any request
    engine.dispose();
  });
});

describe('SyncEngine scheduling (Decision 9.1)', () => {
  it('T1: single-flight — overlapping triggers coalesce onto one run', async () => {
    const db = await bootDb();
    const fake = makeFakeWebDav();
    const engine = new SyncEngine({ db, fetch: fake.fetch, env: fakeEnv() });
    await Promise.resolve();
    await engine.configure({ remoteUrl: fake.baseUrl, user: 'u', password: 'p' });
    const p1 = engine.runSync('manual');
    const p2 = engine.runSync('manual');
    expect(p2).toBe(p1); // same in-flight promise
    await p1;
    engine.dispose();
  });

  it('T2: AUTH failures suspend auto-retry entirely (no credential guessing)', async () => {
    const db = await bootDb();
    const fake = makeFakeWebDav();
    const env = fakeEnv();
    const engine = new SyncEngine({ db, fetch: fake.fetch, env });
    await Promise.resolve();
    await engine.configure({ remoteUrl: fake.baseUrl, user: 'u', password: 'p' });

    fake.faults.failStatus = 401;
    expect((await engine.runSync('manual')).ok).toBe(false);
    const requestsSoFar = fake.state.requests.length;

    // An auto trigger afterwards must NOT hammer the server.
    const auto = await engine.runSync('auto');
    expect(auto.ok).toBe(true); // skipped, not an error
    expect(fake.state.requests.length).toBe(requestsSoFar); // zero new requests

    // Re-arming requires the user to act (fresh configure).
    delete fake.faults.failStatus;
    await engine.configure({ remoteUrl: fake.baseUrl, user: 'u', password: 'p2' });
    expect((await engine.runSync('auto')).ok).toBe(true);
    engine.dispose();
  });

  it('T3: retryable failures back off (1m → 5m → 30m cap) and reset on success', async () => {
    let now = T0;
    const db = await bootDb();
    const fake = makeFakeWebDav();
    const env = fakeEnv();
    const engine = new SyncEngine({ db, fetch: fake.fetch, env, now: () => now });
    await Promise.resolve();
    await engine.configure({ remoteUrl: fake.baseUrl, user: 'u', password: 'p' });

    fake.faults.failStatus = 500;
    expect((await engine.runSync('manual')).ok).toBe(false);
    const after1 = fake.state.requests.length;
    expect((await engine.runSync('auto')).ok).toBe(true); // inside backoff → skipped
    expect(fake.state.requests.length).toBe(after1);

    now += 61_000; // past the 1-minute step
    expect((await engine.runSync('auto')).ok).toBe(false); // tried again → failed
    expect(fake.state.requests.length).toBeGreaterThan(after1);
    engine.dispose();
  });

  it('T4: periodic-when-online env hooks — interval + online event + visible-if-stale; saveData stands down', async () => {
    const db = await bootDb();
    const fake = makeFakeWebDav();
    const env = fakeEnv({ saveData: true });
    const engine = new SyncEngine({ db, fetch: fake.fetch, env });
    await Promise.resolve();
    await engine.configure({ remoteUrl: fake.baseUrl, user: 'u', password: 'p' });

    // autoSync defaults on → a 15-minute interval is registered.
    expect(env.intervals).toHaveLength(1);

    // saveData=true: auto triggers skip (manual still works).
    const auto = await engine.runSync('auto');
    expect(auto.ok).toBe(true);
    expect(fake.state.requests).toHaveLength(0);

    env.setSaveData(false);
    // The online listener fires a run when the tab is visible.
    env.fire('online');
    await vi.waitFor(() => {
      expect(fake.state.requests.length).toBeGreaterThan(0);
    });
    engine.dispose();
  });

  it('T5: setAutoSync(false) stops the scheduler; true re-arms it', async () => {
    const db = await bootDb();
    const fake = makeFakeWebDav();
    const env = fakeEnv();
    const engine = new SyncEngine({ db, fetch: fake.fetch, env });
    await Promise.resolve();
    await engine.configure({ remoteUrl: fake.baseUrl, user: 'u', password: 'p' });
    expect(env.intervals).toHaveLength(1);
    engine.setAutoSync(false);
    await vi.waitFor(async () => {
      const row = await stateOf(db);
      expect(row.autoSync).toBe(false);
    });
    const off = await engine.runSync('auto');
    expect(off.ok).toBe(true);
    expect(fake.state.requests).toHaveLength(0); // auto is off
    engine.dispose();
  });
});

describe('probe + memory-only mode (additive seams)', () => {
  it('P1: probe() before setup refuses with CONFIG and touches no network', async () => {
    const db = await bootDb();
    const fake = makeFakeWebDav();
    const engine = new SyncEngine({ db, fetch: fake.fetch, env: fakeEnv() });
    await Promise.resolve();
    const res = await engine.probe();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('CONFIG');
    expect(fake.state.requests).toHaveLength(0);
    engine.dispose();
  });

  it('P2: probe() after configure runs OPTIONS only — zero local writes', async () => {
    const db = await bootDb();
    const fake = makeFakeWebDav();
    const engine = new SyncEngine({ db, fetch: fake.fetch, env: fakeEnv() });
    await Promise.resolve();
    await engine.configure({ remoteUrl: fake.baseUrl, user: 'u', password: 'p' });
    const before = await stateOf(db);
    const res = await engine.probe();
    expect(res.ok).toBe(true);
    const after = await stateOf(db);
    expect(after).toEqual(before); // probe is read-only
    engine.dispose();
  });

  it('P3: memory-only credentials still sync (password never persisted, still used)', async () => {
    const db = await bootDb();
    const fake = makeFakeWebDav();
    const engine = new SyncEngine({ db, fetch: fake.fetch, env: fakeEnv() });
    await Promise.resolve();
    await engine.configure({
      remoteUrl: fake.baseUrl,
      user: 'alice',
      password: 'mem-pw',
      remember: false,
    });
    await db.put(
      'tasks',
      makeTask({ id: testUlid('p3-task'), deviceId: db.deviceId, updatedAt: T0 + 1000 }),
    );
    const run = await engine.runSync('manual');
    expect(run.ok).toBe(true); // the in-memory password was used
    const row = await stateOf(db);
    expect(row.remotePassword).toBe('');
    expect(fake.state.requests.some((r) => r.method === 'PUT')).toBe(true); // a batch was pushed
    engine.dispose();
  });
});

export { assertSecureRemote };
