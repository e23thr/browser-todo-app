/**
 * Backup document — canonical serialization (ADR-004 §2.4) and Stage A parse
 * (Decision 5.1 + Decision 6: untrusted input, never eval, whole-file reject).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildBackupDocument,
  canonicalizeRecord,
  inputByteSize,
  parseBackupDocument,
  readImportText,
  serializeBackupDoc,
} from '../../../src/portability/backup-document';
import {
  BACKUP_FORMAT,
  MAX_IMPORT_BYTES,
  backupFileName,
  snapshotFileName,
  recoveryFileName,
} from '../../../src/portability/constants';
import {
  fakeFile,
  fixtureId,
  makeDocObject,
  makeDocText,
  makeTask,
  seedCorpus,
  T0,
} from './helpers';

const TARGET = { targetSchemaVersion: 1 };

function fixture(name: string): string {
  return readFileSync(resolve(process.cwd(), 'tests/fixtures/backup', name), 'utf8');
}

describe('canonical serialization (ADR-004 §2.4)', () => {
  it('rebuilds records in ADR-002 declaration order, omitting absent optionals', () => {
    const task = makeTask({
      id: fixtureId(20),
      listId: fixtureId(10),
      title: 'Buy milk',
      dueDate: '2026-10-24',
      tags: ['errand'],
    });
    const canonical = canonicalizeRecord('tasks', task);
    expect(Object.keys(canonical)).toEqual([
      'id',
      'listId',
      'title',
      'notes',
      'status',
      'priority',
      'dueDate',
      'tags',
      'sortOrder',
      'createdAt',
      'updatedAt',
      'deletedAt',
      'deviceId',
    ]);
    // Optional fields that are absent are omitted (never null).
    expect(Object.keys(canonical)).not.toContain('reminderAt');
    expect(Object.keys(canonical)).not.toContain('recurrence');
    expect(Object.keys(canonical)).not.toContain('parentTaskId');
    expect(Object.keys(canonical)).not.toContain('completedAt');
    // Fields typed `T | null` are always present.
    expect(canonical['notes']).toBeNull();
    expect(canonical['deletedAt']).toBeNull();
  });

  it('canonicalizes nested recurrence in declaration order and drops unknown fields', () => {
    const canonical = canonicalizeRecord('tasks', {
      ...makeTask({ id: fixtureId(21), listId: fixtureId(10) }),
      recurrence: { freq: 'weekly', interval: 2, until: '2026-12-01', evil: 'dropped' },
      bogus: 'dropped',
    });
    const rec = canonical['recurrence'] as Record<string, unknown>;
    expect(Object.keys(rec)).toEqual(['freq', 'interval', 'until']);
    expect(canonical['bogus']).toBeUndefined();
  });

  it('is deterministic: the same corpus serializes to identical bytes apart from the stamped fields', () => {
    const corpus = seedCorpus();
    const a = serializeBackupDoc(
      buildBackupDocument({
        kind: 'export',
        exportedAt: T0,
        deviceId: fixtureId(1),
        schemaVersion: 1,
        ...corpus,
      }),
    );
    const b = serializeBackupDoc(
      buildBackupDocument({
        kind: 'export',
        exportedAt: T0,
        deviceId: fixtureId(1),
        schemaVersion: 1,
        ...corpus,
      }),
    );
    expect(a).toBe(b);
    expect(a.endsWith('\n')).toBe(true);
    expect(a).toContain('\n  "format"'); // 2-space pretty print
  });

  it('sorts lists/tasks/snapshots canonically with id tie-break', () => {
    const corpus = seedCorpus();
    const shuffled = {
      ...corpus,
      lists: [...corpus.lists].reverse(),
      tasks: [...corpus.tasks].reverse(),
    };
    const doc = buildBackupDocument({
      kind: 'export',
      exportedAt: T0,
      deviceId: fixtureId(1),
      schemaVersion: 1,
      ...shuffled,
    });
    expect(doc.data.lists.map((l) => l.sortOrder)).toEqual(['h', 'm']);
    expect(doc.data.tasks.map((t) => t.id)).toEqual([fixtureId(20), fixtureId(22), fixtureId(21)]);
  });
});

describe('Stage A parse (whole-file reject, zero side effects)', () => {
  it('accepts a well-formed document and reports counts/advisory warnings', () => {
    const text = makeDocText({ ...seedCorpus() });
    const parsed = parseBackupDocument(text, TARGET);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.kind).toBe('export');
    expect(parsed.value.schemaVersion).toBe(1);
    expect(parsed.value.warnings).toEqual(['app: provenance block absent']);
  });

  it('warns (never rejects) on counts mismatch and unknown envelope keys', () => {
    const doc = makeDocObject({ ...seedCorpus() });
    doc['counts'] = { lists: 99, tasks: 0, snapshots: 0 };
    doc['mystery'] = 'ignored';
    const parsed = parseBackupDocument(JSON.stringify(doc), TARGET);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.warnings.some((w) => w.includes('counts.lists mismatch'))).toBe(true);
    expect(parsed.value.warnings.some((w) => w.includes('unknown key "mystery"'))).toBe(true);
  });

  it('rejects unreadable JSON and non-object tops with PARSE_ERROR', () => {
    expect(parseBackupDocument('{"format":', TARGET)).toMatchObject({
      ok: false,
      error: { code: 'PARSE_ERROR' },
    });
    expect(parseBackupDocument('[1,2,3]', TARGET)).toMatchObject({
      ok: false,
      error: { code: 'PARSE_ERROR' },
    });
  });

  it('rejects the wrong format token — and names recovery files as not importable', () => {
    const wrong = parseBackupDocument(fixture('drill4-wrong-format-token.json'), TARGET);
    expect(wrong).toMatchObject({ ok: false, error: { code: 'NOT_A_BACKUP' } });

    const recovery = parseBackupDocument(fixture('drill14-recovery-document.json'), TARGET);
    expect(recovery.ok).toBe(false);
    if (!recovery.ok && recovery.error.code === 'NOT_A_BACKUP') {
      expect(recovery.error.message).toContain('not importable');
    }
  });

  it('rejects formatVersion > 1 with FORMAT_TOO_NEW and schemaVersion ahead with NEWER_SCHEMA', () => {
    expect(parseBackupDocument(fixture('drill4-format-too-new.json'), TARGET)).toMatchObject({
      ok: false,
      error: { code: 'FORMAT_TOO_NEW', found: 2, supported: 1 },
    });
    expect(parseBackupDocument(fixture('drill4-schema-too-new.json'), TARGET)).toMatchObject({
      ok: false,
      error: { code: 'NEWER_SCHEMA', found: 99, supported: 1 },
    });
  });

  it('rejects missing data.settings with NOT_A_BACKUP', () => {
    expect(parseBackupDocument(fixture('drill4-missing-settings.json'), TARGET)).toMatchObject({
      ok: false,
      error: { code: 'NOT_A_BACKUP' },
    });
  });

  it('rejects prototype-pollution keys anywhere in the tree (MALICIOUS_SHAPE)', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const doc = makeDocObject({ ...seedCorpus() });
      (doc['data'] as Record<string, unknown>)['settings'] = {
        ...((doc['data'] as Record<string, unknown>)['settings'] as Record<string, unknown>),
        [key]: { polluted: true },
      };
      const parsed = parseBackupDocument(JSON.stringify(doc), TARGET);
      expect(parsed).toMatchObject({ ok: false, error: { code: 'MALICIOUS_SHAPE' } });
    }
    // The static fixture (own `__proto__` key inside a task) too.
    expect(parseBackupDocument(fixture('drill4-proto-pollution.json'), TARGET)).toMatchObject({
      ok: false,
      error: { code: 'MALICIOUS_SHAPE' },
    });
  });

  it('rejects depth bombs beyond 8 levels (iterative walk, no recursion)', () => {
    expect(parseBackupDocument(fixture('drill4-deep-nesting.json'), TARGET)).toMatchObject({
      ok: false,
      error: { code: 'MALICIOUS_SHAPE' },
    });
  });

  it('rejects count-limit bombs before any record work (LIMIT_EXCEEDED)', () => {
    const bomb =
      `{"format":"${BACKUP_FORMAT}","formatVersion":1,"schemaVersion":1,"kind":"export",` +
      `"exportedAt":${String(T0)},"deviceId":"${fixtureId(1)}","counts":{"lists":0,"tasks":0,"snapshots":0},` +
      `"data":{"settings":{"id":"settings"},"lists":[],"tasks":[${'0,'.repeat(100_000)}0],"snapshots":[]}}`;
    const parsed = parseBackupDocument(bomb, TARGET);
    expect(parsed).toMatchObject({
      ok: false,
      error: { code: 'LIMIT_EXCEEDED', limit: 'data.tasks', found: 100_001, cap: 100_000 },
    });
  });

  it('caps the input size before reading a File (FILE_TOO_LARGE)', async () => {
    const huge = fakeFile('huge.json', '', MAX_IMPORT_BYTES + 1);
    expect(inputByteSize(huge)).toBe(MAX_IMPORT_BYTES + 1);
    const read = await readImportText(huge);
    expect(read).toMatchObject({
      ok: false,
      error: { code: 'FILE_TOO_LARGE', cap: MAX_IMPORT_BYTES },
    });
    // ...and the same cap applies to raw strings.
    expect(parseBackupDocument('x'.repeat(MAX_IMPORT_BYTES + 1), TARGET)).toMatchObject({
      ok: false,
      error: { code: 'FILE_TOO_LARGE' },
    });
  });

  it('measures the cap in UTF-8 BYTES, not UTF-16 code units (multi-byte content)', async () => {
    // Thai text: one UTF-16 code unit per char, three UTF-8 bytes per char —
    // so `.length` and the byte length disagree for the very input the cap
    // exists to bound.
    const thai = 'สวัสดี โลก';
    const thaiBytes = new TextEncoder().encode(thai).length;
    expect(thai.length).toBeLessThan(thaiBytes); // the two measures differ
    expect(inputByteSize(thai)).toBe(thaiBytes);
    expect(inputByteSize(thai)).toBeGreaterThan(thai.length);
    const fromString = await readImportText(thai);
    expect(fromString.ok && fromString.value.bytes).toBe(thaiBytes);

    // UNDER the cap in code units, OVER it in bytes → still FILE_TOO_LARGE
    // (a code-unit check would have let this through to JSON.parse).
    const multiByteOverCap = 'ก'.repeat(Math.floor(MAX_IMPORT_BYTES / 3) + 1);
    expect(multiByteOverCap.length).toBeLessThanOrEqual(MAX_IMPORT_BYTES);
    expect(parseBackupDocument(multiByteOverCap, TARGET)).toMatchObject({
      ok: false,
      error: {
        code: 'FILE_TOO_LARGE',
        bytes: multiByteOverCap.length * 3,
        cap: MAX_IMPORT_BYTES,
      },
    });
    expect(inputByteSize(multiByteOverCap)).toBe(multiByteOverCap.length * 3);
  });

  it('reads File and string inputs (readImportText) and surfaces read failures as PARSE_ERROR', async () => {
    const text = makeDocText({ ...seedCorpus() });
    const fromFile = await readImportText(fakeFile('backup.json', text));
    expect(fromFile.ok).toBe(true);
    if (fromFile.ok) expect(fromFile.value.text).toBe(text);
    const fromString = await readImportText(text);
    if (fromString.ok) expect(fromString.value.bytes).toBe(text.length);

    const broken = {
      name: 'broken.json',
      size: 10,
      text: () => Promise.reject(new Error('unreadable')),
    } as unknown as File;
    const failed = await readImportText(broken);
    expect(failed).toMatchObject({ ok: false, error: { code: 'PARSE_ERROR' } });
  });
});

describe('filename conventions (Decision 9)', () => {
  it('produces filesystem-safe UTC names with no colons in the time part', () => {
    expect(backupFileName(Date.UTC(2026, 9, 23, 18, 37, 0))).toBe(
      'local-first-todo-backup-2026-10-23T183700Z.json',
    );
    expect(snapshotFileName(Date.UTC(2026, 9, 23, 8, 5, 9))).toBe(
      'local-first-todo-snapshot-2026-10-23T080509Z.json',
    );
    expect(recoveryFileName(Date.UTC(2026, 9, 23, 8, 5, 9))).toBe(
      'local-first-todo-recovery-2026-10-23T080509Z.json',
    );
  });
});
