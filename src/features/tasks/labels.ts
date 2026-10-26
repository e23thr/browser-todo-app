/**
 * Display labels for domain view data (design §7 S2, §5.4).
 *
 * The domain returns STRUCTURED group labels and raw day strings; this module is where
 * they become locale-aware copy — the domain never formats user-facing strings
 * (ADR-003), and every English source string lives in the i18n catalog.
 */

import { getLocale, t } from '../../app/i18n';
import type { GroupLabel } from '../../domain/views';
import { formatDueDate, relativeDay } from './fields';

/** `YYYY-MM-DD` → localized `21 Oct` (group headers, badges). */
export function formatDayShort(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return dateStr;
  return new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'short' }).format(
    new Date(year, month - 1, day),
  );
}

/** Group header text (h2). Day groups read naturally; list groups carry the list name. */
export function groupTitle(
  label: GroupLabel,
  count: number,
  today: string,
  listName: string | null,
): string {
  switch (label.kind) {
    case 'overdue':
      return `${t('group.overdue')} (${String(count)})`;
    case 'day': {
      const rel = relativeDay(label.date, today);
      const head =
        rel === 'today'
          ? t('group.today')
          : rel === 'tomorrow'
            ? t('group.tomorrow')
            : formatDayShort(label.date);
      return `${head} (${String(count)})`;
    }
    case 'list':
      return `${listName ?? ''} (${String(count)})`;
    case 'results':
      return t('search.results.count', { count });
    case 'retention':
      // S6 retention partition: structured bucket label → localized copy.
      return `${t(label.bucket === 'recent' ? 'group.retention.recent' : 'group.retention.older')} (${String(count)})`;
    case 'archived':
      return `${t('group.archived')} (${String(count)})`;
  }
}

export interface DueBadge {
  readonly text: string;
  readonly overdue: boolean;
}

/**
 * Due badge copy (§7 S2): `task.due.overdue` (`{date}`) / `.today` / `.tomorrow`,
 * else a localized medium date. Overdue is text + marker, never colour alone.
 */
export function dueBadge(dueDate: string | undefined, today: string): DueBadge | null {
  if (dueDate === undefined) return null;
  const rel = relativeDay(dueDate, today);
  if (dueDate < today) {
    return { text: t('task.due.overdue', { date: formatDayShort(dueDate) }), overdue: true };
  }
  if (rel === 'today') return { text: t('task.due.today'), overdue: false };
  if (rel === 'tomorrow') return { text: t('task.due.tomorrow'), overdue: false };
  return { text: formatDueDate(dueDate), overdue: false };
}
