/**
 * RRULE-lite recurrence semantics (S4, V1) — pure date math over ALL-DAY due
 * dates, i.e. `YYYY-MM-DD` local day labels (E6: no timezone math, never
 * `new Date(string)` which parses as UTC midnight).
 *
 * Binding format (`model.ts` `Recurrence`, reserved by the E7 schemaVersion 3
 * migration): `{ freq, interval >= 1, until?: 'YYYY-MM-DD' }` — NO exceptions
 * and NO end-count (PROJECT_ANALYSIS R4: the subset is the whole V1 surface).
 *
 * Semantics (settled by t_1b9ee0e6 / this card t_354a153f):
 * - `daily`   + interval calendar days,
 * - `weekly`  + interval weeks,
 * - `monthly` + interval calendar months with DAY CLAMPING (Jan 31 + 1 month =
 *   Feb 28/29 — the clamped day sticks for later steps, so
 *   Jan 31 -> Feb 28 -> Mar 28, never Mar 31),
 * - `weekdays` counts WEEKDAY occurrences (Mon-Fri) — independent of the
 *   `weekStart` setting by binding decision.
 * - `until` is INCLUSIVE: an occurrence landing exactly on `until` still
 *   happens; the first one after it ends the series (`null`).
 * - The next occurrence is always STRICTLY AFTER `after` (the completion day),
 *   so completing a task early never skips an occurrence and completing one
 *   late rolls the series forward instead of minting a past-due duplicate.
 *
 * The same stepping rules drive the S5 reminder roll-forward
 * (`features/notifications/scheduler.ts`) — see docs/dev/commands-notify.md §3.
 */

import type { Recurrence } from './model';

/**
 * Safety valve for the roll-forward loop (a decade-old due date on a daily rule
 * is ~3 700 steps; this bounds a pathological row without changing any sane
 * result). Same spirit as the scheduler's `MAX_STEPS`.
 */
export const MAX_OCCURRENCE_STEPS = 100_000;

/** Local calendar parts — never a UTC instant (E6). */
type Parts = { readonly y: number; readonly m: number; readonly d: number };

const DAY_LABEL = /^(\d{4})-(\d{2})-(\d{2})$/u;

function pad2(n: number): string {
  return n < 10 ? `0${String(n)}` : String(n);
}

/** `YYYY-MM-DD` -> parts, rejecting impossible days (2025-02-30). */
function parseDayLabel(value: string): Parts | null {
  const match = DAY_LABEL.exec(value);
  if (match === null) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1) return null;
  // Round-trip through a LOCAL date: catches 2025-02-30 without timezone math.
  const probe = new Date(y, m - 1, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== m - 1 || probe.getDate() !== d) {
    return null;
  }
  return { y, m, d };
}

function toLocalDate(parts: Parts): Date {
  return new Date(parts.y, parts.m - 1, parts.d);
}

function dayLabel(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function shiftDays(parts: Parts, days: number): string {
  return dayLabel(new Date(parts.y, parts.m - 1, parts.d + days));
}

function isWeekday(date: Date): boolean {
  const day = date.getDay();
  return day !== 0 && day !== 6;
}

/** One recurrence step from the day label `from`, or `null` for an unusable row. */
export function stepOccurrence(from: string, recurrence: Recurrence): string | null {
  const interval = Math.trunc(recurrence.interval);
  if (!Number.isFinite(interval) || interval < 1) return null;
  const parts = parseDayLabel(from);
  if (parts === null) return null;

  switch (recurrence.freq) {
    case 'daily':
      return shiftDays(parts, interval);
    case 'weekly':
      return shiftDays(parts, interval * 7);
    case 'monthly': {
      const months = parts.y * 12 + (parts.m - 1) + interval;
      const y = Math.floor(months / 12);
      const m = (months % 12) + 1;
      const lastDay = new Date(y, m, 0).getDate(); // day 0 of the NEXT month
      return dayLabel(new Date(y, m - 1, Math.min(parts.d, lastDay)));
    }
    case 'weekdays': {
      let date = toLocalDate(parts);
      let remaining = interval;
      while (remaining > 0) {
        date = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
        if (isWeekday(date)) remaining -= 1;
      }
      return dayLabel(date);
    }
  }
}

/**
 * The next occurrence of a series that started at the day label `from`, rolled
 * forward past the day label `after` (the completion day) and capped by
 * `until`. `null` = the series has no next occurrence (ended, or the row is
 * unusable).
 */
export function nextOccurrence(from: string, recurrence: Recurrence, after: string): string | null {
  // Day labels are zero-padded ISO dates, so lexicographic order IS calendar
  // order — no instant conversion anywhere on this path (E6).
  let current = from;
  for (let steps = 0; steps <= MAX_OCCURRENCE_STEPS; steps += 1) {
    const next = stepOccurrence(current, recurrence);
    // Defensive: a step must strictly advance, otherwise a broken rule would spin.
    if (next === null || next <= current) return null;
    if (next > after) {
      const until = recurrence.until;
      return until !== undefined && next > until ? null : next;
    }
    current = next;
  }
  return null;
}

/** Does `recurrence` still have an occurrence strictly after the day label `after`? */
export function hasOccurrenceAfter(recurrence: Recurrence, from: string, after: string): boolean {
  return nextOccurrence(from, recurrence, after) !== null;
}
