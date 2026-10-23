import type { JSX } from 'preact';

import { t } from '../../app/i18n';
import { TaskScreen } from '../tasks/TaskScreen';

/**
 * Today (`/today`) — task view per design §7 S2 (M3) on top of the domain selector
 * (ADR-003): grouping, membership and order come from `selectView({kind:'today'})`
 * (Overdue + Today, pinned by the domain's golden tests); this card owns the header,
 * composer, rows, states and interactions.
 */
export function TodayView(): JSX.Element {
  return (
    <TaskScreen
      view={{ kind: 'today' }}
      title={t('view.today')}
      emptyIcon="check-circle"
      emptyTitle={t('today.empty.title')}
      emptyBody={t('today.empty.body')}
    />
  );
}
