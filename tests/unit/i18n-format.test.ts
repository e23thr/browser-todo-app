import { describe, expect, it } from 'vitest';

import { resolveMessage } from '../../src/i18n/format';

/**
 * The pure core of `t()` (decomposition card t_1b9ee0e6): active catalog → English → the key
 * itself, `{name}` interpolation, and reported missing params — no DOM, no logging here.
 */

const EN = {
  plain: 'Hello',
  counted: '{count} tasks',
  two: '"{title}" moved to {list}',
  onlyEnglish: 'English only',
} as const;

const TH = {
  plain: 'สวัสดี',
  counted: '{count} งาน',
  two: 'ย้าย "{title}" ไป {list}',
} as const;

describe('resolveMessage — catalog resolution', () => {
  it('prefers the active catalog', () => {
    const r = resolveMessage(TH, EN, 'plain');
    expect(r.text).toBe('สวัสดี');
    expect(r.source).toBe('active');
    expect(r.missingParams).toEqual([]);
  });

  it('falls back to English when the active catalog lacks the key', () => {
    const r = resolveMessage(TH, EN, 'onlyEnglish');
    expect(r.text).toBe('English only');
    expect(r.source).toBe('english');
  });

  it('returns the key itself when neither catalog has it', () => {
    const r = resolveMessage(TH, EN, 'no.such.key');
    expect(r.text).toBe('no.such.key');
    expect(r.source).toBe('key');
  });

  it('treats an empty active catalog as pre-boot (English source)', () => {
    const r = resolveMessage({}, EN, 'plain');
    expect(r.text).toBe('Hello');
    expect(r.source).toBe('english');
  });
});

describe('resolveMessage — {name} interpolation', () => {
  it('substitutes every placeholder from params', () => {
    const r = resolveMessage(EN, EN, 'two', { title: 'Report', list: 'Work' });
    expect(r.text).toBe('"Report" moved to Work');
    expect(r.missingParams).toEqual([]);
  });

  it('stringifies numbers, including 0', () => {
    expect(resolveMessage(EN, EN, 'counted', { count: 0 }).text).toBe('0 tasks');
    expect(resolveMessage(EN, EN, 'counted', { count: 12 }).text).toBe('12 tasks');
  });

  it('keeps an unknown placeholder literal and reports it', () => {
    const r = resolveMessage(EN, EN, 'two', { title: 'Report' });
    expect(r.text).toBe('"Report" moved to {list}');
    expect(r.missingParams).toEqual(['list']);
  });

  it('reports every placeholder when params are omitted entirely', () => {
    const r = resolveMessage(EN, EN, 'two');
    expect(r.text).toBe('"{title}" moved to {list}');
    expect([...r.missingParams].sort()).toEqual(['list', 'title']);
  });

  it('reports a repeated missing placeholder only once', () => {
    const catalog = { again: '{x} and {x}' };
    const r = resolveMessage(catalog, catalog, 'again');
    expect(r.missingParams).toEqual(['x']);
  });

  it('leaves templates without placeholders untouched', () => {
    expect(resolveMessage(EN, EN, 'plain', { unused: 1 }).text).toBe('Hello');
  });
});
