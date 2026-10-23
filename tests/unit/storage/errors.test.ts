import { describe, expect, it } from 'vitest';

import {
  blocked,
  classifyUnknown,
  err,
  invalidRecord,
  migrationFailed,
  newerSchema,
  notFound,
  ok,
  quotaExceeded,
  txAborted,
  unavailable,
  unknownError,
} from '../../../src/storage/errors';
import type { Result, StorageError } from '../../../src/storage/errors';

describe('errors.ts typed contract (ADR-002 §10.1/§10.4)', () => {
  it('ok/err shape', () => {
    const good: Result<number, StorageError> = ok(42);
    expect(good).toEqual({ ok: true, value: 42 });
    const bad: Result<number, StorageError> = err(notFound('tasks', 'x'));
    expect(bad.ok).toBe(false);
  });

  it('constructors produce the ADR code shapes', () => {
    expect(unavailable().code).toBe('UNAVAILABLE');
    expect(unavailable('x')).toEqual({ code: 'UNAVAILABLE', cause: 'x' });
    expect(blocked('msg')).toEqual({ code: 'BLOCKED', message: 'msg' });
    expect(quotaExceeded().code).toBe('QUOTA_EXCEEDED');
    expect(quotaExceeded('c')).toEqual({ code: 'QUOTA_EXCEEDED', cause: 'c' });
    expect(invalidRecord('tasks', ['issue'])).toEqual({
      code: 'INVALID_RECORD',
      store: 'tasks',
      issues: ['issue'],
    });
    expect(invalidRecord('tasks', ['issue'], 'id1')).toEqual({
      code: 'INVALID_RECORD',
      store: 'tasks',
      id: 'id1',
      issues: ['issue'],
    });
    expect(notFound('lists', 'k')).toEqual({ code: 'NOT_FOUND', store: 'lists', key: 'k' });
    expect(migrationFailed(1, 2)).toEqual({ code: 'MIGRATION_FAILED', from: 1, to: 2 });
    expect(migrationFailed(1, 2, 'c')).toEqual({ code: 'MIGRATION_FAILED', from: 1, to: 2, cause: 'c' });
    expect(newerSchema(3, 1)).toEqual({ code: 'NEWER_SCHEMA', found: 3, supported: 1 });
    expect(txAborted().code).toBe('TX_ABORTED');
    expect(txAborted('c')).toEqual({ code: 'TX_ABORTED', cause: 'c' });
    expect(unknownError().code).toBe('UNKNOWN');
    expect(unknownError('c')).toEqual({ code: 'UNKNOWN', cause: 'c' });
  });

  it('classifyUnknown maps DOMException names to typed errors', () => {
    const quotaModern = new DOMException('full', 'QuotaExceededError');
    expect(classifyUnknown(quotaModern).code).toBe('QUOTA_EXCEEDED');

    const quotaLegacy = { name: 'Whatever', code: 22 };
    expect(classifyUnknown(quotaLegacy).code).toBe('QUOTA_EXCEEDED');

    expect(classifyUnknown(new DOMException('aborted', 'AbortError')).code).toBe('TX_ABORTED');
    expect(classifyUnknown(new DOMException('old', 'VersionError')).code).toBe('NEWER_SCHEMA');
    expect(classifyUnknown(new DOMException('denied', 'SecurityError')).code).toBe('UNAVAILABLE');
    expect(classifyUnknown(new DOMException('closed', 'InvalidStateError')).code).toBe('UNAVAILABLE');
    expect(classifyUnknown(new DOMException('dupe', 'ConstraintError')).code).toBe('INVALID_RECORD');
    expect(classifyUnknown(new DOMException('bad data', 'DataError')).code).toBe('INVALID_RECORD');
    expect(classifyUnknown(new DOMException('clone', 'DataCloneError')).code).toBe('INVALID_RECORD');
    expect(classifyUnknown(new DOMException('?', 'UnknownError')).code).toBe('UNKNOWN');
    expect(classifyUnknown(new Error('plain')).code).toBe('UNKNOWN');
    expect(classifyUnknown('a string').code).toBe('UNKNOWN');
    expect(classifyUnknown(null).code).toBe('UNKNOWN');
    expect(classifyUnknown(undefined).code).toBe('UNKNOWN');
  });
});
