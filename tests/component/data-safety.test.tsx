import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fireEvent, render, screen } from '@testing-library/preact';

import { Onboarding } from '../../src/features/data-safety/Onboarding';
import { RecoveryScreen } from '../../src/features/data-safety/RecoveryScreen';
import { NudgeBanner } from '../../src/features/data-safety/NudgeBanner';
import { QuotaMeter } from '../../src/features/data-safety/QuotaMeter';
import { PersistenceRow } from '../../src/features/data-safety/PersistenceRow';
import { SafetyDialog } from '../../src/features/data-safety/SafetyDialog';
import { SnapshotList } from '../../src/features/data-safety/SnapshotList';
import { StoragePanel } from '../../src/features/data-safety/StoragePanel';
import { UndoToast } from '../../src/features/data-safety/UndoToast';
import { PRE_IMPORT_PROTECTION_MS } from '../../src/storage/snapshots';
import type { SnapshotMeta } from '../../src/features/data-safety/types';
import {
  answerDialog,
  currentDialog,
  openDialog,
  resetDialogs,
} from '../../src/features/data-safety/notices';
import { resetFlags } from '../../src/features/data-safety/flags';
import { setLocale } from '../../src/i18n';

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const DAY = 86_400_000;

/** Same formatter `absoluteDate()` uses, so expectations survive locale/ICU differences. */
function fmt(ms: number): string {
  return new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' }).format(
    new Date(ms),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  resetFlags();
  resetDialogs();
});

afterEach(() => {
  resetDialogs();
});

describe('<QuotaMeter> (5.2, 10.2)', () => {
  const labels = {
    ok: 'Plenty of room',
    warn: 'Worth a look',
    crit: 'Action needed',
    unknown: 'Unknown',
  };

  it('exposes role=meter with visible value text and hides the ok label under 50%', () => {
    render(
      <QuotaMeter usedBytes={43_000_000} totalBytes={2 * 1024 * 1024 * 1024} labels={labels} />,
    );
    const meter = screen.getByRole('meter');
    expect(meter.getAttribute('aria-valuenow')).toBe('2');
    expect(screen.getByText('41 MB of ≈2 GB (2%)', { exact: true })).toBeTruthy();
    expect(screen.queryByText('Plenty of room', { exact: true })).toBeNull();
  });

  it('switches to warn at 80% and crit at 90%, always with tier text (never colour alone)', () => {
    const { rerender } = render(<QuotaMeter usedBytes={85} totalBytes={100} labels={labels} />);
    expect(screen.getByText('Worth a look', { exact: true })).toBeTruthy();

    rerender(<QuotaMeter usedBytes={95} totalBytes={100} labels={labels} />);
    expect(screen.getByText('Action needed', { exact: true })).toBeTruthy();
  });

  it('renders the indeterminate unknown state when the browser reports no total', () => {
    render(<QuotaMeter usedBytes={10} totalBytes={null} labels={labels} />);
    expect(screen.getByText('Unknown', { exact: true })).toBeTruthy();
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('0');
  });
});

describe('<PersistenceRow> (5.3, 10.3)', () => {
  it('shows the granted state without any action button', () => {
    render(<PersistenceRow state="granted" onRequest={() => undefined} />);
    expect(
      screen.getByText('Protected — this browser is keeping app data', { exact: true }),
    ).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers "Request protection" first and "Ask again" after a refusal', () => {
    const { rerender } = render(
      <PersistenceRow state="not-requested" onRequest={() => undefined} />,
    );
    expect(screen.getByRole('button', { name: 'Request protection' })).toBeTruthy();

    rerender(<PersistenceRow state="denied" onRequest={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Ask again' })).toBeTruthy();
  });

  it('degrades to a read-only unsupported state (9.4)', () => {
    render(<PersistenceRow state="unsupported" />);
    expect(
      screen.getByText("This browser doesn't offer extra protection", { exact: true }),
    ).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows the fallback line when persist() threw (10.3 error state)', () => {
    render(<PersistenceRow state="denied" error onRequest={() => undefined} />);
    expect(
      screen.getByText("This browser wouldn't say. Backups are your safety net.", {
        exact: true,
      }),
    ).toBeTruthy();
  });
});

describe('<StoragePanel> (4, 5.1)', () => {
  const noop = (): void => undefined;

  function panel(props: Partial<Parameters<typeof StoragePanel>[0]> = {}) {
    return (
      <StoragePanel
        quota={{ usedBytes: 43_000_000, totalBytes: 2 * 1024 * 1024 * 1024 }}
        persistence="granted"
        lastBackupAt={NOW - 18 * DAY}
        snapshots={[]}
        now={NOW}
        onRequestPersist={noop}
        onExport={noop}
        onImport={noop}
        onRestoreSnapshot={noop}
        onDownloadSnapshot={noop}
        onDeleteAll={noop}
        {...props}
      />
    );
  }

  it('renders every 4.1 section as an h3 under the settings h2', () => {
    render(panel());
    for (const heading of [
      'Storage in this browser',
      'Keeping your data',
      'Backup',
      'Snapshots',
      'Danger zone',
    ]) {
      expect(screen.getByRole('heading', { level: 3, name: heading })).toBeTruthy();
    }
    expect(
      screen.getByText(`Last backup: 18 days ago (${fmt(NOW - 18 * DAY)})`, { exact: true }),
    ).toBeTruthy();
  });

  it('names the hidden import picker and keeps it out of the tab order (§5.3, axe WCAG 4.1.2)', () => {
    render(panel());

    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    // The picker is `visually-hidden`, not display:none, so axe reads it on every Settings
    // scan: it needs an accessible name of its own. It is driven by the visible "Import…"
    // button, so it must not be a tab stop of its own.
    expect(input?.getAttribute('aria-label')).toBe('Import…');
    expect(input?.tabIndex).toBe(-1);
  });

  it('keeps "Back up now" reachable and routes export/import/delete callbacks', () => {
    const onExport = vi.fn();
    const onDeleteAll = vi.fn();
    const onImport = vi.fn();
    render(panel({ onExport, onDeleteAll, onImport }));

    fireEvent.click(screen.getByRole('button', { name: 'Back up now' }));
    expect(onExport).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Delete all data' }));
    expect(onDeleteAll).toHaveBeenCalledTimes(1);

    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    const file = new File(['{}'], 'local-first-todo-backup-2026-10-23T120000Z.json', {
      type: 'application/json',
    });
    if (input !== null) {
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      fireEvent.change(input);
    }
    expect(onImport.mock.calls[0]?.[0]).toBe(file);
  });

  it('shows the neutral never-backed-up copy when there is nothing to back up (7)', () => {
    render(panel({ dataExists: false, lastBackupAt: null }));
    expect(screen.getByText('Last backup: Never', { exact: true })).toBeTruthy();
    expect(
      screen.getByText('Nothing to back up yet — once you add tasks, save a backup here.', {
        exact: true,
      }),
    ).toBeTruthy();
  });

  it('shows the 4.3 snapshots empty state', () => {
    render(panel());
    expect(
      screen.getByText(
        "Snapshots are automatic safety copies made before big changes (like an import). You'll see up to three here.",
        { exact: true },
      ),
    ).toBeTruthy();
  });

  it('degrades to the 9.4 unavailable line when boot failed', () => {
    render(panel({ unavailable: true }));
    expect(
      screen.getByText(
        "Storage details aren't available in this browser. Backups are still your safety net.",
        { exact: true },
      ),
    ).toBeTruthy();
  });

  it('renders the invalid-file notice with the 7 "Choose another file" escape hatch', () => {
    const onChooseAnother = vi.fn();
    render(
      panel({
        importNotice: { tone: 'error', message: "This file isn't a Todo backup." },
        onChooseAnother,
      }),
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Choose another file' }));
    expect(onChooseAnother).toHaveBeenCalledTimes(1);
  });

  it('disables the export button and shows the gerund while saving (9)', () => {
    render(panel({ exportState: 'saving', state: 'export-loading' }));
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Saving backup…' });
    expect(button.disabled).toBe(true);
  });
});

describe('<SafetyDialog> (5.6 a11y contract)', () => {
  it('is an alertdialog whose initial focus is the safe action', () => {
    render(
      <SafetyDialog
        kind="import-confirm"
        file={{
          schemaVersion: 1,
          counts: { lists: 2, tasks: 5, doneTasks: 1, snapshots: 0 },
          exportedAt: NOW - DAY,
          fileSizeBytes: 2048,
        }}
        currentCounts={{ lists: 1, tasks: 3, doneTasks: 0, hasData: true }}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );

    const dialog = screen.getByRole('alertdialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(document.activeElement?.textContent).toBe('Cancel');
    expect(
      screen.getByText(
        'Importing will replace the data currently in this browser: 3 tasks in 1 lists will be removed and replaced by the backup, and your settings are replaced too — theme and language come from the backup file.',
        { exact: true },
      ),
    ).toBeTruthy();
  });

  it('states the three ADR-004 Decision 5.5 confirm facts (en)', () => {
    render(
      <SafetyDialog
        kind="import-confirm"
        file={{
          schemaVersion: 1,
          counts: { lists: 2, tasks: 5, doneTasks: 1, snapshots: 0 },
          exportedAt: NOW - DAY,
          fileSizeBytes: 2048,
        }}
        currentCounts={{ lists: 1, tasks: 3, doneTasks: 0, hasData: true }}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );

    // (a) replaces-ALL warning with counts — including the SETTINGS record the engine's
    // one-tx replace overwrites (import.ts tx spans ['lists','tasks','settings']).
    expect(screen.getByText(/and your settings are replaced too/u, { exact: true })).toBeTruthy();
    // (b) undo snapshot pointer: WHERE it lives + the binding download escape hatch.
    expect(
      screen.getByText(/It lives in Settings → Storage & back up → Snapshots/u, { exact: true }),
    ).toBeTruthy();
    expect(
      screen.getByText(/restore it in one tap or download it as a file/u, { exact: true }),
    ).toBeTruthy();
    // (c) tombstone-resurrection caveat.
    expect(
      screen.getByText(
        'Importing an older backup can bring back tasks and lists you deleted after that backup was made.',
        { exact: true },
      ),
    ).toBeTruthy();
  });

  it('states the three Decision 5.5 confirm facts in Thai too (§11 both locales)', async () => {
    await setLocale('th');
    render(
      <SafetyDialog
        kind="import-confirm"
        file={{
          schemaVersion: 1,
          counts: { lists: 2, tasks: 5, doneTasks: 1, snapshots: 0 },
          exportedAt: NOW - DAY,
          fileSizeBytes: 2048,
        }}
        currentCounts={{ lists: 1, tasks: 3, doneTasks: 0, hasData: true }}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );

    // (a) settings replacement, (b) snapshot location + download, (c) tombstone caveat.
    expect(screen.getByText(/การตั้งค่าของคุณก็ถูกแทนที่ด้วย/u, { exact: true })).toBeTruthy();
    expect(
      screen.getByText(/สแนปช็อต คุณสามารถกู้คืนได้ในแตะเดียว/u, { exact: true }),
    ).toBeTruthy();
    expect(screen.getByText(/ดาวน์โหลดเป็นไฟล์ได้ที่นั่น/u, { exact: true })).toBeTruthy();
    expect(screen.getByText(/อาจทำให้งานและรายการที่คุณลบไป/u, { exact: true })).toBeTruthy();
    await setLocale('en');
  });

  it('takes the safe path on Escape (cancel, never confirm)', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <SafetyDialog
        kind="delete-all-confirm"
        dataCounts={{ lists: 1, tasks: 4, doneTasks: 0, hasData: true }}
        onConfirm={onConfirm}
        onCancel={onCancel}
        onExport={() => undefined}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('keeps Tab inside the dialog (focus trap)', () => {
    render(
      <SafetyDialog
        kind="delete-all-confirm"
        dataCounts={{ lists: 1, tasks: 4, doneTasks: 0, hasData: true }}
        onConfirm={() => undefined}
        onCancel={() => undefined}
        onExport={() => undefined}
      />,
    );
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.querySelectorAll('button')).toHaveLength(3);

    fireEvent.keyDown(document, { key: 'Tab' });
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).not.toBeNull();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('puts focus on "Free up space" in the quota dialog and keeps three actions (6.4)', () => {
    render(
      <SafetyDialog
        kind="quota-exceeded"
        pendingCount={1}
        onFreeSpace={() => undefined}
        onExport={() => undefined}
        onRetry={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Not enough storage space' })).toBeTruthy();
    expect(document.activeElement?.textContent).toBe('Free up space');
    expect(screen.getByRole('button', { name: 'Export a backup' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(
      screen.getByText(
        "Your change couldn't be saved because this browser's storage for Todo is full. Nothing has been lost — your change is waiting and will be saved as soon as there's space.",
        { exact: true },
      ),
    ).toBeTruthy();
  });

  it('starts delete-all focus on "Export a backup first" (6.8) and carries the counts', () => {
    render(
      <SafetyDialog
        kind="delete-all-confirm"
        dataCounts={{ lists: 3, tasks: 12, doneTasks: 5, hasData: true }}
        onConfirm={() => undefined}
        onCancel={() => undefined}
        onExport={() => undefined}
      />,
    );
    expect(document.activeElement?.textContent).toBe('Export a backup first');
    expect(
      screen.getByText(
        'This permanently deletes 12 tasks, 3 lists and all settings from this browser. It cannot be undone.',
        { exact: true },
      ),
    ).toBeTruthy();
  });
});

describe('<NudgeBanner> (5.5)', () => {
  it('renders tier label, copy and actions, and snoozes on close', () => {
    const onAction = vi.fn();
    const onSnooze = vi.fn();
    render(
      <NudgeBanner
        kind="backup-reminder"
        tier={1}
        title="It's been 18 days since your last backup."
        body="A backup file is your safety net."
        actions={[
          { id: 'back-up-now', label: 'Back up now', variant: 'primary' },
          { id: 'later', label: 'Remind me later', variant: 'secondary' },
        ]}
        onAction={onAction}
        onSnooze={onSnooze}
        closeLabel="Close"
      />,
    );

    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.getByText('Worth a look', { exact: true })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back up now' }));
    expect(onAction).toHaveBeenCalledWith('back-up-now');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onSnooze).toHaveBeenCalledWith(7);
  });

  it('offers the 2 overflow control when more notices are hidden', () => {
    const onShowAll = vi.fn();
    render(
      <NudgeBanner
        kind="quota-warn"
        tier={2}
        title="Storage is filling up"
        body="…"
        actions={[]}
        onAction={() => undefined}
        onSnooze={() => undefined}
        moreCount={2}
        onShowAll={onShowAll}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '2 more notices' }));
    expect(onShowAll).toHaveBeenCalledTimes(1);
  });
});

describe('<Onboarding> (6.1 — honest copy)', () => {
  it('names the iOS Safari 7-day rule, the install path and the backup safety net', () => {
    render(<Onboarding onDone={() => undefined} />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Your data lives in this browser' }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "One important thing: on iPhones and iPads, Safari can delete a website's data after 7 days if you don't visit the site. That can include your tasks.",
        { exact: true },
      ),
    ).toBeTruthy();
    // ADR-008 / S13: install is presented AS the durable-storage option (the R1 structural
    // fix), and the backup discipline stays visible — belt and braces (§5.5).
    expect(
      screen.getByText(
        "The strongest protection is installing Todo to your home screen: on iPhones and iPads, installed apps are exempt from that 7-day cleanup. After you add your first task the app offers to install — and you can always do it from your browser's Share or Menu button.",
        { exact: true },
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Backups still matter after installing (belt and braces): every so often, tap Back up now in Settings → Storage & back up and keep that file somewhere safe. If the browser ever clears this app's data, you can restore everything from it.",
        { exact: true },
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "A backup is a single .json file containing all your tasks and lists. It's created entirely on your device and saved to your downloads. Nothing is sent anywhere. To restore, use Import in Settings → Storage & back up.",
        { exact: true },
      ),
    ).toBeTruthy();
  });

  it('finishes the first-run screen through the single CTA', () => {
    const onDone = vi.fn();
    render(<Onboarding onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: 'Get started' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('ships the same honesty in Thai (11 QA checklist)', async () => {
    await setLocale('th');
    render(<Onboarding onDone={() => undefined} />);
    expect(
      screen.getByText(
        'สิ่งสำคัญอย่างหนึ่ง: บน iPhone และ iPad ซาฟารีอาจลบข้อมูลของเว็บไซต์หลังจาก 7 วันหากคุณไม่เข้าชมเว็บไซต์ ซึ่งอาจรวมถึงงานของคุณด้วย',
        { exact: true },
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'การป้องกันที่ดีที่สุดคือการติดตั้ง Todo ลงบนหน้าจอโฮมของคุณ: บน iPhone และ iPad แอปที่ติดตั้งแล้วจะได้รับการยกเว้นจากการล้างข้อมูล 7 วันนั้น หลังจากคุณเพิ่มงานแรก แอปจะเสนอการติดตั้งให้ และคุณสามารถติดตั้งได้ตลอดเวลาจากปุ่มแชร์หรือเมนูของเบราว์เซอร์',
        { exact: true },
      ),
    ).toBeTruthy();
    await setLocale('en');
  });
});

describe('<RecoveryScreen> (6.5, 10.9)', () => {
  it('surfaces lastBackupAt and confirms "Start fresh" inline before acting', () => {
    const onRestore = vi.fn();
    const onStartFresh = vi.fn();
    render(
      <RecoveryScreen
        lastBackupAt={NOW - 5 * DAY}
        onRestore={onRestore}
        onStartFresh={onStartFresh}
        now={NOW}
      />,
    );

    expect(
      screen.getByRole('heading', { level: 1, name: "We couldn't find your tasks" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        `Your last backup was 5 days ago (${fmt(NOW - 5 * DAY)}). You can restore everything from that file.`,
        { exact: true },
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restore from a backup' })).toBeTruthy();

    expect(
      screen.queryByText(
        'Starting fresh creates a new empty task list. Anything not restored from a backup is gone.',
        { exact: true },
      ),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start fresh' }));
    expect(onStartFresh).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        'Starting fresh creates a new empty task list. Anything not restored from a backup is gone.',
        { exact: true },
      ),
    ).toBeTruthy();

    const confirms = screen.getAllByRole('button', { name: 'Start fresh' });
    fireEvent.click(confirms[confirms.length - 1] as HTMLElement);
    expect(onStartFresh).toHaveBeenCalledTimes(1);
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('says there may be nothing to restore when no backup was ever taken', () => {
    const onRestore = vi.fn();
    render(
      <RecoveryScreen
        lastBackupAt={null}
        onRestore={onRestore}
        onStartFresh={() => undefined}
        now={NOW}
      />,
    );
    expect(
      screen.getByText("You haven't backed up before, so there may be nothing to restore from.", {
        exact: true,
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restore from a backup' }));
    expect(onRestore).toHaveBeenCalledTimes(1);
  });
});

describe('dialog queue wiring', () => {
  it('resolves the promise a flow awaits when the dialog verdict is given', async () => {
    const pending = openDialog({ kind: 'quota-exceeded', pendingCount: 1 });
    expect(currentDialog()?.request.kind).toBe('quota-exceeded');
    answerDialog(true);
    await expect(pending).resolves.toBe(true);
  });
});

describe('<SafetyDialog> §5.6/§10.6 busy confirm state (N5)', () => {
  const importFile = {
    schemaVersion: 1,
    counts: { lists: 2, tasks: 5, doneTasks: 1, snapshots: 0 },
    exportedAt: NOW - DAY,
    fileSizeBytes: 2048,
  };

  it('keeps the import dialog mounted with disabled actions and an Importing… status', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <SafetyDialog
        kind="import-confirm"
        file={importFile}
        currentCounts={{ lists: 1, tasks: 3, doneTasks: 0, hasData: true }}
        busy
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    const dialog = screen.getByRole('alertdialog');
    expect(dialog.getAttribute('aria-busy')).toBe('true');
    expect(dialog.getAttribute('data-state')).toBe('busy');
    expect(screen.getByRole('status').textContent).toBe('Importing…');

    const cancel = screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel' });
    const go = screen.getByRole<HTMLButtonElement>('button', { name: 'Replace and import' });
    expect(cancel.disabled).toBe(true);
    expect(go.disabled).toBe(true);

    // Escape is inert while the write runs (§5.6: no safe path left mid-write). The
    // disabled buttons are the double-submit guard — a real browser never dispatches
    // their click, so the disabled check above is the binding assertion for those.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('shows Deleting… on the busy delete-all confirm and Restoring… on restore', () => {
    const { rerender } = render(
      <SafetyDialog
        kind="delete-all-confirm"
        dataCounts={{ lists: 1, tasks: 4, doneTasks: 0, hasData: true }}
        busy
        onConfirm={() => undefined}
        onCancel={() => undefined}
        onExport={() => undefined}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe('Deleting…');

    rerender(
      <SafetyDialog
        kind="restore-confirm"
        snapshot={{
          id: '01ARZ3NDEKTSV4RRFFQ6000030',
          takenAt: NOW - DAY,
          kind: 'auto',
          reason: 'pre-import',
          sizeBytes: 1024,
        }}
        currentCounts={{ lists: 1, tasks: 4, doneTasks: 0, hasData: true }}
        busy
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe('Restoring…');
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Restore snapshot' }).disabled,
    ).toBe(true);
  });

  it('renders the dialog interactively again when busy clears', () => {
    const onCancel = vi.fn();
    const { rerender } = render(
      <SafetyDialog
        kind="import-confirm"
        file={importFile}
        currentCounts={{ lists: 1, tasks: 3, doneTasks: 0, hasData: true }}
        busy
        onConfirm={() => undefined}
        onCancel={onCancel}
      />,
    );
    rerender(
      <SafetyDialog
        kind="import-confirm"
        file={importFile}
        currentCounts={{ lists: 1, tasks: 3, doneTasks: 0, hasData: false }}
        onConfirm={() => undefined}
        onCancel={onCancel}
      />,
    );
    expect(screen.queryByRole('status')).toBeNull();
    const cancel = screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel' });
    expect(cancel.disabled).toBe(false);
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('<SnapshotList> ADR-004 Decision 5.5 (b) download escape hatch (B2)', () => {
  const base = {
    id: '01ARZ3NDEKTSV4RRFFQ6000030',
    kind: 'auto' as const,
    sizeBytes: 2048,
  };
  const preImport: SnapshotMeta = {
    ...base,
    takenAt: NOW - 60_000,
    reason: 'pre-import',
  };
  const scheduled: SnapshotMeta = { ...base, takenAt: NOW - 120_000, reason: 'scheduled' };

  it('offers Download on pre-import rows only, and Restore keeps the upload icon', () => {
    const onDownload = vi.fn();
    const onRestore = vi.fn();
    render(
      <SnapshotList
        snapshots={[preImport, scheduled]}
        now={NOW}
        onRestore={onRestore}
        onDownload={onDownload}
      />,
    );

    const download = screen.getByTestId('download-snapshot');
    fireEvent.click(download);
    expect(onDownload).toHaveBeenCalledWith(preImport);

    // Exactly one Download button: the scheduled row has no undo to preserve.
    expect(screen.getAllByTestId('download-snapshot')).toHaveLength(1);

    const restore = screen.getAllByRole('button', { name: 'Restore' });
    expect(restore).toHaveLength(2);
    fireEvent.click(restore[0] as HTMLElement);
    expect(onRestore).toHaveBeenCalledWith(preImport.id);
    // N6: the Restore button carries the upload icon, never the download one.
    expect(restore[0]?.querySelector('use')?.getAttribute('href')).toBe('#i-upload');
  });

  it('promises "kept for 7 days" only while the §8.4 protection actually holds', () => {
    const first = render(
      <SnapshotList
        snapshots={[preImport]}
        now={NOW}
        onRestore={() => undefined}
        onDownload={() => undefined}
      />,
    );
    expect(screen.getByText('kept for 7 days', { exact: true })).toBeTruthy();
    first.unmount();

    // Past the 7-day window the note must stop promising protection (retention reality).
    render(
      <SnapshotList
        snapshots={[{ ...preImport, takenAt: NOW - PRE_IMPORT_PROTECTION_MS }]}
        now={NOW}
        onRestore={() => undefined}
        onDownload={() => undefined}
      />,
    );
    expect(screen.queryByText('kept for 7 days', { exact: true })).toBeNull();
  });
});

describe('<UndoToast> undo + download escape hatch (B2)', () => {
  it('renders the secondary download action alongside Restore', () => {
    const onAction = vi.fn();
    const onSecondary = vi.fn();
    render(
      <UndoToast
        message="Import complete. Your previous data is saved as a snapshot."
        actionLabel="Restore previous data"
        onAction={onAction}
        secondaryLabel="Download snapshot"
        onSecondary={onSecondary}
        onDismiss={() => undefined}
        variant="success"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Download snapshot' }));
    expect(onSecondary).toHaveBeenCalledTimes(1);
    expect(onAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Restore previous data' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});

describe('<QuotaMeter> §11 no inline English (N1)', () => {
  const labels = {
    ok: 'Plenty of room',
    warn: 'Worth a look',
    crit: 'Action needed',
    unknown: 'Unknown',
  };

  it('localizes the value line from the catalog by default', () => {
    render(
      <QuotaMeter usedBytes={43_000_000} totalBytes={2 * 1024 * 1024 * 1024} labels={labels} />,
    );
    expect(screen.getByText('41 MB of ≈2 GB (2%)', { exact: true })).toBeTruthy();
  });

  it('renders the Thai value line after a locale switch', async () => {
    await setLocale('th');
    render(
      <QuotaMeter usedBytes={43_000_000} totalBytes={2 * 1024 * 1024 * 1024} labels={labels} />,
    );
    expect(screen.getByText('41 MB จาก ≈2 GB (2%)', { exact: true })).toBeTruthy();
    await setLocale('en');
  });
});

describe('<RecoveryScreen> N3 singular last-backup line', () => {
  it('says "1 day ago" (never "1 days ago") and "today" for a same-day backup', () => {
    const { rerender } = render(
      <RecoveryScreen
        lastBackupAt={NOW - 1 * DAY}
        onRestore={() => undefined}
        onStartFresh={() => undefined}
        now={NOW}
      />,
    );
    expect(
      screen.getByText(
        `Your last backup was 1 day ago (${fmt(NOW - 1 * DAY)}). You can restore everything from that file.`,
        { exact: true },
      ),
    ).toBeTruthy();

    rerender(
      <RecoveryScreen
        lastBackupAt={NOW}
        onRestore={() => undefined}
        onStartFresh={() => undefined}
        now={NOW}
      />,
    );
    expect(
      screen.getByText(
        `Your last backup was today (${fmt(NOW)}). You can restore everything from that file.`,
        { exact: true },
      ),
    ).toBeTruthy();
  });
});

describe('<NudgeBanner> N6 link action variant', () => {
  it('styles a link action as button-link, not button-secondary', () => {
    render(
      <NudgeBanner
        kind="quota-warn"
        tier={2}
        title="Storage is filling up"
        body="…"
        actions={[{ id: 'learn', label: 'How backups work', variant: 'link' }]}
        onAction={() => undefined}
        onSnooze={() => undefined}
        closeLabel="Close"
      />,
    );
    const link = screen.getByRole('button', { name: 'How backups work' });
    expect(link.getAttribute('class')).toContain('button-link');
    expect(link.getAttribute('class')).not.toContain('button-secondary');
  });
});
