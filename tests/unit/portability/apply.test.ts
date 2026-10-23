/**
 * `applyImport` stages 5–7 (ADR-004 Decision 5): pre-import snapshot (the undo)
 * → ONE atomic replace transaction → report. Drills 10–13 of the testing
 * contract, incl. quota and snapshot-failure semantics — no silent write drops.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AppDBImpl } from '../../../src/storage/db';
import {
  applyImport,
  prepareImport,
  prepareSnapshotRestore,
  restoreSnapshot,
} from '../../../src/portability/import';
import { listSnapshots, takeSnapshot } from '../../../src/portability/snapshots-api';
import { THEME_PREF_KEY, writeThemePref } from '../../../src/app/theme';
import {
  injectQuotaOnPuts,
  makeList,
  makeSettings,
  makeSnapshot,
  makeTask,
  openFixtureDb,
  uniqueDbName,
} from '../storage/fixtures';
import {
  canonicalText,
  fixture,
  fixtureId,
  injectFailureOnStorePut,
  makeDocText,
  seedCorpus,
  T0,
} from './helpers';

const opened: AppDBImpl[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

beforeEach(() => {
  window.localStorage.clear();
});

async function openSeeded(): Promise<AppDBImpl> {
  const db = await openFixtureDb(uniqueDbName('apply'));
  opened.push(db);
  await db.put('settings', makeSettings());
  await db.put('lists', makeList());
  await db.put('tasks', makeTask());
  return db;
}

async function rowTexts(
  db: AppDBImpl,
): Promise<{ lists: string[]; tasks: string[]; settings: string }> {
  const lists = await db.readUnfiltered('lists');
  const tasks = await db.readUnfiltered('tasks');
  const settings = await db.readUnfiltered('settings');
  if (!lists.ok || !tasks.ok || !settings.ok) throw new Error('read failed');
  return {
    lists: lists.value.map((r) => canonicalText('lists', r)).sort(),
    tasks: tasks.value.map((r) => canonicalText('tasks', r)).sort(),
    settings: canonicalText('settings', settings.value[0]),
  };
}

describe('applyImport — atomic replace with the pre-import snapshot as undo', () => {
  it('hard-deletes stale rows (incl. tombstones), applies records verbatim, reports the undo (drills 5/13)', async () => {
    const db = await openSeeded();
    // A stale tombstone that the replace must remove — REPLACE is complete.
    await db.put(
      'tasks',
      makeTask({ id: fixtureId(90), listId: fixtureId(10), deletedAt: T0 - 3 }),
    );

    const corpus = seedCorpus();
    const text = makeDocText({ ...corpus });
    const prepared = await prepareImport(text);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const applied = await applyImport(prepared.value, { db, now: () => T0 });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const report = applied.value;
    expect(report.outcome).toBe('applied');
    expect(report.accepted).toEqual({ lists: 2, tasks: 3, settings: true });
    expect(report.recoveryFileName).toBeNull();
    expect(report.undoSnapshot?.takenAt).toBe(T0);

    // Byte-equivalence (§2.4): stored rows are the document's records verbatim.
    const after = await rowTexts(db);
    expect(after.lists).toEqual(corpus.lists.map((r) => canonicalText('lists', r)).sort());
    expect(after.tasks).toEqual(corpus.tasks.map((r) => canonicalText('tasks', r)).sort());
    expect(after.settings).toBe(canonicalText('settings', corpus.settings));

    // The pre-import snapshot is a real snapshot the user can find and undo from.
    const snaps = await listSnapshots({ db });
    expect(snaps.ok && snaps.value.map((s) => s.reason)).toEqual(['pre-import']);
  });

  it('reports partial + the recovery download when records were quarantined (drill 5)', async () => {
    const db = await openSeeded();
    const corpus = seedCorpus();
    const prepared = await prepareImport(
      makeDocText({
        ...corpus,
        lists: [...corpus.lists, { ...makeList({ id: fixtureId(12), name: '' }) }],
      }),
    );
    if (!prepared.ok) throw new Error('prepare failed');
    const applied = await applyImport(prepared.value, { db });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.outcome).toBe('partial');
    expect(applied.value.quarantined).toBe(1);
    expect(applied.value.recoveryFileName).toMatch(/^local-first-todo-recovery-/u);
    expect(applied.value.recoveryFile?.json).toContain('"raw"');
    // Recovery file is download-only: nothing about it was persisted.
    const payloads = await db.getAll('snapshot_payloads');
    expect(payloads.ok && payloads.value).toHaveLength(1); // just the undo payload
  });

  it('ignores imported snapshot metadata with a warning; snapshots stay device-local (drill 13)', async () => {
    const db = await openSeeded();
    const corpus = seedCorpus();
    const prepared = await prepareImport(makeDocText({ ...corpus }));
    if (!prepared.ok) throw new Error('prepare failed');
    expect(prepared.value.warnings.join(' ')).toContain('snapshot metadata ignored');
    const applied = await applyImport(prepared.value, { db });
    expect(applied.ok).toBe(true);
    const snaps = await listSnapshots({ db });
    expect(snaps.ok && snaps.value).toHaveLength(1); // only the pre-import row
    expect(snaps.ok && snaps.value[0]?.reason).toBe('pre-import');
  });

  it('rewrites the theme mirror from the imported settings (ADR-002 §3.4)', async () => {
    const db = await openSeeded();
    writeThemePref('light');
    const corpus = seedCorpus();
    const prepared = await prepareImport(
      makeDocText({ ...corpus, settings: { ...corpus.settings, theme: 'dark' } }),
    );
    if (!prepared.ok) throw new Error('prepare failed');
    const applied = await applyImport(prepared.value, { db });
    expect(applied.ok).toBe(true);
    expect(window.localStorage.getItem(THEME_PREF_KEY)).toBe('dark');
  });
});

describe('applyImport — failure semantics (never a silent write drop)', () => {
  it('surfaces QUOTA_EXCEEDED with the DB exactly as before (drill 12)', async () => {
    const db = await openSeeded();
    const before = await rowTexts(db);
    const prepared = await prepareImport(makeDocText({ ...seedCorpus() }));
    if (!prepared.ok) throw new Error('prepare failed');

    const restore = injectQuotaOnPuts();
    try {
      const applied = await applyImport(prepared.value, { db, allowWithoutSnapshot: true });
      expect(applied).toMatchObject({ ok: false, error: { code: 'QUOTA_EXCEEDED' } });
      expect(await rowTexts(db)).toEqual(before);
    } finally {
      restore();
    }
  });

  it('aborts on pre-import snapshot failure unless the user opted in (drill 11)', async () => {
    const db = await openSeeded();
    const prepared = await prepareImport(makeDocText({ ...seedCorpus() }));
    if (!prepared.ok) throw new Error('prepare failed');

    const restore = injectFailureOnStorePut(
      'snapshot_payloads',
      new DOMException('no room', 'QuotaExceededError'),
    );
    try {
      const aborted = await applyImport(prepared.value, { db });
      expect(aborted).toMatchObject({ ok: false, error: { code: 'SNAPSHOT_FAILED' } });
      const snaps = await listSnapshots({ db });
      expect(snaps.ok && snaps.value).toEqual([]); // zero side effects

      const opted = await applyImport(prepared.value, { db, allowWithoutSnapshot: true });
      expect(opted.ok).toBe(true);
      if (opted.ok) {
        expect(opted.value.undoSnapshot).toBeNull();
        expect(opted.value.warnings.join(' ')).toContain('without an undo snapshot');
      }
    } finally {
      restore();
    }
  });
});

describe('restoreSnapshot — the import undo (drill 10)', () => {
  it('restores the pre-import state byte-equivalently and takes its own undo snapshot', async () => {
    const db = await openFixtureDb(uniqueDbName('undo'));
    opened.push(db);
    // A valid pre-import state (restoreSnapshot is the full import pipeline per
    // §8.1 — invalid rows quarantine to the recovery file on ANY import, undo
    // included, so the byte-equivalence drill runs over valid records).
    const l1 = makeList({ id: fixtureId(10) });
    const t1 = makeTask({ id: fixtureId(20), listId: l1.id });
    await db.put('lists', l1);
    await db.put('tasks', t1);
    await db.put('settings', makeSettings());
    const original = await rowTexts(db);

    const corpus = seedCorpus();
    const prepared = await prepareImport(makeDocText({ ...corpus }));
    if (!prepared.ok) throw new Error('prepare failed');
    const applied = await applyImport(prepared.value, { db });
    if (!applied.ok || applied.value.undoSnapshot === null) throw new Error('apply failed');
    const undoId = applied.value.undoSnapshot.id;

    // Undo: restoreSnapshot runs the full pipeline on the stored payload.
    const restored = await restoreSnapshot(undoId, { db });
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value.undoSnapshot).not.toBeNull(); // undo of the undo
    expect(await rowTexts(db)).toEqual(original);

    // ...and the undo-of-undo snapshot exists for the new state.
    const snaps = await listSnapshots({ db });
    expect(
      snaps.ok && snaps.value.filter((s) => s.reason === 'pre-import').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('exposes a zero-side-effect half for confirm flows (prepareSnapshotRestore)', async () => {
    const db = await openSeeded();
    const snap = await takeSnapshot('manual', { db, now: () => T0 });
    if (!snap.ok) throw new Error('snapshot failed');
    const prepared = await prepareSnapshotRestore(snap.value.id, { db });
    expect(prepared.ok).toBe(true);
    if (prepared.ok) expect(prepared.value.fileSummary.kind).toBe('snapshot');

    const missing = await prepareSnapshotRestore(fixtureId(55), { db });
    expect(missing).toMatchObject({ ok: false });
  });
});

describe('restore path drill: export -> wipe -> import -> restored (drill 1)', () => {
  it('restores every record byte-equivalently after a factory reset', async () => {
    const { exportBackup, deleteAllData } = await import('../../../src/portability/export');
    // A clean profile seeded with ONLY the corpus (openSeeded's default task
    // deliberately dangles and would be quarantined, not restored).
    const db = await openFixtureDb(uniqueDbName('restore'));
    opened.push(db);
    const corpus = seedCorpus();
    for (const row of corpus.lists) await db.put('lists', row);
    for (const row of corpus.tasks) await db.put('tasks', row);
    await db.put('settings', corpus.settings);
    await db.put('snapshots', corpus.snapshots[0] ?? makeSnapshot(fixtureId(30)));

    const exported = await exportBackup({ db, now: () => T0, download: false });
    if (!exported.ok) throw new Error('export failed');
    const beforeWipe = await rowTexts(db);

    const wiped = await deleteAllData({ db, storage: window.localStorage });
    expect(wiped.ok).toBe(true);

    const prepared = await prepareImport(exported.value.document, {
      fileName: exported.value.fileName,
    });
    if (!prepared.ok) throw new Error('prepare failed');
    const applied = await applyImport(prepared.value, { db });
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.value.warnings.join(' ')).toContain('snapshot metadata ignored');

    const after = await rowTexts(db);
    // settings.lastBackupAt was stamped by export; everything else is verbatim.
    expect(after.lists).toEqual(beforeWipe.lists);
    expect(after.tasks).toEqual(beforeWipe.tasks);
    expect(JSON.parse(after.settings)['lastBackupAt']).toBe(T0);
    expect(JSON.parse(beforeWipe.settings)['lastBackupAt']).toBe(T0); // export stamped the doc + DB
  });
});

describe('fixture corpus sanity', () => {
  it('keeps hostile fixtures as raw text (never imported as JSON modules)', () => {
    const raw = fixture('drill4-proto-pollution.json');
    expect(raw).toContain('"__proto__"');
  });
});
