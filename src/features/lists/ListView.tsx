import type { JSX } from 'preact';

import { t } from '../../app/i18n';
import { state } from '../tasks/store';
import { TaskScreen, useResolvedList } from '../tasks/TaskScreen';

/**
 * Per-list view (`/list/:id`) — design §7 S2 (M3): flat manual order of one list's
 * open tasks, heading = the list name (the M6 card adds drag handles and `Alt+↑/↓`
 * here, D1). An unknown id (deep link, or the list deleted in another tab) redirects
 * to Today with a polite announcement (§14).
 */
export function ListView({
  params,
}: {
  readonly params: Readonly<Record<string, string>>;
}): JSX.Element {
  const id = params['id'] ?? '';
  const resolved = useResolvedList(id);
  const list = state.value.lists.get(id);
  const title = list?.name ?? t('view.list');

  return (
    <TaskScreen
      view={{ kind: 'list', listId: id }}
      title={title}
      emptyIcon="folder"
      emptyTitle={t('list.empty.tasks')}
      emptyBody={t('all.empty.body')}
      listResolved={resolved}
    />
  );
}
