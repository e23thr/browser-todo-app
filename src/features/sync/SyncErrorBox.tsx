/**
 * The one sync error block (setup failures and run failures share it).
 *
 * Deliberately NO `role="alert"`: the failure is announced assertively through
 * the app's global live region (`announce()`), exactly like the settings
 * language-load failure — a self-announcing node would double-speak for screen
 * readers. The box is plain content with stable test ids.
 */

import type { ComponentChildren, JSX } from 'preact';

import { t } from '../../app/i18n';

export interface SyncErrorBoxProps {
  /** Container test id; the title/detail probes derive `${testId}-title` etc. */
  readonly testId: string;
  readonly title: string;
  readonly body?: string;
  readonly detail?: string;
  /** Retry guidance line (countdown or "retries paused"). */
  readonly hint?: string;
  readonly children?: ComponentChildren;
}

export function SyncErrorBox({
  testId,
  title,
  body,
  detail,
  hint,
  children,
}: SyncErrorBoxProps): JSX.Element {
  return (
    <div class="sync-error" data-testid={testId}>
      <p class="sync-error-title" data-testid={`${testId}-title`}>
        <strong>{title}</strong>
      </p>
      {body === undefined ? null : <p class="sync-error-body">{body}</p>}
      {hint === undefined ? null : <p class="sync-error-hint field-hint">{hint}</p>}
      {detail === undefined ? null : (
        <p class="sync-error-detail" data-testid={`${testId}-detail`}>
          {t('sync.error.detailLabel', { detail })}
        </p>
      )}
      {children}
    </div>
  );
}
