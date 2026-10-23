import type { JSX } from 'preact';

import { t } from '../../app/i18n';
import { EmptyState, View } from '../../components/View';

/**
 * Search (`/search`) — shell scaffolding (design §4.8).
 *
 * Renders the documented empty-query state. The field, the 150 ms debounce, the result list
 * and the live result count belong to the M5 search implementation, which consumes this route
 * slot (the input must be able to read tasks, and no task data source exists yet).
 */
export function SearchView(): JSX.Element {
  return (
    <View title={t('view.search')}>
      <EmptyState icon="search" title={t('view.search')} body={t('search.hint')} />
    </View>
  );
}
