import { afterEach, describe, expect, it } from 'vitest';

import type { AppDBImpl } from '../../../src/storage/db';
import {
  buildRecoveryFile,
  makeQuarantineApi,
  runBootValidation,
} from '../../../src/storage/quarantine';
import type { QuarantineEntry } from '../../../src/storage/quarantine';

import { makeMeta, makeTask, openFixtureDb, uniqueDbName } from './fixtures';

const opened: AppDBImpl[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

describe('quarantine building blocks (ADR-002 Decision 8 step 4)', () => {
  it('buildRecoveryFile emits the pinned ADR-004 Decision 7.1 envelope and filename', () => {
    const ulid = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const entries: QuarantineEntry[] = [
      { store: 'tasks', key: ulid, record: { id: ulid, title: 'bad' }, issues: ['title: range'] },
      {
        store: 'tasks',
        key: 'K1',
        record: { id: 'K1', title: 'bad id' },
        issues: ['id: missing or not a ULID'],
      },
    ];

    // Explicit clock + version + device: used by the quarantine API on the boot path.
    const file = buildRecoveryFile(entries, {
      now: () => Date.UTC(2026, 0, 2, 3, 4, 5),
      schemaVersion: 4,
      deviceId: '01ARZ3NDEKTSV4RRFFQ69G5FAZ',
    });
    expect(file.filename).toBe('local-first-todo-recovery-2026-01-02T030405Z.json');
    const parsed = JSON.parse(file.json) as {
      format: string;
      formatVersion: number;
      schemaVersion: number;
      createdAt: number;
      deviceId: string;
      source: { kind: string; fileName: string | null; fileSchemaVersion: number };
      entries: { store: string; id: string | null; issues: string[]; raw: unknown }[];
    };
    expect(parsed.format).toBe('local-first-todo-recovery'); // NOT importable
    expect(parsed.formatVersion).toBe(1);
    expect(parsed.schemaVersion).toBe(4);
    expect(parsed.createdAt).toBe(Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(parsed.deviceId).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAZ');
    expect(parsed.source).toEqual({
      kind: 'boot-validation',
      fileName: null,
      fileSchemaVersion: 4,
    });

    // Entries: raw verbatim, id = the record id when parseable else null.
    expect(parsed.entries).toEqual([
      { store: 'tasks', id: ulid, issues: ['title: range'], raw: { id: ulid, title: 'bad' } },
      {
        store: 'tasks',
        id: null,
        issues: ['id: missing or not a ULID'],
        raw: { id: 'K1', title: 'bad id' },
      },
    ]);

    // Human-inspectable per ADR-004 Decision 2.4 convention.
    expect(file.json.endsWith('\n')).toBe(true);

    // Defaults: APP_SCHEMA_VERSION, live clock, pinned filename shape.
    const defaults = buildRecoveryFile(entries);
    expect(defaults.filename).toMatch(
      /^local-first-todo-recovery-\d{4}-\d{2}-\d{2}T\d{6}Z\.json$/u,
    );
    const defaultsParsed = JSON.parse(defaults.json) as { schemaVersion: number };
    expect(defaultsParsed.schemaVersion).toBe(1); // APP_SCHEMA_VERSION default
  });

  it('keyOf tolerates records without an id (quarantine entry still carries them)', async () => {
    const db = await openFixtureDb(uniqueDbName('q-keyof'));
    opened.push(db);
    const metaRecord = makeMeta();
    const entries: QuarantineEntry[] = [
      { store: 'tasks', key: '', record: { title: 'no id at all' }, issues: ['id: format'] },
      { store: 'meta', key: 'meta', record: metaRecord, issues: ['schemaVersion: range'] },
    ];
    db.setQuarantine(entries);
    const file = db.quarantine.recoveryFile();
    const parsed = JSON.parse(file.json) as {
      deviceId: string;
      entries: { id: string | null; raw: unknown }[];
    };
    // No parseable id -> null, but `raw` keeps every record verbatim.
    expect(parsed.entries.map((e) => e.id)).toEqual([null, null]);
    expect(parsed.entries.map((e) => e.raw)).toEqual([{ title: 'no id at all' }, metaRecord]);
    expect(parsed.deviceId).toBe(db.deviceId); // envelope carries the device identity
  });

  it('runBootValidation passes a clean database', async () => {
    const db = await openFixtureDb(uniqueDbName('q-clean'));
    opened.push(db);
    await db.put('tasks', makeTask());
    const result = await runBootValidation(db);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it('quarantine purge honors the NEWER_SCHEMA write guard (typed refusal)', async () => {
    const db = await openFixtureDb(uniqueDbName('q-guard'));
    opened.push(db);
    const task = makeTask();
    await db.put('tasks', task);
    db.setQuarantine([{ store: 'tasks', key: task.id, record: task, issues: ['x'] }]);
    db.setWriteGuard({ code: 'NEWER_SCHEMA', found: 9, supported: 1 });

    const api = makeQuarantineApi(db);
    const purged = await api.purge();
    expect(purged.ok).toBe(false);
    if (!purged.ok) expect(purged.error.code).toBe('NEWER_SCHEMA');
    // Row is untouched — refusal is non-destructive.
    const rows = await db.readUnfiltered('tasks');
    if (rows.ok) expect(rows.value).toHaveLength(1);
    expect(api.list()).toHaveLength(1); // denylist intact until a successful purge
  });
});
