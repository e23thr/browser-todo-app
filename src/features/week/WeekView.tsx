import type { JSX } from 'preact';

import { t } from '../../app/i18n';
import { TaskScreen } from '../tasks/TaskScreen';

/** Next 7 days (`/week`, alias `/next7`) — design §7 S2 (M3); day groups from the domain. */
export function WeekView(): JSX.Element {
  return (
    <TaskScreen
      view={{ kind: 'week' }}
      title={t('view.next7days')}
      emptyIcon="calendar"
      emptyTitle={t('next7.empty.title')}
      emptyBody={t('next7.empty.body')}
    />
  );
}
