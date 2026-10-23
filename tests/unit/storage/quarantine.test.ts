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
  it('buildRecoveryFile works without options (defaults) and formats a stable filename', () => {
    const entries: QuarantineEntry[] = [
      { store: 'tasks', key: 'K1', record: { id: 'K1', title: 'bad' }, issues: ['title: range'] },
    ];
    const file = buildRecoveryFile(entries);
    expect(file.filename).toMatch(/^recovery-\d{8}-\d{6}\.json$/u);
    const parsed = JSON.parse(file.json) as {
      schemaVersion: number;
      generatedAt: string;
      note: string;
      quarantine: QuarantineEntry[];
    };
    expect(parsed.schemaVersion).toBe(1); // APP_SCHEMA_VERSION default
    expect(parsed.quarantine).toHaveLength(1);
    expect(parsed.note).toContain('Nothing was deleted');

    // Explicit clock + version: used by the quarantine API on the boot path.
    const pinned = buildRecoveryFile(entries, {
      now: () => Date.UTC(2026, 0, 2, 3, 4, 5),
      schemaVersion: 4,
    });
    expect(pinned.filename).toBe('recovery-20260102-030405.json');
    const pinnedParsed = JSON.parse(pinned.json) as { schemaVersion: number };
    expect(pinnedParsed.schemaVersion).toBe(4);
  });

  it('keyOf tolerates records without an id (quarantine entry still carries them)', async () => {
    const db = await openFixtureDb(uniqueDbName('q-keyof'));
    opened.push(db);
    const entries: QuarantineEntry[] = [
      { store: 'tasks', key: '', record: { title: 'no id at all' }, issues: ['id: format'] },
      { store: 'meta', key: 'meta', record: makeMeta(), issues: ['schemaVersion: range'] },
    ];
    db.setQuarantine(entries);
    const file = db.quarantine.recoveryFile();
    const parsed = JSON.parse(file.json) as { quarantine: { key: string }[] };
    expect(parsed.quarantine.map((q) => q.key)).toEqual(['', 'meta']);
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
