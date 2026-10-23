import type { JSX } from 'preact';

import { t } from '../../app/i18n';
import { EmptyState, View } from '../../components/View';

/**
 * Completed (`/completed`) — shell scaffolding (design §4.7).
 * The completed list and reopen/delete row menus land with the core-UI card.
 */
export function CompletedView(): JSX.Element {
  return (
    <View title={t('view.completed')}>
      <EmptyState
        icon="check-circle"
        title={t('completed.empty.title')}
        body={t('completed.empty.body')}
      />
    </View>
  );
}
