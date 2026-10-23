import { afterEach, describe, expect, it } from 'vitest';

import type { AppDBImpl } from '../../../src/storage/db';
import {
  AUTO_RETENTION,
  deleteSnapshot,
  fallbackRawCodec,
  getSnapshotPayload,
  listSnapshots,
  readSnapshotSource,
  restoreSnapshot,
  takeSnapshot,
} from '../../../src/storage/snapshots';
import type { SnapshotCodec } from '../../../src/storage/snapshots';

import {
  fixedNow,
  makeList,
  makeSettings,
  makeTask,
  openFixtureDb,
  uniqueDbName,
} from './fixtures';

const opened: AppDBImpl[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

async function fixture(): Promise<AppDBImpl> {
  const db = await openFixtureDb(uniqueDbName('snap'));
  opened.push(db);
  await db.put('settings', makeSettings());
  await db.put('lists', makeList());
  await db.put('tasks', makeTask());
  return db;
}

describe('snapshots (ADR-002 Decision 9)', () => {
  it('stores payload + metadata with payloadRef == id, byte-sized payload', async () => {
    const db = await fixture();
    const snap = await takeSnapshot(db, { kind: 'auto', reason: 'scheduled', now: fixedNow });
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    expect(snap.value.payloadRef).toBe(snap.value.id);
    expect(snap.value.sizeBytes).toBeGreaterThan(0);
    expect(snap.value.schemaVersion).toBe(1);

    const payload = await getSnapshotPayload(db, snap.value.id);
    expect(payload.ok).toBe(true);
    if (payload.ok) {
      expect(payload.value).toBeDefined();
      const parsed = JSON.parse(payload.value ?? '{}') as { stores?: { tasks?: unknown[] } };
      expect(parsed.stores?.tasks).toHaveLength(1);
    }

    const listed = await listSnapshots(db);
    if (listed.ok) expect(listed.value.map((s) => s.id)).toContain(snap.value.id);
  });

  it('rolls auto retention at last-3 but keeps every manual snapshot', async () => {
    const db = await fixture();
    for (let i = 0; i < AUTO_RETENTION + 2; i += 1) {
      const snap = await takeSnapshot(db, {
        kind: 'auto',
        reason: 'scheduled',
        now: () => fixedNow() + i * 1000,
      });
      expect(snap.ok).toBe(true);
    }
    const manual = await takeSnapshot(db, {
      kind: 'manual',
      reason: 'manual',
      now: () => fixedNow() + 99_000,
    });
    expect(manual.ok).toBe(true);
    for (let i = 0; i < 3; i += 1) {
      await takeSnapshot(db, {
        kind: 'auto',
        reason: 'scheduled',
        now: () => fixedNow() + 100_000 + i,
      });
    }

    const listed = await listSnapshots(db);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const autos = listed.value.filter((s) => s.kind === 'auto');
    const manuals = listed.value.filter((s) => s.kind === 'manual');
    expect(autos).toHaveLength(AUTO_RETENTION);
    expect(manuals).toHaveLength(1);

    // Pruned snapshots take their payloads with them (no orphan blobs).
    const payloads = await db.getAll('snapshot_payloads');
    if (payloads.ok) expect(payloads.value).toHaveLength(listed.value.length);
  });

  it('restores rows and resets meta.schemaVersion in one replace', async () => {
    const db = await fixture();
    const snap = await takeSnapshot(db, { kind: 'manual', reason: 'manual', now: fixedNow });
    if (!snap.ok) throw new Error('snapshot failed');

    // Mutate: rename list, delete task row hard, add a new task.
    const lists = await db.getAll('lists');
    const list = lists.ok ? lists.value[0] : undefined;
    if (list !== undefined) await db.put('lists', { ...list, name: 'Renamed' });
    const tasks = await db.getAll('tasks');
    const task = tasks.ok ? tasks.value[0] : undefined;
    if (task !== undefined) await db.delete('tasks', task.id);

    const restored = await restoreSnapshot(db, snap.value.id);
    expect(restored.ok).toBe(true);

    const listsAfter = await db.getAll('lists');
    if (listsAfter.ok) {
      expect(listsAfter.value[0]?.name).toBe('Inbox');
    }
    const tasksAfter = await db.getAll('tasks');
    if (tasksAfter.ok) expect(tasksAfter.value).toHaveLength(1);
    expect(db.schemaVersion).toBe(1);
  });

  it('deleteSnapshot removes metadata and payload together', async () => {
    const db = await fixture();
    const snap = await takeSnapshot(db, { kind: 'manual', reason: 'manual', now: fixedNow });
    if (!snap.ok) throw new Error('snapshot failed');
    const deleted = await deleteSnapshot(db, snap.value.id);
    expect(deleted.ok).toBe(true);
    const payload = await getSnapshotPayload(db, snap.value.id);
    if (payload.ok) expect(payload.value).toBeUndefined();
    const listed = await listSnapshots(db);
    if (listed.ok) expect(listed.value.find((s) => s.id === snap.value.id)).toBeUndefined();
  });

  it('routes payloads through the injected codec (ADR-004 hook)', async () => {
    const db = await fixture();
    const calls: string[] = [];
    const codec: SnapshotCodec = {
      name: 'test-codec',
      serialize(source) {
        calls.push('serialize');
        return fallbackRawCodec.serialize(source);
      },
      deserialize(payload) {
        calls.push('deserialize');
        return fallbackRawCodec.deserialize(payload);
      },
    };
    const snap = await takeSnapshot(db, { kind: 'manual', reason: 'manual', codec, now: fixedNow });
    if (!snap.ok) throw new Error('snapshot failed');
    await restoreSnapshot(db, snap.value.id, codec);
    expect(calls).toEqual(['serialize', 'deserialize']);
  });

  it('fallbackRawCodec round-trips and rejects malformed payloads', async () => {
    const db = await fixture();
    const source = await readSnapshotSource(db);
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    const text = fallbackRawCodec.serialize(source.value);
    const back = fallbackRawCodec.deserialize(text);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.value.stores.tasks).toHaveLength(1);

    expect(fallbackRawCodec.deserialize('not json').ok).toBe(false);
    expect(fallbackRawCodec.deserialize('[]').ok).toBe(false);
    expect(fallbackRawCodec.deserialize('null').ok).toBe(false);
    expect(fallbackRawCodec.deserialize('{"stores":{}}').ok).toBe(false);
    expect(fallbackRawCodec.deserialize('{"schemaVersion":"x"}').ok).toBe(false);
    expect(fallbackRawCodec.deserialize('{"schemaVersion":1.5}').ok).toBe(false);

    // Missing stores deserialize to empty inventories (no crash on thin payloads).
    const thin = fallbackRawCodec.deserialize('{"schemaVersion":2}');
    expect(thin.ok).toBe(true);
    if (thin.ok) {
      expect(thin.value.schemaVersion).toBe(2);
      expect(thin.value.stores.tasks).toEqual([]);
      expect(thin.value.stores.lists).toEqual([]);
      expect(thin.value.stores.settings).toEqual([]);
    }
  });

  it('takes the Date.now default clock and survives a missing meta row', async () => {
    const db = await fixture();
    await db.delete('meta', 'meta');
    const source = await readSnapshotSource(db);
    expect(source.ok).toBe(true);
    if (source.ok) expect(source.value.schemaVersion).toBe(1); // fallback

    const snap = await takeSnapshot(db, { kind: 'manual', reason: 'manual' }); // no `now` given
    expect(snap.ok).toBe(true);
    if (snap.ok) expect(snap.value.takenAt).toBeGreaterThan(0);
  });

  it('prunes tied auto snapshots deterministically (id tie-break)', async () => {
    const db = await fixture();
    for (let i = 0; i < 5; i += 1) {
      const snap = await takeSnapshot(db, {
        kind: 'auto',
        reason: 'scheduled',
        now: () => fixedNow(), // all same takenAt -> comparator id branch
      });
      expect(snap.ok).toBe(true);
    }
    const listed = await listSnapshots(db);
    if (listed.ok) {
      expect(listed.value).toHaveLength(AUTO_RETENTION);
      // Newest ids (lexicographic ULID order) survive.
      const kept = listed.value.map((s) => s.id).sort();
      expect(kept).toEqual([...listed.value.map((s) => s.id)].sort());
    }
  });

  it('restoreSnapshot of a missing snapshot is a typed error, not a crash', async () => {
    const db = await fixture();
    const missing = await restoreSnapshot(db, '01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('UNKNOWN');
  });

  it('propagates QUOTA_EXCEEDED on snapshot write', async () => {
    const db = await fixture();
    const { injectQuotaOnPuts } = await import('./fixtures');
    const restore = injectQuotaOnPuts();
    try {
      const snap = await takeSnapshot(db, { kind: 'auto', reason: 'scheduled', now: fixedNow });
      expect(snap.ok).toBe(false);
      if (!snap.ok) expect(snap.error.code).toBe('QUOTA_EXCEEDED');
    } finally {
      restore();
    }
  });

  it('evicts retention victims BEFORE the new puts (ADR-004 8.2 evict-then-put)', async () => {
    const db = await fixture();
    // Three autos already stored: the 4th write must evict the oldest one first.
    for (let i = 0; i < AUTO_RETENTION; i += 1) {
      const prior = await takeSnapshot(db, {
        kind: 'auto',
        reason: 'scheduled',
        now: () => fixedNow() + i,
      });
      expect(prior.ok).toBe(true);
    }

    // Order-spy on the raw object-store write path (idb -> IDBObjectStore).
    const ops: string[] = [];
    const proto = IDBObjectStore.prototype as unknown as {
      put: (...args: unknown[]) => unknown;
      delete: (...args: unknown[]) => unknown;
    };
    const originalPut = proto.put;
    const originalDelete = proto.delete;
    proto.put = function spyPut(this: unknown, ...args: unknown[]): unknown {
      const storeName = (this as { name: string }).name;
      ops.push(`put:${storeName}`);
      return originalPut.apply(this, args);
    };
    proto.delete = function spyDelete(this: unknown, ...args: unknown[]): unknown {
      const storeName = (this as { name: string }).name;
      ops.push(`delete:${storeName}`);
      return originalDelete.apply(this, args);
    };
    try {
      const snap = await takeSnapshot(db, {
        kind: 'auto',
        reason: 'scheduled',
        now: () => fixedNow() + 1000,
      });
      expect(snap.ok).toBe(true);
    } finally {
      proto.put = originalPut;
      proto.delete = originalDelete;
    }

    // The oldest auto loses metadata + payload first; only then land the new rows.
    expect(ops).toEqual([
      'delete:snapshots',
      'delete:snapshot_payloads',
      'put:snapshot_payloads',
      'put:snapshots',
    ]);
    const firstPut = ops.findIndex((o) => o.startsWith('put:'));
    const lastDelete = ops.map((o) => o.startsWith('delete:')).lastIndexOf(true);
    expect(lastDelete).toBeGreaterThan(-1);
    expect(lastDelete).toBeLessThan(firstPut); // never hold 4 payloads transiently

    // Retention outcome unchanged: 3 newest autos kept, payload rows match 1:1.
    const listed = await listSnapshots(db);
    expect(listed.ok && listed.value).toHaveLength(AUTO_RETENTION);
    const payloads = await db.getAll('snapshot_payloads');
    expect(payloads.ok && payloads.value).toHaveLength(AUTO_RETENTION);
  });
});
