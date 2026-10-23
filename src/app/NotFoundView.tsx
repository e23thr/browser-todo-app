import type { JSX } from 'preact';

import { View } from '../components/View';
import { t } from './i18n';

export function NotFoundView({ path }: { readonly path: string }): JSX.Element {
  return (
    <View title={t('notFound.title')}>
      <p class="empty-state-body">{t('notFound.body', { path })}</p>
      <p>
        <a href="#/today">{t('notFound.back')}</a>
      </p>
    </View>
  );
}
