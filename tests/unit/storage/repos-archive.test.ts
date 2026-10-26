/**
 * TaskRepo.setArchived (S6, E9) over fake-indexeddb — the persisted half of
 * the archive/restore contract: one put inside one readwrite transaction,
 * `completedAt` preserved on archive and backfilled on restore, and the
 * legal-pair guard writing NOTHING for an illegal source state.
 */
import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import type { Task, TaskDraft } from '../../../src/domain/model';
import { openForTests } from '../../../src/storage/db';
import { createErrorLog } from '../../../src/storage/errorLog';
import { newUlid } from '../../../src/storage/id';
import { TaskRepo } from '../../../src/storage/repos/taskRepo';
import { T0, uniqueDbName } from './fixtures';

async function setup(prefix: string) {
  const opened = await openForTests({ dbName: uniqueDbName(prefix) });
  if (!opened.ok) throw new Error(`open failed: ${JSON.stringify(opened.error)}`);
  let now = T0;
  let seq = 0;
  const deps = {
    db: opened.value,
    clock: () => now,
    ids: () => {
      seq += 1;
      return newUlid(T0 + seq);
    },
    errorLog: createErrorLog(),
  };
  return {
    db: opened.value,
    tasks: new TaskRepo(deps),
    setNow: (t: number) => {
      now = t;
    },
  };
}

function draft(over: Partial<TaskDraft> = {}): TaskDraft {
  return { listId: 'L', title: 'Write tests', notes: null, priority: 'P3', tags: [], ...over };
}

/** A created list id (tasks validate listId as a ULID). */
async function seedListId(h: Awaited<ReturnType<typeof setup>>): Promise<string> {
  const id = newUlid(T0);
  await h.db.put('lists', {
    id,
    name: 'Inbox',
    color: '#336699',
    sortOrder: 'h',
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    deviceId: '0'.repeat(26),
  });
  return id;
}

/** Raw persisted row (unwrapped `db.get`). */
async function readTask(h: Awaited<ReturnType<typeof setup>>, id: string) {
  const r = await h.db.get('tasks', id);
  if (!r.ok) throw new Error(`read failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

describe('TaskRepo.setArchived (S6)', () => {
  it('archive: done → archived PRESERVING completedAt verbatim', async () => {
    const h = await setup('repo-archive');
    const listId = await seedListId(h);
    const created = await h.tasks.create(draft({ listId }));
    if (!created.ok) throw new Error('create failed');
    h.setNow(T0 + 100);
    const done = await h.tasks.setDone(created.value.id, true);
    if (!done.ok) throw new Error('setDone failed');
    expect(done.value.completedAt).toBe(T0 + 100);

    h.setNow(T0 + 5_000);
    const archived = await h.tasks.setArchived(created.value.id, true);
    expect(archived.ok).toBe(true);
    if (!archived.ok) return;
    expect(archived.value.status).toBe('archived');
    expect(archived.value.completedAt).toBe(T0 + 100); // original finish time, not "now"
    expect(archived.value.updatedAt).toBe(T0 + 5_000); // restamped like every write

    // The row PERSISTED as archived (read-back through a fresh transaction).
    const read = await readTask(h, created.value.id);
    expect(read?.status).toBe('archived');
    expect(read?.completedAt).toBe(T0 + 100);
  });

  it('restore: archived → done, backfilling completedAt only when the stamp is missing', async () => {
    const h = await setup('repo-restore');
    const listId = await seedListId(h);
    const created = await h.tasks.create(draft({ listId }));
    if (!created.ok) throw new Error('create failed');
    h.setNow(T0 + 100);
    await h.tasks.setDone(created.value.id, true);
    await h.tasks.setArchived(created.value.id, true);

    h.setNow(T0 + 9_000);
    const restored = await h.tasks.setArchived(created.value.id, false);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value.status).toBe('done');
    expect(restored.value.completedAt).toBe(T0 + 100); // kept, not restamped

    // A lost stamp gets backfilled so the retention partition can bucket it.
    const stamped = restored.value;
    await h.tasks.setArchived(stamped.id, true);
    const lost: Task = { ...stamped, status: 'archived' };
    delete lost.completedAt;
    const written = await h.tasks.upsertImported([lost]);
    if (!written.ok) throw new Error('upsert failed');
    h.setNow(T0 + 12_000);
    const backfilled = await h.tasks.setArchived(stamped.id, false);
    expect(backfilled.ok).toBe(true);
    if (!backfilled.ok) return;
    expect(backfilled.value.completedAt).toBe(T0 + 12_000);
  });

  it('rejects the illegal source states with TASK_STATUS_INVALID and writes nothing', async () => {
    const h = await setup('repo-archive-guard');
    const listId = await seedListId(h);
    const created = await h.tasks.create(draft({ listId }));
    if (!created.ok) throw new Error('create failed');

    // OPEN → archive is not a transition S6 offers.
    const archiveOpen = await h.tasks.setArchived(created.value.id, true);
    expect(archiveOpen.ok).toBe(false);
    if (!archiveOpen.ok) {
      expect(archiveOpen.error).toMatchObject({ code: 'RULE', rule: 'TASK_STATUS_INVALID' });
    }

    // DONE → restore is not a silent uncomplete.
    await h.tasks.setDone(created.value.id, true);
    const restoreDone = await h.tasks.setArchived(created.value.id, false);
    expect(restoreDone.ok).toBe(false);
    if (!restoreDone.ok) {
      expect(restoreDone.error).toMatchObject({ code: 'RULE', rule: 'TASK_STATUS_INVALID' });
    }
    const read = await readTask(h, created.value.id);
    expect(read?.status).toBe('done'); // untouched by both rejected writes
  });

  it('treats an absent or tombstoned row as TASK_MISSING', async () => {
    const h = await setup('repo-archive-missing');
    const listId = await seedListId(h);
    const created = await h.tasks.create(draft({ listId }));
    if (!created.ok) throw new Error('create failed');

    const missing = await h.tasks.setArchived('0'.repeat(26), true);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatchObject({ code: 'RULE', rule: 'TASK_MISSING' });

    await h.tasks.remove(created.value.id, { mode: 'cascade' });
    const tombstoned = await h.tasks.setArchived(created.value.id, true);
    expect(tombstoned.ok).toBe(false);
    if (!tombstoned.ok) {
      expect(tombstoned.error).toMatchObject({ code: 'RULE', rule: 'TASK_MISSING' });
    }
  });
});
