import type { JSX } from 'preact';

import { t } from '../../app/i18n';
import { TaskScreen } from '../tasks/TaskScreen';

/**
 * All open (`/all`) — design §7 S2 (M3). Grouped by list with per-list open counts
 * (ux-foundation §4.5 / ADR-003 `selectView`, pinned by golden tests); rows carry list
 * badges and no reorder affordance (D1: aggregate views use derived order).
 */
export function AllOpenView(): JSX.Element {
  return (
    <TaskScreen
      view={{ kind: 'allOpen' }}
      title={t('view.allOpen')}
      emptyIcon="file-text"
      emptyTitle={t('all.empty.title')}
      emptyBody={t('all.empty.body')}
    />
  );
}
