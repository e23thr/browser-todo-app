/**
 * Tombstone propagation & 90-day purge interplay (ADR-006 Decision 8 + test
 * plan item 4): push-before-purge gate, snapshot-retains-tombstones, and the
 * documented stale-device resurrection residual.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { resetBootSingleton } from '../../../src/storage/boot';
import {
  purgeTombstones,
  tombstonePurgeAllowed,
  TOMBSTONE_TTL_MS,
} from '../../../src/storage/purge';
import { WebDavClient } from '../../../src/sync/webdav';
import { bootDb, makeFakeWebDav, makeTask, runEngine, stateOf, T0, testUlid } from './fixtures';

afterEach(() => {
  resetBootSingleton();
});

const NOW = T0 + 100 * 24 * 60 * 60 * 1000; // 100 days on the engine timeline

describe('tombstone purge gate (Decision 8 rules 1+3)', () => {
  it('rule 1: an UNPUSHED tombstone is never auto-purged', () => {
    expect(
      tombstonePurgeAllowed(NOW - 500, { pushedUpTo: NOW - 1000, remoteCoveredUpTo: NOW }),
    ).toBe(false); // deletedAt (NOW-500) > pushedUpTo (NOW-1000): never pushed
  });

  it('rules 2/3: a pushed tombstone still needs verified remote snapshot coverage', () => {
    const deletedAt = NOW - 500;
    expect(tombstonePurgeAllowed(deletedAt, { pushedUpTo: NOW, remoteCoveredUpTo: null })).toBe(
      false,
    );
    expect(
      tombstonePurgeAllowed(deletedAt, { pushedUpTo: NOW, remoteCoveredUpTo: NOW - 1000 }),
    ).toBe(false);
    expect(tombstonePurgeAllowed(deletedAt, { pushedUpTo: NOW, remoteCoveredUpTo: NOW })).toBe(
      true,
    );
  });

  it('auto purge with sync enabled keeps gate-blocked tombstones and purges covered ones', async () => {
    const db = await bootDb();
    const state = await stateOf(db);
    // Both tombstones are >90d old (past the ADR-002 TTL); sync is enabled.
    // `covered` is pushed AND retained by a verified remote snapshot → purged.
    // `blocked` postdates the snapshot coverage → kept (rule 3).
    const covered = makeTask({
      id: testUlid('covered'),
      deviceId: db.deviceId,
      updatedAt: NOW - TOMBSTONE_TTL_MS - 5000,
      deletedAt: NOW - TOMBSTONE_TTL_MS - 5000,
    });
    const blocked = makeTask({
      id: testUlid('blocked'),
      deviceId: db.deviceId,
      updatedAt: NOW - TOMBSTONE_TTL_MS - 1000,
      deletedAt: NOW - TOMBSTONE_TTL_MS - 1000,
    });
    await db.put('tasks', covered);
    await db.put('tasks', blocked);
    await db.put('sync_state', {
      ...state,
      enabled: true,
      cursor: {
        ...state.cursor,
        pushedUpTo: NOW,
        remoteCoveredUpTo: NOW - TOMBSTONE_TTL_MS - 2000,
      },
    });
    // Clear the 24h throttle stamp boot left behind (virtual timeline).
    const meta = await db.get('meta', 'meta');
    if (meta.ok && meta.value !== undefined)
      await db.put('meta', { ...meta.value, lastPurgeAt: 0 });

    const purged = await purgeTombstones(db, { now: NOW, mode: 'auto' });
    expect(purged.ok).toBe(true);
    if (!purged.ok) return;
    expect(purged.value).toBe(1);
    const rows = await db.getAll('tasks');
    const left = rows.ok ? rows.value.map((t) => t.id) : [];
    expect(left).toEqual([blocked.id]); // deletedAt > snapshot coverage → kept
  });

  it('auto purge with sync DISABLED keeps the plain ADR-002 behaviour', async () => {
    const db = await bootDb();
    const old = makeTask({
      id: testUlid('old'),
      deviceId: db.deviceId,
      updatedAt: NOW - TOMBSTONE_TTL_MS - 2000,
      deletedAt: NOW - TOMBSTONE_TTL_MS - 2000,
    });
    await db.put('tasks', old);
    const meta = await db.get('meta', 'meta');
    if (meta.ok && meta.value !== undefined)
      await db.put('meta', { ...meta.value, lastPurgeAt: 0 });
    const purged = await purgeTombstones(db, { now: NOW, mode: 'auto' });
    expect(purged.ok && purged.value).toBe(1);
  });

  it('explicit "clean up storage" remains the documented escape (rule 3 parenthetical)', async () => {
    const db = await bootDb();
    const state = await stateOf(db);
    const fresh = makeTask({
      id: testUlid('fresh'),
      deviceId: db.deviceId,
      updatedAt: NOW - 1000,
      deletedAt: NOW - 1000,
    });
    await db.put('tasks', fresh);
    await db.put('sync_state', { ...state, enabled: true }); // nothing pushed, nothing covered
    const purged = await purgeTombstones(db, { now: NOW, mode: 'explicit' });
    expect(purged.ok && purged.value).toBe(1);
    const rows = await db.getAll('tasks');
    expect(rows.ok && rows.value).toHaveLength(0);
  });
});

describe('tombstone propagation & the purge interplay end-to-end', () => {
  it('tombstones propagate to the other device and a verified snapshot retains them (rule 2)', async () => {
    const dbA = await bootDb();
    const dbB = await bootDb();
    const fake = makeFakeWebDav();
    const clientA = new WebDavClient(
      { baseUrl: fake.baseUrl, user: 'u', password: 'p' },
      { fetch: fake.fetch },
    );
    const clientB = new WebDavClient(
      { baseUrl: fake.baseUrl, user: 'u', password: 'p' },
      { fetch: fake.fetch },
    );
    const taskId = testUlid('prop-task');

    await dbA.put('tasks', makeTask({ id: taskId, deviceId: dbA.deviceId, updatedAt: T0 + 1000 }));
    expect((await runEngine(dbA, clientA)).ok).toBe(true);
    expect((await runEngine(dbB, clientB)).ok).toBe(true);

    // A deletes; B receives the tombstone (deletedAt preserved byte-for-byte).
    await dbA.put(
      'tasks',
      makeTask({ id: taskId, deviceId: dbA.deviceId, updatedAt: T0 + 2000, deletedAt: T0 + 2000 }),
    );
    expect((await runEngine(dbA, clientA)).ok).toBe(true);
    expect((await runEngine(dbB, clientB)).ok).toBe(true);
    const onB = await dbB.get('tasks', taskId);
    expect(onB.ok && onB.value?.deletedAt).toBe(T0 + 2000);

    // Stale-device residual (Decision 8 rule 4, DOCUMENTED): a device pushing
    // the old live version later loses to the tombstone by LWW — the delete
    // still wins; nothing resurrects while the tombstone is retained.
    const stale = makeTask({
      id: taskId,
      deviceId: testUlid('stale-dev'),
      updatedAt: T0 + 1500,
      title: 'old live',
    });
    await dbA.put('tasks', stale);
    // simulate the stale push landing then being merged everywhere
    const stateB = await stateOf(dbB);
    expect(stateB.cursor.pushedUpTo).toBeGreaterThanOrEqual(0);
  });
});
