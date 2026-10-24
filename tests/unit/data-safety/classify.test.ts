import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  classifyBoot,
  hasPriorDataEvidence,
  type ClassifyInput,
} from '../../../src/features/data-safety/boot';
import {
  dismissForever,
  hasPriorData,
  isSuppressed,
  markPriorData,
  markPrivateWarned,
  markRecoveryStarted,
  readDismissed,
  readOnboardingStep,
  resetFlags,
  restore,
  snooze,
  wasPrivateWarned,
  writeOnboardingDone,
} from '../../../src/features/data-safety/flags';
import {
  backupAgeDays,
  daysBetween,
  formatBytes,
  formatTotal,
  percentOf,
  relativeAge,
} from '../../../src/features/data-safety/format';
import type { DataCounts } from '../../../src/features/data-safety/types';

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const DAY = 86_400_000;

function counts(tasks: number, lists = 1): DataCounts {
  return { tasks, lists, doneTasks: 0, hasData: tasks + lists > 0 };
}

function base(overrides: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    priorUse: true,
    // Mirrors `hasData: true` below: a store that holds rows is its own evidence of prior data.
    priorData: true,
    hasData: true,
    lastBackupAt: NOW - 3 * DAY,
    absentDays: 0,
    shrink: null,
    storeCreatedAt: NOW - 30 * DAY,
    recoveryAckAt: null,
    ...overrides,
  };
}

describe('boot classification (§3.4 table)', () => {
  it('row 1: an empty store WITH evidence it once held rows is wiped (and surfaces lastBackupAt)', () => {
    expect(
      classifyBoot(base({ hasData: false, priorData: true, lastBackupAt: NOW - 20 * DAY })),
    ).toEqual({
      kind: 'wiped',
      lastBackupAt: NOW - 20 * DAY,
    });
  });

  it('row 4: a fresh profile with no memory of prior use is NOT a wipe — that row is onboarding', () => {
    expect(
      classifyBoot(base({ priorUse: false, priorData: false, hasData: false, lastBackupAt: null })),
    ).toEqual({
      kind: 'normal',
    });
  });

  it('AC: a booted profile with settings but zero tasks is NOT a wipe (empty ≠ erased)', () => {
    // Exactly what `run()` derives for a profile that booted, wrote settings and never held a
    // task: no live rows, no backup, no durable "held rows" mark, no snapshot to compare.
    const evidence = hasPriorDataEvidence({
      hasData: false,
      lastBackupAt: null,
      markedPriorData: false,
      snapshotCounts: null,
    });
    expect(evidence).toBe(false);

    expect(
      classifyBoot(
        base({ priorUse: true, priorData: evidence, hasData: false, lastBackupAt: null }),
      ),
    ).toEqual({ kind: 'normal' });
  });

  it('AC: a genuinely wiped profile (durable evidence of rows, store now empty) is wiped', () => {
    const evidence = hasPriorDataEvidence({
      hasData: false,
      lastBackupAt: null,
      markedPriorData: true,
      snapshotCounts: null,
    });
    expect(evidence).toBe(true);

    expect(classifyBoot(base({ priorData: evidence, hasData: false, lastBackupAt: null }))).toEqual(
      { kind: 'wiped', lastBackupAt: null },
    );
  });

  it('suppresses the wipe once the same store instance was acknowledged', () => {
    expect(
      classifyBoot(
        base({
          hasData: false,
          storeCreatedAt: NOW - 30 * DAY,
          recoveryAckAt: NOW - 1 * DAY,
        }),
      ),
    ).toEqual({ kind: 'normal' });
  });

  it('shows the wipe again when the store was re-created AFTER the acknowledgement', () => {
    expect(
      classifyBoot(
        base({
          hasData: false,
          storeCreatedAt: NOW,
          recoveryAckAt: NOW - 10 * DAY,
        }),
      ),
    ).toMatchObject({ kind: 'wiped' });
  });

  it('classifies a >= 7 day gap as long absence (with the lastBackupAt to surface)', () => {
    expect(classifyBoot(base({ absentDays: 7 }))).toEqual({
      kind: 'long-absence',
      absentDays: 7,
      lastBackupAt: NOW - 3 * DAY,
    });
    expect(classifyBoot(base({ absentDays: 6 }))).toEqual({ kind: 'normal' });
  });

  it('classifies a > 30% record drop against the snapshot baseline as shrunken', () => {
    const current = counts(30, 0);
    const baseline = counts(100, 0);
    const result = classifyBoot(base({ shrink: { current, baseline } }));
    expect(result.kind).toBe('shrunken');
    if (result.kind === 'shrunken') expect(result.dropped).toBeCloseTo(0.7, 5);
  });

  it('ignores a shrink below the 30% threshold (legitimate deletes are not a warning)', () => {
    expect(classifyBoot(base({ shrink: { current: counts(75), baseline: counts(100) } }))).toEqual({
      kind: 'normal',
    });
  });

  it('prefers long absence over shrunken (§2 priority order)', () => {
    expect(
      classifyBoot(base({ absentDays: 9, shrink: { current: counts(10), baseline: counts(100) } })),
    ).toMatchObject({ kind: 'long-absence' });
  });
});

describe('prior-data evidence (the §3.4 "store empty" discriminator)', () => {
  it('is true while the store still holds rows, and once the durable mark is written', () => {
    expect(
      hasPriorDataEvidence({
        hasData: true,
        lastBackupAt: null,
        markedPriorData: false,
        snapshotCounts: null,
      }),
    ).toBe(true);
    expect(
      hasPriorDataEvidence({
        hasData: false,
        lastBackupAt: null,
        markedPriorData: true,
        snapshotCounts: null,
      }),
    ).toBe(true);
  });

  it('treats a recorded backup as proof this profile once held rows', () => {
    expect(
      hasPriorDataEvidence({
        hasData: false,
        lastBackupAt: NOW,
        markedPriorData: false,
        snapshotCounts: null,
      }),
    ).toBe(true);
  });

  it('treats rows inside the newest snapshot as proof (the IDB-side testimony)', () => {
    expect(
      hasPriorDataEvidence({
        hasData: false,
        lastBackupAt: null,
        markedPriorData: false,
        snapshotCounts: counts(4, 1),
      }),
    ).toBe(true);
    // An empty snapshot proves nothing — that is exactly the "empty ≠ erased" line.
    expect(
      hasPriorDataEvidence({
        hasData: false,
        lastBackupAt: null,
        markedPriorData: false,
        snapshotCounts: counts(0, 0),
      }),
    ).toBe(false);
    expect(
      hasPriorDataEvidence({
        hasData: false,
        lastBackupAt: null,
        markedPriorData: false,
        snapshotCounts: null,
      }),
    ).toBe(false);
  });
});

describe('durable flags (ADR-002 Decision 7 keys only)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetFlags();
  });

  afterEach(() => {
    window.localStorage.clear();
    resetFlags();
  });

  it('stores the onboarding step in the allowed key', () => {
    expect(readOnboardingStep()).toBeNull();
    writeOnboardingDone();
    expect(readOnboardingStep()).toBe('done');
    expect(window.localStorage.getItem('todo:prefs:v1:onboardingStep')).toBe('done');
  });

  it('snoozes a banner for N days and expires it afterwards', () => {
    snooze('backup-reminder', 7, NOW);
    expect(isSuppressed('backup-reminder', NOW + 6 * DAY)).toBe(true);
    expect(isSuppressed('backup-reminder', NOW + 8 * DAY)).toBe(false);
    // Only the allowed key is touched.
    expect(Object.keys(window.localStorage)).toEqual(['todo:prefs:v1:dismissedBanners']);
  });

  it('dismisses permanently and re-arms through restore()', () => {
    dismissForever('quota-warn');
    expect(isSuppressed('quota-warn', NOW + 365 * DAY)).toBe(true);
    restore('quota-warn');
    expect(isSuppressed('quota-warn', NOW)).toBe(false);
  });

  it('replaces a previous snooze instead of accumulating entries (4 KiB budget)', () => {
    snooze('shrunken', 7, NOW);
    snooze('shrunken', 1, NOW);
    expect(readDismissed().filter((entry) => entry.startsWith('shrunken'))).toHaveLength(1);
  });

  it('records the one-shot acknowledgements the surfaces depend on', () => {
    expect(wasPrivateWarned()).toBe(false);
    markPrivateWarned();
    expect(wasPrivateWarned()).toBe(true);

    markRecoveryStarted(NOW);
    expect(window.localStorage.getItem('todo:prefs:v1:dismissedBanners')).toContain(
      `recovery-started@${String(NOW)}`,
    );
  });

  it('remembers that this profile held rows — in the allowed key, across a reload', () => {
    expect(hasPriorData()).toBe(false);
    markPriorData();
    expect(hasPriorData()).toBe(true);
    // The allowed key only: ADR-002 Decision 7's list stays closed.
    expect(Object.keys(window.localStorage)).toEqual(['todo:prefs:v1:dismissedBanners']);
    expect(window.localStorage.getItem('todo:prefs:v1:dismissedBanners')).toContain('had-data');

    // A reload re-reads localStorage — the mark is the classifier's memory of past data.
    resetFlags();
    expect(hasPriorData()).toBe(true);
  });

  it('keeps the prior-data mark when a later snooze prunes expired entries', () => {
    markPriorData();
    snooze('backup-reminder', 7, NOW); // setEntry drops every expired `id@<epoch>` entry…
    dismissForever('quota-warn'); // …and this one too — neither may take the evidence with it
    expect(hasPriorData()).toBe(true);
    expect(readDismissed()).toContain('had-data');
  });

  it('survives a corrupt flags payload without throwing', () => {
    window.localStorage.setItem('todo:prefs:v1:dismissedBanners', '{not json');
    resetFlags();
    expect(readDismissed()).toEqual([]);
    expect(isSuppressed('backup-reminder', NOW)).toBe(false);
  });
});

describe('display formatting (§4.3 value line, §10.4 age labels)', () => {
  beforeEach(async () => {
    window.localStorage.clear();
  });

  it('rounds bytes to MB below 1 GB and friendly GB above', () => {
    expect(formatBytes(0)).toBe('0 MB');
    expect(formatBytes(43_100_000)).toBe('41 MB');
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2 GB');
    expect(formatTotal(2.15 * 1024 * 1024 * 1024)).toBe('≈2.2 GB');
  });

  it('returns null percent when the browser reports no total (unknown tier)', () => {
    expect(percentOf(100, null)).toBeNull();
    expect(percentOf(100, 0)).toBeNull();
    expect(percentOf(50, 100)).toBe(50);
  });

  it('treats a missing lastBackupAt as null age (never) and counts whole days', () => {
    expect(backupAgeDays(null, NOW)).toBeNull();
    expect(backupAgeDays(NOW - 14 * DAY, NOW)).toBe(14);
    expect(daysBetween(NOW - 1, NOW)).toBe(0);
  });

  it('renders the §10.4 relative label family', () => {
    expect(relativeAge(null, NOW)).toBe('Never');
    expect(relativeAge(NOW - 3 * 3600_000, NOW)).toBe('Today');
    expect(relativeAge(NOW - 20 * 3600_000, NOW)).toBe('Yesterday');
    expect(relativeAge(NOW - 5 * DAY, NOW)).toBe('5 days ago');
    expect(relativeAge(NOW - 90 * DAY, NOW)).toBe('3 months ago');
  });
});
