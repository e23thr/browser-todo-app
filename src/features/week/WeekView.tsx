import type { JSX } from 'preact';

import { t } from '../../app/i18n';
import { startQuickAdd } from '../../app/quickAdd';
import { EmptyState, View } from '../../components/View';

/**
 * Next 7 days (`/week`, alias `/next7`) — shell scaffolding (design §4.4).
 * Day groups and per-task rows land with the core-UI card.
 */
export function WeekView(): JSX.Element {
  return (
    <View title={t('view.next7days')}>
      <EmptyState
        icon="calendar"
        title={t('next7.empty.title')}
        body={t('next7.empty.body')}
        actionLabel={t('task.action.add')}
        onAction={startQuickAdd}
      />
    </View>
  );
}
