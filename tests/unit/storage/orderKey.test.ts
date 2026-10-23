import { describe, expect, it } from 'vitest';

import {
  ORDER_KEY_MAX,
  OrderKeyError,
  isCanonicalOrderKey,
  orderKeyAfter,
  orderKeyBefore,
  orderKeyBetween,
  orderKeyFirst,
} from '../../../src/storage/orderKey';

import { mulberry32 } from './fixtures';

function expectBetween(a: string | null, b: string | null, m: string): void {
  if (a !== null) expect(a < m).toBe(true);
  if (b !== null) expect(m < b).toBe(true);
  expect(isCanonicalOrderKey(m)).toBe(true);
  expect(m.length).toBeLessThanOrEqual(ORDER_KEY_MAX);
}

describe('order keys (ADR-002 Decision 4.2)', () => {
  it('seeds with "h" (known vector)', () => {
    expect(orderKeyFirst()).toBe('h');
    expect(orderKeyBetween(null, null)).toBe('h');
  });

  it('keeps strict bounds for known vectors', () => {
    const cases: [string | null, string | null][] = [
      [null, 'h'],
      ['h', null],
      ['a', 'b'],
      ['h', 'hz'],
      ['1', '101'],
      ['00h', '0h'],
      ['zzzz', 'zzzzz'],
      [null, '00h'],
    ];
    for (const [a, b] of cases) {
      const m = orderKeyBetween(a, b);
      expectBetween(a, b, m);
    }
  });

  it('after/before helpers respect bounds', () => {
    const a = orderKeyFirst();
    const after = orderKeyAfter(a);
    expect(a < after).toBe(true);
    const before = orderKeyBefore(a);
    expect(before < a).toBe(true);
    expectBetween(a, null, after);
    expectBetween(null, a, before);
  });

  it('property: repeated random inserts keep a strict total order', () => {
    const rand = mulberry32(0xc0ffee);
    const keys = [orderKeyFirst()];
    for (let i = 0; i < 300; i += 1) {
      const at = Math.floor(rand() * (keys.length + 1));
      const a = at > 0 ? (keys[at - 1] as string) : null;
      const b = at < keys.length ? (keys[at] as string) : null;
      const m = orderKeyBetween(a, b);
      expectBetween(a, b, m);
      keys.splice(at, 0, m);
    }
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('property: canonicity — results never end in 0 and stay within the cap', () => {
    const rand = mulberry32(7);
    const keys = ['1', 'h', 'zz'];
    for (let i = 0; i < 200; i += 1) {
      const at = Math.floor(rand() * (keys.length + 1));
      const a = at > 0 ? (keys[at - 1] as string) : null;
      const b = at < keys.length ? (keys[at] as string) : null;
      const m = orderKeyBetween(a, b);
      expect(isCanonicalOrderKey(m)).toBe(true);
      expect(m.endsWith('0')).toBe(false);
      expect(m.length).toBeLessThanOrEqual(ORDER_KEY_MAX);
      keys.splice(at, 0, m);
    }
  });

  it('density: a midpoint exists between any two canonical keys', () => {
    const rand = mulberry32(99);
    const pool = ['1', '2', 'h', 'hh', 'hz', '0h', '00h', 'zzzzzz', 'm3d', '0000h'];
    for (let i = 0; i < 100; i += 1) {
      const [x, y] = [
        pool[Math.floor(rand() * pool.length)],
        pool[Math.floor(rand() * pool.length)],
      ];
      if (x === undefined || y === undefined || x === y || x > y) continue;
      expectBetween(x, y, orderKeyBetween(x, y));
    }
  });

  it('rejects invalid input (programmer error)', () => {
    expect(() => orderKeyBetween('h', 'h')).toThrow(OrderKeyError);
    expect(() => orderKeyBetween('hz', 'h')).toThrow(OrderKeyError);
    expect(() => orderKeyBetween('h0', 'z')).toThrow(OrderKeyError); // non-canonical (trailing 0)
    expect(() => orderKeyBetween('H', 'z')).toThrow(OrderKeyError); // uppercase
    expect(() => orderKeyBetween('', 'z')).toThrow(OrderKeyError); // empty
    try {
      orderKeyBetween('h0', 'z');
    } catch (e) {
      expect((e as OrderKeyError).code).toBe('INVALID_INPUT');
    }
  });

  it('signals EXHAUSTED when no midpoint fits the 32-char cap (rebalance hatch)', () => {
    try {
      orderKeyBetween(null, `${'0'.repeat(31)}1`);
      expect.unreachable('expected EXHAUSTED');
    } catch (e) {
      expect((e as OrderKeyError).code).toBe('EXHAUSTED');
    }
    try {
      orderKeyAfter('h'.repeat(ORDER_KEY_MAX));
      expect.unreachable('expected EXHAUSTED');
    } catch (e) {
      expect((e as OrderKeyError).code).toBe('EXHAUSTED');
    }
  });

  it('isCanonicalOrderKey enforces alphabet, canonicity, and cap', () => {
    expect(isCanonicalOrderKey('h')).toBe(true);
    expect(isCanonicalOrderKey('0000h')).toBe(true);
    expect(isCanonicalOrderKey('0')).toBe(false); // trailing zero
    expect(isCanonicalOrderKey('hz0')).toBe(false);
    expect(isCanonicalOrderKey('H')).toBe(false);
    expect(isCanonicalOrderKey('h!')).toBe(false);
    expect(isCanonicalOrderKey('')).toBe(false);
    expect(isCanonicalOrderKey('h'.repeat(33))).toBe(false);
    expect(isCanonicalOrderKey(12)).toBe(false);
    expect(isCanonicalOrderKey(null)).toBe(false);
  });
});
