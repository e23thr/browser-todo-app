/**
 * E7 QA probe (t_ed1fa949, h_reviewer) — M12 migration end-to-end through the
 * REAL `boot()` path with the REAL production registry (existing suites drive
 * `runMigrations` directly or boot with toy registries), plus a hand-rolled
 * v1 export JSON (raw literal, not built by current-version code) through the
 * import pipeline.
 *
 * Covers: priority remap on live AND tombstoned rows, stamps untouched (LWW),
 * pre-migration snapshot, boot validation quarantine-free, recurrence reserved
 * format, old-export upgrade to schemaVersion 3.
 */
import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import { boot, resetBootSingleton } from '../../../src/storage/boot';
import { APP_SCHEMA_VERSION } from '../../../src/storage/schema';
import type { AppDBImpl } from '../../../src/storage/db';
import { prepareImport } from '../../../src/portability/import';
import type { Task } from '../../../src/domain/model';
import { fixedNow, makeList, makeMeta, makeSettings, seedDb, uniqueDbName, T0 } from './fixtures';

const booted: AppDBImpl[] = [];
afterEach(() => {
  for (const db of booted.splice(0)) db.close();
  resetBootSingleton();
});

/** A v1 row: numeric priority, no tags field (MVP shape). */
function v1Task(over: Record<string, unknown>): Task {
  return {
    id: over['id'],
    listId: over['listId'],
    title: over['title'] ?? 'v1 task',
    notes: null,
    status: 'open',
    sortOrder: 'h',
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    deviceId: '0'.repeat(26),
    ...over,
  } as unknown as Task;
}

describe('QA-E7-M1: boot() end-to-end v1 → v3 (production registry)', () => {
  it('real boot migrates priorities (live + tombstoned), keeps stamps, snapshots first', async () => {
    const name = uniqueDbName('qa-e7-boot');
    const listId = '0'.repeat(26);
    await seedDb(name, {
      meta: makeMeta({ schemaVersion: 1 }),
      lists: [makeList({ id: listId })],
      settings: [makeSettings()],
      tasks: [
        v1Task({ id: 'A'.repeat(26), listId, title: 'high', priority: 2, tags: ['work'] }),
        v1Task({ id: 'B'.repeat(26), listId, title: 'medium', priority: 1 }),
        v1Task({ id: 'C'.repeat(26), listId, title: 'low', priority: 0 }),
        v1Task({ id: 'D'.repeat(26), listId, title: 'unset' }),
        v1Task({ id: 'E'.repeat(26), listId, title: 'garbage', priority: 'nonsense' }),
        // Tombstoned row: must ALSO be remapped (exports/sync read raw rows).
        v1Task({
          id: 'F'.repeat(26),
          listId,
          title: 'tombstone',
          priority: 2,
          deletedAt: T0 - 1,
        }),
        // Legacy recurrence with count → reserved format without count.
        v1Task({
          id: 'G'.repeat(26),
          listId,
          title: 'recur',
          priority: 1,
          recurrence: { freq: 'weekly', interval: 2, until: '2026-12-31', count: 9 },
        }),
      ],
    });

    const result = await boot({ dbName: name, now: fixedNow });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const db = result.value as AppDBImpl;
    booted.push(db);

    // Boot report: migration recorded with a pre-migration snapshot.
    const report = db.bootReport;
    // eslint-disable-next-line no-console
    console.log(
      '[qa-e7-m1] report:',
      JSON.stringify({
        migrated: report.migrated,
        snap: report.preMigrationSnapshotId !== null,
        quarantined: report.quarantined,
      }),
    );
    expect(report.migrated).toEqual({ from: 1, to: APP_SCHEMA_VERSION });
    expect(report.preMigrationSnapshotId).not.toBeNull();
    expect(report.quarantined).toBe(0); // valid v1 data must not be quarantined after migration
    expect(db.schemaVersion).toBe(APP_SCHEMA_VERSION);

    const read = await db.readUnfiltered('tasks');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const byId = new Map(read.value.map((t) => [t.id, t]));
    expect(byId.get('A'.repeat(26))?.priority).toBe('P1'); // High → P1
    expect(byId.get('B'.repeat(26))?.priority).toBe('P2'); // Medium → P2
    expect(byId.get('C'.repeat(26))?.priority).toBe('P3'); // Low → P3
    expect(byId.get('D'.repeat(26))?.priority).toBe('P4'); // unset → P4
    expect(byId.get('E'.repeat(26))?.priority).toBe('P4'); // garbage → P4 (kept, never dropped)
    // Tombstoned row remapped too, tombstone preserved.
    expect(byId.get('F'.repeat(26))?.priority).toBe('P1');
    expect(byId.get('F'.repeat(26))?.deletedAt).toBe(T0 - 1);
    // Recurrence reduced to the reserved shape (count stripped, until kept).
    expect(byId.get('G'.repeat(26))?.recurrence).toEqual({
      freq: 'weekly',
      interval: 2,
      until: '2026-12-31',
    });
    // Stamps NEVER touched by migration — LWW depends on them.
    expect(byId.get('A'.repeat(26))?.updatedAt).toBe(T0);
    expect(byId.get('A'.repeat(26))?.deviceId).toBe('0'.repeat(26));
    expect(byId.get('A'.repeat(26))?.tags).toEqual(['work']);
  }, 30_000);

  it('reboot of the migrated DB is a no-op (idempotent, no second snapshot)', async () => {
    const name = uniqueDbName('qa-e7-reboot');
    const listId = '0'.repeat(26);
    await seedDb(name, {
      meta: makeMeta({ schemaVersion: 1 }),
      lists: [makeList({ id: listId })],
      settings: [makeSettings()],
      tasks: [v1Task({ id: 'A'.repeat(26), listId, priority: 2 })],
    });
    const first = await boot({ dbName: name, now: fixedNow });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    booted.push(first.value as AppDBImpl);
    resetBootSingleton(name);
    const second = await boot({ dbName: name, now: fixedNow });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const db = second.value as AppDBImpl;
    booted.push(db);
    // eslint-disable-next-line no-console
    console.log(
      '[qa-e7-m2] second boot migrated =',
      JSON.stringify(db.bootReport.migrated),
      'quarantined =',
      String(db.bootReport.quarantined),
    );
    expect(db.bootReport.migrated).toBeNull();
    expect(db.bootReport.preMigrationSnapshotId).toBeNull();
    const read = await db.readUnfiltered('tasks');
    if (read.ok) expect(read.value[0]?.priority).toBe('P1');
  }, 30_000);
});

describe('QA-E7-M2: hand-rolled literal v1 export JSON upgrades on import', () => {
  it('raw JSON (numeric priority, count recurrence, no tags field) → upgradedTo current schema, no quarantine', async () => {
    // Literal file content as an MVP build would have written it — NOT produced
    // by current-version serializers (independence from the code under test).
    const raw = JSON.stringify({
      format: 'local-first-todo-backup',
      formatVersion: 1,
      schemaVersion: 1,
      kind: 'export',
      exportedAt: T0,
      deviceId: '0'.repeat(26),
      data: {
        settings: makeSettings(),
        lists: [makeList({ id: '0'.repeat(26) })],
        tasks: [
          v1Task({ id: 'A'.repeat(26), listId: '0'.repeat(26), title: 'high old', priority: 2 }),
          v1Task({ id: 'B'.repeat(26), listId: '0'.repeat(26), title: 'low old', priority: 0 }),
          v1Task({ id: 'C'.repeat(26), listId: '0'.repeat(26), title: 'unset old' }),
          v1Task({
            id: 'D'.repeat(26),
            listId: '0'.repeat(26),
            title: 'recur old',
            recurrence: { freq: 'daily', interval: 1, count: 3 },
          }),
        ],
        snapshots: [],
      },
    });

    const plan = await prepareImport(raw, { fileName: 'mvp-export.json' });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const p = plan.value;
    // eslint-disable-next-line no-console
    console.log(
      '[qa-e7-m3] fileSummary:',
      JSON.stringify(p.fileSummary),
      'quarantined:',
      JSON.stringify(p.quarantined),
    );
    expect(p.fileSummary.schemaVersion).toBe(1);
    expect(p.fileSummary.upgradedTo).toBe(APP_SCHEMA_VERSION);
    expect(p.accepted.tasks).toBe(4);
    expect(p.accepted.lists).toBe(1);
    expect(p.quarantined).toEqual([]);
    const byId = new Map(p.records.tasks.map((t) => [t.id, t]));
    expect(byId.get('A'.repeat(26))?.priority).toBe('P1');
    expect(byId.get('B'.repeat(26))?.priority).toBe('P3');
    expect(byId.get('C'.repeat(26))?.priority).toBe('P4');
    expect(byId.get('D'.repeat(26))?.recurrence).toEqual({ freq: 'daily', interval: 1 });
    expect(byId.get('A'.repeat(26))?.updatedAt).toBe(T0); // stamps preserved for LWW
  });

  it('NEWER_SCHEMA: a schemaVersion 99 file is rejected, not partially imported', async () => {
    const raw = JSON.stringify({
      format: 'local-first-todo-backup',
      formatVersion: 1,
      schemaVersion: 99,
      kind: 'export',
      exportedAt: T0,
      deviceId: '0'.repeat(26),
      data: { settings: makeSettings(), lists: [], tasks: [], snapshots: [] },
    });
    const plan = await prepareImport(raw, { fileName: 'from-the-future.json' });
    // eslint-disable-next-line no-console
    console.log(
      '[qa-e7-m4] future file →',
      plan.ok ? 'ACCEPTED (BAD)' : JSON.stringify(plan.error),
    );
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toMatchObject({ code: 'NEWER_SCHEMA' });
  });
});
