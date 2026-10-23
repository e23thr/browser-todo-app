import { afterEach, describe, expect, it } from 'vitest';

import type { AppDBImpl } from '../../../src/storage/db';
import { PURGE_INTERVAL_MS, TOMBSTONE_TTL_MS, purgeTombstones } from '../../../src/storage/purge';

import {
  injectQuotaOnPuts,
  makeList,
  makeMeta,
  makeTask,
  openFixtureDb,
  uniqueDbName,
} from './fixtures';

const NOW = 1_800_000_000_000;

const opened: AppDBImpl[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

async function fixture(meta = makeMeta()): Promise<AppDBImpl> {
  const db = await openFixtureDb(uniqueDbName('purge'), meta);
  opened.push(db);
  await db.put('meta', meta);
  return db;
}

describe('tombstone purge (ADR-002 Decision 6)', () => {
  it('auto: purges tombstones older than 90 days only, never live rows', async () => {
    const db = await fixture(makeMeta({ lastPurgeAt: 0 }));
    const live = makeTask();
    const oldTomb = makeTask({ deletedAt: NOW - TOMBSTONE_TTL_MS - 1 });
    const freshTomb = makeTask({ deletedAt: NOW - 1000 });
    const oldListTomb = makeList({ deletedAt: NOW - TOMBSTONE_TTL_MS - 5 });
    for (const row of [live, oldTomb, freshTomb, oldListTomb]) {
      await db.put(row === oldListTomb ? 'lists' : 'tasks', row);
    }

    const result = await purgeTombstones(db, { now: NOW, mode: 'auto' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(2); // oldTomb + oldListTomb

    expect((await db.get('tasks', live.id)).ok).toBe(true);
    const fresh = await db.get('tasks', freshTomb.id);
    if (fresh.ok) expect(fresh.value).toBeDefined(); // kept: under 90 days
    const old = await db.get('tasks', oldTomb.id);
    if (old.ok) expect(old.value).toBeUndefined();
  });

  it('auto: throttled to at most once per 24h via meta.lastPurgeAt', async () => {
    const db = await fixture(makeMeta({ lastPurgeAt: NOW - PURGE_INTERVAL_MS + 1000 }));
    await db.put('tasks', makeTask({ deletedAt: NOW - TOMBSTONE_TTL_MS - 1 }));

    const throttled = await purgeTombstones(db, { now: NOW, mode: 'auto' });
    if (throttled.ok) expect(throttled.value).toBe(0);
    const still = await db.getAll('tasks');
    if (still.ok) expect(still.value).toHaveLength(1); // nothing purged

    const later = await purgeTombstones(db, { now: NOW + PURGE_INTERVAL_MS, mode: 'auto' });
    if (later.ok) expect(later.value).toBe(1);
    const meta = await db.get('meta', 'meta');
    if (meta.ok) expect(meta.value?.lastPurgeAt).toBe(NOW + PURGE_INTERVAL_MS);
  });

  it('auto: runs on first pass when lastPurgeAt is absent', async () => {
    const db = await fixture(makeMeta());
    await db.put('tasks', makeTask({ deletedAt: NOW - TOMBSTONE_TTL_MS - 1 }));
    const result = await purgeTombstones(db, { now: NOW, mode: 'auto' });
    if (result.ok) expect(result.value).toBe(1);
  });

  it('explicit "Clean up storage": purges ALL tombstones immediately', async () => {
    const db = await fixture(makeMeta({ lastPurgeAt: NOW })); // even while throttled
    const freshTomb = makeTask({ deletedAt: NOW - 1000 });
    const oldTomb = makeTask({ deletedAt: NOW - TOMBSTONE_TTL_MS - 1 });
    const live = makeTask();
    for (const row of [freshTomb, oldTomb, live]) await db.put('tasks', row);

    const result = await purgeTombstones(db, { now: NOW, mode: 'explicit' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(2);

    const rows = await db.getAll('tasks');
    if (rows.ok) expect(rows.value.map((t) => t.id)).toEqual([live.id]);
    // Explicit mode does not stamp lastPurgeAt (it is not the throttle pass).
    const meta = await db.get('meta', 'meta');
    if (meta.ok) expect(meta.value?.lastPurgeAt).toBe(NOW);
  });

  it('propagates QUOTA_EXCEEDED instead of silently dropping the pass', async () => {
    // Auto mode stamps meta.lastPurgeAt in the pass transaction — a
    // quota-exhausted write must surface as the typed error, never vanish.
    const db = await fixture(makeMeta({ lastPurgeAt: 0 }));
    const restore = injectQuotaOnPuts();
    try {
      const result = await purgeTombstones(db, { now: NOW, mode: 'auto' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('QUOTA_EXCEEDED');
    } finally {
      restore();
    }
  });

  it('auto pass is atomic (D6): a stamp failure rolls the deletions back', async () => {
    const db = await fixture(makeMeta({ lastPurgeAt: 0 }));
    await db.put('tasks', makeTask({ deletedAt: NOW - TOMBSTONE_TTL_MS - 1 }));
    const restore = injectQuotaOnPuts();
    try {
      const result = await purgeTombstones(db, { now: NOW, mode: 'auto' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('QUOTA_EXCEEDED');
    } finally {
      restore();
    }
    // Nothing half-purged: deletions and the throttle stamp share one tx, so
    // the pass either commits completely or leaves the DB untouched.
    const rows = await db.getAll('tasks');
    expect(rows.ok && rows.value).toHaveLength(1);
    const meta = await db.get('meta', 'meta');
    expect(meta.ok && meta.value?.lastPurgeAt).toBe(0); // stamp rolled back too
  });
});
