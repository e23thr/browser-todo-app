import { describe, expect, it } from 'vitest';

import {
  isLocalDateString,
  validateList,
  validateMeta,
  validateRow,
  validateSettings,
  validateSnapshot,
  validateSnapshotPayload,
  validateTask,
} from '../../../src/storage/validate';

import {
  makeList,
  makeMeta,
  makeSettings,
  makeSnapshot,
  makeTask,
  newUlidSafe,
} from './fixtures-helpers';

const issuesOf = (r: { ok: boolean; issues?: string[] }): string[] => r.issues ?? [];

describe('validate.ts (ADR-002 Decision 11)', () => {
  it('accepts valid records of every type', () => {
    expect(validateMeta(makeMeta()).ok).toBe(true);
    expect(validateList(makeList()).ok).toBe(true);
    expect(validateTask(makeTask()).ok).toBe(true);
    expect(validateSettings(makeSettings()).ok).toBe(true);
    const id = newUlidSafe();
    expect(validateSnapshot(makeSnapshot(id)).ok).toBe(true);
    expect(validateSnapshotPayload({ id, payload: '{"schemaVersion":1}' }).ok).toBe(true);
  });

  it('validates dueDate against a real calendar', () => {
    expect(isLocalDateString('2026-02-28')).toBe(true);
    expect(isLocalDateString('2024-02-29')).toBe(true); // leap year
    expect(isLocalDateString('2026-02-30')).toBe(false);
    expect(isLocalDateString('2026-02-29')).toBe(false); // not a leap year
    expect(isLocalDateString('2026-13-01')).toBe(false);
    expect(isLocalDateString('2026-1-1')).toBe(false); // strict format
    expect(isLocalDateString('2026-01-01T00:00:00Z')).toBe(false);
    expect(isLocalDateString('')).toBe(false);
    expect(isLocalDateString(20260101)).toBe(false);
    const bad = makeTask({ dueDate: '2026-02-30' });
    expect(validateTask(bad).ok).toBe(false);
  });

  it('rejects oversized strings per Decision 3 caps', () => {
    expect(validateList(makeList({ name: 'x'.repeat(201) })).ok).toBe(false);
    expect(validateList(makeList({ name: '   ' })).ok).toBe(false);
    expect(validateTask(makeTask({ title: 'x'.repeat(1001) })).ok).toBe(false);
    expect(validateTask(makeTask({ notes: 'x'.repeat(20_001) })).ok).toBe(false);
    expect(validateTask(makeTask({ notes: null })).ok).toBe(true);
    expect(validateTask(makeTask({ tags: ['x'.repeat(101)] })).ok).toBe(false);
    expect(validateTask(makeTask({ tags: Array.from({ length: 51 }, () => 't') })).ok).toBe(false);
  });

  it('enforces the ADR-004 §6.2 caps at exact boundaries', () => {
    // Task.tags: each 1..100 chars (ADR-002 left the cap open — §6.2 table rules).
    expect(validateTask(makeTask({ tags: ['x'.repeat(100)] })).ok).toBe(true);
    expect(validateTask(makeTask({ tags: ['x'.repeat(101)] })).ok).toBe(false);
    expect(validateTask(makeTask({ tags: ['x'.repeat(80)] })).ok).toBe(true); // spec-valid probe
    // List.color theme token: ^[a-z][a-z0-9-]{0,31}$ (32 chars incl. first).
    expect(validateList(makeList({ color: 'a'.padEnd(32, 'b') })).ok).toBe(true);
    expect(validateList(makeList({ color: 'a'.padEnd(33, 'b') })).ok).toBe(false);
    expect(validateList(makeList({ color: 'Accent-Red' })).ok).toBe(false); // lowercase-only
    // Settings.locale: 1..35 chars, BCP-47-ish (multi-subtag allowed).
    expect(validateSettings(makeSettings({ locale: 'x'.repeat(35) })).ok).toBe(true);
    expect(validateSettings(makeSettings({ locale: 'x'.repeat(36) })).ok).toBe(false);
    expect(validateSettings(makeSettings({ locale: 'zh-Hant-TW' })).ok).toBe(true); // spec-valid probe
    // Timestamps: non-negative safe integers — no year-9999 ceiling (§6.2).
    expect(validateTask(makeTask({ createdAt: Number.MAX_SAFE_INTEGER })).ok).toBe(true);
  });

  it('rejects wrong types, ranges, and formats', () => {
    expect(validateTask(makeTask({ priority: 3 as never })).ok).toBe(false);
    expect(validateTask(makeTask({ status: 'nope' as never })).ok).toBe(false);
    expect(validateTask(makeTask({ tags: 'todo' as never })).ok).toBe(false);
    expect(validateTask(makeTask({ sortOrder: 'H!' })).ok).toBe(false);
    expect(validateTask(makeTask({ id: 'not-a-ulid' })).ok).toBe(false);
    expect(validateTask(makeTask({ deletedAt: 'yesterday' as never })).ok).toBe(false);
    expect(validateTask(makeTask({ deletedAt: null })).ok).toBe(true);
    expect(validateTask(makeTask({ createdAt: -5 })).ok).toBe(false);
    expect(validateTask(makeTask({ createdAt: 1.5 })).ok).toBe(false);
    expect(validateList(makeList({ color: 'blue-ish!' })).ok).toBe(false);
    expect(validateList(makeList({ color: '#ff00aa' })).ok).toBe(true);
    expect(validateList(makeList({ color: 'accent-strong' })).ok).toBe(true);
  });

  it('validates recurrence strictly', () => {
    expect(validateTask(makeTask({ recurrence: { freq: 'daily', interval: 1 } })).ok).toBe(true);
    expect(
      validateTask(makeTask({ recurrence: { freq: 'weekly', interval: 2, until: '2026-01-31' } }))
        .ok,
    ).toBe(true);
    expect(
      validateTask(makeTask({ recurrence: { freq: 'yearly' as never, interval: 1 } })).ok,
    ).toBe(false);
    expect(validateTask(makeTask({ recurrence: { freq: 'daily', interval: 0 } })).ok).toBe(false);
    expect(
      validateTask(makeTask({ recurrence: { freq: 'daily', interval: 1, until: '2026-02-30' } }))
        .ok,
    ).toBe(false);
    expect(validateTask(makeTask({ recurrence: 'daily' as never })).ok).toBe(false);
  });

  it('blocks prototype-pollution-shaped payloads (E8 malicious import)', () => {
    const polluted = JSON.parse('{"id":"x","__proto__":{"admin":true}}') as unknown;
    const r = validateList(polluted);
    expect(r.ok).toBe(false);
    expect(issuesOf(r).join(' ')).toContain('__proto__');

    const ctor = JSON.parse('{"id":"x","constructor":{"bad":1}}') as unknown;
    expect(validateList(ctor).ok).toBe(false);
    const proto = { id: 'x', prototype: {} } as unknown;
    expect(validateList(proto).ok).toBe(false);

    const nested = JSON.parse(
      '{"id":"x","name":"n","color":"#ffffff","sortOrder":"h","createdAt":1,"updatedAt":1,"deletedAt":null,"deviceId":"x","recurrence":{"__proto__":{"x":1},"freq":"daily","interval":1}}',
    ) as unknown;
    expect(validateTask(nested).ok).toBe(false);
  });

  it('rejects unknown fields (strict schema)', () => {
    const extra = { ...makeList(), surprise: 1 };
    const r = validateList(extra);
    expect(r.ok).toBe(false);
    expect(issuesOf(r).join(' ')).toContain('surprise');
  });

  it('validates meta and settings singletons', () => {
    expect(validateMeta({ ...makeMeta(), schemaVersion: 0 }).ok).toBe(false);
    expect(validateMeta({ ...makeMeta(), deviceId: 'nope' }).ok).toBe(false);
    expect(validateSettings({ ...makeSettings(), id: 'other' }).ok).toBe(false);
    expect(validateSettings({ ...makeSettings(), theme: 'neon' as never }).ok).toBe(false);
    expect(validateSettings({ ...makeSettings(), weekStart: 2 as never }).ok).toBe(false);
    expect(validateSettings({ ...makeSettings(), defaultListId: 'nope' }).ok).toBe(false);
    expect(validateSettings({ ...makeSettings(), defaultListId: null }).ok).toBe(true);
    expect(validateSettings({ ...makeSettings(), notificationsEnabled: 'yes' as never }).ok).toBe(
      false,
    );
    expect(validateSettings({ ...makeSettings(), lastBackupAt: null }).ok).toBe(true);
    expect(validateSettings({ ...makeSettings(), lastBackupAt: 'soon' as never }).ok).toBe(false);
    expect(validateSettings({ ...makeSettings(), locale: 'en-US' }).ok).toBe(true);
    expect(validateSettings({ ...makeSettings(), locale: 'not a locale!' }).ok).toBe(false);
    expect(validateMeta('not an object').ok).toBe(false);
  });

  it('validates snapshots and payloads (payloadRef == id convention)', () => {
    const id = newUlidSafe();
    expect(validateSnapshot({ ...makeSnapshot(id), payloadRef: 'other' }).ok).toBe(false);
    expect(validateSnapshot({ ...makeSnapshot(id), kind: 'auto2' as never }).ok).toBe(false);
    expect(validateSnapshot({ ...makeSnapshot(id), reason: 'oops' as never }).ok).toBe(false);
    expect(validateSnapshot({ ...makeSnapshot(id), sizeBytes: -1 }).ok).toBe(false);
    expect(validateSnapshot({ ...makeSnapshot(id), schemaVersion: 0 }).ok).toBe(false);
    expect(validateSnapshotPayload({ id, payload: 'not json' }).ok).toBe(false);
    expect(validateSnapshotPayload({ id, payload: '[1,2]' }).ok).toBe(false);
    expect(validateSnapshotPayload({ id, payload: 42 }).ok).toBe(false);
    expect(validateSnapshotPayload({ id: 'nope', payload: '{}' }).ok).toBe(false);
  });

  it('validateRow dispatches per store', () => {
    expect(validateRow('tasks', makeTask()).ok).toBe(true);
    expect(validateRow('lists', makeList()).ok).toBe(true);
    expect(validateRow('meta', makeMeta()).ok).toBe(true);
    expect(validateRow('settings', makeSettings()).ok).toBe(true);
    const id = newUlidSafe();
    expect(validateRow('snapshots', makeSnapshot(id)).ok).toBe(true);
    expect(validateRow('snapshot_payloads', { id, payload: '{}' }).ok).toBe(true);
  });
});
