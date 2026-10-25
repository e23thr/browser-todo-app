/**
 * E8 sync UI — status surface (S9): idle / syncing / error / conflicts-pending
 * over the engine's documented states, manual + periodic-when-online triggers,
 * live-region announcements, and the two acceptance-critical properties:
 *
 *  - an OFFLINE sync attempt shows a clear error state and leaves local data
 *    untouched (evidence below is byte-identical before/after);
 *  - every engine error code maps onto honest catalog copy (Decision 6 table),
 *    with the retry countdown only where auto-retry actually runs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fireEvent, render, screen, waitFor } from '@testing-library/preact';

import { loadSettings, registerSettingsPersistence } from '../../src/app/settings';
import { setListOptions } from '../../src/app/lists';
import SettingsView from '../../src/features/settings/SettingsView';
import { SyncPanel } from '../../src/features/sync/SyncPanel';
import { bindSyncEngineForTest } from '../../src/features/sync/syncHost';
import type { SyncErrorCode, SyncError, SyncRunSummary, SyncState } from '../../src/sync';
import { makeFakeWebDav, stateOf } from '../unit/sync/fixtures';
import {
  configuredEngine,
  fakeEngine,
  regions,
  seed,
  setUpSync,
  tearDownSync,
} from './sync-harness';
import { makeList, makeTask, type TestRunner } from './fixtures';

beforeEach(() => {
  setUpSync();
});

afterEach(() => {
  tearDownSync();
});

/** Deep snapshot of the store's task rows — the "local data untouched" evidence. */
function snapshot(store: TestRunner): string {
  return JSON.stringify([...store.tasks.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

const baseSummary: SyncRunSummary = {
  startedAt: 0,
  finishedAt: 0,
  trigger: 'manual',
  pulled: { snapshots: 0, batches: 0, records: 0 },
  pushed: { batches: 0, records: 0 },
  applied: 0,
  conflictsCreated: 0,
  compacted: false,
  notices: [],
};

describe('sync status surface (S9)', () => {
  it('Settings hosts the sync panel at its documented mount point', async () => {
    registerSettingsPersistence(null);
    setListOptions([]);
    await loadSettings();
    const rig = await configuredEngine();
    expect(rig.engine.state().value.status).toBe('idle');

    render(<SettingsView />);

    expect(screen.getByRole('heading', { level: 2, name: 'Sync' })).toBeTruthy();
    const mount = document.querySelector('[data-mount-point="sync"]');
    expect(mount).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeTruthy();
  });

  it('idle surface: never-synced state, manual trigger, periodic toggle and forget action', async () => {
    const rig = await configuredEngine();
    render(<SyncPanel />);

    expect(screen.getByTestId('sync-status-line').textContent).toBe('Not synced yet');
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeTruthy();
    expect(
      screen.getByRole<HTMLInputElement>('checkbox', { name: 'Sync automatically when online' })
        .checked,
    ).toBe(true);
    // Decision 9.1 armed the periodic-when-online scheduler at configure time.
    expect(rig.env.activeIntervals()).toBe(1);
    expect(screen.getByRole('button', { name: 'Forget credentials' })).toBeTruthy();
    expect(screen.getByText(/storage server you chose/, { exact: true })).toBeTruthy();
  });

  it('manual sync runs, reports last-synced and announces completion', async () => {
    const rig = await configuredEngine();
    await seed({ lists: [makeList()], tasks: [makeTask({ title: 'Buy milk' })] });
    render(<SyncPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));

    await waitFor(() => {
      expect(screen.getByTestId('sync-status-line').textContent).toContain('Last synced:');
    });
    const state = rig.engine.state().value;
    expect(state.status).toBe('idle');
    expect(state.status === 'idle' && state.lastSyncAt).not.toBeNull();
    expect(rig.fake.state.requests.length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(regions.polite?.textContent).toContain('Sync finished');
    });
  });

  it('the in-flight run shows its phase in the status line and announces the start', async () => {
    const fake = makeFakeWebDav();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await configuredEngine({
      fake,
      fetch: async (input, init) => {
        await gate;
        return fake.fetch(input, init);
      },
    });
    render(<SyncPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));

    await waitFor(() => {
      expect(screen.getByTestId('sync-status-line').textContent).toContain('Syncing');
    });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Sync now' }).disabled).toBe(true);
    await waitFor(() => {
      expect(regions.polite?.textContent).toContain('Sync started');
    });

    release();
    await waitFor(() => {
      expect(screen.getByTestId('sync-status-line').textContent).toContain('Last synced:');
    });
    await waitFor(() => {
      expect(regions.polite?.textContent).toContain('Sync finished');
    });
  });

  it('offline attempt: clear error state, ZERO requests, local data byte-identical', async () => {
    const rig = await configuredEngine({ online: false });
    const store = await seed({
      lists: [makeList()],
      tasks: [makeTask({ title: 'Buy milk' }), makeTask({ title: 'Walk dog' })],
    });
    const before = snapshot(store);
    render(<SyncPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));

    const error = await screen.findByTestId('sync-error');
    expect(error.textContent).toContain('Cannot reach the storage server');
    expect(error.textContent).toContain('Your tasks on this device are unaffected');
    expect(rig.fake.state.requests).toHaveLength(0); // preflight refused before any request

    const state = rig.engine.state().value;
    expect(state.status).toBe('error');
    expect(state.status === 'error' && state.error.code).toBe('NETWORK');

    expect(snapshot(store)).toBe(before); // local data untouched — the evidence
    await waitFor(() => {
      expect(regions.assertive?.textContent).toContain('Sync failed');
    });
  });

  it('auto-sync toggle persists to sync_state and disarms/re-arms the scheduler', async () => {
    const rig = await configuredEngine();
    render(<SyncPanel />);

    const toggle = screen.getByRole<HTMLInputElement>('checkbox', {
      name: 'Sync automatically when online',
    });
    fireEvent.click(toggle);
    await waitFor(async () => {
      const row = await stateOf(rig.db);
      expect(row.autoSync).toBe(false);
    });
    expect(rig.env.activeIntervals()).toBe(0);

    fireEvent.click(toggle);
    await waitFor(async () => {
      const row = await stateOf(rig.db);
      expect(row.autoSync).toBe(true);
    });
    expect(rig.env.activeIntervals()).toBe(1);
  });

  it('forget credentials: turns sync off, returns to setup, task data untouched', async () => {
    const rig = await configuredEngine();
    const store = await seed({ lists: [makeList()], tasks: [makeTask({ title: 'Buy milk' })] });
    const before = snapshot(store);
    render(<SyncPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Forget credentials' }));

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'WebDAV address' })).toBeTruthy();
    });
    const row = await stateOf(rig.db);
    expect(row.enabled).toBe(false);
    expect(row.remotePassword).toBe('');
    expect(snapshot(store)).toBe(before);
    expect(rig.env.activeIntervals()).toBe(0);
    await waitFor(() => {
      expect(regions.polite?.textContent).toContain('credentials removed');
    });
  });

  it('AUTH failure from a run: honest copy + "Enter credentials again" re-opens setup with the address prefilled', async () => {
    const rig = await configuredEngine();
    rig.fake.faults.failStatus = 401;
    render(<SyncPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));

    const error = await screen.findByTestId('sync-error');
    expect(error.textContent).toContain('Sign-in rejected');
    // Non-retryable codes must NOT show a countdown (Decision 6 / §3 of the contract).
    expect(error.textContent).toContain('Automatic retries are paused');

    fireEvent.click(screen.getByRole('button', { name: 'Enter credentials again' }));

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'WebDAV address' })).toBeTruthy();
    });
    expect(screen.getByLabelText<HTMLInputElement>('WebDAV address', { exact: true }).value).toBe(
      rig.fake.baseUrl,
    );
    const row = await stateOf(rig.db);
    expect(row.remotePassword).toBe('');
    expect(row.enabled).toBe(false);
  });

  it('surfaces run notices (the "never silent" channel) under the status line', () => {
    const state: SyncState = {
      status: 'idle',
      configured: true,
      autoSync: true,
      lastSyncAt: 1_700_000_000_000,
      lastRun: {
        ...baseSummary,
        notices: [
          {
            kind: 'delete-lost',
            recordId: '01J000000000000000000000AA',
            title: 'Buy milk',
            lostTo: { updatedAt: 1, deviceId: 'B'.repeat(26) },
          },
        ],
      },
    };
    const rig = fakeEngine({ state });
    bindSyncEngineForTest(rig.engine);
    const view = render(<SyncPanel />);

    const notices = screen.getByTestId('sync-notices');
    expect(notices.textContent).toContain('Sync notices');
    expect(notices.textContent).toContain('Buy milk');
    view.unmount();
  });

  it('maps every engine error code to catalog copy — no raw keys, detail shown when present', () => {
    const codes: SyncErrorCode[] = [
      'CONFIG',
      'AUTH',
      'CORS',
      'NETWORK',
      'REMOTE_MISSING',
      'CONFLICT_WRITE',
      'CORRUPT_REMOTE',
      'SYNC_FORMAT_UNKNOWN',
      'SYNC_FORMAT_NEWER',
      'REMOTE_FULL',
      'LOCAL_STORAGE',
      'LOCKED',
      'ABORTED',
    ];

    for (const code of codes) {
      const error: SyncError = {
        code,
        message: 'engine message',
        retryable: code !== 'AUTH',
        ...(code === 'CORRUPT_REMOTE'
          ? { detail: 'todo-sync/v1/changes/dev/0000000001.json' }
          : {}),
      };
      const state: SyncState = {
        status: 'error',
        error,
        lastSyncAt: null,
        retryAt: code === 'AUTH' ? null : 1_700_000_060_000,
      };
      const rig = fakeEngine({ state });
      bindSyncEngineForTest(rig.engine);
      const view = render(<SyncPanel />);

      const title = screen.getByTestId('sync-error-title').textContent;
      const box = screen.getByTestId('sync-error');
      expect(title.length, `title for ${code}`).toBeGreaterThan(0);
      expect(title).not.toContain('sync.error'); // never a raw key
      expect(box.textContent).not.toContain(`sync.error.${code.toLowerCase()}`);
      if (code === 'CORRUPT_REMOTE') {
        expect(screen.getByTestId('sync-error-detail').textContent).toContain('0000000001.json');
        expect(box.textContent).toContain('Local data is untouched');
      }
      if (code === 'AUTH') {
        expect(box.textContent).toContain('Automatic retries are paused');
      } else if (state.retryAt !== null) {
        expect(box.textContent).toContain('Next automatic attempt');
      }
      view.unmount();
    }
  });
});
