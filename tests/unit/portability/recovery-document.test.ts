/**
 * Recovery document (ADR-004 Decision 7): `serializeRecoveryDoc` is the ONLY
 * recovery-file writer — import quarantine AND boot-validation quarantine
 * produce this exact shape (the E1 hook delegates here).
 */
import { describe, expect, it } from 'vitest';

import {
  buildRecoveryDocumentFile,
  serializeRecoveryDoc,
} from '../../../src/portability/recovery-document';
import { fixtureId, T0 } from './helpers';

describe('serializeRecoveryDoc (Decision 7.1)', () => {
  it('emits the pinned envelope, verbatim raws and the not-importable format token', () => {
    const raw = { id: fixtureId(20), title: { hostile: true } };
    const json = serializeRecoveryDoc(
      [
        { store: 'tasks', id: fixtureId(20), issues: ['title: type (string)'], raw },
        { store: 'tasks', id: null, issues: ['id: missing or not a ULID'], raw: { title: 'x' } },
      ],
      { kind: 'boot-validation', fileName: null, fileSchemaVersion: 1 },
      { createdAt: T0, deviceId: fixtureId(1), schemaVersion: 1 },
    );

    expect(json.endsWith('\n')).toBe(true);
    expect(json).toContain('\n  "format"'); // pretty-printed, human-repairable
    const doc = JSON.parse(json) as {
      format: string;
      formatVersion: number;
      schemaVersion: number;
      createdAt: number;
      deviceId: string;
      source: { kind: string; fileName: string | null; fileSchemaVersion: number };
      entries: { store: string; id: string | null; issues: string[]; raw: unknown }[];
    };
    expect(doc.format).toBe('local-first-todo-recovery');
    expect(doc.formatVersion).toBe(1);
    expect(doc.schemaVersion).toBe(1);
    expect(doc.createdAt).toBe(T0);
    expect(doc.deviceId).toBe(fixtureId(1));
    expect(doc.source).toEqual({ kind: 'boot-validation', fileName: null, fileSchemaVersion: 1 });
    expect(doc.entries).toHaveLength(2);
    expect(doc.entries[0]?.raw).toEqual(raw); // verbatim, no normalization
    expect(doc.entries[1]?.id).toBeNull();
    expect(doc.entries[0]?.issues).toEqual(['title: type (string)']);

    // The envelope key order is fixed (format, formatVersion, schemaVersion,
    // createdAt, deviceId, source, entries).
    expect(Object.keys(doc)).toEqual([
      'format',
      'formatVersion',
      'schemaVersion',
      'createdAt',
      'deviceId',
      'source',
      'entries',
    ]);
  });

  it('buildRecoveryDocumentFile pairs the pinned filename with the document', () => {
    const file = buildRecoveryDocumentFile(
      [],
      { kind: 'import', fileName: 'backup.json', fileSchemaVersion: 1 },
      { createdAt: Date.UTC(2026, 9, 23, 8, 5, 9), deviceId: fixtureId(1), schemaVersion: 1 },
    );
    expect(file.filename).toBe('local-first-todo-recovery-2026-10-23T080509Z.json');
    expect(JSON.parse(file.json)).toMatchObject({
      format: 'local-first-todo-recovery',
      entries: [],
    });
  });

  it('copies issue arrays so callers cannot mutate the document afterwards', () => {
    const issues = ['title: bad'];
    const json = serializeRecoveryDoc(
      [{ store: 'tasks', id: null, issues, raw: {} }],
      { kind: 'import', fileName: null, fileSchemaVersion: 1 },
      { createdAt: T0, deviceId: fixtureId(1), schemaVersion: 1 },
    );
    issues.push('mutated');
    const doc = JSON.parse(json) as { entries: { issues: string[] }[] };
    expect(doc.entries[0]?.issues).toEqual(['title: bad']);
  });
});
