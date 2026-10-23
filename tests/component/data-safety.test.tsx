import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fireEvent, render, screen } from '@testing-library/preact';

import { Onboarding } from '../../src/features/data-safety/Onboarding';
import { RecoveryScreen } from '../../src/features/data-safety/RecoveryScreen';
import { NudgeBanner } from '../../src/features/data-safety/NudgeBanner';
import { QuotaMeter } from '../../src/features/data-safety/QuotaMeter';
import { PersistenceRow } from '../../src/features/data-safety/PersistenceRow';
import { SafetyDialog } from '../../src/features/data-safety/SafetyDialog';
import { StoragePanel } from '../../src/features/data-safety/StoragePanel';
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
        'Importing will replace the data currently in this browser: 3 tasks in 1 lists will be removed and replaced by the backup.',
        { exact: true },
      ),
    ).toBeTruthy();
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
  it('names the iOS Safari 7-day rule and the backup protection path', () => {
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
    expect(
      screen.getByText(
        "Your protection is backups. Every so often, tap Back up now in Settings → Storage & back up to save a backup file, and keep that file somewhere safe. If the browser ever clears this app's data, you can restore everything from that file.",
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
