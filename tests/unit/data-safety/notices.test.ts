import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveBanners } from '../../../src/features/data-safety/derive';
import { resetFlags, snooze } from '../../../src/features/data-safety/flags';
import {
  answerDialog,
  clearBanners,
  currentDialog,
  openDialog,
  resetDialogs,
  resetToasts,
  snoozeBanner,
  toasts,
  pushToast,
  dismissToast,
  setBanner,
  visibleBanners,
} from '../../../src/features/data-safety/notices';
import {
  isQuotaExceeded,
  noteWriteFailure,
  resetPendingWrites,
  retryPendingWrites,
  pendingWrites,
} from '../../../src/features/data-safety/pendingWrites';
import { resetState, patchState } from '../../../src/features/data-safety/state';
import {
  persistenceState,
  quotaState,
  resetStorageInfo,
} from '../../../src/features/data-safety/storageInfo';

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const DAY = 86_400_000;

beforeEach(() => {
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
  resetDialogs();
});

describe('banner priority and cap (§2)', () => {
  it('shows at most two banners, highest priority first, and counts the overflow', () => {
    setBanner('backup-reminder', { N: 20, never: 0 });
    setBanner('persist-denied', {});
    setBanner('quota-warn', { pct: 92 });
    setBanner('long-absence', { N: 9, lastBackupAt: 0 });

    const { visible, overflow } = visibleBanners(NOW);
    expect(visible.map((banner) => banner.id)).toEqual(['long-absence', 'quota-warn']);
    expect(overflow).toBe(2);
  });

  it('hides snoozed banners and exposes a new revision so renderers re-read the flags', () => {
    setBanner('backup-reminder', { N: 30, never: 0 });
    const before = visibleBanners(NOW);
    expect(before.visible).toHaveLength(1);

    snoozeBanner('backup-reminder', 7);
    const after = visibleBanners(NOW + 1 * DAY);
    expect(after.visible).toHaveLength(0);
    expect(after.revision).toBeGreaterThan(before.revision);

    // …and it comes back once the snooze expires.
    expect(visibleBanners(NOW + 8 * DAY).visible).toHaveLength(1);
  });

  it('supports a durable permanent dismissal through the same flag key', () => {
    setBanner('shrunken', { pct: 55 });
    snooze('shrunken', 7, NOW);
    expect(visibleBanners(NOW + 1 * DAY).visible).toHaveLength(0);
  });
});

describe('notice derivation (state → candidates)', () => {
  it('arms the backup nudge only when data exists and the backup is >= 14 days old', () => {
    patchState({
      status: 'ready',
      hasData: true,
      lastBackupAt: NOW - 14 * DAY,
      classification: { kind: 'normal' },
    });
    deriveBanners(NOW);
    expect(visibleBanners(NOW).visible.map((banner) => banner.id)).toContain('backup-reminder');

    patchState({ lastBackupAt: NOW - 3 * DAY });
    deriveBanners(NOW);
    expect(visibleBanners(NOW).visible.map((banner) => banner.id)).not.toContain('backup-reminder');
  });

  it('shows the "never backed up yet" variant when data exists but no backup ever ran', () => {
    patchState({
      status: 'ready',
      hasData: true,
      lastBackupAt: null,
      classification: { kind: 'normal' },
    });
    deriveBanners(NOW);
    const banner = visibleBanners(NOW).visible.find((entry) => entry.id === 'backup-reminder');
    expect(banner?.params['never']).toBe(1);
  });

  it('never nudges about backups when there is nothing to back up', () => {
    patchState({
      status: 'ready',
      hasData: false,
      lastBackupAt: null,
      classification: { kind: 'normal' },
    });
    deriveBanners(NOW);
    expect(visibleBanners(NOW).visible).toHaveLength(0);
  });

  it('arms the quota banner at >= 80% of a reported total', () => {
    patchState({
      status: 'ready',
      hasData: true,
      lastBackupAt: NOW,
      classification: { kind: 'normal' },
    });
    quotaState.value = { usedBytes: 85, totalBytes: 100, supported: true, loading: false };
    deriveBanners(NOW);
    expect(visibleBanners(NOW).visible.map((banner) => banner.id)).toContain('quota-warn');

    quotaState.value = { usedBytes: 79, totalBytes: 100, supported: true, loading: false };
    deriveBanners(NOW);
    expect(visibleBanners(NOW).visible.map((banner) => banner.id)).not.toContain('quota-warn');
  });

  it('never derives a quota banner when the browser reports no total (§9.4)', () => {
    patchState({
      status: 'ready',
      hasData: true,
      lastBackupAt: NOW,
      classification: { kind: 'normal' },
    });
    quotaState.value = { usedBytes: 100, totalBytes: null, supported: false, loading: false };
    deriveBanners(NOW);
    expect(visibleBanners(NOW).visible.map((banner) => banner.id)).not.toContain('quota-warn');
  });

  it('surfaces the boot classification and the pending-write queue', () => {
    patchState({
      status: 'ready',
      hasData: true,
      lastBackupAt: NOW,
      classification: { kind: 'long-absence', absentDays: 9, lastBackupAt: NOW - 40 * DAY },
    });
    persistenceState.value = 'denied';
    noteWriteFailure({ code: 'QUOTA_EXCEEDED' }, 'task', async () => true);

    deriveBanners(NOW);
    const ids = visibleBanners(NOW).visible.map((banner) => banner.id);
    expect(ids).toContain('long-absence');
    expect(ids).toContain('quota-pending');
  });
});

describe("T3 dialog queue (§2: queue, don't stack)", () => {
  it('resolves the promise with the verdict and drains one at a time', async () => {
    const first = openDialog({ kind: 'private-browsing' });
    const second = openDialog({ kind: 'quota-exceeded', pendingCount: 2 });

    expect(currentDialog()?.request.kind).toBe('private-browsing');
    answerDialog(false);
    expect(await first).toBe(false);
    expect(currentDialog()?.request.kind).toBe('quota-exceeded');
    answerDialog(true);
    expect(await second).toBe(true);
    expect(currentDialog()).toBeNull();
  });

  it('resolves queued dialogs as cancelled on reset (teardown never leaks promises)', async () => {
    const pending = openDialog({ kind: 'private-browsing' });
    resetDialogs();
    expect(await pending).toBe(false);
    expect(currentDialog()).toBeNull();
  });
});

describe('pending writes (§6.4: never silently dropped)', () => {
  it('ignores non-quota failures', () => {
    expect(noteWriteFailure({ code: 'TX_ABORTED' }, 'x', async () => true)).toBeNull();
    expect(pendingWrites.value).toHaveLength(0);
  });

  it('queues a quota failure and opens the blocking dialog', () => {
    noteWriteFailure({ code: 'QUOTA_EXCEEDED' }, 'create task', async () => true);
    expect(pendingWrites.value).toHaveLength(1);
    expect(currentDialog()?.request).toEqual({ kind: 'quota-exceeded', pendingCount: 1 });
    expect(isQuotaExceeded({ code: 'QUOTA_EXCEEDED' })).toBe(true);
    expect(isQuotaExceeded('boom')).toBe(false);
  });

  it('keeps the entry when the dialog is dismissed (Escape), then retires it after a good retry', async () => {
    let landed = false;
    noteWriteFailure({ code: 'QUOTA_EXCEEDED' }, 'create task', async () => landed);
    answerDialog(false); // Escape/close: pending stays, dialog goes
    expect(pendingWrites.value).toHaveLength(1);

    await retryPendingWrites();
    expect(pendingWrites.value).toHaveLength(1); // still failing → still pending

    landed = true;
    await retryPendingWrites();
    expect(pendingWrites.value).toHaveLength(0);
  });

  it('retires an entry whose retry throws instead of crashing the drain', async () => {
    noteWriteFailure({ code: 'QUOTA_EXCEEDED' }, 'x', () => Promise.reject(new Error('nope')));
    await expect(retryPendingWrites()).resolves.toBeUndefined();
    expect(pendingWrites.value).toHaveLength(1);
  });
});

describe('T4 toasts', () => {
  it('pushes, dismisses and lists toasts', () => {
    const id = pushToast({ message: 'Backup saved to your downloads.', variant: 'success' });
    expect(toasts.value).toHaveLength(1);
    dismissToast(id);
    expect(toasts.value).toHaveLength(0);
    dismissToast(id); // idempotent
    expect(toasts.value).toHaveLength(0);
  });
});

describe('quota banner copy inputs', () => {
  it('uses a retry spy through the queue', async () => {
    const retry = vi.fn(async () => true);
    noteWriteFailure({ code: 'QUOTA_EXCEEDED' }, 'x', retry);
    await retryPendingWrites();
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
