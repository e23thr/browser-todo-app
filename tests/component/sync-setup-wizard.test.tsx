/**
 * E8 sync UI — setup wizard (S9).
 *
 * Contract under test (docs/dev/sync-engine-api.md + the impl card body):
 *  - valid / wrong / unreachable credentials are all graceful (setup never
 *    half-completes; a failed test rolls back to unconfigured);
 *  - OPT-IN boundary: ZERO requests to the WebDAV host before the user submits
 *    the connection test — every earlier interaction is local;
 *  - wizard keyboard flow (Enter submits, focus follows the current step,
 *    `aria-current="step"` progress) and live-region announcements (WCAG 2.2 AA);
 *  - credentials land only in the browser-profile `sync_state` row, masked
 *    (`type="password"`), with the Decision 7 memory-only mode selectable.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';

import { SyncPanel } from '../../src/features/sync/SyncPanel';
import { stateOf } from '../unit/sync/fixtures';
import {
  bindUnconfigured,
  makeEngine,
  regions,
  seed,
  setUpSync,
  tearDownSync,
} from './sync-harness';
import { makeList, makeTask } from './fixtures';

beforeEach(() => {
  setUpSync();
});

afterEach(() => {
  tearDownSync();
});

/** Type a full wizard run up to (but not including) the submit button. */
function fillWizard(url = 'https://dav.test/base/'): void {
  fireEvent.input(screen.getByLabelText('WebDAV address', { exact: true }), {
    target: { value: url },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.input(screen.getByLabelText('User name', { exact: true }), {
    target: { value: 'alice' },
  });
  fireEvent.input(screen.getByLabelText('Password', { exact: true }), {
    target: { value: 'app-pw' },
  });
}

describe('sync setup wizard (S9)', () => {
  it('opt-in boundary: renders the wizard and sends NOTHING to the host until the connection test runs', async () => {
    const rig = await makeEngine();
    bindUnconfigured(rig);
    render(<SyncPanel />);

    expect(screen.getByRole('textbox', { name: 'WebDAV address' })).toBeTruthy();
    expect(screen.getByText(/Nothing leaves this device/, { exact: true })).toBeTruthy();

    fillWizard();

    // The boundary itself: URL + credentials were typed, steps were navigated,
    // and the host has still seen ZERO requests.
    expect(rig.fake.state.requests).toHaveLength(0);
    const state = rig.engine.state().value;
    expect(state.status).toBe('idle');
    expect(state.status === 'idle' && state.configured).toBe(false);
  });

  it('valid credentials: the connection test enables sync and hands over to the status surface', async () => {
    const rig = await makeEngine();
    bindUnconfigured(rig);
    render(<SyncPanel />);
    fillWizard();

    fireEvent.click(screen.getByRole('button', { name: 'Test connection & enable' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sync now' })).toBeTruthy();
    });
    expect(screen.queryByTestId('sync-wizard')).toBeNull();

    // Setup's own request is the OPTIONS probe — that is the whole allowance.
    expect(rig.fake.state.requests.map((request) => request.method)).toContain('OPTIONS');

    // Credentials are stored exactly where the contract says: the browser
    // profile's sync_state row (never localStorage, never the server).
    const row = await stateOf(rig.db);
    expect(row.enabled).toBe(true);
    expect(row.remoteUser).toBe('alice');
    expect(row.remotePassword).toBe('app-pw');

    const state = rig.engine.state().value;
    expect(state.status).toBe('idle');
    expect(state.status === 'idle' && state.configured).toBe(true);

    // Setup completes WITHOUT kicking off a run — "Not synced yet" until the
    // user syncs (no surprise traffic).
    expect(screen.getByTestId('sync-status-line').textContent).toBe('Not synced yet');

    await waitFor(() => {
      expect(regions.polite?.textContent).toContain('Sync enabled');
    });
  });

  it('remember off keeps the password out of storage (Decision 7 memory-only mode)', async () => {
    const rig = await makeEngine();
    bindUnconfigured(rig);
    render(<SyncPanel />);
    fillWizard();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Remember me on this device' }));
    expect(
      screen.getByRole<HTMLInputElement>('checkbox', { name: 'Remember me on this device' })
        .checked,
    ).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Test connection & enable' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sync now' })).toBeTruthy();
    });

    const row = await stateOf(rig.db);
    expect(row.enabled).toBe(true);
    expect(row.remotePassword).toBe(''); // never written to disk
    // The in-memory password still worked: the probe reached the host.
    expect(rig.fake.state.requests.length).toBeGreaterThan(0);
  });

  it('wrong credentials: the AUTH error surfaces in place, setup does not complete, nothing is stored', async () => {
    const rig = await makeEngine();
    bindUnconfigured(rig);
    rig.fake.faults.failStatus = 401;
    render(<SyncPanel />);
    fillWizard();

    fireEvent.click(screen.getByRole('button', { name: 'Test connection & enable' }));

    const error = await screen.findByTestId('setup-error');
    expect(error.textContent).toContain('Sign-in rejected');
    expect(error.textContent).toContain('Enter them again');

    // The form is kept (with what was typed) so the fix is one edit away.
    expect(screen.getByLabelText<HTMLInputElement>('User name', { exact: true }).value).toBe(
      'alice',
    );
    expect(screen.getByRole('button', { name: 'Test connection & enable' })).toBeTruthy();

    // Rolled back: setup did not half-complete and nothing was persisted.
    const row = await stateOf(rig.db);
    expect(row.enabled).toBe(false);
    const state = rig.engine.state().value;
    expect(state.status).toBe('idle');
    expect(state.status === 'idle' && state.configured).toBe(false);

    // The only request the failed attempt made was the setup probe itself.
    expect(rig.fake.state.requests.every((request) => request.method === 'OPTIONS')).toBe(true);

    await waitFor(() => {
      expect(regions.assertive?.textContent).toContain('Sign-in rejected');
    });
  });

  it('unreachable server: graceful error, local data untouched, still unconfigured', async () => {
    const rig = await makeEngine();
    bindUnconfigured(rig);
    const store = await seed({ lists: [makeList()], tasks: [makeTask({ title: 'Buy milk' })] });
    const before = JSON.stringify([...store.tasks.entries()].map(([id, task]) => [id, task]));
    rig.fake.faults.reject = 'network';
    render(<SyncPanel />);
    fillWizard();

    fireEvent.click(screen.getByRole('button', { name: 'Test connection & enable' }));

    const error = await screen.findByTestId('setup-error');
    // The engine classifies a rejected fetch as CORS (browser cannot tell it
    // from DNS/TLS) — the wizard shows that copy honestly.
    expect(error.textContent).toContain('The browser blocked the request');

    const after = JSON.stringify([...store.tasks.entries()].map(([id, task]) => [id, task]));
    expect(after).toBe(before); // local data byte-identical

    const row = await stateOf(rig.db);
    expect(row.enabled).toBe(false);
    expect(rig.engine.state().value.status).toBe('idle');
  });

  it('an insecure address is refused locally — step one never advances and the host sees nothing', async () => {
    const rig = await makeEngine();
    bindUnconfigured(rig);
    render(<SyncPanel />);

    fireEvent.input(screen.getByLabelText('WebDAV address', { exact: true }), {
      target: { value: 'http://evil.example/dav/' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // Still on step 1, with the local CONFIG copy; no request was made.
    expect(screen.getByRole('textbox', { name: 'WebDAV address' })).toBeTruthy();
    const error = await screen.findByTestId('setup-error');
    expect(error.textContent).toContain('HTTPS');
    expect(rig.fake.state.requests).toHaveLength(0);

    // SC 4.1.3: the refusal is silent in the DOM (the box carries no
    // role="alert" by design), so it has to reach the global ASSERTIVE region.
    const title = screen.getByTestId('setup-error-title').textContent;
    await waitFor(() => {
      expect(regions.assertive?.textContent).toBe(`Sync failed: ${title}`);
    });
  });

  it('an empty password is refused locally — the error is rendered AND announced assertively', async () => {
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

    // Submit step 2 with the password left empty.
    fireEvent.submit(
      screen.getByLabelText('Password', { exact: true }).closest('form') as HTMLFormElement,
    );

    const error = await screen.findByTestId('setup-error');
    expect(error.textContent).toContain('Enter the password for this storage.');
    expect(document.activeElement).toBe(screen.getByLabelText('Password', { exact: true }));

    // Local refusal only — the opt-in boundary holds, setup stays unconfigured.
    expect(rig.fake.state.requests).toHaveLength(0);
    expect(rig.engine.state().value.status).toBe('idle');

    // SC 4.1.3: the password error also reaches the global assertive region.
    const title = screen.getByTestId('setup-error-title').textContent;
    await waitFor(() => {
      expect(regions.assertive?.textContent).toBe(`Sync failed: ${title}`);
    });
  });

  it('keyboard flow: Enter submits each step, focus follows the current step, progress marks aria-current', async () => {
    const rig = await makeEngine();
    bindUnconfigured(rig);
    render(<SyncPanel />);

    const url = screen.getByLabelText<HTMLInputElement>('WebDAV address', { exact: true });
    expect(url.type).toBe('url');
    fireEvent.input(url, { target: { value: 'https://dav.test/base/' } });

    const progress = screen.getByRole('list', { name: 'Setup progress' });
    expect(
      within(progress)
        .getAllByRole('listitem')
        .filter((item) => item.getAttribute('aria-current') === 'step'),
    ).toHaveLength(1);

    fireEvent.submit(url.closest('form') as HTMLFormElement);

    // Focus moves to the first field of step 2…
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('User name', { exact: true }));
    });
    // …the progress marker follows…
    const current = within(progress)
      .getAllByRole('listitem')
      .filter((item) => item.getAttribute('aria-current') === 'step');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain('Sign-in details');
    // …and the step change is announced politely.
    await waitFor(() => {
      expect(regions.polite?.textContent).toBe('Step 2 of 2: Sign-in details');
    });

    // Password is masked, and Enter in the credentials step submits too.
    expect(screen.getByLabelText('Password', { exact: true }).getAttribute('type')).toBe(
      'password',
    );
    fireEvent.input(screen.getByLabelText('User name', { exact: true }), {
      target: { value: 'alice' },
    });
    fireEvent.input(screen.getByLabelText('Password', { exact: true }), {
      target: { value: 'app-pw' },
    });
    fireEvent.submit(
      screen.getByLabelText('Password', { exact: true }).closest('form') as HTMLFormElement,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sync now' })).toBeTruthy();
    });
    expect(rig.fake.state.requests.map((request) => request.method)).toContain('OPTIONS');
  });

  it('Back returns to the address step with the typed URL kept and focus restored', async () => {
    const rig = await makeEngine();
    bindUnconfigured(rig);
    render(<SyncPanel />);

    fireEvent.input(screen.getByLabelText('WebDAV address', { exact: true }), {
      target: { value: 'https://dav.test/base/' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(screen.getByLabelText<HTMLInputElement>('WebDAV address', { exact: true }).value).toBe(
      'https://dav.test/base/',
    );
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('WebDAV address', { exact: true }));
    });
    expect(rig.fake.state.requests).toHaveLength(0);
  });
});
