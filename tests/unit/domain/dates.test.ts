/**
 * All-day dueDate semantics (ADR-003 Decision 5 / PROJECT_ANALYSIS E6):
 * local calendar-day labels, no timezone math — `todayStr` must never flip at
 * UTC midnight.
 */
import { describe, expect, it } from 'vitest';

import {
  addDays,
  diffDays,
  isOverdue,
  isWithinNext7,
  msUntilNextLocalMidnight,
  todayStr,
} from '../../../src/domain/dates';
import { makeTask, T0 } from './fixtures';

describe('dates: local calendar-day labels', () => {
  it('todayStr uses LOCAL date components (never toISOString)', () => {
    // 00:30 local on Jan 1 — in any TZ west of UTC this is still Dec 31 UTC.
    const localNewYear = new Date(2026, 0, 1, 0, 30, 0, 0).getTime();
    expect(todayStr(() => localNewYear)).toBe('2026-01-01');
    // And a late-evening instant stays on its local day.
    const late = new Date(2026, 5, 15, 23, 59, 0, 0).getTime();
    expect(todayStr(() => late)).toBe('2026-06-15');
  });

  it('addDays does calendar arithmetic across month and year boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29'); // leap year
  });

  it('diffDays counts whole days between labels', () => {
    expect(diffDays('2026-01-01', '2026-01-03')).toBe(2);
    expect(diffDays('2026-01-03', '2026-01-01')).toBe(-2);
    expect(diffDays('2026-03-28', '2026-03-31')).toBe(3); // across a DST switch
  });

  it('isOverdue = open && dueDate < today (labels compare lexicographically)', () => {
    const t = makeTask({ dueDate: '2026-10-22' });
    expect(isOverdue(t, '2026-10-23')).toBe(true);
    expect(isOverdue(t, '2026-10-22')).toBe(false);
    expect(isOverdue({ ...t, status: 'done' }, '2026-10-23')).toBe(false);
    expect(isOverdue(makeTask(), '2026-10-23')).toBe(false); // no dueDate
  });

  it('isWithinNext7 covers [today, today+6] inclusively', () => {
    const t = makeTask();
    expect(isWithinNext7({ ...t, dueDate: '2026-10-23' }, '2026-10-23')).toBe(true);
    expect(isWithinNext7({ ...t, dueDate: '2026-10-29' }, '2026-10-23')).toBe(true);
    expect(isWithinNext7({ ...t, dueDate: '2026-10-30' }, '2026-10-23')).toBe(false);
    expect(isWithinNext7({ ...t, dueDate: '2026-10-22' }, '2026-10-23')).toBe(false);
    expect(isWithinNext7({ ...t, dueDate: '2026-10-23', status: 'done' }, '2026-10-23')).toBe(
      false,
    );
  });

  it('msUntilNextLocalMidnight counts to the next local day boundary', () => {
    const justBeforeMidnight = new Date(2026, 0, 1, 23, 59, 59, 999).getTime();
    expect(msUntilNextLocalMidnight(() => justBeforeMidnight)).toBe(1);
    const midday = new Date(2026, 0, 1, 12, 0, 0, 0).getTime();
    expect(msUntilNextLocalMidnight(() => midday)).toBe(12 * 60 * 60 * 1000);
  });

  it('a fixed epoch clock still produces a coherent label', () => {
    expect(todayStr(() => T0)).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });
});
