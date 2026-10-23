/**
 * Presentation helpers for the data-safety surface (design §4.3 value lines, §10.4 age labels).
 *
 * Pure functions with an injectable `now` — §9: "All numeric ages computed from an injectable
 * now (testability)". Everything user-visible goes through `t()`; dates follow the active
 * locale (§11: localized absolute date, localized relative family).
 */

import { t, getLocale } from '../../i18n';

const MB = 1024 * 1024;
const GB = 1024 * MB;
const DAY_MS = 86_400_000;

/** Trim a float to one decimal without a trailing `.0` ("2.0" → "2"). */
function trim(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return String(Number.isInteger(rounded) ? rounded : rounded.toFixed(1));
}

/**
 * Quota value line (§4.3): MB below 1 GB, GB above. Used bytes round to whole MB under a GB,
 * so the number never implies precision the StorageManager does not have.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 MB';
  if (bytes < GB) return `${String(Math.round(bytes / MB))} MB`;
  return `${trim(bytes / GB)} GB`;
}

/** Friendly total ("≈2 GB"): the estimate is an approximation and the copy admits it. */
export function formatTotal(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return formatBytes(bytes);
  return bytes < GB ? formatBytes(bytes) : `≈${trim(bytes / GB)} GB`;
}

/** Integer percent 0–100, or `null` when the browser reported no total (§4.3 unknown state). */
export function percentOf(used: number, total: number | null): number | null {
  if (total === null || !Number.isFinite(total) || total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((used / total) * 100)));
}

/** Whole calendar days between two instants, in the viewer's local timezone (§3.2: `today −
 * lastBackupAt`), so "Yesterday" means yesterday's DATE, not "24 hours ago". */
export function daysBetween(from: number, to: number): number {
  const a = new Date(from);
  const b = new Date(to);
  const dayA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const dayB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.max(0, Math.round((dayB - dayA) / DAY_MS));
}

/**
 * Age of the last backup in whole days: `null` = never backed up (§3.2 treats never as +∞ for
 * the nudge, but the copy is different — "You haven't backed up yet.").
 */
export function backupAgeDays(lastBackupAt: number | null, now: number): number | null {
  if (lastBackupAt === null) return null;
  return daysBetween(lastBackupAt, now);
}

/** §4.3 relative label family: Never / Today / Yesterday / N days ago / N months ago. */
export function relativeAge(at: number | null, now: number): string {
  if (at === null) return t('dataSafety.age.never');
  const days = daysBetween(at, now);
  if (days <= 0) return t('dataSafety.age.today');
  if (days === 1) return t('dataSafety.age.yesterday');
  if (days < 60) return t('dataSafety.age.days', { N: days });
  return t('dataSafety.age.months', { N: Math.round(days / 30) });
}

/** Localized absolute date ("5 Oct 2026") for the `(5 Oct 2026)` half of the backup row. */
export function absoluteDate(at: number, locale: string = getLocale()): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

/** Localized absolute date + time for snapshot rows ("23 Oct 2026, 14:02"). */
export function absoluteDateTime(at: number, locale: string = getLocale()): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(at));
  } catch {
    return absoluteDate(at, locale);
  }
}
