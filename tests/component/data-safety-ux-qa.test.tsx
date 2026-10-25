/**
 * E3 data-safety UX — scripted QA scenario suite (test card t_b1595f03).
 *
 * Every scenario in the card goal is scripted here against MOCKED storage states
 * (`navigator.storage` mocks + scripted boot classifications) and, for the import/undo
 * path, against the REAL ADR-004 engine on fake-indexeddb. The real-browser pass with a
 * REAL StorageManager lives in tests/e2e/data-safety-ux.spec.ts.
 *
 * Scenarios (docs/design/data-safety.md §3 flows):
 *   S1 first run / onboarding honesty      S4 quota-exceeded write (never dropped)
 *   S2 storage & backup panel values       S5 eviction / wipe / long absence / shrunken
 *   S3 persist() after first task + nudge  S6 private-browsing warning
 *   S7 import confirm + pre-import snapshot undo (real engine)
 *   R review round-1 rework verification (B1 copy / B2 undo durability / B3 recovery offer / N4 / N5)
 *   P §8.4 pre-import retention protection (real engine)
 *   K keyboard/a11y matrix over every T3 dialog (§5.6)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';

import { App } from '../../src/app/App';
import { DataSafetyHost } from '../../src/features/data-safety/DataSafetyHost';
import { Onboarding } from '../../src/features/data-safety/Onboarding';
import { SafetyDialog } from '../../src/features/data-safety/SafetyDialog';
import type { SafetyDialogProps } from '../../src/features/data-safety/SafetyDialog';
import { SnapshotList } from '../../src/features/data-safety/SnapshotList';
import { StoragePanelContainer } from '../../src/features/data-safety/StoragePanelContainer';
import { classifyBoot } from '../../src/features/data-safety/boot';
import { deriveBanners } from '../../src/features/data-safety/derive';
import {
  isSuppressed,
  readOnboardingStep,
  recoveryStartedAt,
  resetFlags,
} from '../../src/features/data-safety/flags';
import {
  chooseImportFile,
  importState,
  resetImportState,
  restoreSnapshot,
} from '../../src/features/data-safety/importFlow';
import {
  answerDialog,
  clearBanners,
  closeDialog,
  currentDialog,
  openDialog,
  resetDialogs,
  resetToasts,
  visibleBanners,
} from '../../src/features/data-safety/notices';
import {
  noteWriteFailure,
  pendingWrites,
  resetPendingWrites,
  retryPendingWrites,
} from '../../src/features/data-safety/pendingWrites';
import {
  isPersistGateOpen,
  noteFirstMeaningfulWrite,
  resetPersistGate,
} from '../../src/features/data-safety/persistGate';
import { initFirstRunFlag, patchState, resetState } from '../../src/features/data-safety/state';
import {
  persistenceState,
  quotaState,
  refreshPersistence,
  refreshQuota,
  requestPersist,
  resetStorageInfo,
} from '../../src/features/data-safety/storageInfo';
import { err, ok, type AppError, type Result } from '../../src/domain/kernel';
import {
  DEFAULT_SETTINGS,
  type List,
  type Settings,
  type Task,
  type TaskDraft,
} from '../../src/domain/model';
import { MutationRunner } from '../../src/domain/pipeline';
import type {
  ListPort,
  ListRemoveOutcome,
  MoveOutcome,
  MoveTarget,
  SettingsPort,
  TaskPort,
  TaskRemoveDisposition,
  TaskRemoveOutcome,
} from '../../src/domain/ports';
import { addTask, bindRunnerForTest, resetTaskStore } from '../../src/features/tasks/store';
import type { DataCounts, ImportPreview, SnapshotMeta } from '../../src/features/data-safety/types';
import {
  AUTO_RETENTION,
  bindDataSafetyDb,
  listSnapshots,
  MAX_PROTECTED_SNAPSHOTS,
  PRE_IMPORT_PROTECTION_MS,
  takeSnapshot,
} from '../../src/portability';
import type { AppDBImpl } from '../../src/storage/db';
import { setLocale } from '../../src/i18n';

import { makeList, makeTask, makeTestRunner, mountLiveRegions } from './fixtures';
import { fakeFile, fixture, fixtureId, makeDocText } from '../unit/portability/helpers';
import {
  makeList as makeStoredList,
  makeSettings,
  makeTask as makeStoredTask,
  openFixtureDb,
  uniqueDbName,
} from '../unit/storage/fixtures';

const DAY = 86_400_000;

/**
 * Let component effects flush before keyboard interaction. Dialogs that mount via a
 * signal update (not via `render()`) attach their keydown listener in an effect that the
 * test renderer flushes on the next macrotask; a real user can never press a key inside
 * that window. Every keyboard step in this suite goes through `settle()` first.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

type StorageMock = {
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
  persist?: () => Promise<boolean>;
  persisted?: () => Promise<boolean>;
};

const originalStorageDescriptor = Object.getOwnPropertyDescriptor(navigator, 'storage');

/** Script a StorageManager state (or remove the API entirely with `undefined`). */
function installStorage(mock: StorageMock | undefined): void {
  if (mock === undefined) {
    Reflect.deleteProperty(navigator, 'storage');
    return;
  }
  Object.defineProperty(navigator, 'storage', { value: mock, configurable: true });
}

function restoreStorage(): void {
  if (originalStorageDescriptor === undefined) {
    Reflect.deleteProperty(navigator, 'storage');
  } else {
    Object.defineProperty(navigator, 'storage', originalStorageDescriptor);
  }
}

const openedDbs: AppDBImpl[] = [];
let live: ReturnType<typeof mountLiveRegions> | null = null;

beforeEach(() => {
  window.localStorage.clear();
  resetFlags();
  clearBanners();
  resetDialogs();
  resetToasts();
  resetPendingWrites();
  resetState();
  resetStorageInfo();
  resetPersistGate();
  resetImportState();
  resetTaskStore();
  live = mountLiveRegions();
});

afterEach(() => {
  restoreStorage();
  resetDialogs();
  resetTaskStore();
  live?.dispose();
  live = null;
  for (const db of openedDbs.splice(0)) db.close();
});

function ready(overrides: Record<string, unknown> = {}): void {
  patchState({
    status: 'ready',
    classification: { kind: 'normal' },
    hasData: true,
    lastBackupAt: Date.now() - 20 * DAY,
    priorUse: true,
    onboarding: false,
    ...overrides,
  } as never);
}

/* ================================================================== *
 * S1 — First run (§3.1 / §6.1)                                        *
 * ================================================================== */

describe('S1 — first run: onboarding before task UI, honest copy, durable marker', () => {
  it('shows the first-run screen before any task UI and finishes through the single CTA', async () => {
    window.localStorage.clear();
    initFirstRunFlag();
    render(<App />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your data lives in this browser' }),
    ).toBeTruthy();
    // …before any task UI: the app shell's Today view is not on screen yet.
    expect(screen.queryByRole('heading', { level: 1, name: 'Today' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Get started' }));
    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { level: 1, name: 'Your data lives in this browser' }),
      ).toBeNull();
    });
    // The durable marker is the ADR-002 key only.
    expect(readOnboardingStep()).toBe('done');
    expect(window.localStorage.getItem('todo:prefs:v1:onboardingStep')).toBe('done');
  });

  it('names the iOS 7-day rule + the install and backup paths in English AND Thai (§11 QA checklist)', async () => {
    const english = render(<Onboarding onDone={() => undefined} />);
    expect(
      screen.getByText(
        /Safari can delete a website's data after 7 days if you don't visit the site/u,
        {
          exact: true,
        },
      ),
    ).toBeTruthy();
    // ADR-008 / S13: install is the named durable-storage option; backups stay (belt and braces).
    expect(
      screen.getByText(/The strongest protection is installing Todo to your home screen/u, {
        exact: true,
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(/Backups still matter after installing/u, { exact: true }),
    ).toBeTruthy();
    english.unmount();

    await setLocale('th');
    render(<Onboarding onDone={() => undefined} />);
    expect(
      screen.getByText(/ซาฟารีอาจลบข้อมูลของเว็บไซต์หลังจาก 7 วัน/u, { exact: true }),
    ).toBeTruthy();
    expect(screen.getByText(/การป้องกันที่ดีที่สุดคือการติดตั้ง/u, { exact: true })).toBeTruthy();
    await setLocale('en');
  });
});

/* ================================================================== *
 * S2 — Storage & back up panel values (§4.3) with mocked storage       *
 * ================================================================== */

describe('S2 — panel values with scripted StorageManager states', () => {
  it('healthy estimate → quota value line + persistence granted row', async () => {
    installStorage({
      estimate: async () => ({ usage: 43_000_000, quota: 2 * 1024 * 1024 * 1024 }),
      persist: async () => true,
      persisted: async () => true,
    });
    ready();
    await refreshQuota();
    expect(await refreshPersistence()).toBe('granted');
    render(<StoragePanelContainer />);

    const meter = screen.getByRole('meter');
    expect(meter.getAttribute('aria-valuenow')).toBe('2');
    expect(screen.getByText('41 MB of ≈2 GB (2%)', { exact: true })).toBeTruthy();
    expect(
      screen.getByText('Protected — this browser is keeping app data', { exact: true }),
    ).toBeTruthy();
  });

  it('80% warn tier and 90% crit tier carry their text labels (colour is never the only signal)', async () => {
    installStorage({ estimate: async () => ({ usage: 85, quota: 100 }) });
    ready();
    await refreshQuota();
    const { rerender } = render(<StoragePanelContainer />);
    expect(screen.getByText('Worth a look — storage is filling up', { exact: true })).toBeTruthy();

    quotaState.value = { usedBytes: 95, totalBytes: 100, supported: true, loading: false };
    rerender(<StoragePanelContainer />);
    expect(
      screen.getByText('Action needed — storage is almost full', { exact: true }),
    ).toBeTruthy();

    quotaState.value = { usedBytes: 79, totalBytes: 100, supported: true, loading: false };
    rerender(<StoragePanelContainer />);
    expect(screen.queryByText('Worth a look — storage is filling up', { exact: true })).toBeNull();
    deriveBanners();
    expect(visibleBanners().visible.map((banner) => banner.id)).not.toContain('quota-warn');

    quotaState.value = { usedBytes: 80, totalBytes: 100, supported: true, loading: false };
    deriveBanners();
    expect(visibleBanners().visible.map((banner) => banner.id)).toContain('quota-warn');
  });

  it('no StorageManager at all → unknown meter + unsupported persistence row (§9.4)', async () => {
    installStorage(undefined);
    ready({ status: 'failed' });
    await refreshQuota();
    expect(await refreshPersistence()).toBe('unsupported');
    render(<StoragePanelContainer />);

    expect(
      screen.getByText(
        "Storage details aren't available in this browser. Backups are still your safety net.",
        {
          exact: true,
        },
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("This browser doesn't offer extra protection", { exact: true }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request protection' })).toBeNull();
  });

  it('estimate() without a total → the indeterminate meter copy, never a fake number', async () => {
    installStorage({ estimate: async () => ({ usage: 1024 }), persisted: async () => false });
    ready();
    await refreshQuota();
    render(<StoragePanelContainer />);
    expect(
      screen.getByText("Your browser doesn't report storage use here.", { exact: true }),
    ).toBeTruthy();
    expect(screen.queryByText(/of ≈/u, { exact: true })).toBeNull();
  });

  it('persistence states: not-requested → "Request protection"; denied → "Ask again"; persist() throw → error copy', async () => {
    installStorage({ persist: async () => false, persisted: async () => false });
    ready();
    expect(await refreshPersistence()).toBe('not-requested');
    const { rerender } = render(<StoragePanelContainer />);
    expect(screen.getByRole('button', { name: 'Request protection' })).toBeTruthy();

    expect(await requestPersist()).toBe('denied');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Ask again' })).toBeTruthy();
    });
    expect(
      screen.getByText('Not protected — this browser may clear app data', { exact: true }),
    ).toBeTruthy();

    installStorage({
      persist: async () => Promise.reject(new Error('blocked')),
      persisted: async () => false,
    });
    await requestPersist();
    rerender(<StoragePanelContainer />);
    expect(
      screen.getByText("This browser wouldn't say. Backups are your safety net.", { exact: true }),
    ).toBeTruthy();
  });

  it('lastBackupAt age labels: Never (danger with data / neutral without), Today, Yesterday, N days, N months (§10.4)', () => {
    installStorage(undefined);
    // `relativeAge` counts CALENDAR days (§3.2 "today − lastBackupAt"), so anchor the
    // offsets to a fixed local hour — an 20h offset can fall on the same calendar day.
    const today = new Date();
    today.setHours(1, 0, 0, 0);
    const anchor = today.getTime();
    const cases: Array<[number | null, boolean, RegExp]> = [
      [null, true, /^Last backup: Never$/u],
      [anchor, true, /^Last backup: Today \(/u],
      [anchor - DAY, true, /^Last backup: Yesterday \(/u],
      [anchor - 5 * DAY, true, /^Last backup: 5 days ago \(/u],
      [anchor - 90 * DAY, true, /^Last backup: 3 months ago \(/u],
    ];
    for (const [lastBackupAt, dataExists, pattern] of cases) {
      ready({ lastBackupAt, hasData: dataExists });
      const { unmount } = render(<StoragePanelContainer />);
      expect(screen.getByText(pattern, { exact: true })).toBeTruthy();
      unmount();
    }

    ready({ lastBackupAt: null, hasData: false });
    render(<StoragePanelContainer />);
    expect(screen.getByText(/^Last backup: Never$/u, { exact: true })).toBeTruthy();
    expect(
      screen.getByText('Nothing to back up yet — once you add tasks, save a backup here.', {
        exact: true,
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Snapshots are automatic safety copies made before big changes (like an import). You'll see up to three here.",
        {
          exact: true,
        },
      ),
    ).toBeTruthy();
  });

  it('the panel keeps export + import reachable and the danger zone at the bottom (§4.1)', () => {
    installStorage(undefined);
    ready();
    render(<StoragePanelContainer />);
    expect(screen.getByRole('button', { name: 'Back up now' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Import…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete all data' })).toBeTruthy();
    const headings = [...document.querySelectorAll('h3')].map((node) => node.textContent);
    expect(headings).toEqual([
      'Storage in this browser',
      'Keeping your data',
      'Backup',
      'Snapshots',
      'Danger zone',
    ]);
  });
});

/* ================================================================== *
 * S3 — persist() at first meaningful use + backup nudge (§3.2, §5.5)   *
 * ================================================================== */

describe('S3 — persist() requested after the FIRST task created, exactly once', () => {
  it('addTask success triggers the persist() gate; a second task does not request again', async () => {
    const persist = vi.fn(async () => true);
    installStorage({
      persist,
      persisted: async () => false,
      estimate: async () => ({ quota: 2e9 }),
    });
    const built = makeTestRunner({ lists: [makeList({ id: 'L1' })] });
    bindRunnerForTest(built.runner);

    expect(isPersistGateOpen()).toBe(false);
    const first = await addTask({
      title: 'Buy milk',
      notes: null,
      dueDate: null,
      listId: 'L1',
      priority: 'P3',
      tags: [],
    });
    expect(first.ok).toBe(true);
    await waitFor(() => {
      expect(persist).toHaveBeenCalledTimes(1);
    });
    expect(persistenceState.value).toBe('granted');

    const second = await addTask({
      title: 'Buy eggs',
      notes: null,
      dueDate: null,
      listId: 'L1',
      priority: 'P3',
      tags: [],
    });
    expect(second.ok).toBe(true);
    await waitFor(() => undefined);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(isPersistGateOpen()).toBe(true);
  });

  it('a FAILED first write does not request persist() (no meaningful use yet)', async () => {
    const persist = vi.fn(async () => true);
    installStorage({
      persist,
      persisted: async () => false,
      estimate: async () => ({ quota: 2e9 }),
    });
    const built = makeQuotaRunner();
    bindRunnerForTest(built.runner);

    const failed = await addTask({
      title: 'Buy milk',
      notes: null,
      dueDate: null,
      listId: 'L1',
      priority: 'P3',
      tags: [],
    });
    expect(failed.ok).toBe(false);
    await waitFor(() => undefined);
    expect(persist).not.toHaveBeenCalled();
  });
});

describe('S3 — backup-reminder nudge (§3.2/§6.3)', () => {
  function bannersFor(lastBackupAt: number | null, hasData = true): string[] {
    ready({ lastBackupAt, hasData });
    deriveBanners(Date.now());
    return visibleBanners(Date.now()).visible.map((banner) => banner.id);
  }

  it('does NOT nag at 13 days, fires at the 14-day threshold and beyond', () => {
    installStorage(undefined);
    expect(bannersFor(Date.now() - 13 * DAY)).not.toContain('backup-reminder');
    expect(bannersFor(Date.now() - 14 * DAY)).toContain('backup-reminder');
    expect(bannersFor(Date.now() - 400 * DAY)).toContain('backup-reminder');
  });

  it('fires the "never backed up" variant only when data exists', () => {
    installStorage(undefined);
    expect(bannersFor(null, true)).toContain('backup-reminder');
    expect(bannersFor(null, false)).not.toContain('backup-reminder');
  });

  it('renders the nudge copy (incl. the Safari 7-day rule) and snoozes 7 days on close', async () => {
    installStorage(undefined);
    ready({ lastBackupAt: Date.now() - 20 * DAY });
    render(<DataSafetyHost />);
    await waitFor(() => {
      expect(
        screen.getByText(/It's been 20 days since your last backup\./u, { exact: true }),
      ).toBeTruthy();
    });
    expect(
      screen.getByText(/Safari on iPhone and iPad, which can remove website data after 7 days/u, {
        exact: true,
      }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back up now' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Hide for 7 days' }));
    await waitFor(() => {
      expect(
        screen.queryByText(/It's been 20 days since your last backup\./u, { exact: true }),
      ).toBeNull();
    });
    expect(isSuppressed('backup-reminder', Date.now())).toBe(true);
    // A snooze is a 7-day suppression, not a permanent dismissal.
    expect(isSuppressed('backup-reminder', Date.now() + 8 * DAY)).toBe(false);
  });

  it('clears after a successful backup and does not return until the threshold passes again (§6.3)', () => {
    installStorage(undefined);
    expect(bannersFor(Date.now() - 20 * DAY)).toContain('backup-reminder');
    // A successful export stamps lastBackupAt = now (actions.ts) — simulate the same state change.
    expect(bannersFor(Date.now())).not.toContain('backup-reminder');
  });
});

/* ================================================================== *
 * S4 — QuotaExceededError on a simulated full-quota write (§3.3/§6.4)  *
 * ================================================================== */

describe('S4 — quota-exceeded write: dialog appears, the write is NEVER dropped', () => {
  it('routes a real store write failure through the dialog + pending queue and retires it only when it lands', async () => {
    installStorage(undefined);
    ready({ lastBackupAt: Date.now() });
    const built = makeQuotaRunner();
    bindRunnerForTest(built.runner);
    render(<DataSafetyHost />);

    // 1. Simulated full-quota write through the PRODUCTION write path (store.guard).
    const result = await addTask({
      title: 'Buy milk',
      notes: null,
      dueDate: null,
      listId: 'L1',
      priority: 'P3',
      tags: [],
    });
    expect(result.ok).toBe(false);

    // 2. The blocking dialog opens with exactly the three §6.4 actions.
    await waitFor(() => {
      expect(currentDialog()?.request.kind).toBe('quota-exceeded');
    });
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('heading', { name: 'Not enough storage space' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Free up space' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Export a backup' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(pendingWrites.value).toHaveLength(1);

    // 3. Escape = close, but the pending write SURVIVES — nothing is dropped.
    await settle();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(pendingWrites.value).toHaveLength(1);
    expect(built.created).toHaveLength(0); // nothing landed, nothing dropped

    // 4. Retry while still full (the banner's "Try again" runs the same retryPendingWrites):
    //    still pending, still not dropped.
    await retryPendingWrites();
    expect(pendingWrites.value).toHaveLength(1);
    expect(built.created).toHaveLength(0);

    // 5. Free space, retry → the write lands and the entry retires; no re-opened dialog.
    built.setFull(false);
    await retryPendingWrites();
    await waitFor(() => {
      expect(pendingWrites.value).toHaveLength(0);
    });
    expect(built.created).toHaveLength(1);
    expect(built.created[0]?.title).toBe('Buy milk');
    expect(currentDialog()).toBeNull();
  });

  it('§6.4 (D1 fixed): Escape must leave the persistent T2 "N changes waiting" banner', async () => {
    installStorage(undefined);
    ready({ lastBackupAt: Date.now() });
    const built = makeQuotaRunner();
    bindRunnerForTest(built.runner);
    render(<DataSafetyHost />);

    await addTask({
      title: 'Buy milk',
      notes: null,
      dueDate: null,
      listId: 'L1',
      priority: 'P3',
      tags: [],
    });
    await waitFor(() => {
      expect(currentDialog()?.request.kind).toBe('quota-exceeded');
    });
    await settle();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    await settle();

    // §6.4 verbatim: "Escaping the dialog (Escape / close): allowed, but a persistent T2
    // banner replaces it: '1 change is waiting to be saved.' with the same three actions."
    // Regression guard for D1: the derive effect now tracks `pendingWrites` — `useSignalEffect`
    // subscribes to every signal `deriveBanners` reads — so a write queued after mount surfaces
    // its T2 banner immediately, with no unrelated trigger needed.
    expect(screen.getAllByText('1 change is waiting to be saved.', { exact: true })).toHaveLength(
      1,
    );
  });

  it('a second queued failure counts up in the dialog and the banner (no write is ever discarded)', async () => {
    installStorage(undefined);
    ready({ lastBackupAt: Date.now() });
    noteWriteFailure({ code: 'QUOTA_EXCEEDED' }, 'create task', async () => false);
    answerDialog(false);
    noteWriteFailure({ code: 'QUOTA_EXCEEDED' }, 'create task', async () => false);
    expect(pendingWrites.value).toHaveLength(2);

    render(<DataSafetyHost />);
    await waitFor(() => {
      expect(
        screen.getAllByText('2 changes are waiting to be saved.', { exact: true }).length,
      ).toBeGreaterThan(0);
    });
    // Both the T2 banner and the dialog body state the count (§6.4) — assert the banner copy.
    const banners = document.querySelectorAll('.nudge-banner');
    expect(
      [...banners].some((banner) =>
        banner.textContent.includes('2 changes are waiting to be saved.'),
      ),
    ).toBe(true);
    await retryPendingWrites();
    expect(pendingWrites.value).toHaveLength(2);
  });
});

/* ================================================================== *
 * S5 — Eviction / wipe detection (§3.4)                               *
 * ================================================================== */

describe('S5 — eviction / wipe detection with scripted boot states', () => {
  it('boot-validation wipe (empty store after prior use) → recovery screen surfacing lastBackupAt', async () => {
    installStorage({
      persisted: async () => false,
      estimate: async () => ({ usage: 0, quota: 2e9 }),
    });
    const lastBackupAt = Date.now() - 5 * DAY;
    patchState({
      status: 'ready',
      classification: { kind: 'wiped', lastBackupAt },
      hasData: false,
      lastBackupAt,
      priorUse: true,
      onboarding: false,
    });
    render(<App />);
    expect(
      await screen.findByRole('heading', { level: 1, name: "We couldn't find your tasks" }),
    ).toBeTruthy();
    expect(screen.getByText(/Your last backup was 5 days ago \(/u, { exact: true })).toBeTruthy();
    expect(
      screen.getByText(/Safari removed the app's data after 7 days/u, { exact: true }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restore from a backup' })).toBeTruthy();
  });

  it('"Start fresh" asks inline first, then acknowledges so the SAME store is not re-flagged as evicted', async () => {
    installStorage(undefined);
    patchState({
      status: 'ready',
      classification: { kind: 'wiped', lastBackupAt: null },
      hasData: false,
      priorUse: true,
      onboarding: false,
    });
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: "We couldn't find your tasks" });
    expect(
      screen.getByText(/You haven't backed up before, so there may be nothing to restore from\./u, {
        exact: true,
      }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Start fresh' }));
    expect(recoveryStartedAt()).toBeNull(); // not yet — the inline confirm must come first
    const confirms = screen.getAllByRole('button', { name: 'Start fresh' });
    fireEvent.click(confirms[confirms.length - 1] as HTMLElement);
    expect(recoveryStartedAt()).not.toBeNull();

    // Same episode, same store instance → classifyBoot must not nag again (§3.4 ack rule).
    const reclassified = classifyBoot({
      priorUse: true,
      priorData: true,
      hasData: false,
      lastBackupAt: null,
      absentDays: 0,
      shrink: null,
      storeCreatedAt: Date.now() - 30 * DAY,
      recoveryAckAt: recoveryStartedAt(),
    });
    expect(reclassified).toEqual({ kind: 'normal' });
    // A store re-created AFTER the ack is a NEW eviction and must warn again.
    expect(
      classifyBoot({
        priorUse: true,
        priorData: true,
        hasData: false,
        lastBackupAt: null,
        absentDays: 0,
        shrink: null,
        storeCreatedAt: Date.now() + DAY,
        recoveryAckAt: recoveryStartedAt(),
      }),
    ).toMatchObject({ kind: 'wiped' });
  });

  it('first run after a long absence (≥ 7 days) surfaces lastBackupAt in the banner (§6.6)', async () => {
    installStorage(undefined);
    const lastBackupAt = Date.now() - 40 * DAY;
    ready({ classification: { kind: 'long-absence', absentDays: 9, lastBackupAt } });
    render(<DataSafetyHost />);
    expect(
      await screen.findByText("Welcome back — it's been 9 days.", { exact: true }),
    ).toBeTruthy();
    // The §6.6 lastBackupLine is interpolated INTO the banner body.
    const body = document.querySelector('.nudge-banner')?.textContent ?? '';
    expect(body).toContain('Your last backup was');
    expect(body).toMatch(/Your last backup was [^.]+\d{4}\./u);

    // …and the "never backed up" variant when there is no backup at all.
    ready({ classification: { kind: 'long-absence', absentDays: 12, lastBackupAt: null } });
    await waitFor(() => {
      expect(document.querySelector('.nudge-banner')?.textContent ?? '').toContain(
        'You have never backed up.',
      );
    });
  });

  it('long-absence boundary is 7 days, and it outranks a shrunken store (§3.4 priority)', () => {
    expect(
      classifyBoot({
        priorUse: true,
        priorData: true,
        hasData: true,
        lastBackupAt: null,
        absentDays: 7,
        shrink: null,
        storeCreatedAt: null,
        recoveryAckAt: null,
      }),
    ).toMatchObject({ kind: 'long-absence', absentDays: 7 });
    expect(
      classifyBoot({
        priorUse: true,
        priorData: true,
        hasData: true,
        lastBackupAt: null,
        absentDays: 6,
        shrink: null,
        storeCreatedAt: null,
        recoveryAckAt: null,
      }),
    ).toEqual({ kind: 'normal' });
  });

  it('a >30% record drop vs the snapshot baseline raises the T2 shrunken warning (§3.4)', async () => {
    installStorage(undefined);
    ready({
      classification: {
        kind: 'shrunken',
        dropped: 0.7,
        baseline: { lists: 1, tasks: 99, doneTasks: 0, hasData: true },
      },
      lastBackupAt: Date.now(),
    });
    render(<DataSafetyHost />);
    expect(await screen.findByText(/70%/u, { exact: true })).toBeTruthy();
  });
});

/* ================================================================== *
 * S6 — Private-browsing warning at first write (§3.5 / §6.7)          *
 * ================================================================== */

describe('S6 — private-browsing warning (ephemeral heuristic at first write)', () => {
  it('opens the one-time dialog when persist() is denied AND the quota looks like private mode', async () => {
    installStorage({
      persist: async () => false,
      persisted: async () => false,
      estimate: async () => ({ usage: 1_000_000, quota: 8_000_000 }),
    });
    ready();
    render(<DataSafetyHost />);

    await noteFirstMeaningfulWrite();
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByRole('heading', { name: 'This looks like private browsing' }),
    ).toBeTruthy();
    // §6.7 honesty: never claims data is definitely lost.
    expect(within(dialog).getByText(/may not be there next time/u, { exact: true })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Export a backup' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Got it' })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Got it' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    // Once per profile: a second first-write (new session) never re-opens it.
    resetPersistGate();
    await noteFirstMeaningfulWrite();
    await waitFor(() => undefined);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('never warns when the browser grants persistence (even with a small quota)', async () => {
    installStorage({
      persist: async () => true,
      persisted: async () => true,
      estimate: async () => ({ usage: 1_000_000, quota: 8_000_000 }),
    });
    ready();
    render(<DataSafetyHost />);
    await noteFirstMeaningfulWrite();
    await waitFor(() => undefined);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(persistenceState.value).toBe('granted');
  });
});

/* ================================================================== *
 * S7 — Import confirm + pre-import snapshot undo (§8) — REAL engine    *
 * ================================================================== */

describe('S7 — import confirm + pre-import snapshot undo (real ADR-004 engine)', () => {
  it('writes nothing before confirm, replaces on confirm, and the undo restores the previous data', async () => {
    const db = await openFixtureDb(uniqueDbName('qa-ux'));
    openedDbs.push(db);
    bindDataSafetyDb(db);

    // Current data: 1 list + 1 task. The backup carries a DIFFERENT list + task.
    // Ids are valid ULIDs (fixtureId) so nothing is quarantined by ADR-004 validation.
    const currentList = makeStoredList({ id: fixtureId(10), name: 'Current list' });
    const currentTask = makeStoredTask({
      id: fixtureId(11),
      listId: currentList.id,
      title: 'Current task',
    });
    await db.put('settings', makeSettings());
    await db.put('lists', currentList);
    await db.put('tasks', currentTask);

    const backupList = makeStoredList({ id: fixtureId(20), name: 'Backup list' });
    const backupTask = makeStoredTask({
      id: fixtureId(21),
      listId: backupList.id,
      title: 'Backup task',
    });
    const file = fakeFile(
      'local-first-todo-backup-2026-10-23.json',
      makeDocText({ lists: [backupList], tasks: [backupTask] }),
    );

    render(<DataSafetyHost />);

    /* --- pick → validate → preview → CONFIRM (nothing written yet) --- */
    void chooseImportFile(file);
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByRole('heading', { name: 'Replace everything with this backup?' }),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(/This backup contains 1 tasks in 1 lists/u, { exact: true }),
    ).toBeTruthy();
    // ADR-004 Decision 5.5 (a) [review R1 B1]: the settings record IS replaced — the copy says so.
    expect(
      within(dialog).getByText(
        'Importing will replace the data currently in this browser: 1 tasks in 1 lists will be removed and replaced by the backup, and your settings are replaced too — theme and language come from the backup file.',
        { exact: true },
      ),
    ).toBeTruthy();
    // (b): the undo's location AND the download escape hatch are named.
    expect(
      within(dialog).getByText(
        /It lives in Settings → Storage & back up → Snapshots, where you can restore it in one tap or download it as a file\./u,
        { exact: true },
      ),
    ).toBeTruthy();
    // (c): the tombstone-resurrection caveat.
    expect(
      within(dialog).getByText(
        /Importing an older backup can bring back tasks and lists you deleted after that backup was made\./u,
        { exact: true },
      ),
    ).toBeTruthy();

    // Zero side effects while the dialog is open (§8.1 steps 1–4).
    const rowsWhileOpen = await db.getAll('tasks');
    expect(rowsWhileOpen.ok && rowsWhileOpen.value.map((row) => row.id)).toEqual([currentTask.id]);
    const snapsWhileOpen = await db.getAll('snapshots');
    expect(snapsWhileOpen.ok && snapsWhileOpen.value).toEqual([]);

    /* --- cancel = nothing changes --- */
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(importState.value.step).toBe('pick');
    const rowsAfterCancel = await db.getAll('tasks');
    expect(rowsAfterCancel.ok && rowsAfterCancel.value.map((row) => row.id)).toEqual([
      currentTask.id,
    ]);

    /* --- confirm → pre-import snapshot + replace + undo toast --- */
    void chooseImportFile(file);
    const confirmDialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Replace and import' }));
    await waitFor(() => {
      expect(
        screen.getByText('Import complete. Your previous data is saved as a snapshot.', {
          exact: true,
        }),
      ).toBeTruthy();
    });
    expect(importState.value.step).toBe('done');
    // Review R1 B2: the undo toast also offers the durable downloadSnapshot escape hatch
    // (the rolling-3 can evict the undo; a downloaded file cannot).
    await settle();
    expect(screen.getByRole('button', { name: 'Download snapshot' })).toBeTruthy();

    const replaced = await db.getAll('tasks');
    expect(replaced.ok && replaced.value.map((row) => row.id)).toEqual([backupTask.id]);
    const snapshots = await db.getAll('snapshots');
    expect(snapshots.ok && snapshots.value).toHaveLength(1);
    const undoSnapshot = snapshots.ok ? snapshots.value[0] : undefined;
    expect(undoSnapshot?.reason).toBe('pre-import');
    expect(importState.value).toMatchObject({ step: 'done', undoSnapshotId: undoSnapshot?.id });

    /* --- undo: restore-confirm dialog → the previous data comes back --- */
    fireEvent.click(screen.getByRole('button', { name: 'Restore previous data' }));
    const restoreDialog = await screen.findByRole('alertdialog');
    expect(
      within(restoreDialog).getByText(/Replace everything with the snapshot from/u, {
        exact: true,
      }),
    ).toBeTruthy();
    fireEvent.click(within(restoreDialog).getByRole('button', { name: 'Restore snapshot' }));
    // Sync on the DATA, not on copy: the first import's persistent undo toast is still
    // mounted ("Import complete…"), so a text waitFor would pass before the restore lands.
    await waitFor(async () => {
      const after = await db.getAll('tasks');
      expect(after.ok && after.value.map((row) => row.id)).toEqual([currentTask.id]);
    });
    const restored = await db.getAll('tasks');
    expect(restored.ok && restored.value.map((row) => row.id)).toEqual([currentTask.id]);
  });

  it('an invalid file never mutates anything and always offers "Choose another file" (§7)', async () => {
    const db = await openFixtureDb(uniqueDbName('qa-ux-bad'));
    openedDbs.push(db);
    bindDataSafetyDb(db);
    await db.put('settings', makeSettings());
    await db.put('tasks', makeStoredTask());

    render(
      <>
        <DataSafetyHost />
        <StoragePanelContainer />
      </>,
    );
    await chooseImportFile(fakeFile('not-a-backup.json', '{"hello": "world"}'));

    // The inline notice (role=alert) is the panel's `.storage-notice`; the polite/assertive
    // live regions also carry role=alert, so query the notice node itself.
    await waitFor(() => {
      expect(document.querySelector('.storage-notice')).not.toBeNull();
    });
    const notice = document.querySelector('.storage-notice') as HTMLElement;
    expect(notice.textContent).toContain("This file isn't a");
    expect(within(notice).getByRole('button', { name: 'Choose another file' })).toBeTruthy();
    const rows = await db.getAll('tasks');
    expect(rows.ok && rows.value).toHaveLength(1);
    const snaps = await db.getAll('snapshots');
    expect(snaps.ok && snaps.value).toEqual([]);
  });
});

/* ================================================================== *
 * R — review round-1 rework verification (B1/B2/B3 + N4/N5)          *
 * ================================================================== */

describe('R — review round-1 rework verification', () => {
  it('B3: a whole-file NOTHING_TO_IMPORT reject offers the recovery file and writes nothing', async () => {
    const db = await openFixtureDb(uniqueDbName('qa-ux-reject'));
    openedDbs.push(db);
    bindDataSafetyDb(db);
    await db.put('settings', makeSettings());
    await db.put('tasks', makeStoredTask());

    render(
      <>
        <DataSafetyHost />
        <StoragePanelContainer />
      </>,
    );
    await chooseImportFile(
      fakeFile(
        'drill7-all-corrupt-with-snapshot-metadata.json',
        fixture('drill7-all-corrupt-with-snapshot-metadata.json'),
      ),
    );

    // The inline notice carries the extended copy…
    await waitFor(() => {
      expect(document.querySelector('.storage-notice')).not.toBeNull();
    });
    const notice = document.querySelector('.storage-notice') as HTMLElement;
    expect(notice.textContent).toContain('Nothing in this file could be imported');
    expect(notice.textContent).toContain('The damaged records can be saved as a recovery file');
    // …and the download rides a toast — the binding "offer it in the UX".
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Download recovery file' })).toBeTruthy();
    });

    // Zero side effects on a whole-file reject.
    expect(importState.value.step).toBe('invalid');
    const rows = await db.getAll('tasks');
    expect(rows.ok && rows.value).toHaveLength(1);
    const snaps = await db.getAll('snapshots');
    expect(snaps.ok && snaps.value).toEqual([]);
  });

  it('B2: a pre-import snapshot row carries the 7-day note + a download affordance (autos carry neither)', () => {
    const now = Date.UTC(2026, 9, 24, 12, 0, 0);
    const recent: SnapshotMeta = {
      id: fixtureId(40),
      takenAt: now - DAY,
      kind: 'auto',
      reason: 'pre-import',
      sizeBytes: 1_024,
    };
    const old: SnapshotMeta = {
      id: fixtureId(41),
      takenAt: now - 8 * DAY,
      kind: 'auto',
      reason: 'pre-import',
      sizeBytes: 1_024,
    };
    const auto: SnapshotMeta = {
      id: fixtureId(42),
      takenAt: now - DAY,
      kind: 'auto',
      reason: 'scheduled',
      sizeBytes: 1_024,
    };
    const onRestore = vi.fn();
    const onDownload = vi.fn();
    render(
      <SnapshotList
        snapshots={[recent, old, auto]}
        onRestore={onRestore}
        onDownload={onDownload}
        now={now}
      />,
    );

    // The note tells the TRUTH about retention: only while protection actually holds.
    expect(screen.getAllByText('kept for 7 days', { exact: true })).toHaveLength(1);
    const downloads = screen.getAllByRole('button', { name: 'Download snapshot' });
    expect(downloads).toHaveLength(2); // both pre-import rows, never the auto row
    fireEvent.click(downloads[0] as HTMLElement);
    expect(onDownload).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByRole('button', { name: 'Restore' })[0] as HTMLElement);
    expect(onRestore).toHaveBeenCalledWith(recent.id);
  });

  it('N4: restoring an evicted snapshot says so instead of the generic "nothing changed" copy', async () => {
    const db = await openFixtureDb(uniqueDbName('qa-ux-n4'));
    openedDbs.push(db);
    bindDataSafetyDb(db);
    await db.put('settings', makeSettings());
    await db.put('tasks', makeStoredTask());
    render(<DataSafetyHost />);

    await restoreSnapshot(fixtureId(99)); // a snapshot that was never taken / already evicted
    await waitFor(() => {
      expect(importState.value).toMatchObject({ step: 'failed', recoverable: true });
    });
    const message = (importState.value as { message?: string }).message ?? '';
    expect(message).toBe('That snapshot is no longer available. Nothing was changed.');
    await waitFor(() => {
      expect(
        screen.getByText('That snapshot is no longer available. Nothing was changed.', {
          exact: true,
        }),
      ).toBeTruthy();
    });
  });

  it('N5 §5.6 busy lifecycle: answerDialog(true) keeps the dialog mounted until closeDialog()', async () => {
    const verdict = openDialog({
      kind: 'delete-all-confirm',
      dataCounts: { lists: 1, tasks: 1, doneTasks: 0, hasData: true },
    });
    answerDialog(true);
    // The dialog does NOT close before the destructive write it just authorised runs.
    expect(currentDialog()?.busy).toBe(true);
    expect(currentDialog()?.request.kind).toBe('delete-all-confirm');
    closeDialog();
    expect(currentDialog()).toBeNull();
    expect(await verdict).toBe(true);
  });

  it('N5: the cancel path still resolves false and drains the queue at once', async () => {
    const verdict = openDialog({
      kind: 'delete-all-confirm',
      dataCounts: { lists: 1, tasks: 1, doneTasks: 0, hasData: true },
    });
    answerDialog(false);
    expect(currentDialog()).toBeNull();
    expect(await verdict).toBe(false);
  });
});

/* ================================================================== *
 * P — §8.4 pre-import retention protection (real engine)             *
 * ================================================================== */

describe('P — §8.4 pre-import retention protection (real engine on fake-indexeddb)', () => {
  it('holds 2 protected pre-imports inside the rolling 3, evicts the oldest on a 3rd, and lapses after 7 days', async () => {
    const db = await openFixtureDb(uniqueDbName('qa-protect'));
    openedDbs.push(db);
    await db.put('settings', makeSettings());
    await db.put('lists', makeStoredList());
    await db.put('tasks', makeStoredTask());

    // The UI note quotes exactly these constants — promise and behaviour cannot drift.
    expect(PRE_IMPORT_PROTECTION_MS).toBe(7 * DAY);
    expect(MAX_PROTECTED_SNAPSHOTS).toBe(2);
    expect(AUTO_RETENTION).toBe(3);

    const HOUR = 3_600_000;
    const T = Date.UTC(2026, 9, 20, 0, 0, 0);
    const at = (ms: number) => (): number => T + ms;

    const p1 = await takeSnapshot('pre-import', { db, now: at(0) });
    const p2 = await takeSnapshot('pre-import', { db, now: at(HOUR) });
    expect(p1.ok).toBe(true);
    expect(p2.ok).toBe(true);
    if (!p1.ok || !p2.ok) return;

    // Rolling autos fill the remaining slot; the list never exceeds the rolling 3.
    await takeSnapshot('scheduled', { db, now: at(2 * HOUR) });
    await takeSnapshot('scheduled', { db, now: at(3 * HOUR) });
    await takeSnapshot('scheduled', { db, now: at(4 * HOUR) });
    const afterAutos = await listSnapshots({ db });
    const ids1 = afterAutos.ok ? afterAutos.value.map((row) => row.id) : [];
    expect(ids1).toHaveLength(AUTO_RETENTION);
    expect(ids1).toContain(p1.value.id); // protected: survived two newer autos
    expect(ids1).toContain(p2.value.id);

    // A THIRD protected snapshot pushes out the OLDEST protected one (§8.4).
    const p3 = await takeSnapshot('pre-import', { db, now: at(5 * HOUR) });
    expect(p3.ok).toBe(true);
    if (!p3.ok) return;
    const afterThird = await listSnapshots({ db });
    const ids2 = afterThird.ok ? afterThird.value.map((row) => row.id) : [];
    expect(ids2).toHaveLength(AUTO_RETENTION);
    expect(ids2).not.toContain(p1.value.id);
    expect(ids2).toContain(p2.value.id);
    expect(ids2).toContain(p3.value.id);

    // Past the 7-day window protection lapses and the row rolls out like any auto.
    const far = T + 5 * HOUR + PRE_IMPORT_PROTECTION_MS + HOUR;
    await takeSnapshot('scheduled', { db, now: () => far });
    await takeSnapshot('scheduled', { db, now: () => far + HOUR });
    const afterExpiry = await listSnapshots({ db });
    const ids3 = afterExpiry.ok ? afterExpiry.value.map((row) => row.id) : [];
    expect(ids3).toHaveLength(AUTO_RETENTION);
    expect(ids3).not.toContain(p2.value.id); // 7d+ old → protection lapsed → rolled out
    expect(ids3).toContain(p3.value.id);
  });
});

/* ================================================================== *
 * K — keyboard / a11y matrix over every T3 dialog (§5.6)             *
 * ================================================================== */

const qaPreview: ImportPreview = {
  schemaVersion: 1,
  counts: { lists: 1, tasks: 1, doneTasks: 0, snapshots: 0 },
  exportedAt: Date.UTC(2026, 9, 1, 12, 0, 0),
  fileSizeBytes: 2_048,
};
const qaCounts: DataCounts = { lists: 1, tasks: 1, doneTasks: 0, hasData: true };
const qaSnapshot: SnapshotMeta = {
  id: fixtureId(30),
  takenAt: Date.UTC(2026, 9, 20, 12, 0, 0),
  kind: 'auto',
  reason: 'pre-import',
  sizeBytes: 1_024,
};

/** Focus an opener button, mount the dialog, and return the handles the matrix needs. */
async function mountDialog(props: SafetyDialogProps): Promise<{
  readonly opener: HTMLElement;
  readonly view: ReturnType<typeof render>;
  readonly dialog: HTMLElement;
}> {
  render(<button type="button">opener</button>);
  const opener = screen.getByRole('button', { name: 'opener' });
  opener.focus();
  expect(document.activeElement).toBe(opener);
  const view = render(<SafetyDialog {...props} />);
  await settle();
  return { opener, view, dialog: screen.getByRole('alertdialog') };
}

function dialogButtons(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>('button:not([disabled])')];
}

/** Shared §5.6 contract: aria wiring, Tab trap both ways. Focus return is asserted by each
 * test AFTER its Escape/scrim steps (unmounting here would tear the dialog down first). */
async function expectModalContract(
  props: SafetyDialogProps,
  safestAction: string,
): Promise<{
  readonly opener: HTMLElement;
  readonly view: ReturnType<typeof render>;
  readonly dialog: HTMLElement;
}> {
  const { opener, view, dialog } = await mountDialog(props);

  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')).not.toBeNull();
  expect(document.getElementById(dialog.getAttribute('aria-describedby') ?? '')).not.toBeNull();

  // Initial focus on the SAFEST action — never a destructive confirm.
  expect((document.activeElement as HTMLElement).textContent).toBe(safestAction);

  // Tab trap: last → first, Shift+Tab: first → last.
  const buttons = dialogButtons(dialog);
  const first = buttons[0] as HTMLElement;
  const last = buttons[buttons.length - 1] as HTMLElement;
  last.focus();
  fireEvent.keyDown(document, { key: 'Tab' });
  expect(document.activeElement).toBe(first);
  first.focus();
  fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(last);

  return { opener, view, dialog };
}

/** Close the dialog the way the host does (unmount) and prove focus went back to the opener. */
function expectFocusReturn(view: ReturnType<typeof render>, opener: HTMLElement): void {
  view.unmount();
  expect(document.activeElement).toBe(opener);
}

describe('K — keyboard/a11y matrix over every T3 dialog (§5.6)', () => {
  it('quota-exceeded: Escape closes (keeping the write), never the retry/export actions', async () => {
    const spies = { onFreeSpace: vi.fn(), onExport: vi.fn(), onRetry: vi.fn(), onCancel: vi.fn() };
    const { opener, view, dialog } = await expectModalContract(
      { kind: 'quota-exceeded', pendingCount: 1, ...spies },
      'Free up space',
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(spies.onCancel).toHaveBeenCalledTimes(1);
    expect(spies.onRetry).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector('.safety-scrim') as HTMLElement);
    expect(spies.onCancel).toHaveBeenCalledTimes(2);
    expectFocusReturn(view, opener);
    expect(dialog.isConnected).toBe(false);
  });

  it('private-browsing: Escape/scrim dismiss — never the export action', async () => {
    const spies = { onExport: vi.fn(), onDismiss: vi.fn() };
    const { opener, view } = await expectModalContract(
      { kind: 'private-browsing', ...spies },
      'Got it',
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(spies.onDismiss).toHaveBeenCalledTimes(1);
    expect(spies.onExport).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector('.safety-scrim') as HTMLElement);
    expect(spies.onDismiss).toHaveBeenCalledTimes(2);
    expectFocusReturn(view, opener);
  });

  it('import-confirm: Escape/scrim cancel — the destructive confirm never fires', async () => {
    const spies = { onConfirm: vi.fn(), onCancel: vi.fn() };
    const { opener, view } = await expectModalContract(
      { kind: 'import-confirm', file: qaPreview, currentCounts: qaCounts, ...spies },
      'Cancel',
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(spies.onCancel).toHaveBeenCalledTimes(1);
    expect(spies.onConfirm).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector('.safety-scrim') as HTMLElement);
    expect(spies.onCancel).toHaveBeenCalledTimes(2);
    expect(spies.onConfirm).not.toHaveBeenCalled();
    expectFocusReturn(view, opener);
  });

  it('delete-all-confirm: focus starts on "Export a backup first"; Escape/scrim never wipe', async () => {
    const spies = { onConfirm: vi.fn(), onCancel: vi.fn(), onExport: vi.fn() };
    const { opener, view } = await expectModalContract(
      { kind: 'delete-all-confirm', dataCounts: qaCounts, ...spies },
      'Export a backup first',
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(spies.onCancel).toHaveBeenCalledTimes(1);
    expect(spies.onConfirm).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector('.safety-scrim') as HTMLElement);
    expect(spies.onCancel).toHaveBeenCalledTimes(2);
    expect(spies.onConfirm).not.toHaveBeenCalled();
    expectFocusReturn(view, opener);
  });

  it('restore-confirm: Escape/scrim cancel — the restore never runs', async () => {
    const spies = { onConfirm: vi.fn(), onCancel: vi.fn() };
    const { opener, view } = await expectModalContract(
      { kind: 'restore-confirm', snapshot: qaSnapshot, currentCounts: qaCounts, ...spies },
      'Cancel',
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(spies.onCancel).toHaveBeenCalledTimes(1);
    expect(spies.onConfirm).not.toHaveBeenCalled();
    expectFocusReturn(view, opener);
  });

  it('N5 busy state: buttons disabled, focus on the dialog, Escape and scrim inert, status announced', async () => {
    const spies = { onConfirm: vi.fn(), onCancel: vi.fn() };
    render(
      <SafetyDialog
        kind="import-confirm"
        file={qaPreview}
        currentCounts={qaCounts}
        busy
        {...spies}
      />,
    );
    await settle();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.getAttribute('data-state')).toBe('busy');
    expect(dialog.getAttribute('aria-busy')).toBe('true');
    expect(within(dialog).getByRole('status').textContent).toBe('Importing…');
    for (const button of within(dialog).getAllByRole('button')) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    // Focus moved back onto the dialog itself (the focused button is now disabled).
    expect(document.activeElement).toBe(dialog);

    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(document.querySelector('.safety-scrim') as HTMLElement);
    expect(spies.onCancel).not.toHaveBeenCalled();
    expect(spies.onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeNull(); // still mounted
  });

  it('N5 busy labels per confirming kind (importing / deleting / restoring)', async () => {
    const { unmount } = render(
      <SafetyDialog
        kind="delete-all-confirm"
        dataCounts={qaCounts}
        busy
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        onExport={vi.fn()}
      />,
    );
    await settle();
    expect(within(screen.getByRole('alertdialog')).getByRole('status').textContent).toBe(
      'Deleting…',
    );
    unmount();

    render(
      <SafetyDialog
        kind="restore-confirm"
        snapshot={qaSnapshot}
        currentCounts={qaCounts}
        busy
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await settle();
    expect(within(screen.getByRole('alertdialog')).getByRole('status').textContent).toBe(
      'Restoring…',
    );
  });
});

/* ================================================================== *
 * Test seam: a MutationRunner over ports that fail like a full disk    *
 * ================================================================== */

/**
 * A production `MutationRunner` over in-memory ports whose `create` throws the typed
 * `QUOTA_EXCEEDED` while `full` is on — the "simulated full-quota write" of §3.3.
 */
function makeQuotaRunner(): {
  runner: MutationRunner;
  setFull: (value: boolean) => void;
  created: Task[];
} {
  const flag = { full: true };
  const created: Task[] = [];
  const settings: Settings = { ...DEFAULT_SETTINGS };
  const tasks = new Map<string, Task>();
  let seq = 0;

  const taskPort: TaskPort = {
    async loadAll(): Promise<
      Result<{ tasks: Task[]; lists: List[]; settings: Settings }, AppError>
    > {
      return ok({ tasks: [...tasks.values()], lists: [], settings });
    },
    async create(draft: TaskDraft): Promise<Result<Task, AppError>> {
      if (flag.full) return err({ code: 'QUOTA_EXCEEDED' });
      seq += 1;
      const task = makeTask({
        id: draft.id ?? `QATASK${String(seq)}`,
        listId: draft.listId,
        title: draft.title,
        notes: draft.notes,
        priority: draft.priority,
        ...(draft.dueDate !== undefined ? { dueDate: draft.dueDate } : {}),
      });
      tasks.set(task.id, task);
      created.push(task);
      return ok(task);
    },
    async patch(id: string): Promise<Result<Task, AppError>> {
      const current = tasks.get(id);
      if (current === undefined) return err({ code: 'RULE', rule: 'TASK_MISSING', message: id });
      return ok(current);
    },
    async setDone(id: string, done: boolean): Promise<Result<Task, AppError>> {
      const current = tasks.get(id);
      if (current === undefined) return err({ code: 'RULE', rule: 'TASK_MISSING', message: id });
      return ok({ ...current, status: done ? 'done' : 'open' });
    },
    async move(id: string, target: MoveTarget): Promise<Result<MoveOutcome<Task>, AppError>> {
      const current = tasks.get(id);
      if (current === undefined) return err({ code: 'RULE', rule: 'TASK_MISSING', message: id });
      return ok({ row: { ...current, listId: target.group.listId }, rebalanced: false });
    },
    async remove(
      id: string,
      disposition: TaskRemoveDisposition,
    ): Promise<Result<TaskRemoveOutcome, AppError>> {
      const now = Date.now();
      const current = tasks.get(id);
      if (current === undefined) return ok({ tombstoned: [], promoted: [] });
      const children = [...tasks.values()].filter((task) => task.parentTaskId === id);
      const tombstoned: Task[] = [{ ...current, deletedAt: now, updatedAt: now }];
      const promoted: Task[] = [];
      tasks.delete(id);
      if (disposition.mode === 'cascade') {
        for (const child of children) {
          tombstoned.push({ ...child, deletedAt: now, updatedAt: now });
          tasks.delete(child.id);
        }
      } else {
        for (const child of children) {
          const row: Task = { ...child, updatedAt: now };
          delete row.parentTaskId;
          tasks.set(child.id, row);
          promoted.push(row);
        }
      }
      return ok({ tombstoned, promoted });
    },
    async sweepTag(from: string, to: string | null): Promise<Result<Task[], AppError>> {
      const now = Date.now();
      const rewritten: Task[] = [];
      for (const task of tasks.values()) {
        if (!task.tags.includes(from)) continue;
        const row: Task = {
          ...task,
          tags:
            to === null
              ? task.tags.filter((tag) => tag !== from)
              : [...new Set(task.tags.map((tag) => (tag === from ? to : tag)))],
          updatedAt: now,
        };
        tasks.set(row.id, row);
        rewritten.push(row);
      }
      return ok(rewritten);
    },
    async upsertImported(rows: Task[]): Promise<Result<void, AppError>> {
      for (const row of rows) tasks.set(row.id, row);
      return ok(undefined);
    },
  };

  const listPort: ListPort = {
    async loadAll(): Promise<Result<List[], AppError>> {
      return ok([]);
    },
    async create(input): Promise<Result<List, AppError>> {
      return ok(makeList({ id: input.id ?? 'QALIST', name: input.name, color: input.color }));
    },
    async rename(id: string): Promise<Result<List, AppError>> {
      return ok(makeList({ id }));
    },
    async recolor(id: string): Promise<Result<List, AppError>> {
      return ok(makeList({ id }));
    },
    async move(id: string): Promise<Result<MoveOutcome<List>, AppError>> {
      return ok({ row: makeList({ id }), rebalanced: false });
    },
    async remove(): Promise<Result<ListRemoveOutcome, AppError>> {
      return ok({ moved: [], tombstoned: [] });
    },
  };

  const settingsPort: SettingsPort = {
    async get(): Promise<Result<Settings, AppError>> {
      return ok(settings);
    },
    async update(patch): Promise<Result<Settings, AppError>> {
      Object.assign(settings, patch);
      return ok(settings);
    },
  };

  const runner = new MutationRunner({
    tasks: taskPort,
    lists: listPort,
    settings: settingsPort,
    clock: () => Date.now(),
    ids: () => `QAID${String((seq += 1))}`,
    orderKeys: { between: () => 'a0', first: () => 'a0' },
    deviceId: 'QA',
  });

  return { runner, setFull: (value) => (flag.full = value), created };
}
