/**
 * Update-flow surfaces (ADR-005 Decision 5): the "Update available" toast, the flush/updating
 * states, the "updated — refresh when ready" notice for sibling tabs, and the stale-tab guard
 * notice (Decision 3). Behaviour is fixed by the ADR; visuals follow the E5 token set.
 *
 * Accessibility (Decision 5, §8): the notice owns its live region (`aria-live="polite"`), the
 * actions are real buttons with ≥ 44 px targets, and nothing steals focus — the toast is
 * announced without interrupting whatever the user is doing (E9: never disruptive).
 */

import type { JSX } from 'preact';

import { t } from '../i18n';
import { chunkLoadFailed } from '../app/stale-tab';
import { applyUpdate, dismissUpdate, updateError, updateSurface } from '../app/update';
import '../styles/update.css';

function apply(): void {
  void applyUpdate();
}

function Notice(props: {
  readonly title: string;
  readonly body?: string | undefined;
  readonly error?: string | undefined;
  readonly actions: JSX.Element;
}): JSX.Element {
  return (
    <section class="update-notice" role="status" aria-live="polite">
      <p class="update-notice-title">{props.title}</p>
      {props.body === undefined ? null : <p class="update-notice-body">{props.body}</p>}
      {props.error === undefined ? null : (
        <p class="update-notice-error" role="alert">
          {props.error}
        </p>
      )}
      <div class="update-notice-actions">{props.actions}</div>
    </section>
  );
}

function refreshButton(): JSX.Element {
  return (
    <button type="button" class="update-action update-action-primary" onClick={apply}>
      {t('update.action.refresh')}
    </button>
  );
}

/**
 * The single visual surface for every update-flow message. Returns `null` when idle, so the
 * component can be mounted once at boot.
 */
export function UpdateNotice(): JSX.Element | null {
  const surface = updateSurface.value;
  const stale = chunkLoadFailed.value;
  const error = updateError.value;

  if (surface === 'none' && !stale) return null;

  return (
    <div class="update-notice-stack" data-update-notice="">
      {stale ? <Notice title={t('update.stale.title')} actions={refreshButton()} /> : null}
      {surface === 'toast' ? (
        <Notice
          title={t('update.available.title')}
          body={t('update.available.body')}
          error={
            error === 'save'
              ? t('update.error.save')
              : error === 'blocked'
                ? t('update.error.unsaved')
                : undefined
          }
          actions={
            <>
              <button type="button" class="update-action update-action-primary" onClick={apply}>
                {t('update.action.apply')}
              </button>
              <button
                type="button"
                class="update-action"
                onClick={() => {
                  dismissUpdate();
                }}
              >
                {t('update.action.dismiss')}
              </button>
            </>
          }
        />
      ) : null}
      {surface === 'flushing' ? <Notice title={t('update.saving')} actions={<span />} /> : null}
      {surface === 'updating' ? <Notice title={t('update.applying')} actions={<span />} /> : null}
      {surface === 'applied-elsewhere' ? (
        <Notice title={t('update.applied.title')} actions={refreshButton()} />
      ) : null}
    </div>
  );
}
