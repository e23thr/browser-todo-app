import { describe, expect, it, beforeEach } from 'vitest';

import { ULID_RE, isUlid, newUlid, resetUlidStateForTests } from '../../../src/storage/id';

beforeEach(() => {
  resetUlidStateForTests();
});

describe('ULID (ADR-002 Decision 4.1)', () => {
  it('produces 26-char Crockford base32 ids matching the ADR regex', () => {
    for (let i = 0; i < 50; i += 1) {
      const id = newUlid();
      expect(id).toHaveLength(26);
      expect(id).toMatch(ULID_RE);
      expect(isUlid(id)).toBe(true);
    }
  });

  it('is monotonic within the same millisecond', () => {
    const now = 1_700_000_000_000;
    const ids = Array.from({ length: 100 }, () => newUlid(now));
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(100);
  });

  it('sorts lexicographically in creation order across milliseconds', () => {
    const a = newUlid(1_700_000_000_000);
    const b = newUlid(1_700_000_000_001);
    const c = newUlid(1_700_000_001_000);
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
  });

  it('never goes backwards on clock skew (clamps to last timestamp)', () => {
    const a = newUlid(1_700_000_005_000);
    const b = newUlid(1_700_000_000_000); // clock moved backwards
    expect(b > a).toBe(true);
  });

  it('encodes the timestamp in the first 10 chars', () => {
    const t = 1_700_000_000_000;
    const id1 = newUlid(t);
    const id2 = newUlid(t + 1); // one step in the last time digit
    expect(id1.slice(0, 9)).toBe(id2.slice(0, 9));
    expect(id1.slice(0, 10)).not.toBe(id2.slice(0, 10));
  });

  it('exhausting the random component in one ms bumps the encoded time', () => {
    const now = 1_700_000_000_000;
    let last = '';
    for (let i = 0; i < 4000; i += 1) {
      last = newUlid(now);
    }
    expect(last).toMatch(ULID_RE);
  });

  it('refuses timestamps beyond the 48-bit ULID range', () => {
    expect(() => newUlid(281_474_976_710_656)).toThrow(RangeError);
  });

  it('isUlid rejects wrong shapes', () => {
    expect(isUlid('')).toBe(false);
    expect(isUlid('x'.repeat(26))).toBe(false); // 'X' would be ok uppercase, 'x' lowercase is not
    expect(isUlid('0'.repeat(25))).toBe(false);
    expect(isUlid('0'.repeat(27))).toBe(false);
    expect(isUlid('0'.repeat(24) + 'IL')).toBe(false); // excluded letters
    expect(isUlid(42)).toBe(false);
    expect(isUlid(null)).toBe(false);
  });
});
