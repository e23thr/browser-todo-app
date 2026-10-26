/**
 * E9 QA probes — S11 storage dashboard VALUES under mocked storage states, the
 * §9.4 "no dead UI" import routing from the panel side, and a hostile-title render
 * check (imported markup must stay text). Written independently by the QA gate
 * (h_reviewer, card t_adbd2e36) at 9ee9669.
 *
 * Covered here (per the card's acceptance criteria):
 *   - quota meter: known percent, unknown/browser-silent, and near-full tiers;
 *   - persistence status: all four states, with no dead control anywhere;
 *   - last-backup line: never / with age / no data yet;
 *   - snapshot list: rows, Restore wiring, pre-import Download escape hatch, empty state;
 *   - feature detection: without FSA globals the Import button drives the hidden input;
 *   - XSS: a title imported from a hostile CSV renders as literal text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fireEvent, render, screen } from '@testing-library/preact';

import { StoragePanel } from '../../src/features/data-safety/StoragePanel';
import type { SnapshotMeta } from '../../src/features/data-safety/types';
import { resetFlags } from '../../src/features/data-safety/flags';
import { setLocale } from '../../src/i18n';
import { TaskScreen } from '../../src/features/tasks/TaskScreen';
import { makeList, makeTask, seed, setUpCoreUi, tearDownCoreUi } from './core-ui-harness';

type Globals = { showOpenFilePicker?: unknown };
const g = globalThis as Globals;

let inputClicks = 0;
let originalInputClick: unknown;

beforeEach(async () => {
  window.localStorage.clear();
  resetFlags();
  await setLocale('en');
  inputClicks = 0;
  originalInputClick = Reflect.get(HTMLInputElement.prototype, 'click');
  Reflect.set(HTMLInputElement.prototype, 'click', function click() {
    inputClicks += 1;
  });
});

afterEach(() => {
  Reflect.set(HTMLInputElement.prototype, 'click', originalInputClick);
  delete g.showOpenFilePicker;
  vi.restoreAllMocks();
});

type PanelProps = Partial<Parameters<typeof StoragePanel>[0]>;

const NOW = 1_792_900_000_000; // fixed clock for age math

function renderPanel(overrides: PanelProps = {}) {
  return render(
    <StoragePanel
      quota={{ usedBytes: 25_000_000, totalBytes: 100_000_000 }}
      persistence="granted"
      lastBackupAt={null}
      snapshots={[]}
      now={NOW}
      onRequestPersist={() => undefined}
      onExport={() => undefined}
      onImport={() => undefined}
      onRestoreSnapshot={() => undefined}
      onDownloadSnapshot={() => undefined}
      onDeleteAll={() => undefined}
      {...overrides}
    />,
  );
}

describe('Q11 — quota values under mocked storage states', () => {
  it('renders the used/total/percent value line and the meter value now', () => {
    renderPanel({ quota: { usedBytes: 25_000_000, totalBytes: 100_000_000 } });
    const meter = screen.getByRole('meter');
    expect(meter.getAttribute('aria-valuenow')).toBe('25');
    expect(meter.getAttribute('aria-valuetext')).toMatch(/\(25%\)/u);
    expect(screen.getByText(/\(25%\)/u, { exact: true })).toBeTruthy();
    expect(document.querySelector('.quota-meter')?.getAttribute('data-tier')).toBe('ok');
  });

  it('browser-silent quota (totalBytes null) shows the unknown copy, never "0% full"', () => {
    renderPanel({ quota: { usedBytes: 1, totalBytes: null } });
    expect(
      screen.getByText("Your browser doesn't report storage use here.", { exact: true }),
    ).toBeTruthy();
    expect(document.querySelector('.quota-meter')?.getAttribute('data-tier')).toBe('loading');
    expect(screen.getByRole('meter').getAttribute('aria-valuetext')).toBe(
      "Your browser doesn't report storage use here.",
    );
  });

  it('a near-full quota crosses into the crit tier with its own words (not colour alone)', () => {
    renderPanel({ quota: { usedBytes: 95_000_000, totalBytes: 100_000_000 } });
    expect(document.querySelector('.quota-meter')?.getAttribute('data-tier')).toBe('crit');
    expect(
      screen.getByText('Action needed — storage is almost full', { exact: true }),
    ).toBeTruthy();
  });

  it('the storage-unavailable state replaces the meter with the degrade copy (§9.4)', () => {
    renderPanel({ unavailable: true });
    expect(
      screen.getByText(
        "Storage details aren't available in this browser. Backups are still your safety net.",
        { exact: true },
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('meter')).toBeNull();
  });
});

describe('Q12 — persistence status: four states, zero dead controls', () => {
  it('granted — read-only row, no button', () => {
    renderPanel({ persistence: 'granted' });
    expect(
      screen.getByText('Protected — this browser is keeping app data', { exact: true }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ask again' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Request protection' })).toBeNull();
  });

  it('denied — "Ask again" offered', () => {
    renderPanel({ persistence: 'denied' });
    expect(
      screen.getByText('Not protected — this browser may clear app data', { exact: true }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ask again' })).toBeTruthy();
  });

  it('not-requested — "Request protection" offered', () => {
    renderPanel({ persistence: 'not-requested' });
    expect(screen.getByText('Not protected yet', { exact: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Request protection' })).toBeTruthy();
  });

  it('unsupported — degrade copy and NO control (§9.4 no dead UI)', () => {
    renderPanel({ persistence: 'unsupported' });
    expect(
      screen.getByText("This browser doesn't offer extra protection", { exact: true }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ask again' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Request protection' })).toBeNull();
  });
});

describe('Q13 — last-backup line and the backup actions', () => {
  it('never backed up (data present) says "Last backup: Never" and keeps the danger marker', () => {
    renderPanel({ lastBackupAt: null, dataExists: true });
    const age = document.querySelector('.backup-age');
    expect(age?.textContent).toBe('Last backup: Never');
    expect(age?.getAttribute('data-danger')).toBe('true');
    expect(screen.getByRole('button', { name: 'Back up now' })).toBeTruthy();
  });

  it('no data yet uses the neutral empty copy instead of danger styling', () => {
    renderPanel({ lastBackupAt: null, dataExists: false });
    expect(
      screen.getByText('Nothing to back up yet — once you add tasks, save a backup here.', {
        exact: true,
      }),
    ).toBeTruthy();
    expect(document.querySelector('.backup-age')?.getAttribute('data-danger')).toBeNull();
  });

  it('a real timestamp renders relative + absolute age', () => {
    const threeDays = 3 * 24 * 60 * 60 * 1000;
    renderPanel({ lastBackupAt: NOW - threeDays, dataExists: true });
    const age = document.querySelector('.backup-age')?.textContent ?? '';
    expect(age).toMatch(/^Last backup: /u);
    expect(age).not.toContain('Never');
    expect(age).toMatch(/\([A-Z][a-z]{2} \d{1,2}, \d{4}\)/u); // absolute date in parens
  });
});

describe('Q14 — snapshot list: rows, restore wiring, download escape hatch', () => {
  const rows: SnapshotMeta[] = [
    {
      id: 'snap-preimport',
      takenAt: NOW - 60_000,
      kind: 'auto',
      reason: 'pre-import',
      sizeBytes: 4096,
    },
    {
      id: 'snap-manual',
      takenAt: NOW - 3_600_000,
      kind: 'manual',
      reason: 'manual',
      sizeBytes: 2048,
    },
  ];

  it('renders both rows with kind labels and wires Restore to its own id', () => {
    const onRestore = vi.fn();
    renderPanel({ snapshots: rows, onRestoreSnapshot: onRestore });
    expect(screen.getAllByRole('button', { name: 'Restore' })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Restore' })[0] as HTMLElement);
    expect(onRestore).toHaveBeenCalledWith('snap-preimport');
  });

  it('the pre-import row carries the Download escape hatch (ADR-004 5.5b); manual rows do not', () => {
    const onDownload = vi.fn();
    renderPanel({ snapshots: rows, onDownloadSnapshot: onDownload });
    const downloads = screen.getAllByRole('button', { name: 'Download snapshot' });
    expect(downloads).toHaveLength(1);
    fireEvent.click(downloads[0] as HTMLElement);
    expect(onDownload).toHaveBeenCalledWith(expect.objectContaining({ id: 'snap-preimport' }));
  });

  it('the retention note shows for a fresh pre-import snapshot', () => {
    renderPanel({ snapshots: [rows[0] as SnapshotMeta] });
    expect(screen.getByText('kept for 7 days', { exact: true })).toBeTruthy();
  });

  it('an empty snapshot list explains what snapshots ARE (never a blank card)', () => {
    renderPanel({ snapshots: [] });
    expect(
      screen.getByText(/Snapshots are automatic safety copies/u, { exact: true }),
    ).toBeTruthy();
  });
});

describe('Q15 — §9.4 feature detection from the panel (no dead UI)', () => {
  it('without showOpenFilePicker (Safari/Firefox) Import drives the hidden file input', () => {
    delete g.showOpenFilePicker;
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Import…' }));
    expect(inputClicks).toBe(1);
  });

  it('the hidden input accepts every import format (json + txt/todo + csv)', () => {
    renderPanel();
    const input = document.querySelector('[data-testid="import-file-input"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.getAttribute('accept')).toContain('.json');
    expect(input.getAttribute('accept')).toContain('.txt');
    expect(input.getAttribute('accept')).toContain('.todo');
    expect(input.getAttribute('accept')).toContain('.csv');
  });

  it('with an FSA open picker the system dialog runs instead of the input', async () => {
    const api = vi.fn(async () => [{ getFile: async () => new File(['x'], 'a.txt') }]);
    g.showOpenFilePicker = api;
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Import…' }));
    await vi.waitFor(() => {
      expect(api).toHaveBeenCalledTimes(1);
    });
    expect(inputClicks).toBe(0);
  });
});

/* ------------------------- hostile titles render ------------------------- */

describe('Q16 — imported markup stays TEXT in the list (XSS)', () => {
  beforeEach(() => {
    setUpCoreUi();
  });
  afterEach(() => {
    tearDownCoreUi();
  });

  it('a <script>/<img onerror> title renders literally — no element, no execution', async () => {
    const list = makeList({ id: 'L1', name: 'Personal' });
    const hostile = '<script>window.__pwned=1</script>';
    const img = '<img src=x onerror="window.__pwned=1">';
    await seed({
      lists: [list],
      tasks: [
        makeTask({ id: 'T1', listId: 'L1', title: hostile }),
        makeTask({ id: 'T2', listId: 'L1', title: img }),
      ],
    });
    render(
      <TaskScreen
        view={{ kind: 'list', listId: 'L1' }}
        title="Personal"
        emptyIcon="folder"
        emptyTitle="Empty"
        emptyBody="Nothing"
      />,
    );
    // Literal text present…
    expect(document.body.textContent).toContain(hostile);
    expect(document.body.textContent).toContain(img);
    // …but no live element and no side effect.
    expect(document.querySelector('script:not([src])')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect((globalThis as unknown as Record<string, unknown>)['__pwned']).toBeUndefined();
  });
});

/* ------------------- S6 coupling (resolved) + pre-S6 10k baseline ------------------- */

describe('Q17 — CSV "archived" rows now surface in the S6 archived group', () => {
  beforeEach(() => {
    setUpCoreUi();
  });
  afterEach(() => {
    tearDownCoreUi();
  });

  /**
   * S6 LANDED (finding E9-Q3 resolved): the CSV importer maps status
   * "archived" onto the model's 'archived' status, and the completed view's
   * retention partition now consumes it — an archived row appears in the
   * Archived group while staying invisible in the open/list views.
   */
  it('an archived task imported from CSV shows in the completed view (archived group) and stays out of the open views', async () => {
    const list = makeList({ id: 'L1', name: 'Personal' });
    await seed({
      lists: [list],
      tasks: [
        makeTask({ id: 'T1', listId: 'L1', title: 'open task', status: 'open' }),
        makeTask({ id: 'T2', listId: 'L1', title: 'done task', status: 'done' }),
        makeTask({ id: 'T3', listId: 'L1', title: 'archived task', status: 'archived' }),
      ],
    });

    render(
      <TaskScreen
        view={{ kind: 'list', listId: 'L1' }}
        title="Personal"
        emptyIcon="folder"
        emptyTitle="Empty"
        emptyBody="Nothing"
      />,
    );
    expect(document.body.textContent).toContain('open task');
    expect(document.body.textContent).not.toContain('archived task');

    // Completed view: done rows AND the archived group (S6 retention partition).
    render(
      <TaskScreen
        view={{ kind: 'completed' }}
        title="Completed"
        emptyIcon="check"
        emptyTitle="Empty"
        emptyBody="Nothing"
      />,
    );
    expect(document.body.textContent).toContain('done task');
    expect(document.body.textContent).toContain('archived task');
    expect(document.body.textContent).toContain('Archived (1)');
  });
});

describe('Q18 — 10k completed-task baseline (pre-S6; the S6 retention numbers live in tests/component/retention-perf-10k.test.tsx)', () => {
  beforeEach(() => {
    setUpCoreUi();
  });
  afterEach(() => {
    tearDownCoreUi();
  });

  /**
   * The card's AC asks for retention-view numbers at 10k completed tasks; S6 is
   * deferred, so the retention PARTITION does not exist yet. This records the best
   * available baseline for the S6 resumption card: rendering the existing completed
   * view with 10 000 done tasks — time to first paint and the DOM row cap
   * (§9.1 "virtualize beyond ~200 rows").
   */
  it('renders the existing completed view with 10 000 done tasks (baseline numbers)', async () => {
    const list = makeList({ id: 'L1', name: 'Archive' });
    const base = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const tasks = Array.from({ length: 10_000 }, (_u, i) =>
      makeTask({
        id: `T${String(i).padStart(5, '0')}`,
        listId: 'L1',
        title: `Done ${String(i)}`,
        status: 'done',
        completedAt: base + i,
        sortOrder: `k${String(i).padStart(6, '0')}`,
      }),
    );
    const seedStart = performance.now();
    await seed({ lists: [list], tasks });
    const seedMs = performance.now() - seedStart;

    const renderStart = performance.now();
    render(
      <TaskScreen
        view={{ kind: 'completed' }}
        title="Completed"
        emptyIcon="check"
        emptyTitle="Empty"
        emptyBody="Nothing"
      />,
    );
    const renderMs = performance.now() - renderStart;
    const domRows = document.querySelectorAll('ul.task-list [data-task-id]').length;

    // eslint-disable-next-line no-console -- QA evidence: numbers go to the run log
    console.log(
      `[E9-QA baseline] completed view @10k done: seed ${seedMs.toFixed(1)}ms, ` +
        `render ${renderMs.toFixed(1)}ms, DOM rows ${String(domRows)} of 10000`,
    );
    expect(domRows).toBeGreaterThan(0);
    expect(domRows).toBeLessThan(200); // §9.1 virtualization floor
    expect(renderMs).toBeLessThan(2_000); // generous jsdom ceiling; real numbers logged
  });
});
