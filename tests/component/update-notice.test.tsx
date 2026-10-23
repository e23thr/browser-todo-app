import { render } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';

import { UpdateNotice } from '../../src/components/UpdateNotice';
import { notifyChunkLoadFailure, chunkLoadFailed } from '../../src/app/stale-tab';
import { updateState } from '../../src/app/update';

/**
 * ADR-005 Decision 9 (component): the update surfaces — the toast owns its polite live region,
 * the actions are real buttons (≥ 44 px targets in CSS), and every message maps to a Decision 5
 * state. Behaviour is fixed by the ADR; these tests pin the contract, not the visuals.
 */

describe('UpdateNotice', () => {
  it('renders nothing while the app is idle', () => {
    updateState.value = 'idle';
    chunkLoadFailed.value = false;
    const { container } = render(<UpdateNotice />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the update toast with Apply and Dismiss in a polite live region', () => {
    updateState.value = 'update-ready';
    chunkLoadFailed.value = false;
    const { getByRole, getByText, unmount } = render(<UpdateNotice />);

    expect(getByText('Update available')).toBeTruthy();
    expect(getByRole('button', { name: 'Apply' })).toBeTruthy();
    expect(getByRole('button', { name: 'Dismiss' })).toBeTruthy();
    const region = getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    unmount();
  });

  it('shows "Updating…" while the update applies', () => {
    updateState.value = 'applying';
    chunkLoadFailed.value = false;
    const { getByText, unmount } = render(<UpdateNotice />);
    expect(getByText('Updating…')).toBeTruthy();
    unmount();
  });

  it('shows the refresh-when-ready notice for a sibling tab (never auto-reloads)', () => {
    updateState.value = 'applied-elsewhere';
    chunkLoadFailed.value = false;
    const { getByText, getByRole, unmount } = render(<UpdateNotice />);
    expect(getByText('Updated — refresh when ready')).toBeTruthy();
    expect(getByRole('button', { name: 'Refresh' })).toBeTruthy();
    unmount();
  });

  it('shows the stale-tab guard notice after a lazy chunk load failure (Decision 3)', () => {
    updateState.value = 'idle';
    notifyChunkLoadFailure();
    const { getByText, getByRole, unmount } = render(<UpdateNotice />);
    expect(getByText('The app was updated in another tab — reload to continue here')).toBeTruthy();
    expect(getByRole('button', { name: 'Refresh' })).toBeTruthy();
    chunkLoadFailed.value = false;
    unmount();
  });
});
