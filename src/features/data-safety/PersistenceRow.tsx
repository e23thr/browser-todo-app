/**
 * `<PersistenceRow>` (design §5.3) — "Keeping your data".
 *
 * Four states × idle/busy/error (§10.3). The button only renders when there is something to
 * ask for (`onRequest` absent → no button), so the `granted` and `unsupported` states are
 * read-only rows instead of dead controls (§9.4).
 */

import type { JSX } from 'preact';

import { t } from '../../i18n';
import type { PersistenceState } from './storageInfo';

export interface PersistenceRowProps {
  readonly state: PersistenceState;
  /** Absent → the button is not rendered (§5.3). */
  readonly onRequest?: (() => void) | undefined;
  readonly busy?: boolean;
  /** `persist()` threw (§10.5): show the "This browser wouldn't say." line. */
  readonly error?: boolean;
}

export function PersistenceRow({
  state,
  onRequest,
  busy = false,
  error = false,
}: PersistenceRowProps): JSX.Element {
  // Static keys on purpose: the i18n gate verifies literal `t('…')` call sites (§11).
  const label = ((): string => {
    switch (state) {
      case 'granted':
        return t('dataSafety.persistence.granted');
      case 'denied':
        return t('dataSafety.persistence.denied');
      case 'unsupported':
        return t('dataSafety.persistence.unsupported');
      case 'not-requested':
        return t('dataSafety.persistence.notRequested');
    }
  })();
  const tone = state === 'granted' ? 'granted' : state === 'unsupported' ? 'muted' : 'warn';
  // §4.3: only the denied / not-requested states have something to ask for. Granted and
  // unsupported are read-only rows — never a dead control (§9.4).
  const canRequest =
    onRequest !== undefined && !busy && (state === 'denied' || state === 'not-requested');

  return (
    <div class="persistence-row" data-state={state} data-tone={tone}>
      <p class="persistence-state">
        <span class="persistence-dot" aria-hidden="true" />
        {label}
      </p>
      {error ? <p class="persistence-error">{t('dataSafety.persistence.error')}</p> : null}
      {busy ? (
        <button type="button" class="button button-secondary" aria-busy="true" disabled>
          {t('dataSafety.persistence.ask')}
        </button>
      ) : canRequest ? (
        <button type="button" class="button button-secondary" onClick={onRequest}>
          {state === 'not-requested'
            ? t('dataSafety.persistence.request')
            : t('dataSafety.persistence.ask')}
        </button>
      ) : null}
    </div>
  );
}
