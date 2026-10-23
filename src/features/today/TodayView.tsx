import type { JSX } from 'preact';

import { t } from '../../app/i18n';
import { startQuickAdd } from '../../app/quickAdd';
import { EmptyState, View } from '../../components/View';

/**
 * Today (`/today`) — shell scaffolding (design §4.3).
 *
 * Groups, counts, the composer and the task rows land with the core-UI card (M1–M4), which is
 * gated on this shell; until then the view renders its heading and documented empty state so
 * the navigation destination is real, reachable and announced. Keeping this route statically
 * imported is deliberate: it is the "always-loaded UI" the §9.2 initial-JS budget measures.
 */
export function TodayView(): JSX.Element {
  return (
    <View title={t('view.today')}>
      <EmptyState
        icon="check-circle"
        title={t('today.empty.title')}
        body={t('today.empty.body')}
        actionLabel={t('task.action.add')}
        onAction={startQuickAdd}
      />
    </View>
  );
}
