/**
 * E7 schemaVersion 3 migration (S3 priority model + reserved recurrence format):
 *
 * - the legacy->level mapping matrix (see `legacyPriorityToLevel` for the
 *   orientation note: MVP `2`=High -> P1, `1`=Medium -> P2, `0`=Low -> P3,
 *   unset/unknown -> P4 = no priority),
 * - row normalization (`recurrence.count` stripped to the reserved format,
 *   `tags` normalized, stamps NEVER touched),
 * - the real chain over a real v1 database (boot's registry: the sync_state
 *   step 2 + this step 3), incl. the ROLLBACK DRILL via the automatic
 *   pre-migration snapshot (restore -> back to v1 bytes -> re-run converges),
 * - old exports upgrading through the SAME chain (`migrateRows` +
 *   `prepareImport`).
 */
import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import type { Task } from '../../../src/domain/model';
import {
  legacyPriorityToLevel,
  migrateRows,
  migrateTaskRowToV3,
  productionMigrations,
  runMigrations,
  targetVersionOf,
  toSchemaVersion3,
} from '../../../src/storage/migrations';
import { fallbackRawCodec, restoreSnapshot } from '../../../src/storage/snapshots';
import { APP_SCHEMA_VERSION } from '../../../src/storage/schema';
import type { StoreRows } from '../../../src/storage/types';
import { buildBackupDocument, serializeBackupDoc } from '../../../src/portability/backup-document';
import { prepareImport } from '../../../src/portability/import';
import {
  fixedNow,
  makeList,
  makeMeta,
  makeSettings,
  openFixtureDb,
  seedDb,
  uniqueDbName,
  T0,
} from './fixtures';

/** A v1 task row (numeric `priority`) — casts keep the v3 type system honest. */
function v1Task(over: Record<string, unknown>): Task {
  return {
    id: over['id'],
    listId: over['listId'],
    title: over['title'] ?? 'v1 task',
    notes: null,
    status: 'open',
    tags: [],
    sortOrder: 'h',
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    deviceId: '0'.repeat(26),
    ...over,
  } as unknown as Task;
}

describe('schemaVersion 3 — priority mapping matrix (S3)', () => {
  it('maps legacy levels preserving user-visible meaning', () => {
    // The binding mapping row is encoded value-order-first ("0->P1, 1->P2,
    // 2->P3"); the MVP encoding is 2=High/1=Medium/0=Low, so meaning-preserving
    // is 2->P1 … 0->P3. See `legacyPriorityToLevel` for the flagged rationale.
    expect(legacyPriorityToLevel(2)).toBe('P1'); // High -> most urgent
    expect(legacyPriorityToLevel(1)).toBe('P2'); // Medium
    expect(legacyPriorityToLevel(0)).toBe('P3'); // Low
  });

  it('maps unset and unknown values to P4 (no priority) — never drops the record', () => {
    expect(legacyPriorityToLevel(undefined)).toBe('P4');
    expect(legacyPriorityToLevel(null)).toBe('P4');
    expect(legacyPriorityToLevel(7)).toBe('P4');
    expect(legacyPriorityToLevel('nonsense')).toBe('P4');
  });

  it('is idempotent on already-migrated levels', () => {
    for (const level of ['P1', 'P2', 'P3', 'P4'] as const) {
      expect(legacyPriorityToLevel(level)).toBe(level);
    }
    const row = migrateTaskRowToV3({ id: 'X', priority: 'P2', tags: ['a'] });
    expect(migrateTaskRowToV3(row)).toEqual(row);
  });
});

describe('schemaVersion 3 — row normalization', () => {
  it('reduces recurrence to the reserved format (no end-count — R4)', () => {
    const row = migrateTaskRowToV3({
      id: 'X',
      priority: 2,
      tags: ['a'],
      recurrence: { freq: 'daily', interval: 2, until: '2026-12-31', count: 5 },
    });
    expect(row['recurrence']).toEqual({ freq: 'daily', interval: 2, until: '2026-12-31' });
  });

  it('leaves a malformed recurrence untouched so boot validation quarantines it', () => {
    const broken = { freq: 'daily' }; // no interval — not a valid reserved value
    const row = migrateTaskRowToV3({ id: 'X', priority: 0, tags: [], recurrence: broken });
    expect(row['recurrence']).toBe(broken);
  });

  it('normalizes missing tags to an empty array and copies arrays', () => {
    expect(migrateTaskRowToV3({ id: 'X', priority: 1 })['tags']).toEqual([]);
    const tags = ['a'];
    const row = migrateTaskRowToV3({ id: 'X', priority: 1, tags });
    expect(row['tags']).toEqual(['a']);
    expect(row['tags']).not.toBe(tags);
  });

  it('never restamps the record (migration is not a user write)', () => {
    const row = migrateTaskRowToV3({
      id: 'X',
      priority: 2,
      tags: [],
      updatedAt: 42,
      deviceId: '0'.repeat(26),
    });
    expect(row['updatedAt']).toBe(42);
    expect(row['deviceId']).toBe('0'.repeat(26));
  });
});

describe('schemaVersion 3 — real chain over a v1 database + rollback drill', () => {
  it('runs 1 -> 3 with the auto pre-migration snapshot and remaps every level', async () => {
    const dbName = uniqueDbName('mig-v3');
    await seedDb(dbName, {
      meta: makeMeta({ schemaVersion: 1 }),
      lists: [makeList({ id: '0'.repeat(26) })],
      tasks: [
        v1Task({ id: 'A'.repeat(26), priority: 2, title: 'high' }),
        v1Task({ id: 'B'.repeat(26), priority: 1, title: 'medium' }),
        v1Task({ id: 'C'.repeat(26), priority: 0, title: 'low' }),
        v1Task({
          id: 'D'.repeat(26),
          title: 'unset',
          recurrence: { freq: 'weekly', interval: 1, count: 3 },
        }),
      ],
      settings: [makeSettings()],
    });

    const db = await openFixtureDb(dbName, makeMeta({ schemaVersion: 1 }));
    expect(db.schemaVersion).toBe(1);
    const migrated = await runMigrations(db, { registry: productionMigrations, now: fixedNow });
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.value.from).toBe(1);
    expect(migrated.value.to).toBe(APP_SCHEMA_VERSION);
    expect(targetVersionOf(productionMigrations)).toBe(3);
    expect(migrated.value.preMigrationSnapshotId).not.toBeNull();
    expect(db.schemaVersion).toBe(3);

    const rows = await db.readUnfiltered('tasks');
    if (!rows.ok) throw new Error('read failed');
    const byId = new Map(rows.value.map((r) => [r.id, r]));
    expect(byId.get('A'.repeat(26))?.priority).toBe('P1');
    expect(byId.get('B'.repeat(26))?.priority).toBe('P2');
    expect(byId.get('C'.repeat(26))?.priority).toBe('P3');
    expect(byId.get('D'.repeat(26))?.priority).toBe('P4');
    expect(byId.get('D'.repeat(26))?.recurrence).toEqual({ freq: 'weekly', interval: 1 });
    // Unchanged fields survive verbatim (stamps, title, sortOrder).
    expect(byId.get('A'.repeat(26))?.title).toBe('high');
    expect(byId.get('A'.repeat(26))?.updatedAt).toBe(T0);

    /* ---- rollback drill: restore the pre-migration snapshot ---- */
    const snapId = migrated.value.preMigrationSnapshotId;
    if (snapId === null) throw new Error('expected a pre-migration snapshot');
    const restored = await restoreSnapshot(db, snapId, fallbackRawCodec);
    expect(restored.ok).toBe(true);
    expect(db.schemaVersion).toBe(1);

    const v1Rows = await db.readUnfiltered('tasks');
    if (!v1Rows.ok) throw new Error('read failed');
    const v1ById = new Map(v1Rows.value.map((r) => [r.id, r]));
    // Rollback = exact v1 bytes again (numeric priorities, count present).
    expect(v1ById.get('A'.repeat(26))?.priority).toBe(2);
    expect(v1ById.get('D'.repeat(26))?.recurrence).toEqual({
      freq: 'weekly',
      interval: 1,
      count: 3,
    });

    // Re-running the chain converges to the SAME v3 rows.
    const again = await runMigrations(db, { registry: productionMigrations, now: fixedNow });
    expect(again.ok).toBe(true);
    const finalRows = await db.readUnfiltered('tasks');
    if (!finalRows.ok) throw new Error('read failed');
    const finalById = new Map(finalRows.value.map((r) => [r.id, r]));
    expect(finalById.get('A'.repeat(26))?.priority).toBe('P1');
    expect(finalById.get('C'.repeat(26))?.priority).toBe('P3');
    expect(finalById.get('D'.repeat(26))?.recurrence).toEqual({ freq: 'weekly', interval: 1 });
    db.close();
  }, 30_000);

  it('the step is one atomic readwrite over `tasks` only (ADR-002 Decision 8)', () => {
    expect(toSchemaVersion3.to).toBe(3);
    expect(toSchemaVersion3.stores).toEqual(['tasks']);
  });
});

describe('schemaVersion 3 — old exports upgrade through the same chain', () => {
  it('migrateRows upgrades v1 rows in memory (export/snapshot path)', async () => {
    const rows = {
      meta: [makeMeta({ schemaVersion: 1 })],
      lists: [makeList()],
      tasks: [v1Task({ id: 'A'.repeat(26), priority: 2, tags: ['work'] })],
      settings: [makeSettings()],
      snapshots: [],
      snapshot_payloads: [],
    } as unknown as StoreRows;
    const upgraded = await migrateRows(productionMigrations, rows, 1, 3);
    expect(upgraded.ok).toBe(true);
    if (!upgraded.ok) return;
    const task = upgraded.value.rows.tasks[0] as Task;
    expect(task.priority).toBe('P1');
    expect(task.tags).toEqual(['work']);
    expect(upgraded.value.schemaVersion).toBe(3);
  });

  it('a v1 backup document imports with P-levels and the reserved recurrence', async () => {
    const doc = buildBackupDocument({
      kind: 'export',
      exportedAt: T0,
      deviceId: '0'.repeat(26),
      schemaVersion: 1,
      settings: makeSettings(),
      lists: [makeList({ id: '0'.repeat(26) })],
      tasks: [
        v1Task({ id: 'A'.repeat(26), listId: '0'.repeat(26), priority: 2 }),
        v1Task({
          id: 'B'.repeat(26),
          listId: '0'.repeat(26),
          priority: 0,
          recurrence: { freq: 'daily', interval: 1, count: 9 },
        }),
      ],
      snapshots: [],
    });
    const plan = await prepareImport(serializeBackupDoc(doc), { fileName: 'old-backup.json' });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.fileSummary.schemaVersion).toBe(1);
    expect(plan.value.fileSummary.upgradedTo).toBe(3);
    expect(plan.value.accepted.tasks).toBe(2);
    expect(plan.value.quarantined).toEqual([]);
    const byId = new Map(plan.value.records.tasks.map((t) => [t.id, t]));
    expect(byId.get('A'.repeat(26))?.priority).toBe('P1');
    expect(byId.get('B'.repeat(26))?.priority).toBe('P3');
    expect(byId.get('B'.repeat(26))?.recurrence).toEqual({ freq: 'daily', interval: 1 });
  });
});
