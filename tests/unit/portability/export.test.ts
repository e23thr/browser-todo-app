/**
 * Export + wipe (ADR-004 Decisions 9–10): full backup incl. tombstones, the
 * stability property, the pinned "Delete all data" factory-reset semantics, and
 * the best-effort `settings.lastBackupAt` write (drills 1–2, 12).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppDBImpl } from '../../../src/storage/db';
import { clearPrefs, deleteAllData, exportBackup } from '../../../src/portability/export';
import { downloadTextFile } from '../../../src/portability/download';
import { parseBackupDocument } from '../../../src/portability/backup-document';
import { bindDataSafetyDb } from '../../../src/portability/context';
import { PREFS_PREFIX } from '../../../src/portability/constants';
import { broadcastDataReplaced, mirrorTheme } from '../../../src/portability/side-effects';
import {
  injectQuotaOnPuts,
  makeMeta,
  makeSettings,
  makeSnapshot,
  openFixtureDb,
  uniqueDbName,
} from '../storage/fixtures';
import { canonicalText, fixtureId, seedCorpus, T0 } from './helpers';

const opened: AppDBImpl[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  bindDataSafetyDb(null);
  vi.restoreAllMocks();
});

beforeEach(() => {
  window.localStorage.clear();
});

async function openSeeded(): Promise<AppDBImpl> {
  const db = await openFixtureDb(uniqueDbName('exp'));
  opened.push(db);
  const corpus = seedCorpus();
  for (const row of corpus.lists) await db.put('lists', row);
  for (const row of corpus.tasks) await db.put('tasks', row);
  await db.put('settings', corpus.settings);
  await db.put('snapshots', corpus.snapshots[0] ?? makeSnapshot(fixtureId(30)));
  return db;
}

describe('exportBackup (Decision 9)', () => {
  it('produces a complete, human-readable backup document (tombstones + snapshot metadata)', async () => {
    const db = await openSeeded();
    const exported = await exportBackup({ db, now: () => T0, download: false });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const report = exported.value;
    expect(report.fileName).toBe('local-first-todo-backup-2023-11-14T221320Z.json');
    expect(report.counts).toEqual({ lists: 2, tasks: 3, snapshots: 1 });
    expect(report.document.endsWith('\n')).toBe(true);
    expect(report.warnings).toEqual([]);

    const parsed = parseBackupDocument(report.document, { targetSchemaVersion: 1 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.kind).toBe('export');
    expect(parsed.value.warnings).toEqual([]); // we produce the app/counts blocks
    // Tombstones are included: "complete" means complete (§2.3).
    expect(
      parsed.value.tasks.filter((t) => (t as { deletedAt?: unknown }).deletedAt !== null),
    ).toHaveLength(1);

    // The DB's own lastBackupAt was stamped (self-consistent document).
    const settings = await db.get('settings', 'settings');
    expect(settings.ok && settings.value?.lastBackupAt).toBe(T0);
  });

  it('is stable: exporting twice with no change differs only in exportedAt/lastBackupAt (drill 2)', async () => {
    const db = await openSeeded();
    const first = await exportBackup({ db, now: () => T0, download: false });
    const second = await exportBackup({ db, now: () => T0 + 60_000, download: false });
    if (!first.ok || !second.ok) throw new Error('export failed');
    const a = first.value.document;
    const b = second.value.document;
    expect(a).not.toBe(b);
    const strippedA = a.replaceAll(String(T0), 'T').replaceAll(String(T0 + 60_000), 'T');
    const strippedB = b.replaceAll(String(T0), 'T').replaceAll(String(T0 + 60_000), 'T');
    expect(strippedA).toBe(strippedB);
  });

  it('still exports when the lastBackupAt write fails — best-effort, never a lost download (drill 12)', async () => {
    const db = await openSeeded();
    const restore = injectQuotaOnPuts();
    try {
      const exported = await exportBackup({ db, now: () => T0, download: false });
      expect(exported.ok).toBe(true);
      if (exported.ok) {
        expect(exported.value.warnings.join(' ')).toContain('lastBackupAt not written');
        expect(exported.value.document.length).toBeGreaterThan(100);
      }
    } finally {
      restore();
    }
  });

  it('works through the bound database too (no explicit { db })', async () => {
    const db = await openSeeded();
    bindDataSafetyDb(db);
    const exported = await exportBackup({ now: () => T0, download: false });
    expect(exported.ok).toBe(true);
    // ...and refuses cleanly when nothing is bound.
    bindDataSafetyDb(null);
    const unbound = await exportBackup({ download: false });
    expect(unbound).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
  });
});

describe('deleteAllData — the pinned factory reset (Decision 10)', () => {
  it('hard-deletes data + snapshots + payloads, resets settings, keeps meta, clears prefs', async () => {
    const db = await openFixtureDb(uniqueDbName('wipe'), makeMeta({ lastPurgeAt: T0 - 9 }));
    opened.push(db);
    const corpus = seedCorpus();
    for (const row of corpus.lists) await db.put('lists', row);
    for (const row of corpus.tasks) await db.put('tasks', row);
    await db.put('settings', makeSettings({ theme: 'dark', lastBackupAt: T0 }));
    await db.put('snapshots', makeSnapshot(fixtureId(30)));
    await db.put('snapshot_payloads', { id: fixtureId(30), payload: '{}' });

    window.localStorage.setItem(`${PREFS_PREFIX}theme`, 'dark');
    window.localStorage.setItem(`${PREFS_PREFIX}onboardingStep`, '2');
    window.localStorage.setItem('unrelated-key', 'kept');

    const wiped = await deleteAllData({ db, storage: window.localStorage });
    expect(wiped.ok).toBe(true);

    for (const store of ['lists', 'tasks', 'snapshots', 'snapshot_payloads'] as const) {
      const rows = await db.readUnfiltered(store);
      expect(rows.ok && rows.value).toEqual([]);
    }
    const settings = await db.get('settings', 'settings');
    expect(settings.ok && settings.value).toMatchObject({ theme: 'system', lastBackupAt: null });

    const meta = await db.get('meta', 'meta');
    expect(meta.ok && meta.value?.deviceId).toBe(db.deviceId); // identity survives
    expect(meta.ok && meta.value?.lastPurgeAt).toBeUndefined(); // cleared

    expect(window.localStorage.getItem(`${PREFS_PREFIX}theme`)).toBeNull();
    expect(window.localStorage.getItem(`${PREFS_PREFIX}onboardingStep`)).toBeNull();
    expect(window.localStorage.getItem('unrelated-key')).toBe('kept');
  });

  it('takes NO pre-wipe snapshot (a snapshot here would be a forbidden shadow copy)', async () => {
    const db = await openSeeded();
    const wiped = await deleteAllData({ db, storage: window.localStorage });
    expect(wiped.ok).toBe(true);
    const snaps = await db.getAll('snapshots');
    expect(snaps.ok && snaps.value).toEqual([]);
  });
});

describe('side effects are best-effort (never throw across the boundary)', () => {
  it('clearPrefs tolerates storage access that throws', () => {
    const hostile = {
      key: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      removeItem: () => undefined,
    };
    expect(() => {
      clearPrefs(hostile);
    }).not.toThrow();
    expect(() => {
      clearPrefs(null);
    }).not.toThrow();
  });

  it('mirrorTheme/broadcastDataReplaced are feature-detected no-ops at worst', () => {
    expect(() => {
      mirrorTheme(makeSettings());
      mirrorTheme(null);
      broadcastDataReplaced();
    }).not.toThrow();
  });

  it('downloadTextFile hands the blob to the browser when the API exists, else returns false', () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const original = g['URL'];
    try {
      // Feature missing -> false, no throw.
      g['URL'] = undefined;
      expect(downloadTextFile('x.json', '{}')).toBe(false);

      // Feature present -> true, with a download attribute carrying the name.
      const clicked: string[] = [];
      const anchor = document.createElement('a');
      vi.spyOn(anchor, 'click').mockImplementation(() => {
        clicked.push(anchor.download);
      });
      vi.spyOn(document, 'createElement').mockReturnValue(anchor);
      g['URL'] = {
        createObjectURL: () => 'blob:test',
        revokeObjectURL: () => undefined,
      };
      expect(downloadTextFile('local-first-todo-backup-x.json', '{}')).toBe(true);
      expect(clicked).toEqual(['local-first-todo-backup-x.json']);
    } finally {
      g['URL'] = original;
    }
  });
});

describe('canonical byte-equivalence primitive (§2.4)', () => {
  it('matches between an exported record and the row read back', async () => {
    const db = await openSeeded();
    const exported = await exportBackup({ db, now: () => T0, download: false });
    if (!exported.ok) throw new Error('export failed');
    const doc = JSON.parse(exported.value.document) as { data: { tasks: unknown[] } };
    const rows = await db.readUnfiltered('tasks');
    if (!rows.ok) throw new Error('read failed');
    const fromDoc = doc.data.tasks.map((t) => canonicalText('tasks', t)).sort();
    const fromDb = rows.value.map((t) => canonicalText('tasks', t)).sort();
    expect(fromDoc).toEqual(fromDb);
  });
});
