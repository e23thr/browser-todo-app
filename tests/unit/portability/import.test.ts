/**
 * Import pipeline stages 1–3 (ADR-004 Decision 5): `prepareImport` is pure
 * w.r.t. the database — every reject below must leave the DB untouched and take
 * no snapshot. Drills 3–8 and 14 of the ADR-004 testing contract.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { AppDBImpl } from '../../../src/storage/db';
import { prepareImport } from '../../../src/portability/import';
import type { MigrationStep } from '../../../src/storage/migrations';
import { serializeRecoveryDoc } from '../../../src/portability/recovery-document';
import { listSnapshots } from '../../../src/portability/snapshots-api';
import { openFixtureDb, uniqueDbName, makeSettings, makeList, makeTask } from '../storage/fixtures';
import {
  fakeFile,
  fixture,
  fixtureId,
  makeDocObject,
  makeDocText,
  seedCorpus,
  T0,
} from './helpers';

const opened: AppDBImpl[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

async function openSeeded(): Promise<AppDBImpl> {
  const db = await openFixtureDb(uniqueDbName('imp'));
  opened.push(db);
  await db.put('settings', makeSettings());
  await db.put('lists', makeList());
  await db.put('tasks', makeTask());
  return db;
}

/** The zero-side-effects assertion used by every reject drill. */
async function expectUntouched(db: AppDBImpl): Promise<void> {
  const snaps = await listSnapshots({ db });
  expect(snaps.ok && snaps.value).toEqual([]);
  const lists = await db.getAll('lists');
  expect(lists.ok && lists.value).toHaveLength(1);
  const tasks = await db.getAll('tasks');
  expect(tasks.ok && tasks.value).toHaveLength(1);
}

describe('prepareImport — accept path (stages 1–3)', () => {
  it('accepts a valid backup and reports counts, summary and rebuilt records', async () => {
    const corpus = seedCorpus();
    const prepared = await prepareImport(makeDocText({ ...corpus }), { fileName: 'backup.json' });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const plan = prepared.value;
    expect(plan.fileSummary).toMatchObject({
      fileName: 'backup.json',
      formatVersion: 1,
      schemaVersion: 1,
      upgradedTo: 1,
      kind: 'export',
    });
    expect(plan.accepted).toEqual({ lists: 2, tasks: 3, settings: true });
    expect(plan.quarantined).toEqual([]);
    expect(plan.records.settings?.theme).toBe(corpus.settings.theme);
    expect(plan.records.lists.map((l) => l.id)).toEqual([fixtureId(10), fixtureId(11)]);
    expect(plan.recovery).toBeNull();
  });

  it('imports a legitimate empty backup (sections present, arrays []) as a replace-with-empty', async () => {
    const prepared = await prepareImport(makeDocText({ lists: [], tasks: [], snapshots: [] }));
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.value.accepted).toEqual({ lists: 0, tasks: 0, settings: true });
    }
  });

  it('reads File inputs the same as strings', async () => {
    const text = makeDocText({ ...seedCorpus() });
    const prepared = await prepareImport(fakeFile('backup.json', text));
    expect(prepared.ok).toBe(true);
  });
});

describe('prepareImport — whole-file rejects (drill 4: zero side effects)', () => {
  const cases: [string, string, string][] = [
    ['wrong format token', 'drill4-wrong-format-token.json', 'NOT_A_BACKUP'],
    ['recovery file (not importable)', 'drill14-recovery-document.json', 'NOT_A_BACKUP'],
    ['formatVersion from the future', 'drill4-format-too-new.json', 'FORMAT_TOO_NEW'],
    ['schemaVersion from the future', 'drill4-schema-too-new.json', 'NEWER_SCHEMA'],
    ['missing data.settings', 'drill4-missing-settings.json', 'NOT_A_BACKUP'],
    ['prototype-pollution keys', 'drill4-proto-pollution.json', 'MALICIOUS_SHAPE'],
    ['deep-nesting bomb', 'drill4-deep-nesting.json', 'MALICIOUS_SHAPE'],
    ['every record corrupt (drill 7)', 'drill7-all-records-corrupt.json', 'NOTHING_TO_IMPORT'],
  ];

  for (const [label, file, code] of cases) {
    it(`rejects ${label} with ${code} and leaves the DB untouched`, async () => {
      const db = await openSeeded();
      const prepared = await prepareImport(fixture(file));
      expect(prepared).toMatchObject({ ok: false, error: { code } });
      await expectUntouched(db);
    });
  }

  it('rejects truncated JSON and oversize files before reading them', async () => {
    const db = await openSeeded();
    const truncated = await prepareImport('{"format": "local-first-todo-ba');
    expect(truncated).toMatchObject({ ok: false, error: { code: 'PARSE_ERROR' } });

    const oversize = fakeFile('huge.json', '{}', 52_428_801);
    const tooBig = await prepareImport(oversize);
    expect(tooBig).toMatchObject({ ok: false, error: { code: 'FILE_TOO_LARGE', cap: 52_428_800 } });
    await expectUntouched(db);
  });

  it('rejects a count-limit bomb with LIMIT_EXCEEDED (drill 4)', async () => {
    const doc = makeDocObject({ lists: [], tasks: [], snapshots: [] });
    const data = doc['data'] as Record<string, unknown>;
    data['tasks'] = new Array(100_001).fill(0);
    const prepared = await prepareImport(JSON.stringify(doc));
    expect(prepared).toMatchObject({
      ok: false,
      error: { code: 'LIMIT_EXCEEDED', limit: 'data.tasks', found: 100_001, cap: 100_000 },
    });
  });
});

describe('Stage B quarantine (drills 5–8)', () => {
  it('quarantines corrupt records to the recovery file and applies the rest (drill 5)', async () => {
    const corpus = seedCorpus();
    const doc = makeDocObject({
      lists: [...corpus.lists, { ...makeList({ id: fixtureId(12), name: '' }) }],
      tasks: [
        ...corpus.tasks,
        { ...makeTask({ id: fixtureId(23), listId: fixtureId(10), title: '' }) },
      ],
      snapshots: [{ ...corpus.snapshots[0], id: fixtureId(31), sizeBytes: -5 }],
    });
    const prepared = await prepareImport(JSON.stringify(doc), { fileName: 'corrupt.json' });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const plan = prepared.value;
    expect(plan.accepted).toEqual({ lists: 2, tasks: 3, settings: true });
    expect(plan.quarantined).toHaveLength(3);
    // Raw records ride the recovery entries verbatim (pre-upgrade source bytes).
    const byId = new Map(plan.quarantined.map((e) => [e.id, e]));
    expect(byId.get(fixtureId(12))?.raw).toMatchObject({ id: fixtureId(12), name: '' });
    expect(byId.get(fixtureId(23))?.issues[0]).toContain('title');
    expect(byId.get(fixtureId(31))?.store).toBe('snapshots');
    // The downloadable recovery document carries exactly these entries.
    expect(plan.recovery?.filename).toMatch(
      /^local-first-todo-recovery-\d{4}-\d{2}-\d{2}T\d{6}Z\.json$/u,
    );
    const recoveryDoc = JSON.parse(plan.recovery?.json ?? '{}') as {
      entries: unknown[];
      source: unknown;
    };
    expect(recoveryDoc.entries).toHaveLength(3);
    expect(recoveryDoc.source).toMatchObject({ kind: 'import', fileName: 'corrupt.json' });
  });

  it('cascades referential failures: dangling listId and parent chains (drill 6)', async () => {
    const l1 = makeList({ id: fixtureId(10) });
    const l2dead = makeList({ id: fixtureId(11), deletedAt: T0 - 1 }); // tombstoned = still present
    const okTask = makeTask({ id: fixtureId(20), listId: l1.id });
    const tombstonedListTask = makeTask({ id: fixtureId(21), listId: l2dead.id });
    const dangling = makeTask({ id: fixtureId(22), listId: fixtureId(99) });
    const cycleA = makeTask({ id: fixtureId(23), listId: l1.id, parentTaskId: fixtureId(24) });
    const cycleB = makeTask({ id: fixtureId(24), listId: l1.id, parentTaskId: fixtureId(23) });
    const cycleChild = makeTask({ id: fixtureId(25), listId: l1.id, parentTaskId: fixtureId(23) });
    const orphanParent = makeTask({
      id: fixtureId(26),
      listId: l1.id,
      parentTaskId: fixtureId(98),
    });

    const prepared = await prepareImport(
      makeDocText({
        lists: [l1, l2dead],
        tasks: [okTask, tombstonedListTask, dangling, cycleA, cycleB, cycleChild, orphanParent],
      }),
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.records.tasks.map((t) => t.id).sort()).toEqual(
      [fixtureId(20), fixtureId(21)].sort(),
    );
    const issues = new Map(prepared.value.quarantined.map((e) => [e.id, e.issues.join(' ')]));
    expect(issues.get(fixtureId(22))).toContain('listId');
    expect(issues.get(fixtureId(23))).toContain('cycle');
    expect(issues.get(fixtureId(24))).toContain('cycle');
    expect(issues.get(fixtureId(25))).toContain('parentTaskId'); // cascade
    expect(issues.get(fixtureId(26))).toContain('parentTaskId');
  });

  it('keeps the first occurrence of a duplicate id and quarantines later ones (drill 8)', async () => {
    const l1 = makeList({ id: fixtureId(10) });
    const first = makeTask({ id: fixtureId(20), listId: l1.id, title: 'first wins' });
    const dupe = makeTask({ id: fixtureId(20), listId: l1.id, title: 'later loses' });
    const prepared = await prepareImport(makeDocText({ lists: [l1], tasks: [first, dupe] }));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.records.tasks).toHaveLength(1);
    expect(prepared.value.records.tasks[0]?.title).toBe('first wins');
    expect(prepared.value.quarantined).toHaveLength(1);
    expect(prepared.value.quarantined[0]?.issues.join(' ')).toContain('duplicate id');
  });
});

describe('old exports upgrade through the migration chain (drill 3)', () => {
  const notesBackfill: MigrationStep = {
    to: 2,
    stores: ['tasks'],
    run: async (t) => {
      const tasks = await t.getAll('tasks');
      for (const task of tasks) {
        await t.put('tasks', { ...task, notes: task.notes ?? '' });
      }
      return { ok: true, value: undefined };
    },
  };
  const failing: MigrationStep = {
    to: 2,
    stores: ['tasks'],
    run: () => ({ ok: false, error: { code: 'MIGRATION_FAILED' as const, from: 1, to: 2 } }),
  };

  it('upgrades a v1 document to the registry target before validating (zero side effects)', async () => {
    const l1 = makeList({ id: fixtureId(10) });
    const v1Task = makeTask({ id: fixtureId(20), listId: l1.id });
    delete (v1Task as Partial<{ notes: string | null }>).notes;
    const doc = makeDocObject({ schemaVersion: 1, lists: [l1], tasks: [v1Task] });
    const db = await openSeeded();

    const prepared = await prepareImport(JSON.stringify(doc), { migrations: [notesBackfill] });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.fileSummary).toMatchObject({ schemaVersion: 1, upgradedTo: 2 });
    expect(prepared.value.records.tasks[0]?.notes).toBe(''); // migrated shape validates
    await expectUntouched(db);
  });

  it('rejects with UPGRADE_FAILED when a step fails — zero side effects', async () => {
    const l1 = makeList({ id: fixtureId(10) });
    const v1Task = makeTask({ id: fixtureId(20), listId: l1.id });
    delete (v1Task as Partial<{ notes: string | null }>).notes;
    const prepared = await prepareImport(
      JSON.stringify(makeDocObject({ schemaVersion: 1, lists: [l1], tasks: [v1Task] })),
      {
        migrations: [failing],
      },
    );
    expect(prepared).toMatchObject({
      ok: false,
      error: { code: 'UPGRADE_FAILED', from: 1, to: 2 },
    });
  });
});

describe('recovery documents are reports, not backups (drill 14)', () => {
  it('serializeRecoveryDoc output is never importable', async () => {
    const json = serializeRecoveryDoc(
      [{ store: 'tasks', id: fixtureId(20), issues: ['title: bad'], raw: { id: fixtureId(20) } }],
      { kind: 'import', fileName: 'x.json', fileSchemaVersion: 1 },
      { createdAt: T0, deviceId: fixtureId(1), schemaVersion: 1 },
    );
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed['format']).toBe('local-first-todo-recovery');
    expect(json.endsWith('\n')).toBe(true);
    const prepared = await prepareImport(json);
    expect(prepared).toMatchObject({ ok: false, error: { code: 'NOT_A_BACKUP' } });
  });
});
