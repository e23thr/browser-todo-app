/**
 * E8 sync UI — host boot discipline (S9): the PRODUCTION paths of
 * src/features/sync/syncHost.ts. The other three sync-UI suites always install
 * a test-seam engine, so the logic only they leave uncovered lives here:
 *
 *  - nothing bound → bootSyncEngine() opens NOTHING and the panel degrades to
 *    honest "unavailable" copy (§9.4 — the UI never boots storage itself);
 *  - storage bound → the host adopts the handle, builds exactly ONE engine and
 *    bumps the epoch once (idempotent), and boot + wizard render + configure()
 *    together make ZERO network requests — the opt-in boundary on the real
 *    path, where the engine has no injected transport to hide behind;
 *  - readSyncConfig → address + user for the wizard prefill, NEVER the
 *    password, and null (never a throw) with no host, no row, no address, or
 *    unusable storage.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { render, screen } from '@testing-library/preact';

import { bindDataSafetyDb } from '../../src/portability';
import { SyncPanel } from '../../src/features/sync/SyncPanel';
import {
  bootSyncEngine,
  readSyncConfig,
  resetSyncHost,
  syncEngine,
  syncEngineEpoch,
} from '../../src/features/sync/syncHost';
import type { AppDBImpl } from '../../src/storage/db';
import { stateOf } from '../unit/sync/fixtures';
import { openFixtureDb } from '../unit/storage/fixtures';
import { setUpSync, tearDownSync } from './sync-harness';

/* --------------------------------- helpers --------------------------------- */

const opened: AppDBImpl[] = [];

async function openHostDb(): Promise<AppDBImpl> {
  const db = await openFixtureDb(`sync-host-${String(Date.now())}-${String(opened.length)}`);
  opened.push(db);
  return db;
}

/**
 * A recording global `fetch` that FAILS LOUDLY if anything reaches for the
 * network: the boundary assertion is "zero calls" on the production boot path,
 * where the engine runs without an injected transport.
 */
function trackFetch(): { calls: () => number; restore: () => void } {
  const original: unknown = globalThis.fetch;
  const calls: unknown[][] = [];
  globalThis.fetch = (...args: unknown[]): Promise<Response> => {
    calls.push(args);
    return Promise.reject(new Error('unexpected network call during sync-host boot'));
  };
  return {
    calls: () => calls.length,
    restore: () => {
      globalThis.fetch = original as typeof globalThis.fetch;
    },
  };
}

beforeEach(() => {
  setUpSync();
  bindDataSafetyDb(null);
});

afterEach(() => {
  tearDownSync();
  bindDataSafetyDb(null);
  for (const db of opened.splice(0)) db.close();
});

/* --------------------------------- suites ---------------------------------- */

describe('sync host boot discipline (S9)', () => {
  it('unbound storage: boot opens nothing and the panel degrades to honest copy', async () => {
    const epoch = syncEngineEpoch.value;
    expect(bootSyncEngine()).toBeNull();
    expect(syncEngine()).toBeNull();
    expect(syncEngineEpoch.value).toBe(epoch); // a refused boot never claims success
    expect(await readSyncConfig()).toBeNull(); // no host → null, never a throw

    render(<SyncPanel />);
    expect(screen.getByTestId('sync-unavailable').textContent).toContain('Sync is unavailable');
  });

  it('bound storage: adopts the handle, builds one engine, bumps the epoch once — and never fetches', async () => {
    const fetchLog = trackFetch();
    try {
      const db = await openHostDb();
      bindDataSafetyDb(db);

      const epochBefore = syncEngineEpoch.value;
      const host = bootSyncEngine();
      if (host === null) throw new Error('host must boot against bound storage');
      expect(syncEngine()).toBe(host);
      expect(syncEngineEpoch.value).toBe(epochBefore + 1);

      // Idempotent: the app boot path may reach it from more than one place.
      expect(bootSyncEngine()).toBe(host);
      expect(syncEngineEpoch.value).toBe(epochBefore + 1);

      // Hydration still in flight → no row yet → prefill degrades to null…
      expect(await readSyncConfig()).toBeNull();
      // …and once the default row is seeded (empty address) → still null.
      await stateOf(db);
      expect(await readSyncConfig()).toBeNull();

      render(<SyncPanel />);
      expect(screen.queryByTestId('sync-unavailable')).toBeNull();
      expect(screen.getByRole('textbox', { name: 'WebDAV address' })).toBeTruthy();

      // Adopt, construct, hydrate, render — zero requests to any host.
      expect(fetchLog.calls()).toBe(0);
    } finally {
      fetchLog.restore();
    }
  });

  it('readSyncConfig hands back address + user for the prefill — never the password', async () => {
    const fetchLog = trackFetch();
    try {
      expect(await readSyncConfig()).toBeNull(); // no host yet

      const db = await openHostDb();
      bindDataSafetyDb(db);
      const host = bootSyncEngine();
      if (host === null) throw new Error('host must boot against bound storage');
      // Let hydration settle before configure — same connection FIFO the engine rig relies on.
      await stateOf(db);

      const configured = await host.configure({
        remoteUrl: 'https://dav.test/base/',
        user: 'alice',
        password: 'app-pw',
      });
      expect(configured.ok).toBe(true);

      const prefill = await readSyncConfig();
      // Exact shape: remoteUrl + remoteUser and nothing else — no password field.
      expect(prefill).toEqual({ remoteUrl: 'https://dav.test/base/', remoteUser: 'alice' });

      // configure() is a local write — the address never travelled anywhere.
      expect(fetchLog.calls()).toBe(0);

      // Torn-down host → the prefill read degrades to null again.
      resetSyncHost();
      expect(await readSyncConfig()).toBeNull();
    } finally {
      fetchLog.restore();
    }
  });

  it('readSyncConfig degrades to null when the bound storage is unusable — never a throw', async () => {
    const db = await openHostDb();
    bindDataSafetyDb(db);
    if (bootSyncEngine() === null) throw new Error('host must boot against bound storage');

    db.close(); // storage gone under the host: reads fail → Result err → null
    expect(await readSyncConfig()).toBeNull();
  });
});
