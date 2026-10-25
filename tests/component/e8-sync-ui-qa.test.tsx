/**
 * E8 sync-UI QA — INDEPENDENT probe suite (t_98a1b4a5, h_reviewer).
 *
 * Deliberately probes what the impl's 27 tests (sync-setup-wizard / sync-status /
 * sync-conflicts / sync-host) do NOT cover, plus acceptance-critical re-checks
 * with fresh eyes:
 *
 *  Q1  wizard RECOVERY after a failed connection test (wrong creds -> fix ->
 *      succeed) — the impl only proves the failure half.
 *  Q2  double-submit while the test is in flight — the busy guard is state
 *      based, so two rapid submits must not produce two probe cycles.
 *  Q3  local-validation failures (insecure URL on step 1, empty password on
 *      step 2) must reach the LIVE REGION — the wizard docstring promises
 *      "step changes + outcomes go through announce()" but the step-1/empty-
 *      password paths call setFailure() only.
 *  Q4  periodic-when-online through the UI toggle: the 'online' event must
 *      fire a run only while the SURFACE toggle is on, never while off.
 *  Q5  error -> retry -> recovery transition (state machine + announcements).
 *  Q6  opt-in boundary on the PRODUCTION host path across the whole wizard
 *      interaction (typing, step nav, Back, insecure refusal, empty password)
 *      with a global fetch recorder — zero calls until submit.
 *  Q7  conflict titles are remote-controlled: a hostile title must render as
 *      TEXT (no element injection) in the conflict list.
 *  Q8  the typed password must never surface in the live regions (announce
 *      hygiene) across every wizard failure path.
 *  Q9  autoSync=false persisted -> the surface toggle must settle unchecked
 *      (stale `true` default in SyncPanel state).
 *
 * Every probe drives the REAL engine over `makeFakeWebDav` fixtures via the
 * shared sync harness — no structural fakes except where a pure render path
 * is the subject (Q7/Q9 use the real bind seam as well).
 *
 * Status note (HEAD re-verification, 2026-10-26):
 *   E8-UI-D3 was FIXED by 339cf6c (review round-1 finding B1) — both local
 *   validation refusals now announce via the global assertive region.
 *   Q3a/Q3b below are UNMARKED regression guards for that fix (they were
 *   it.fails defect markers while the gap was open).
 *   Still open: E8-UI-D1 (see e8-sync-ui-storegap.test.tsx),
 *   E8-UI-D5 (WebDavClient.probe hits the origin root — docs/qa/e8-sync-ui.md).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';

import { SyncPanel } from '../../src/features/sync/SyncPanel';
import { stateOf } from '../unit/sync/fixtures';
import {
  bindUnconfigured,
  configuredEngine,
  makeEngine,
  regions,
  setUpSync,
  tearDownSync,
} from './sync-harness';

beforeEach(() => {
  setUpSync();
});

afterEach(() => {
  tearDownSync();
});

/** Type the wizard up to (not including) the connection test. */
function fillWizard(url = 'https://dav.test/base/', password = 'app-pw'): void {
  fireEvent.input(screen.getByLabelText('WebDAV address', { exact: true }), {
    target: { value: url },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.input(screen.getByLabelText('User name', { exact: true }), {
    target: { value: 'alice' },
  });
  fireEvent.input(screen.getByLabelText('Password', { exact: true }), {
    target: { value: password },
  });
}

describe('E8 sync-UI QA probes (independent of the impl suites)', () => {
  it('Q1 recovery: wrong credentials -> correct them -> the retry completes setup', async () => {
    const rig = await makeEngine();
    bindUnconfigured(rig);
    rig.fake.faults.failStatus = 401;
    render(<SyncPanel />);
    fillWizard();

    fireEvent.click(screen.getByRole('button', { name: 'Test connection & enable' }));
    const error = await screen.findByTestId('setup-error');
    expect(error.textContent).toContain('Sign-in rejected');

    // The fix: server accepts now; user edits the password in place.
    delete rig.fake.faults.failStatus;
    fireEvent.input(screen.getByLabelText('Password', { exact: true }), {
      target: { value: 'corrected' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection & enable' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sync now' })).toBeTruthy();
    });
    expect(screen.queryByTestId('setup-error')).toBeNull();
    const row = await stateOf(rig.db);
    expect(row.enabled).toBe(true);
    expect(row.remotePassword).toBe('corrected');
    expect(rig.engine.state().value.status).toBe('idle');
    // Every request this journey made was the setup probe — nothing else.
    expect(rig.fake.state.requests.every((r) => r.method === 'OPTIONS')).toBe(true);
  });

  it('Q2 double-submit: two rapid submits while busy run exactly ONE probe cycle', async () => {
    const rig = await makeEngine();
    bindUnconfigured(rig);
    render(<SyncPanel />);
    fillWizard();

    const submit = screen.getByRole('button', { name: 'Test connection & enable' });
    fireEvent.click(submit);
    fireEvent.click(submit); // second click lands before the busy render commits

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sync now' })).toBeTruthy();
    });
    // One OPTIONS probe — the busy guard (and disabled button) held.
    expect(rig.fake.state.requests.filter((r) => r.method === 'OPTIONS')).toHaveLength(1);
  });

  it('Q3a step-1 local refusal (insecure URL) is ANNOUNCED in the assertive region [E8-UI-D3 fixed by 339cf6c]', async () => {
    const rig = await makeEngine();
    bindUnconfigured(rig);
    render(<SyncPanel />);

    fireEvent.input(screen.getByLabelText('WebDAV address', { exact: true }), {
      target: { value: 'http://evil.example/dav/' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByTestId('setup-error')).toBeTruthy();

    // The refusal is announced like every other failure (fixed in 339cf6c).
    await waitFor(() => {
      expect(regions.assertive?.textContent ?? '').toContain(
        'Sync failed: Sync cannot use this address',
      );
    });
    expect(rig.fake.state.requests).toHaveLength(0);
  });

  it('Q3b empty-password refusal on step 2 focuses the field AND is announced [E8-UI-D3 fixed by 339cf6c]', async () => {
    const rig = await makeEngine();
    bindUnconfigured(rig);
    render(<SyncPanel />);
    fireEvent.input(screen.getByLabelText('WebDAV address', { exact: true }), {
      target: { value: 'https://dav.test/base/' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.input(screen.getByLabelText('User name', { exact: true }), {
      target: { value: 'alice' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Test connection & enable' }));
    const error = await screen.findByTestId('setup-error');
    expect(error.textContent).toContain('Enter the password');
    expect(document.activeElement).toBe(screen.getByLabelText('Password', { exact: true }));
    // Outcome announced like every other step-2 failure (wizard docstring contract).
    await waitFor(() => {
      expect(regions.assertive?.textContent ?? '').toContain('Enter the password');
    });
    expect(rig.fake.state.requests).toHaveLength(0);
  });

  it('Q4 online event: fires a run only while the surface auto-sync toggle is ON', async () => {
    const rig = await configuredEngine();
    render(<SyncPanel />);

    // Toggle ON (default) -> the online event triggers an auto run.
    rig.env.fire('online');
    await waitFor(() => {
      expect(rig.fake.state.requests.length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(rig.engine.state().value.status).toBe('idle');
    });

    // Toggle OFF from the surface -> the same event must NOT reach the host.
    const before = rig.fake.state.requests.length;
    const toggle = screen.getByRole<HTMLInputElement>('checkbox', {
      name: 'Sync automatically when online',
    });
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(rig.env.activeIntervals()).toBe(0);
    });
    rig.env.fire('online');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rig.fake.state.requests.length).toBe(before);
  });

  it('Q5 error -> manual retry recovers: state machine + both announcements', async () => {
    const rig = await configuredEngine();
    render(<SyncPanel />);

    rig.env.setOnline(false);
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    await screen.findByTestId('sync-error');
    await waitFor(() => {
      expect(regions.assertive?.textContent ?? '').toContain('Sync failed');
    });

    // Back online -> manual retry -> recovery is announced politely.
    rig.env.setOnline(true);
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    await waitFor(() => {
      expect(screen.queryByTestId('sync-error')).toBeNull();
      expect(screen.getByTestId('sync-status-line').textContent).toContain('Last synced:');
    });
    await waitFor(() => {
      expect(regions.polite?.textContent ?? '').toContain('Sync finished');
    });
    expect(rig.engine.state().value.status).toBe('idle');
  });

  it('Q6 production host path: the whole wizard interaction makes ZERO fetch calls', async () => {
    // Global recorder — the engine here has NO injected transport, so anything
    // the UI or host does would surface as a real global fetch call.
    const original: unknown = globalThis.fetch;
    const calls: unknown[] = [];
    globalThis.fetch = (...args: unknown[]): Promise<Response> => {
      calls.push(args);
      return Promise.reject(new Error('network during wizard interaction'));
    };
    try {
      const rig = await makeEngine();
      bindUnconfigured(rig);
      render(<SyncPanel />);

      // Type, advance, go Back, re-advance, try an insecure URL, then an
      // empty password — the full pre-submit surface.
      fireEvent.input(screen.getByLabelText('WebDAV address', { exact: true }), {
        target: { value: 'https://dav.test/base/' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      fireEvent.input(screen.getByLabelText('WebDAV address', { exact: true }), {
        target: { value: 'http://insecure.example/' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      await screen.findByTestId('setup-error');
      fireEvent.input(screen.getByLabelText('WebDAV address', { exact: true }), {
        target: { value: 'https://dav.test/base/' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      fireEvent.click(screen.getByRole('button', { name: 'Test connection & enable' }));
      await screen.findByTestId('setup-error'); // empty-password refusal
      fireEvent.input(screen.getByLabelText('Password', { exact: true }), {
        target: { value: 'app-pw' },
      });

      expect(calls).toHaveLength(0);
      expect(rig.fake.state.requests).toHaveLength(0);
    } finally {
      globalThis.fetch = original as typeof globalThis.fetch;
    }
  });

  it('Q7 hostile conflict title renders as TEXT — no element injection', async () => {
    const hostile = '<img src=x onerror=alert(1)>"onmouseover="evil';
    const { fakeEngine } = await import('./sync-harness');
    const { bindSyncEngineForTest } = await import('../../src/features/sync/syncHost');
    const rig = fakeEngine({
      state: {
        status: 'conflicts-pending',
        conflicts: [
          {
            recordId: '01J000000000000000000000AA',
            copyId: '01J000000000000000000000BB',
            title: hostile,
            lostTo: { updatedAt: 1_700_000_000_000, deviceId: 'B'.repeat(26) },
          },
        ],
        lastSyncAt: null,
        lastRun: {
          startedAt: 0,
          finishedAt: 0,
          trigger: 'manual',
          pulled: { snapshots: 0, batches: 0, records: 0 },
          pushed: { batches: 0, records: 0 },
          applied: 0,
          conflictsCreated: 1,
          compacted: false,
          notices: [],
        },
      },
    });
    bindSyncEngineForTest(rig.engine);
    const view = render(<SyncPanel />);

    // The hostile string is present as TEXT… (D1: exact:true, no substring match)
    const label = screen.getByText(`Conflict copy of ${hostile}`, { exact: true });
    expect(label).toBeTruthy();
    // …and NOT as a live element: no img/script was created from it.
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector('script[data-dav]')).toBeNull();
    // Every button in the conflict item is a native button (keyboard-reachable).
    const item = label.closest('li');
    expect(item).toBeTruthy();
    for (const button of within(item as HTMLElement).getAllByRole('button')) {
      expect(button.tagName).toBe('BUTTON');
      expect(button.getAttribute('tabindex')).toBeNull(); // no tabindex override
    }
    view.unmount();
  });

  it('Q8 the typed password NEVER appears in either live region', async () => {
    const rig = await makeEngine();
    bindUnconfigured(rig);
    rig.fake.faults.failStatus = 401;
    render(<SyncPanel />);
    fillWizard('https://dav.test/base/', 'Sekrit-Passw0rd!');

    fireEvent.click(screen.getByRole('button', { name: 'Test connection & enable' }));
    await screen.findByTestId('setup-error');
    await waitFor(() => {
      expect((regions.assertive?.textContent ?? '').length).toBeGreaterThan(0);
    });
    const leaked =
      (regions.assertive?.textContent ?? '').includes('Sekrit-Passw0rd!') ||
      (regions.polite?.textContent ?? '').includes('Sekrit-Passw0rd!');
    expect(leaked).toBe(false);
  });

  it('Q9 autoSync=false on file: the surface toggle settles UNCHECKED', async () => {
    const rig = await configuredEngine();
    rig.engine.setAutoSync(false); // fire-and-forget persistence before the panel mounts
    // Poll until the persistence settles (no async-callback waitFor — lint-clean).
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (!(await stateOf(rig.db)).autoSync) break;
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
    expect((await stateOf(rig.db)).autoSync).toBe(false);
    render(<SyncPanel />);
    await waitFor(() => {
      expect(
        screen.getByRole<HTMLInputElement>('checkbox', {
          name: 'Sync automatically when online',
        }).checked,
      ).toBe(false);
    });
  });
});
