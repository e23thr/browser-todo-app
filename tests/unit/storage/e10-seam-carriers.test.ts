/**
 * E10-Q6 carriers beyond import/restore (t_a155ebf2, ADR-007 Decision 4.6):
 * the seam transform must never run inside a live IndexedDB transaction ANYWHERE
 * — repo write/read-modify-write paths, the tombstone purge, and the boot
 * migration chain included.
 *
 * The probe seam here is the one from `tests/unit/portability/apply.test.ts`
 * E10-Q6 describe: readRow/writeRow cross a MACROTASK boundary, which is
 * strictly harder on a live transaction than firefox/webkit's WebCrypto (and
 * exactly where the real engines deactivate the tx). On fake-indexeddb every
 * carrier below FAILS with the old seamed-in-tx code (InvalidStateError on the
 * continuation) and passes once the carriers stage outside / run `txRaw` —
 * the same RED/GREEN the e2e seamed-tx probe pins per engine.
 */
import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import type { TaskDraft } from '../../../src/domain/model';
import { isRuleError } from '../../../src/domain/kernel';
import { boot, resetBootSingleton } from '../../../src/storage/boot';
import type { AppDBImpl } from '../../../src/storage/db';
import {
  resetRowCryptoSeam,
  setRowCryptoSeam,
  type RowCryptoSeam,
} from '../../../src/storage/cryptoSeam';
import { newUlid } from '../../../src/storage/id';
import { purgeTombstones, TOMBSTONE_TTL_MS } from '../../../src/storage/purge';
import { RMW_ATTEMPTS, type RepoDeps } from '../../../src/storage/repos/support';
import { ListRepo } from '../../../src/storage/repos/listRepo';
import { TaskRepo } from '../../../src/storage/repos/taskRepo';
import type { Task } from '../../../src/storage/types';
import { APP_SCHEMA_VERSION } from '../../../src/storage/schema';
import { makeList, makeTask, openFixtureDb, T0, uniqueDbName } from './fixtures';

const opened: AppDBImpl[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  resetRowCryptoSeam();
});

async function openDb(prefix: string): Promise<AppDBImpl> {
  const db = await openFixtureDb(uniqueDbName(prefix));
  opened.push(db);
  return db;
}

/* -------------- the macrotask seam (apply.test.ts E10-Q6 pattern) -------------- */

type SeamCall = { store: string; id: string };

function seamId(row: unknown): string {
  const raw = (row as { id?: unknown }).id;
  return typeof raw === 'string' ? raw : '';
}

function macrotaskSeam(options: {
  calls: SeamCall[];
  onReadRow?: (store: string, id: string) => void | Promise<void>;
}): RowCryptoSeam {
  return {
    readRow: async (store, row) => {
      const id = seamId(row);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await options.onReadRow?.(store, id);
      // Faithful to the real seam: the at-rest marker is dropped on read, so
      // the domain view stays a clean domain row (validateTask rejects unknown
      // fields — the marker must not survive decryption).
      const view = { ...(row as Record<string, unknown>) };
      delete view['sealedBySeam'];
      return { ok: true, value: view };
    },
    writeRow: async (store, row) => {
      const id = seamId(row);
      options.calls.push({ store, id });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return { ok: true, value: { ...(row as Record<string, unknown>), sealedBySeam: id } };
    },
  };
}

function repoDeps(db: AppDBImpl, startAt = T0) {
  let clock = startAt;
  return {
    db,
    clock: (): number => (clock += 1000),
    ids: (): string => newUlid(T0),
  };
}

function draft(listId: string, title: string): TaskDraft {
  return { listId, title, notes: null, priority: 'P3', tags: [] };
}

/* -------------- the repo write path (add + patch + setDone + remove) -------------- */

describe('repo layer — stage-then-txRaw under a macrotask seam (ADR-007 D4.6)', () => {
  it('create/patch/setDone/remove and list create/rename all land (reads via the safe surface)', async () => {
    const db = await openDb('seam-repo');
    const calls: SeamCall[] = [];
    setRowCryptoSeam(macrotaskSeam({ calls }));

    const deps = repoDeps(db);
    const tasks = new TaskRepo(deps);
    const lists = new ListRepo(deps);

    const list = await lists.create({ name: 'Seam list', color: '#336699' });
    expect(list.ok, `list create failed: ${JSON.stringify(list)}`).toBe(true);
    if (!list.ok) return;

    const created = await tasks.create(draft(list.value.id, 'seam task'));
    expect(created.ok, `task create failed: ${JSON.stringify(created)}`).toBe(true);
    if (!created.ok) return;

    const patched = await tasks.patch(created.value.id, { title: 'seam task v2' });
    expect(patched.ok, `patch failed: ${JSON.stringify(patched)}`).toBe(true);

    const done = await tasks.setDone(created.value.id, true);
    expect(done.ok, `setDone failed: ${JSON.stringify(done)}`).toBe(true);
    if (done.ok) expect(done.value.status).toBe('done');

    const renamed = await lists.rename(list.value.id, 'Seam list renamed');
    expect(renamed.ok, `rename failed: ${JSON.stringify(renamed)}`).toBe(true);

    const removed = await tasks.remove(created.value.id, { mode: 'cascade' });
    expect(removed.ok, `remove failed: ${JSON.stringify(removed)}`).toBe(true);
    if (removed.ok) expect(removed.value.tombstoned.map((t) => t.id)).toEqual([created.value.id]);

    // Every seamed store row was sealed OUTSIDE the tx and written verbatim.
    const rawTasks = await db.readUnfiltered('tasks');
    const rawLists = await db.readUnfiltered('lists');
    expect(rawTasks.ok && rawTasks.value).toHaveLength(1);
    expect(rawLists.ok && rawLists.value).toHaveLength(1);
    for (const row of [
      ...(rawTasks.ok ? rawTasks.value : []),
      ...(rawLists.ok ? rawLists.value : []),
    ]) {
      expect((row as { sealedBySeam?: string }).sealedBySeam).toBe(row.id);
    }
    const tomb = rawTasks.ok ? rawTasks.value[0] : undefined;
    expect(tomb?.deletedAt).not.toBeNull(); // the tombstone landed too

    // Domain reads decrypt after their own tx — the store still reads correctly.
    const loaded = await tasks.loadAll();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.tasks).toHaveLength(0); // tombstoned rows are filtered
    expect(loaded.value.lists.map((l) => l.name)).toEqual(['Seam list renamed']);
  });

  it('completeRecurring (done + successor) and restore (S7 undo) survive the seam', async () => {
    const db = await openDb('seam-recurring');
    const calls: SeamCall[] = [];
    setRowCryptoSeam(macrotaskSeam({ calls }));

    const deps = repoDeps(db);
    const tasks = new TaskRepo(deps);
    const list = await new ListRepo(deps).create({ name: 'Recur list', color: '#336699' });
    if (!list.ok) throw new Error('seed list failed');
    const created = await tasks.create(draft(list.value.id, 'water plants'));
    if (!created.ok) throw new Error('seed task failed');

    // S4: done + successor in ONE transaction, both rows staged outside.
    const rec = await tasks.completeRecurring(created.value.id, {
      ...draft(list.value.id, 'water plants (next)'),
      recurrence: { freq: 'weekly', interval: 1 },
    });
    expect(rec.ok, `completeRecurring failed: ${JSON.stringify(rec)}`).toBe(true);
    if (!rec.ok) return;
    expect(rec.value.done.status).toBe('done');
    expect(rec.value.created.status).toBe('open');
    expect(rec.value.created.title).toBe('water plants (next)');
    expect(rec.value.created.recurrence).toEqual({ freq: 'weekly', interval: 1 });

    const both = await db.readUnfiltered('tasks');
    expect(both.ok && both.value).toHaveLength(2);
    for (const row of both.ok ? both.value : []) {
      expect((row as { sealedBySeam?: string }).sealedBySeam).toBe(row.id);
    }

    // S7 undo: the captured before-image comes back, the occurrence is
    // tombstoned — ONE transaction, every row staged outside.
    const undone = await tasks.restore([created.value], [rec.value.created.id]);
    expect(undone.ok, `restore failed: ${JSON.stringify(undone)}`).toBe(true);
    if (!undone.ok) return;
    expect(undone.value.restored.map((t) => t.id)).toEqual([created.value.id]);
    expect(undone.value.tombstoned.map((t) => t.id)).toEqual([rec.value.created.id]);

    const after = await db.readUnfiltered('tasks');
    expect(after.ok && after.value).toHaveLength(2);
    for (const row of after.ok ? after.value : []) {
      expect((row as { sealedBySeam?: string }).sealedBySeam).toBe(row.id);
    }
    // Domain view: exactly the restored task is live again.
    const loaded = await tasks.loadAll();
    expect(loaded.ok && loaded.value.tasks.map((t) => t.title)).toEqual(['water plants']);
  });

  it('setArchived (S6) survives the seam — legal-pair guard re-runs on the fresh row', async () => {
    const db = await openDb('seam-archive');
    const calls: SeamCall[] = [];
    setRowCryptoSeam(macrotaskSeam({ calls }));

    const deps = repoDeps(db);
    const tasks = new TaskRepo(deps);
    const list = await new ListRepo(deps).create({ name: 'Archive list', color: '#336699' });
    if (!list.ok) throw new Error('seed list failed');
    const created = await tasks.create(draft(list.value.id, 'ship it'));
    if (!created.ok) throw new Error('seed task failed');

    // Illegal pair first: archiving an OPEN task writes nothing.
    const illegal = await tasks.setArchived(created.value.id, true);
    expect(illegal.ok).toBe(false);
    if (!illegal.ok)
      expect(isRuleError(illegal.error) && illegal.error.rule).toBe('TASK_STATUS_INVALID');
    const untouched = await db.readUnfiltered('tasks');
    expect(untouched.ok && untouched.value).toHaveLength(1);
    expect((untouched.ok ? untouched.value[0] : undefined) as { sealedBySeam?: string }).toEqual(
      expect.objectContaining({ sealedBySeam: created.value.id }),
    );

    const done = await tasks.setDone(created.value.id, true);
    if (!done.ok) throw new Error('setDone failed');
    const archived = await tasks.setArchived(created.value.id, true);
    expect(archived.ok, `setArchived failed: ${JSON.stringify(archived)}`).toBe(true);
    if (archived.ok) {
      expect(archived.value.status).toBe('archived');
      expect(archived.value.completedAt).toBe(done.value.completedAt); // preserved verbatim
    }

    // The archived row was staged outside and committed verbatim in txRaw.
    const raw = await db.readUnfiltered('tasks');
    expect(raw.ok && raw.value).toHaveLength(1);
    expect((raw.ok ? raw.value[0] : undefined) as { sealedBySeam?: string }).toEqual(
      expect.objectContaining({ sealedBySeam: created.value.id }),
    );
  });

  it('move (single-row RMW) and the rebalance hatch survive the seam', async () => {
    const db = await openDb('seam-move');
    const calls: SeamCall[] = [];
    setRowCryptoSeam(macrotaskSeam({ calls }));

    const deps = repoDeps(db);
    const tasks = new TaskRepo(deps);
    const list = await new ListRepo(deps).create({ name: 'Move list', color: '#336699' });
    if (!list.ok) throw new Error('seed list failed');
    const a = await tasks.create(draft(list.value.id, 'alpha'));
    const b = await tasks.create(draft(list.value.id, 'bravo'));
    if (!a.ok || !b.ok) throw new Error('seed tasks failed');

    const moved = await tasks.move(b.value.id, {
      group: { listId: list.value.id, parentTaskId: null },
      position: 'first',
    });
    expect(moved.ok, `move failed: ${JSON.stringify(moved)}`).toBe(true);
    if (moved.ok) expect(moved.value.row.id).toBe(b.value.id);
  });
});

/* -------------- the at-rest CAS guard (single-row RMW, t_ccdabf50 ruling) -------------- */

describe('at-rest CAS guard — base bytes compared inside the ONE txRaw, bounded repo retry', () => {
  it('a matching base commits the sealed merge (seam never inside the tx)', async () => {
    const db = await openDb('guard-match');
    const calls: SeamCall[] = [];
    const base = makeTask({ id: newUlid(T0), updatedAt: T0 });
    await db.put('tasks', base); // sealed outside any tx by putWith

    setRowCryptoSeam(macrotaskSeam({ calls }));
    const repo = new TaskRepo(repoDeps(db));
    const patched = await repo.patch(base.id, { title: 'merged' });
    expect(patched.ok, `guarded put failed: ${JSON.stringify(patched)}`).toBe(true);

    const raw = await db.readUnfiltered('tasks');
    const row = raw.ok ? raw.value.find((r) => r.id === base.id) : undefined;
    expect(row).toBeDefined();
    expect((row as { sealedBySeam?: string }).sealedBySeam).toBe(base.id);
    expect((row as unknown as Task).title).toBe('merged');
  });

  it('a concurrent write conflicts; the bounded retry re-applies onto the fresh row', async () => {
    const db = await openDb('guard-race');
    const calls: SeamCall[] = [];
    const base = makeTask({ id: newUlid(T0), updatedAt: T0 });
    await db.put('tasks', base);

    // While patch's ONE read decrypts the base (outside any tx), a concurrent
    // writer commits a different-field version — the merge below was based on
    // the pre-write bytes, so the CAS must conflict and re-apply.
    let raced = false;
    setRowCryptoSeam(
      macrotaskSeam({
        calls,
        onReadRow: (store, id) => {
          if (!raced && store === 'tasks' && id === base.id) {
            raced = true;
            return db
              .put('tasks', { ...base, notes: 'raced notes', updatedAt: T0 + 5 })
              .then(() => undefined);
          }
          return undefined;
        },
      }),
    );

    const repo = new TaskRepo(repoDeps(db));
    const patched = await repo.patch(base.id, { title: 'mine' });
    expect(patched.ok, `patch lost the race: ${JSON.stringify(patched)}`).toBe(true);

    // The retry merged onto the FRESH row: both writes survive, none lost.
    const loaded = await repo.loadAll();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const row = loaded.value.tasks.find((t) => t.id === base.id);
    expect(row?.title).toBe('mine');
    expect(row?.notes).toBe('raced notes');
  });

  it('EQUAL-STAMP collision (frozen clock) still CAS-conflicts — never a silent lost update', async () => {
    const db = await openDb('guard-equal-stamp');
    const calls: SeamCall[] = [];
    const base = makeTask({ id: newUlid(T0), updatedAt: T0 });
    await db.put('tasks', base);

    // The concurrent writer stamps the SAME `updatedAt` (frozen clock — the
    // exact residual that made the old envelope-stamp guard blind: equal
    // stamps looked "unchanged"). The at-rest CAS compares BYTES, so the
    // collision is visible regardless of stamps.
    let raced = false;
    setRowCryptoSeam(
      macrotaskSeam({
        calls,
        onReadRow: (store, id) => {
          if (!raced && store === 'tasks' && id === base.id) {
            raced = true;
            return db
              .put('tasks', { ...base, notes: 'from-race', updatedAt: T0 })
              .then(() => undefined);
          }
          return undefined;
        },
      }),
    );

    const frozen: RepoDeps = { db, clock: () => T0, ids: () => newUlid(T0) };
    const repo = new TaskRepo(frozen);
    const patched = await repo.patch(base.id, { title: 'mine' });
    expect(patched.ok, `equal-stamp collision silently lost: ${JSON.stringify(patched)}`).toBe(
      true,
    );

    // Both writers stamped T0; the race write's bytes were never dropped.
    const loaded = await repo.loadAll();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const row = loaded.value.tasks.find((t) => t.id === base.id);
    expect(row?.title).toBe('mine');
    expect(row?.notes).toBe('from-race');
    expect(row?.updatedAt).toBe(T0); // the equal stamp stayed equal — bytes did the guarding
  });

  it('retries exhausted surface the typed retryable STALE_WRITE — the write never lands', async () => {
    const db = await openDb('guard-exhausted');
    const calls: SeamCall[] = [];
    const base = makeTask({ id: newUlid(T0), updatedAt: T0 });
    await db.put('tasks', base);

    // A writer that conflicts on EVERY attempt (fresh bytes each read): the
    // bounded loop must stop and surface the typed error, not loop forever.
    let reads = 0;
    setRowCryptoSeam(
      macrotaskSeam({
        calls,
        onReadRow: (store, id) => {
          if (store === 'tasks' && id === base.id) {
            reads += 1;
            return db
              .put('tasks', { ...base, notes: `raced-${String(reads)}`, updatedAt: T0 + reads })
              .then(() => undefined);
          }
          return undefined;
        },
      }),
    );

    const repo = new TaskRepo(repoDeps(db));
    const patched = await repo.patch(base.id, { title: 'mine' });
    expect(patched.ok).toBe(false);
    if (!patched.ok) {
      expect(patched.error.code).toBe('RULE');
      if (isRuleError(patched.error)) expect(patched.error.rule).toBe('STALE_WRITE');
    }
    expect(reads).toBe(RMW_ATTEMPTS); // bounded — exactly the retry budget

    // The racing writer's LAST write survives; ours never landed.
    const raw = await db.readUnfiltered('tasks');
    const row = raw.ok ? raw.value.find((r) => r.id === base.id) : undefined;
    expect((row as unknown as Task).title).toBe('Write tests');
    expect((row as unknown as Task).notes).toBe(`raced-${String(RMW_ATTEMPTS)}`);
  });

  it('a vanished base row never resurrects — the retry re-read fails TASK_MISSING', async () => {
    const db = await openDb('guard-vanished');
    const calls: SeamCall[] = [];
    const base = makeTask({ id: newUlid(T0), updatedAt: T0 });
    await db.put('tasks', base);
    setRowCryptoSeam(macrotaskSeam({ calls }));
    await db.delete('tasks', base.id);

    const repo = new TaskRepo(repoDeps(db));
    const patched = await repo.patch(base.id, { title: 'ghost' });
    expect(patched.ok).toBe(false);
    if (!patched.ok) {
      expect(patched.error.code).toBe('RULE');
      // The CAS conflict on the vanished row triggers the bounded re-read,
      // which finds nothing and fails like every other missing-row op.
      if (isRuleError(patched.error)) expect(patched.error.rule).toBe('TASK_MISSING');
    }
    const raw = await db.readUnfiltered('tasks');
    expect(raw.ok && raw.value).toHaveLength(0); // no resurrection
  });
});

/* -------------- purge.ts (carrier 2) -------------- */

describe('purgeTombstones — no crypto inside the purge transaction', () => {
  const NOW = T0 + 100 * 24 * 60 * 60 * 1000;

  it('explicit mode purges tombstones under a macrotask seam (txRaw swap)', async () => {
    const db = await openDb('seam-purge-explicit');
    const old = makeTask({
      id: newUlid(T0),
      updatedAt: NOW - TOMBSTONE_TTL_MS - 5000,
      deletedAt: NOW - TOMBSTONE_TTL_MS - 5000,
    });
    await db.put('tasks', old);
    // Recent tombstone: explicit mode purges it too (S11 ignores the TTL).
    await db.put('tasks', makeTask({ id: newUlid(T0), deletedAt: NOW - 1000 }));
    const live = makeTask({ id: newUlid(T0) });
    await db.put('tasks', live);
    const listTomb = makeList({ id: newUlid(T0), deletedAt: NOW - TOMBSTONE_TTL_MS - 1000 });
    await db.put('lists', listTomb);

    const calls: SeamCall[] = [];
    setRowCryptoSeam(macrotaskSeam({ calls }));

    const purged = await purgeTombstones(db, { now: NOW, mode: 'explicit' });
    expect(purged.ok, `explicit purge failed: ${JSON.stringify(purged)}`).toBe(true);
    if (!purged.ok) return;
    // Explicit purges ALL tombstones regardless of age (S11): old + recent task
    // tombstones and the list tombstone.
    expect(purged.value).toBe(3);

    const tasks = await db.readUnfiltered('tasks');
    const lists = await db.readUnfiltered('lists');
    expect(tasks.ok && tasks.value.map((r) => r.id)).toEqual([live.id]);
    expect(lists.ok && lists.value).toHaveLength(0);
    // Purge only ever deletes: the seam's writeRow never ran at all.
    expect(calls).toHaveLength(0);
  });

  it('auto mode still stamps meta.lastPurgeAt in the SAME transaction under the seam', async () => {
    const db = await openDb('seam-purge-auto');
    const old = makeTask({
      id: newUlid(T0),
      updatedAt: NOW - TOMBSTONE_TTL_MS - 5000,
      deletedAt: NOW - TOMBSTONE_TTL_MS - 5000,
    });
    await db.put('tasks', old);
    const meta = await db.get('meta', 'meta');
    if (meta.ok && meta.value !== undefined) {
      await db.put('meta', { ...meta.value, lastPurgeAt: 0 });
    }

    const calls: SeamCall[] = [];
    setRowCryptoSeam(macrotaskSeam({ calls }));

    const purged = await purgeTombstones(db, { now: NOW, mode: 'auto' });
    expect(purged.ok, `auto purge failed: ${JSON.stringify(purged)}`).toBe(true);
    if (!purged.ok) return;
    expect(purged.value).toBe(1);
    const after = await db.get('meta', 'meta');
    expect(after.ok && after.value?.lastPurgeAt).toBe(NOW);
    expect(calls).toHaveLength(0);
  });
});

/* -------------- migrations.ts toSchemaVersion3 (carrier 3) -------------- */

describe('boot migration chain — steps run over AT-REST rows (txRaw)', () => {
  afterEach(() => {
    resetBootSingleton();
  });

  it('a schemaVersion-2 database migrates to the current schema with a live macrotask seam', async () => {
    const name = uniqueDbName('seam-boot');

    // Build a pre-C1 store: schemaVersion 2 (the `crypto_state` store does not
    // even exist below idbVersion 3, so C1 cannot be on — the v3 step cannot
    // meet ciphertext rows; this probe pins that the chain also survives a
    // REGISTERED seam, because its steps see at-rest bytes via txRaw).
    const first = await openFixtureDb(name);
    const meta = await first.get('meta', 'meta');
    if (!meta.ok || meta.value === undefined) throw new Error('meta seed failed');
    await first.put('meta', { ...meta.value, schemaVersion: 2 });
    const legacy: Record<string, unknown> = {
      ...(makeTask({ id: newUlid(T0) }) as unknown as Record<string, unknown>),
      priority: 2, // legacy MVP encoding: 2 = High -> P1 per legacyPriorityToLevel
    };
    delete legacy['tags'];
    await first.put('tasks', legacy as unknown as Task);
    first.close();

    const calls: SeamCall[] = [];
    setRowCryptoSeam(macrotaskSeam({ calls }));

    const booted = await boot({ dbName: name, now: () => T0 });
    expect(booted.ok, `boot/migration failed: ${JSON.stringify(booted)}`).toBe(true);
    if (!booted.ok) return;
    expect(booted.value.bootReport.migrated).toEqual({
      from: 2,
      to: APP_SCHEMA_VERSION,
    });
    opened.push(booted.value as AppDBImpl);

    const row = await booted.value.get('tasks', legacy['id'] as string);
    expect(row.ok).toBe(true);
    if (!row.ok || row.value === undefined) return;
    expect((row.value as unknown as { priority: string }).priority).toBe('P1');
    expect((row.value as unknown as { tags: string[] }).tags).toEqual([]);
    // The step tx wrote at-rest bytes verbatim: the seam never ran in it.
    expect(calls).toHaveLength(0);
  });
});
