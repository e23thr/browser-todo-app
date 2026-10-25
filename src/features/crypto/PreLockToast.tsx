/**
 * The 60-second pre-lock toast (ADR-007 Decision 5.2): "Locking soon — keep
 * working?" — kept in its own module importing ONLY the lock signal so the
 * app shell never pulls the crypto core into its closure.
 */

import type { JSX } from 'preact';

import { t } from '../../app/i18n';
import { preLockWarning } from '../../crypto/lock';

export function PreLockToast(): JSX.Element | null {
  if (preLockWarning.value === null) return null;
  return (
    <div class="prelock-toast" role="status" data-testid="prelock-toast">
      <span>{t('crypto.preLock.toast')}</span>
      <button
        type="button"
        class="button-quiet"
        onClick={() => {
          preLockWarning.value = null;
        }}
      >
        {t('crypto.preLock.keep')}
      </button>
    </div>
  );
}
