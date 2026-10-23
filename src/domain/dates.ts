/**
 * All-day `dueDate` helpers (ADR-003 Decision 5, PROJECT_ANALYSIS E6).
 *
 * `dueDate` is a `'YYYY-MM-DD'` **local calendar-day label** — compared
 * lexicographically (== chronological), never converted to a UTC instant.
 * `todayStr` builds the label from LOCAL date components and never calls
 * `toISOString()` (which would flip "today" at UTC midnight — the E6 bug this
 * module exists to prevent). The only `Date` usage is calendar arithmetic via
 * local-component parse/format and the UTC-component `diffDays`, both DST-safe
 * by construction.
 */

import type { Task } from './model';
import type { Clock } from './ports';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function pad2(n: number): string {
  return n < 10 ? `0${String(n)}` : String(n);
}

/** `'YYYY-MM-DD'` for the LOCAL calendar day of `now` (epoch ms UTC). */
export function todayStr(clock: Clock): string {
  const d = new Date(clock());
  return `${String(d.getFullYear()).padStart(4, '0')}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseDay(dateStr: string): { y: number; m: number; d: number } {
  return {
    y: Number(dateStr.slice(0, 4)),
    m: Number(dateStr.slice(5, 7)),
    d: Number(dateStr.slice(8, 10)),
  };
}

function formatDay(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;
}

/** Calendar arithmetic on day labels: `addDays('2026-02-28', 1) === '2026-03-01'`. */
export function addDays(dateStr: string, n: number): string {
  const { y, m, d } = parseDay(dateStr);
  // Local-component construction: the engine does the calendar math, so month
  // and year rollovers (and DST) cannot corrupt the label.
  const shifted = new Date(y, m - 1, d + n);
  return formatDay(shifted.getFullYear(), shifted.getMonth() + 1, shifted.getDate());
}

/** Whole days from `a` to `b` on the label calendar (`diffDays('2026-01-01','2026-01-03') === 2`). */
export function diffDays(a: string, b: string): number {
  const pa = parseDay(a);
  const pb = parseDay(b);
  // UTC-component construction: exactly MS_PER_DAY per step, no DST anywhere.
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / MS_PER_DAY);
}

/** `status === 'open' && dueDate < today` (ADR-003 Decision 5). */
export function isOverdue(task: Task, today: string): boolean {
  return task.status === 'open' && task.dueDate !== undefined && task.dueDate < today;
}

/** Inclusive window test used by the Next-7-days view: `today ≤ dueDate ≤ today + 6`. */
export function isWithinNext7(task: Task, today: string): boolean {
  return (
    task.status === 'open' &&
    task.dueDate !== undefined &&
    task.dueDate >= today &&
    task.dueDate <= addDays(today, 6)
  );
}

/**
 * Milliseconds from `clock()` until the next LOCAL midnight — the day-rollover
 * timer source (visibilitychange + this timer, ADR-003 Decision 5).
 */
export function msUntilNextLocalMidnight(clock: Clock): number {
  const now = new Date(clock());
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return next.getTime() - now.getTime();
}
