import type { JSX } from 'preact';

import { t } from '../../app/i18n';
import { useListOptions } from '../../app/lists';
import { startQuickAdd } from '../../app/quickAdd';
import { EmptyState, View } from '../../components/View';

/**
 * List view (`/list/:id`) — shell scaffolding (design §4.6).
 *
 * The heading shows the resolved list name once the domain layer is wired through
 * `setListOptions()`; without it, the generic `view.list` title is used so the destination is
 * still a real, labelled screen. Rows, manual order and the row menu land with M2/M6.
 */
export function ListView({
  params,
}: {
  readonly params: Readonly<Record<string, string>>;
}): JSX.Element {
  const lists = useListOptions();
  const id = params['id'] ?? '';
  const list = lists.find((option) => option.id === id);
  const title = list?.name ?? t('view.list');

  return (
    <View title={title}>
      <EmptyState
        icon="folder"
        title={t('list.empty.tasks')}
        body={t('all.empty.body')}
        actionLabel={t('task.action.add')}
        onAction={startQuickAdd}
      />
    </View>
  );
}
