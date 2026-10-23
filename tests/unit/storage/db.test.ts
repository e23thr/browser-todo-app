import { afterEach, describe, expect, it } from 'vitest';

import { AppDBImpl, openForTests, openRawAppDB } from '../../../src/storage/db';
import { classifyUnknown } from '../../../src/storage/errors';
import type { Result } from '../../../src/storage/errors';
import { STORE_DEFS } from '../../../src/storage/schema';

import {
  injectQuotaOnPuts,
  makeMeta,
  makeTask,
  openFixtureDb,
  quotaError,
  uniqueDbName,
} from './fixtures';

function rawOpen(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name);
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(new Error(`raw open failed: ${String(req.error)}`));
    };
    req.onblocked = () => {
      reject(new Error('blocked'));
    };
  });
}

const opened: AppDBImpl[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

async function fixture(name: string): Promise<AppDBImpl> {
  const db = await openFixtureDb(name);
  opened.push(db);
  return db;
}

describe('wrapper schema conformance (ADR-002 Decision 3)', () => {
  it('creates exactly the ADR stores, key paths, and indexes', async () => {
    const name = uniqueDbName('schema');
    const openedRes = await openRawAppDB({ dbName: name });
    expect(openedRes.ok).toBe(true);
    if (!openedRes.ok) return;
    openedRes.value.close();

    const raw = await rawOpen(name);
    try {
      const expected = [...STORE_DEFS].map((d) => d.name).sort();
      const actual = [...raw.objectStoreNames].sort();
      expect(actual).toEqual(expected);

      for (const def of STORE_DEFS) {
        const tx = raw.transaction(def.name, 'readonly');
        const store = tx.objectStore(def.name);
        expect(store.keyPath).toBe(def.keyPath);
        const idxNames = [...store.indexNames].sort();
        expect(idxNames).toEqual(def.indexes.map((i) => i.name).sort());
        for (const idx of def.indexes) {
          expect(store.index(idx.name).keyPath).toEqual(idx.keyPath);
        }
        tx.abort();
      }
    } finally {
      raw.close();
    }
  });
});

describe('wrapper CRUD + query (ADR-002 §10.2/§10.3)', () => {
  it('put/get roundtrip; absence is ok(undefined), not an error', async () => {
    const db = await fixture(uniqueDbName('crud'));
    const task = makeTask();
    const put = await db.put('tasks', task);
    expect(put.ok).toBe(true);
    const got = await db.get('tasks', task.id);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value).toEqual(task);
    const missing = await db.get('tasks', 'missing');
    expect(missing.ok).toBe(true);
    if (missing.ok) expect(missing.value).toBeUndefined();
  });

  it('put is an upsert and never mutates the id', async () => {
    const db = await fixture(uniqueDbName('upsert'));
    const task = makeTask();
    await db.put('tasks', task);
    const updated = { ...task, title: 'changed' };
    await db.put('tasks', updated);
    const got = await db.get('tasks', task.id);
    if (got.ok) {
      expect(got.value?.title).toBe('changed');
      expect(got.value?.id).toBe(task.id);
    }
  });

  it('put rejects malformed primary keys with INVALID_RECORD', async () => {
    const db = await fixture(uniqueDbName('badkey'));
    const bad = await db.put('tasks', { ...makeTask(), id: 'nope' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('INVALID_RECORD');
    const badSettings = await db.put('settings', { id: 'other' } as never);
    expect(badSettings.ok).toBe(false);
  });

  it('meta and settings singletons use their fixed keys', async () => {
    const db = await fixture(uniqueDbName('singletons'));
    await db.put('meta', makeMeta());
    const meta = await db.get('meta', 'meta');
    expect(meta.ok).toBe(true);
    if (meta.ok) expect(meta.value?.schemaVersion).toBe(1);
  });

  it('query supports index eq, ranges, direction, and cursor-level limit', async () => {
    const db = await fixture(uniqueDbName('query'));
    const listId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const t1 = makeTask({ listId, sortOrder: 'h', updatedAt: 1 });
    const t2 = makeTask({ listId, sortOrder: 'm', updatedAt: 2 });
    const t3 = makeTask({ listId, sortOrder: 't', updatedAt: 3 });
    const other = makeTask({ listId: '01ARZ3NDEKTSV4RRFFQ69G5FB0', sortOrder: 'h', updatedAt: 4 });
    for (const t of [t1, t2, t3, other]) await db.put('tasks', t);

    const eq = await db.query('tasks', { index: 'by_listId', range: { eq: listId } });
    expect(eq.ok).toBe(true);
    if (eq.ok) expect(eq.value.map((t) => t.id).sort()).toEqual([t1.id, t2.id, t3.id].sort());

    const bounded = await db.query('tasks', {
      index: 'by_updatedAt',
      range: { lower: 2, upper: 3 },
    });
    if (bounded.ok) expect(bounded.value.map((t) => t.updatedAt)).toEqual([2, 3]);

    const openRange = await db.query('tasks', {
      index: 'by_updatedAt',
      range: { lower: 2, lowerOpen: true },
    });
    if (openRange.ok) expect(openRange.value.map((t) => t.updatedAt)).toEqual([3, 4]);

    const prev = await db.query('tasks', { index: 'by_updatedAt', direction: 'prev', limit: 2 });
    if (prev.ok) expect(prev.value.map((t) => t.updatedAt)).toEqual([4, 3]);

    const capped = await db.query('tasks', { index: 'by_updatedAt', limit: 1 });
    if (capped.ok) expect(capped.value).toHaveLength(1);

    const all = await db.getAll('tasks');
    if (all.ok) expect(all.value).toHaveLength(4);
  });

  it('delete is a HARD delete (purge/import paths only)', async () => {
    const db = await fixture(uniqueDbName('del'));
    const task = makeTask();
    await db.put('tasks', task);
    const deleted = await db.delete('tasks', task.id);
    expect(deleted.ok).toBe(true);
    const gone = await db.get('tasks', task.id);
    if (gone.ok) expect(gone.value).toBeUndefined();
  });
});

describe('tx semantics (ADR-002 §10.3)', () => {
  it('commits when fn resolves ok', async () => {
    const db = await fixture(uniqueDbName('tx-commit'));
    const task = makeTask();
    const result = await db.tx(['tasks'], 'readwrite', async (t) => {
      await t.put('tasks', task);
      return { ok: true as const, value: 'done' };
    });
    expect(result).toEqual({ ok: true, value: 'done' });
    const got = await db.get('tasks', task.id);
    if (got.ok) expect(got.value).toEqual(task);
  });

  it('aborts and preserves the inner error when fn resolves err', async () => {
    const db = await fixture(uniqueDbName('tx-abort'));
    const task = makeTask();
    const inner = invalidRecordErr();
    const result = await db.tx(['tasks'], 'readwrite', async (t) => {
      await t.put('tasks', task);
      return inner;
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_RECORD');
    const gone = await db.get('tasks', task.id);
    if (gone.ok) expect(gone.value).toBeUndefined(); // rolled back
  });

  it('aborts and classifies when fn throws', async () => {
    const db = await fixture(uniqueDbName('tx-throw'));
    const task = makeTask();
    const result = await db.tx(['tasks'], 'readwrite', async (t) => {
      await t.put('tasks', task);
      throw new Error('boom');
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNKNOWN');
    const gone = await db.get('tasks', task.id);
    if (gone.ok) expect(gone.value).toBeUndefined();
  });

  it('propagates QuotaExceededError from inside a transaction, never swallowed', async () => {
    const db = await fixture(uniqueDbName('tx-quota'));
    const restore = injectQuotaOnPuts();
    try {
      const result = await db.tx(['tasks'], 'readwrite', async (t) => {
        await t.put('tasks', makeTask());
        return { ok: true as const, value: undefined };
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('QUOTA_EXCEEDED');
    } finally {
      restore();
    }
  });

  it('rejects empty store lists without throwing', async () => {
    const db = await fixture(uniqueDbName('tx-empty'));
    const result = await db.tx([], 'readwrite', async () => ({ ok: true as const, value: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNKNOWN');
  });

  it('Tx read surface sees uncommitted writes inside the same transaction', async () => {
    const db = await fixture(uniqueDbName('tx-read'));
    const task = makeTask();
    await db.tx(['tasks'], 'readwrite', async (t) => {
      await t.put('tasks', task);
      const seen = await t.get('tasks', task.id);
      expect(seen).toEqual(task);
      const all = await t.getAll('tasks', { index: 'by_listId', range: { eq: task.listId } });
      expect(all.map((x) => x.id)).toContain(task.id);
      await t.delete('tasks', task.id);
      const afterDelete = await t.get('tasks', task.id);
      expect(afterDelete).toBeUndefined();
      return { ok: true as const, value: undefined };
    });
  });
});

describe('QuotaExceededError surfacing (§5.5 — never a silent write drop)', () => {
  it('maps to QUOTA_EXCEEDED on the put surface', async () => {
    const db = await fixture(uniqueDbName('quota-put'));
    const restore = injectQuotaOnPuts();
    try {
      const result = await db.put('tasks', makeTask());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('QUOTA_EXCEEDED');
        expect((result.error as { cause?: unknown }).cause).toBeDefined();
      }
    } finally {
      restore();
    }
  });

  it('keeps the typed cause through classifyUnknown even for wrapped errors', () => {
    const wrapped = quotaError();
    expect(classifyUnknown(wrapped).code).toBe('QUOTA_EXCEEDED');
    expect(classifyUnknown(wrapped)).toHaveProperty('cause');
  });
});

function invalidRecordErr(): Result<never, { code: 'INVALID_RECORD'; store: 'tasks'; issues: string[] }> {
  return { ok: false, error: { code: 'INVALID_RECORD', store: 'tasks', issues: ['nope'] } };
}

describe('unavailable + lifecycle', () => {
  it('reports UNAVAILABLE when indexedDB is missing (private mode)', async () => {
    const globals = globalThis as unknown as { indexedDB?: IDBFactory | undefined };
    const original = globals.indexedDB;
    try {
      globals.indexedDB = undefined;
      const result = await openRawAppDB({ dbName: uniqueDbName('no-idb') });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('UNAVAILABLE');
    } finally {
      globals.indexedDB = original;
    }
  });

  it('closed AppDB refuses work with a typed error, close() is idempotent', async () => {
    const name = uniqueDbName('closed');
    const openedRes = await openForTests({ dbName: name });
    expect(openedRes.ok).toBe(true);
    if (!openedRes.ok) return;
    const db = openedRes.value;
    db.close();
    db.close();
    const got = await db.get('tasks', 'x');
    expect(got.ok).toBe(false);
    const put = await db.put('tasks', makeTask());
    expect(put.ok).toBe(false);
    const del = await db.delete('tasks', 'x');
    expect(del.ok).toBe(false);
    const all = await db.getAll('tasks');
    expect(all.ok).toBe(false);
    const t = await db.tx(['tasks'], 'readwrite', async () => ({ ok: true as const, value: 1 }));
    expect(t.ok).toBe(false);
  });
});

describe('quarantine denylist filtering (Decision 8 step 4)', () => {
  it('excludes quarantined rows from AppDB reads and Tx reads, but never from raw backup reads', async () => {
    const db = await fixture(uniqueDbName('deny'));
    const good = makeTask();
    const bad = makeTask();
    await db.put('tasks', good);
    await db.put('tasks', bad);
    db.setQuarantine([
      { store: 'tasks', key: bad.id, record: bad, issues: ['title: range'] },
    ]);

    const gotBad = await db.get('tasks', bad.id);
    if (gotBad.ok) expect(gotBad.value).toBeUndefined();
    const gotGood = await db.get('tasks', good.id);
    if (gotGood.ok) expect(gotGood.value).toEqual(good);

    const all = await db.getAll('tasks');
    if (all.ok) expect(all.value.map((t) => t.id)).toEqual([good.id]);

    const viaTx = await db.tx(['tasks'], 'readonly', async (t) => ({
      ok: true as const,
      value: await t.getAll('tasks'),
    }));
    if (viaTx.ok) expect(viaTx.value.map((t) => t.id)).toEqual([good.id]);

    const raw = await db.readUnfiltered('tasks');
    if (raw.ok) expect(raw.value).toHaveLength(2); // backup path keeps everything
  });
});
