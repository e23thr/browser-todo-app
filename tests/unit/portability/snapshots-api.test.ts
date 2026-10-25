/**
 * Snapshot engine (ADR-004 Decisions 8–9): document payloads, rolling-3
 * retention with evict-then-put mechanics, manual permanence, the throttled
 * scheduled trigger, and typed quota surfacing (drill 9 + §8.3).
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { AppDBImpl } from '../../../src/storage/db';
import {
  getSnapshotPayload,
  restoreSnapshot as frameworkRestoreSnapshot,
} from '../../../src/storage/snapshots';
import {
  adr004Codec,
  deleteSnapshot,
  downloadSnapshot,
  listSnapshots,
  makeAdr004Codec,
  maybeScheduledSnapshot,
  snapshotDownloadName,
  takeSnapshot,
} from '../../../src/portability/snapshots-api';
import { parseBackupDocument } from '../../../src/portability/backup-document';
import { prepareImport } from '../../../src/portability/import';
import { SCHEDULED_SNAPSHOT_INTERVAL_MS } from '../../../src/portability/constants';
import {
  injectQuotaOnPuts,
  makeSettings,
  makeList,
  makeTask,
  openFixtureDb,
  uniqueDbName,
} from '../storage/fixtures';
import { fixtureId, seedCorpus, T0 } from './helpers';

const opened: AppDBImpl[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

async function openSeeded(): Promise<AppDBImpl> {
  const db = await openFixtureDb(uniqueDbName('snap-api'));
  opened.push(db);
  const corpus = seedCorpus();
  for (const row of corpus.lists) await db.put('lists', row);
  for (const row of corpus.tasks) await db.put('tasks', row);
  await db.put('settings', makeSettings());
  return db;
}

describe('snapshot payloads are importable backup documents (Decision 8.1)', () => {
  it('serializes kind:"snapshot" with exportedAt == Snapshot.takenAt', async () => {
    const db = await openSeeded();
    const snap = await takeSnapshot('manual', { db, now: () => T0 });
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    expect(snap.value.takenAt).toBe(T0);

    const payload = await getSnapshotPayload(db, snap.value.id);
    expect(payload.ok).toBe(true);
    if (!payload.ok || payload.value === undefined) return;
    const parsed = parseBackupDocument(payload.value, { targetSchemaVersion: 1 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.kind).toBe('snapshot');
    expect(parsed.value.exportedAt).toBe(T0);

    // "rollback = import the snapshot" — the payload is a valid import input.
    const prepared = await prepareImport(payload.value);
    expect(prepared.ok).toBe(true);
    if (prepared.ok)
      expect(prepared.value.accepted).toEqual({ lists: 2, tasks: 3, settings: true });
  });

  it('round-trips through the codec seam (makeAdr004Codec)', () => {
    const codec = makeAdr004Codec({ deviceId: fixtureId(1), now: () => T0 });
    const text = codec.serialize({
      schemaVersion: 1,
      takenAt: T0,
      stores: {
        meta: [],
        settings: [makeSettings()],
        lists: [makeList()],
        tasks: [makeTask()],
        snapshots: [],
        snapshot_payloads: [],
        sync_state: [],
      },
    });
    const back = codec.deserialize(text);
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.value.schemaVersion).toBe(1);
      expect(back.value.stores.tasks).toHaveLength(1);
      expect(back.value.stores.snapshot_payloads).toEqual([]);
    }
    expect(codec.deserialize('not json').ok).toBe(false);
    expect(codec.name).toBe('adr-004-json');
  });
});

describe('retention (Decision 8.2, drill 9)', () => {
  it('keeps the newest 3 autos, never evicts manual snapshots, and evicts payloads with metadata', async () => {
    const db = await openSeeded();
    for (let i = 0; i < 5; i += 1) {
      const snap = await takeSnapshot('scheduled', { db, now: () => T0 + i * 1000 });
      expect(snap.ok).toBe(true);
    }
    const manual = await takeSnapshot('manual', { db, now: () => T0 + 5000 });
    if (!manual.ok) throw new Error('manual snapshot failed');

    const listed = await listSnapshots({ db });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const autos = listed.value.filter((s) => s.kind === 'auto');
    const manuals = listed.value.filter((s) => s.kind === 'manual');
    expect(autos).toHaveLength(3);
    expect(manuals).toHaveLength(1);
    // Newest autos survive.
    expect(autos.map((s) => s.takenAt).sort((a, b) => a - b)).toEqual([
      T0 + 2000,
      T0 + 3000,
      T0 + 4000,
    ]);

    // Evicted snapshots take their payloads with them.
    const payloads = await db.getAll('snapshot_payloads');
    expect(payloads.ok && payloads.value).toHaveLength(listed.value.length);

    // deleteSnapshot works for any kind.
    const deleted = await deleteSnapshot(manual.value.id, { db });
    expect(deleted.ok).toBe(true);
    const after = await listSnapshots({ db });
    expect(after.ok && after.value.some((s) => s.kind === 'manual')).toBe(false);
    const missing = await deleteSnapshot(fixtureId(55), { db });
    expect(missing.ok).toBe(true); // idempotent delete
  });
});

describe('download + scheduled trigger (Decisions 8.3/9)', () => {
  it('downloadSnapshot returns the document blob and the pinned filename', async () => {
    const db = await openSeeded();
    const snap = await takeSnapshot('manual', { db, now: () => T0 });
    if (!snap.ok) throw new Error('snapshot failed');
    const blob = await downloadSnapshot(snap.value.id, { db });
    expect(blob.ok).toBe(true);
    if (blob.ok) {
      const text = await blob.value.text();
      expect(text).toContain('"format": "local-first-todo-backup"');
    }
    expect(
      snapshotDownloadName({
        ...snap.value,
        kind: 'manual',
        reason: 'manual',
        sizeBytes: 1,
        schemaVersion: 1,
        payloadRef: snap.value.id,
      }),
    ).toBe('local-first-todo-snapshot-2023-11-14T221320Z.json');
    const missing = await downloadSnapshot(fixtureId(56), { db });
    expect(missing).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('throttles the scheduled trigger to at most one snapshot per 24h', async () => {
    const db = await openSeeded();
    const first = await maybeScheduledSnapshot({ db, now: () => T0 });
    expect(first.ok && first.value).not.toBeNull();

    const soon = await maybeScheduledSnapshot({
      db,
      now: () => T0 + SCHEDULED_SNAPSHOT_INTERVAL_MS - 1,
    });
    expect(soon.ok && soon.value).toBeNull();

    const later = await maybeScheduledSnapshot({
      db,
      now: () => T0 + SCHEDULED_SNAPSHOT_INTERVAL_MS + 1,
    });
    expect(later.ok && later.value).not.toBeNull();

    const listed = await listSnapshots({ db });
    expect(listed.ok && listed.value.filter((s) => s.reason === 'scheduled')).toHaveLength(2);
    expect(listed.ok && listed.value.every((s) => s.kind === 'auto')).toBe(true);
  });
});

describe('error contract (nothing swallowed)', () => {
  it('surfaces QUOTA_EXCEEDED from snapshot writes', async () => {
    const db = await openSeeded();
    const restore = injectQuotaOnPuts();
    try {
      const snap = await takeSnapshot('scheduled', { db, now: () => T0 });
      expect(snap).toMatchObject({ ok: false, error: { code: 'QUOTA_EXCEEDED' } });
    } finally {
      restore();
    }
  });

  it('reports UNAVAILABLE when no database is bound', async () => {
    const unbound = await takeSnapshot('manual');
    expect(unbound).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    const listed = await listSnapshots();
    expect(listed).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
  });
});

describe('rollback validates stored rows (review finding 4)', () => {
  it('deserialize refuses the WHOLE payload when a single row is invalid', () => {
    const codec = makeAdr004Codec({ deviceId: fixtureId(1), now: () => T0 });
    const corpus = seedCorpus();
    const text = codec.serialize({
      schemaVersion: 1,
      takenAt: T0,
      stores: {
        meta: [],
        settings: [corpus.settings],
        lists: corpus.lists,
        tasks: corpus.tasks,
        snapshots: corpus.snapshots,
        snapshot_payloads: [],
        sync_state: [],
      },
    });

    // Healthy payload still round-trips (nothing changes for valid data).
    const good = codec.deserialize(text);
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.value.stores.tasks).toHaveLength(corpus.tasks.length);

    // Corrupt ONE row (parseable JSON, invalid record): the whole payload is
    // refused with a typed error — no partial store, no silently dropped rows.
    const doc = JSON.parse(text) as { data: { tasks: Record<string, unknown>[] } };
    const victim = doc.data.tasks[0];
    if (victim === undefined) throw new Error('fixture task missing');
    victim['sortOrder'] = 'h0'; // non-canonical order key (trailing zero)
    const rejected = codec.deserialize(JSON.stringify(doc));
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error).toMatchObject({
        code: 'INVALID_RECORD',
        store: 'tasks',
        id: victim['id'],
      });
    }
  });

  it('makes restoreSnapshot fail WITHOUT writing when the stored payload has one invalid row', async () => {
    const db = await openSeeded();
    const snap = await takeSnapshot('manual', { db, now: () => T0 });
    if (!snap.ok) throw new Error('snapshot failed');

    // Corrupt one row inside the STORED payload (still a parseable document).
    const stored = await getSnapshotPayload(db, snap.value.id);
    if (!stored.ok || stored.value === undefined) throw new Error('snapshot payload missing');
    const doc = JSON.parse(stored.value) as { data: { tasks: Record<string, unknown>[] } };
    const victim = doc.data.tasks[0];
    if (victim === undefined) throw new Error('fixture task missing');
    victim['title'] = ''; // validateTask: trimmed length must be >= 1
    const replaced = await db.put('snapshot_payloads', {
      id: snap.value.id,
      payload: JSON.stringify(doc),
    });
    expect(replaced.ok).toBe(true);

    // Diverge the live data so ANY rollback write would be observable.
    const lists = await db.getAll('lists');
    const list = lists.ok ? lists.value[0] : undefined;
    if (list === undefined) throw new Error('fixture list missing');
    await db.put('lists', { ...list, name: 'Renamed after snapshot' });
    await db.put('settings', makeSettings({ theme: 'light' }));
    await db.put('tasks', makeTask({ id: fixtureId(99), listId: list.id, title: 'Intruder' }));
    const before = await db.getAll('tasks');
    const beforeCount = before.ok ? before.value.length : -1;

    const restored = await frameworkRestoreSnapshot(db, snap.value.id, adr004Codec);
    expect(restored.ok).toBe(false);
    if (!restored.ok) {
      expect(restored.error).toMatchObject({ code: 'INVALID_RECORD', store: 'tasks' });
    }

    // Zero side effects: nothing written, deleted or replaced by the rollback.
    const listsAfter = await db.getAll('lists');
    expect(listsAfter.ok && listsAfter.value[0]?.name).toBe('Renamed after snapshot');
    const settingsAfter = await db.getAll('settings');
    expect(settingsAfter.ok && settingsAfter.value[0]?.theme).toBe('light');
    const tasksAfter = await db.getAll('tasks');
    expect(tasksAfter.ok && tasksAfter.value).toHaveLength(beforeCount);
    expect(tasksAfter.ok && tasksAfter.value.some((t) => t.title === 'Intruder')).toBe(true);
  });
});
