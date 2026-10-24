import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fireEvent, render, screen, waitFor } from '@testing-library/preact';

import { DataSafetyHost } from '../../src/features/data-safety/DataSafetyHost';
import {
  clearBanners,
  currentDialog,
  openDialog,
  resetDialogs,
  resetToasts,
  toasts,
} from '../../src/features/data-safety/notices';
import { resetFlags } from '../../src/features/data-safety/flags';
import { patchState, resetState } from '../../src/features/data-safety/state';
import {
  persistenceState,
  quotaState,
  resetStorageInfo,
} from '../../src/features/data-safety/storageInfo';
import { resetPendingWrites } from '../../src/features/data-safety/pendingWrites';

/**
 * CLOCK PIN — do not bump this constant to silence a red suite.
 *
 * `ready()` seeds `lastBackupAt = NOW - 20 * DAY`, and `<DataSafetyHost>` derives the nudge
 * copy from the REAL clock (`deriveBanners()` / `visibleBanners()` both default to
 * `Date.now()`), so the "It's been 20 days…" copy only held while the real calendar day was
 * still <= NOW (it went red at 2026-10-24 12:00 UTC). The clock is therefore INSTALLED at
 * `NOW` in `beforeEach` and restored in `afterEach`, keeping every assertion in this file
 * tied to the pinned instant instead of the day the suite happens to run on. Never move this
 * timestamp to make a failure go away — that just re-arms the bomb.
 */
const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const DAY = 86_400_000;

beforeEach(() => {
  // Fake ONLY `Date`: timers/promises stay real, so `waitFor` keeps its 1 s timeout.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  window.localStorage.clear();
  resetFlags();
  clearBanners();
  resetDialogs();
  resetToasts();
  resetPendingWrites();
  resetState();
  resetStorageInfo();
});

afterEach(() => {
  vi.useRealTimers();
  resetDialogs();
});

function ready(overrides: Record<string, unknown> = {}): void {
  patchState({
    status: 'ready',
    classification: { kind: 'normal' },
    hasData: true,
    // The clock is pinned to NOW (see the CLOCK PIN note above), so this stays a fixed
    // epoch — the banner's day math reads the pinned `Date.now()`, not wall time.
    lastBackupAt: NOW - 20 * DAY,
    priorUse: true,
    onboarding: false,
    ...overrides,
  } as never);
}

describe('<DataSafetyHost> banners', () => {
  it('renders the backup-reminder nudge derived from state (3.2)', async () => {
    ready();
    quotaState.value = { usedBytes: 0, totalBytes: null, supported: false, loading: false };
    render(<DataSafetyHost />);

    await waitFor(() => {
      expect(
        screen.getByText("It's been 20 days since your last backup.", { exact: true }),
      ).toBeTruthy();
    });
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back up now' })).toBeTruthy();
    expect(
      screen.getByText(
        "A backup file is your safety net — browsers (especially Safari on iPhone and iPad, which can remove website data after 7 days) can clear this app's data. Save a backup now and keep it somewhere safe.",
        { exact: true },
      ),
    ).toBeTruthy();
  });

  it('caps the stack at two banners and shows the "N more notices" overflow (2)', async () => {
    // Four candidates qualify; §2 caps the visible set at two by priority.
    ready({ classification: { kind: 'long-absence', absentDays: 9, lastBackupAt: 0 } });
    persistenceState.value = 'denied';
    quotaState.value = { usedBytes: 92, totalBytes: 100, supported: true, loading: false };

    render(<DataSafetyHost />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '2 more notices' })).toBeTruthy();
    });
    expect(
      screen.queryByText("It's been 20 days since your last backup.", { exact: true }),
    ).toBeNull();
    expect(screen.getByText("Welcome back — it's been 9 days.", { exact: true })).toBeTruthy();
    expect(document.querySelectorAll('.nudge-banner')).toHaveLength(2);
  });

  it('snoozes a banner for 7 days through the close button (6.3)', async () => {
    ready();
    render(<DataSafetyHost />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Hide for 7 days' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Hide for 7 days' }));
    expect(snoozeWasApplied('backup-reminder')).toBe(true);
    await waitFor(() => {
      expect(
        screen.queryByText("It's been 20 days since your last backup.", { exact: true }),
      ).toBeNull();
    });
  });
});

/** The durable flag is what "snoozed" means; read it back through the flags module. */
function snoozeWasApplied(id: string): boolean {
  const raw = window.localStorage.getItem('todo:prefs:v1:dismissedBanners') ?? '';
  return raw.includes(`${id}@`);
}

describe('<DataSafetyHost> dialogs (3.3 / 6.4)', () => {
  it('renders the queued quota dialog and closes it through the safe path', async () => {
    ready();
    render(<DataSafetyHost />);
    void openDialog({ kind: 'quota-exceeded', pendingCount: 1 });

    await waitFor(() => {
      expect(screen.getByRole('alertdialog')).toBeTruthy();
    });
    expect(screen.getByRole('heading', { name: 'Not enough storage space' })).toBeTruthy();

    // "Try again" closes the dialog (the verdict resolves the queue), leaving the app usable.
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(currentDialog()).toBeNull();
    });
  });

  it('renders no dialog when the queue is empty', async () => {
    ready();
    render(<DataSafetyHost />);
    await waitFor(() => undefined);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('<DataSafetyHost> toasts (T4)', () => {
  it('renders the undo toast with its action and dismisses it on demand', async () => {
    ready();
    const onAction = vi.fn();
    render(<DataSafetyHost />);
    toasts.value = [
      {
        id: 1,
        message: 'Import complete. Your previous data is saved as a snapshot.',
        variant: 'success',
        persistent: true,
        action: { label: 'Restore previous data', run: onAction },
      },
    ];

    await waitFor(() => {
      expect(
        screen.getByText('Import complete. Your previous data is saved as a snapshot.', {
          exact: true,
        }),
      ).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Restore previous data' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(toasts.value).toHaveLength(0);
  });

  it('auto-dismisses a non-persistent toast (8 s T4 lifetime)', async () => {
    ready();
    render(<DataSafetyHost />);
    toasts.value = [{ id: 2, message: 'Backup saved to your downloads.', variant: 'success' }];

    await waitFor(() => {
      expect(screen.getByText('Backup saved to your downloads.', { exact: true })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(toasts.value).toHaveLength(0);
  });
});

describe('<DataSafetyHost> derivation wiring', () => {
  it('derives candidates from the boot classification on mount', async () => {
    ready({ classification: { kind: 'long-absence', absentDays: 12, lastBackupAt: 0 } });
    persistenceState.value = 'denied';
    render(<DataSafetyHost />);

    await waitFor(() => {
      expect(screen.getByText("Welcome back — it's been 12 days.", { exact: true })).toBeTruthy();
    });
    // The persistence-denied banner competes but the cap still holds (§2).
    expect(document.querySelectorAll('.nudge-banner').length).toBeLessThanOrEqual(2);
  });
});
