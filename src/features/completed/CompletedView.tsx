import type { JSX } from 'preact';

import { t } from '../../app/i18n';
import { TaskScreen } from '../tasks/TaskScreen';

/**
 * Completed (`/completed`) — design §7 S2 (M3), flat `completedAt desc`
 * (ux-foundation §4.7 / ADR-003 selector). Uncompleting is the checked checkbox on the
 * row (F3.3); completed rows stay fully editable via the row menu.
 */
export function CompletedView(): JSX.Element {
  return (
    <TaskScreen
      view={{ kind: 'completed' }}
      title={t('view.completed')}
      emptyIcon="check-circle"
      emptyTitle={t('completed.empty.title')}
      emptyBody={t('completed.empty.body')}
    />
  );
}
