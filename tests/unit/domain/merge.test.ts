/**
 * Per-record LWW on (updatedAt, deviceId) — the PRE-DECIDED §6.2 policy. Any
 * deviation from "greater updatedAt wins; tie -> greater deviceId" is a defect.
 */
import { describe, expect, it } from 'vitest';

import { compareLww, conflictCopyTitle, CONFLICT_COPY_PREFIX } from '../../../src/domain/merge';

describe('merge: compareLww', () => {
  it('greater updatedAt wins', () => {
    expect(
      compareLww({ updatedAt: 2, deviceId: 'a' }, { updatedAt: 1, deviceId: 'z' }),
    ).toBeGreaterThan(0);
    expect(
      compareLww({ updatedAt: 1, deviceId: 'z' }, { updatedAt: 2, deviceId: 'a' }),
    ).toBeLessThan(0);
  });

  it('equal updatedAt breaks the tie on greater deviceId (lexicographic)', () => {
    expect(
      compareLww({ updatedAt: 1, deviceId: 'b' }, { updatedAt: 1, deviceId: 'a' }),
    ).toBeGreaterThan(0);
    expect(
      compareLww({ updatedAt: 1, deviceId: 'a' }, { updatedAt: 1, deviceId: 'b' }),
    ).toBeLessThan(0);
  });

  it('identical versions compare 0; antisymmetric under argument order', () => {
    const a = { updatedAt: 5, deviceId: 'DEV-A' };
    const b = { updatedAt: 5, deviceId: 'DEV-B' };
    expect(compareLww(a, { ...a })).toBe(0);
    expect(compareLww(a, b)).toBe(-compareLww(b, a));
    expect(compareLww(a, { ...a, deviceId: 'DEV-A' })).toBe(0);
  });

  it('is a deterministic total order under sorting', () => {
    const stamps = [
      { updatedAt: 1, deviceId: 'b' },
      { updatedAt: 2, deviceId: 'a' },
      { updatedAt: 1, deviceId: 'a' },
      { updatedAt: 2, deviceId: 'b' },
    ];
    const sorted = [...stamps].sort(compareLww).map((s) => `${String(s.updatedAt)}:${s.deviceId}`);
    expect(sorted).toEqual(['1:a', '1:b', '2:a', '2:b']);
  });
});

describe('merge: conflictCopyTitle', () => {
  it('prefixes the losing version title verbatim (§6.2 contract)', () => {
    expect(conflictCopyTitle('Buy milk')).toBe(`${CONFLICT_COPY_PREFIX}Buy milk`);
  });

  it('caps the visible title at 1000 chars', () => {
    const title = conflictCopyTitle('x'.repeat(2000));
    expect(title.length).toBe(1000);
    expect(title.startsWith(CONFLICT_COPY_PREFIX)).toBe(true);
  });
});
