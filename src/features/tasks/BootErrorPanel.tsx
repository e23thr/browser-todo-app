/**
 * Boot-error panel (design §14 error row) — the shared "could not start" state for both
 * screens that render store state: the task views (S2) and the lists manager (S6).
 *
 * Carries the required Retry action (`common.retry` → `retryBoot()`, which resets the
 * storage boot singleton through the store — ADR-003 composition root: no screen talks
 * to `src/storage/boot`), the storage shortcut, and the typed error code for bug reports.
 */

import type { JSX } from 'preact';

import { t } from '../../app/i18n';
import { bootError, retryBoot } from './store';

export function BootErrorPanel(): JSX.Element {
  return (
    <div class="error-panel" role="alert" data-testid="boot-error">
      <h2>{t('error.boot.title')}</h2>
      <p>{t('error.boot.body')}</p>
      <div class="error-actions">
        <button
          type="button"
          class="button button-primary"
          onClick={() => {
            retryBoot();
          }}
        >
          {t('common.retry')}
        </button>
        <a class="button button-secondary" href="#/settings">
          {t('settings.storage')}
        </a>
      </div>
      {bootError.value !== null ? (
        <p class="error-code" data-testid="boot-error-code">
          {bootError.value.code}
        </p>
      ) : null}
    </div>
  );
}
