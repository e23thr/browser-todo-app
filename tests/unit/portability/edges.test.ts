/**
 * Edge cases that keep the per-file coverage honest: failure mappings, missing
 * meta, missing payloads, hostile runtime environments (BroadcastChannel
 * throwing), and migration substrates with records no `Tx` can carry.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { AppDBImpl } from '../../../src/storage/db';
import { exportBackup, deleteAllData, clearPrefs } from '../../../src/portability/export';
import {
  deleteSnapshot,
  downloadSnapshot,
  listSnapshots,
  maybeScheduledSnapshot,
  takeSnapshot,
} from '../../../src/portability/snapshots-api';
import { broadcastDataReplaced } from '../../../src/portability/side-effects';
import { prepareImport } from '../../../src/portability/import';
import type { MigrationStep } from '../../../src/storage/migrations';
import { openFixtureDb, uniqueDbName, makeSettings, makeList, makeTask } from '../storage/fixtures';
import { makeDocObject, fixtureId, T0 } from './helpers';

const opened: AppDBImpl[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

describe('export/wipe failure mappings (typed, never thrown)', () => {
  it('maps read failures onto ExportError and DeleteAllData errors onto StorageError', async () => {
    const db = await openFixtureDb(uniqueDbName('edge'));
    opened.push(db);
    db.close();

    const exported = await exportBackup({ db, download: false });
    expect(exported.ok).toBe(false);
    if (!exported.ok)
      expect(['UNAVAILABLE', 'UNKNOWN', 'TX_ABORTED']).toContain(exported.error.code);

    const wiped = await deleteAllData({ db, storage: null });
    expect(wiped.ok).toBe(false);
    if (!wiped.ok) expect(['UNAVAILABLE', 'UNKNOWN', 'TX_ABORTED']).toContain(wiped.error.code);
  });

  it('wipes cleanly when the meta row is missing (identity cannot be preserved)', async () => {
    const db = await openFixtureDb(uniqueDbName('edge-nometa'));
    opened.push(db);
    await db.put('settings', makeSettings());
    await db.put('lists', makeList());
    await db.delete('meta', 'meta');

    const wiped = await deleteAllData({ db, storage: null });
    expect(wiped.ok).toBe(true);
    const lists = await db.readUnfiltered('lists');
    expect(lists.ok && lists.value).toEqual([]);
  });

  it('clearPrefs removes only the todo:prefs:v1:* namespace', () => {
    window.localStorage.clear();
    window.localStorage.setItem('todo:prefs:v1:theme', 'dark');
    window.localStorage.setItem('todo:prefs:v1:dismissedBanners', 'x');
    window.localStorage.setItem('keep-me', 'y');
    clearPrefs(window.localStorage);
    expect(window.localStorage.getItem('todo:prefs:v1:theme')).toBeNull();
    expect(window.localStorage.getItem('todo:prefs:v1:dismissedBanners')).toBeNull();
    expect(window.localStorage.getItem('keep-me')).toBe('y');
  });
});

describe('snapshot API failure mappings', () => {
  it('reports typed errors from list/delete/download/scheduled on a closed DB', async () => {
    const db = await openFixtureDb(uniqueDbName('edge-snap'));
    opened.push(db);
    db.close();

    for (const call of [
      () => listSnapshots({ db }),
      () => deleteSnapshot(fixtureId(50), { db }),
      () => downloadSnapshot(fixtureId(50), { db }),
      () => maybeScheduledSnapshot({ db, now: () => T0 }),
      () => takeSnapshot('manual', { db, now: () => T0 }),
    ]) {
      const result = await call();
      expect(result.ok).toBe(false);
    }
  });

  it('deleteSnapshot/downloadSnapshot report UNAVAILABLE when unbound', async () => {
    expect(await deleteSnapshot(fixtureId(50))).toMatchObject({
      ok: false,
      error: { code: 'UNAVAILABLE' },
    });
    expect(await downloadSnapshot(fixtureId(50))).toMatchObject({
      ok: false,
      error: { code: 'UNAVAILABLE' },
    });
  });
});

describe('hostile runtime environments (side effects never throw)', () => {
  it('survives a BroadcastChannel constructor that throws', () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const original = g['BroadcastChannel'];
    try {
      g['BroadcastChannel'] = function Throwing(): never {
        throw new DOMException('denied', 'SecurityError');
      };
      expect(() => {
        broadcastDataReplaced();
      }).not.toThrow();
    } finally {
      g['BroadcastChannel'] = original;
    }
  });

  it('is a no-op when BroadcastChannel does not exist at all', () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const original = g['BroadcastChannel'];
    try {
      g['BroadcastChannel'] = undefined;
      expect(() => {
        broadcastDataReplaced();
      }).not.toThrow();
    } finally {
      g['BroadcastChannel'] = original;
    }
  });
});

describe('export fallbacks', () => {
  it('exports module-default settings when the profile has no settings row yet', async () => {
    const db = await openFixtureDb(uniqueDbName('edge-nosettings'));
    opened.push(db);
    await db.put('lists', makeList());
    const exported = await exportBackup({ db, now: () => T0, download: false });
    expect(exported.ok).toBe(true);
    if (exported.ok) {
      const doc = JSON.parse(exported.value.document) as { data: { settings: { theme: string } } };
      expect(doc.data.settings.theme).toBe('system'); // DEFAULT_SETTINGS_RECORD
    }
  });
});

describe('migration substrate with uncarrable records (upgrade.ts passthrough)', () => {
  const echoStep: MigrationStep = {
    to: 2,
    stores: ['tasks'],
    run: (t) => {
      // The migration ADDS a row — its provenance falls back to the row itself.
      return t
        .put('tasks', {
          id: fixtureId(40),
          listId: fixtureId(10),
          title: 'added by migration',
          notes: '',
          status: 'open',
          priority: 'P3',
          tags: [],
          sortOrder: 'h',
          createdAt: T0,
          updatedAt: T0,
          deletedAt: null,
          deviceId: fixtureId(1),
        })
        .then(() => ({ ok: true, value: undefined }));
    },
  };
  /** Completes the chain to the APP baseline without touching rows. */
  const toV3Noop: MigrationStep = {
    to: 3,
    stores: ['tasks'],
    run: () => ({ ok: true as const, value: undefined }),
  };
  const toV4Noop: MigrationStep = {
    to: 4,
    stores: ['tasks'],
    run: () => ({ ok: true as const, value: undefined }),
  };

  it('passes records without ids (and duplicate ids) through to quarantine verbatim', async () => {
    const l1 = makeList({ id: fixtureId(10) });
    const good = makeTask({ id: fixtureId(20), listId: l1.id });
    const dupe = makeTask({ id: fixtureId(20), listId: l1.id, title: 'dupe' });
    const idless = { title: 'no id at all' };
    const doc = makeDocObject({ schemaVersion: 1, lists: [l1], tasks: [good, dupe, idless] });

    const prepared = await prepareImport(JSON.stringify(doc), {
      migrations: [echoStep, toV3Noop, toV4Noop],
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.fileSummary.upgradedTo).toBe(4);
    // Migrated rows: the original + the migration-added one; the dupe and the
    // id-less record ride through as quarantined entries with raw provenance.
    expect(prepared.value.accepted.tasks).toBe(2);
    const raws = prepared.value.quarantined.map((e) => e.raw);
    expect(raws).toContainEqual(dupe);
    expect(raws).toContainEqual(idless);
  });
});
