import type { JSX } from 'preact';

import { t } from '../../app/i18n';
import { startQuickAdd } from '../../app/quickAdd';
import { EmptyState, View } from '../../components/View';

/**
 * All open (`/all`) — shell scaffolding (design §4.5).
 * List grouping lands with the core-UI card.
 */
export function AllOpenView(): JSX.Element {
  return (
    <View title={t('view.allOpen')}>
      <EmptyState
        icon="file-text"
        title={t('all.empty.title')}
        body={t('all.empty.body')}
        actionLabel={t('task.action.add')}
        onAction={startQuickAdd}
      />
    </View>
  );
}
