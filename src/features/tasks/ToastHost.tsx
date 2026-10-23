/**
 * Toast host (design §7 S8) — bottom-center on compact / bottom-left on wide, max
 * width 360 px. Error toasts are `role="alert"` (the assertive channel) and persist
 * until dismissed or 8 s; an optional action (Retry) is a real 44 px button. A toast is
 * never the only channel for a failure: the store also announces `a11y.saveFailed`.
 */

import { useEffect } from 'preact/hooks';
import type { JSX } from 'preact';

import { t } from '../../app/i18n';
import { Icon } from '../../app/icons';
import { dismissToast, toasts, type Toast } from './toasts';

const AUTO_DISMISS_MS = 8000;

function ToastItem({ toast }: { readonly toast: Toast }): JSX.Element {
  useEffect(() => {
    const timer = setTimeout(() => {
      dismissToast(toast.id);
    }, AUTO_DISMISS_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [toast.id]);

  return (
    <div
      class={`toast toast-${toast.tone}`}
      data-variant={toast.tone}
      role={toast.tone === 'error' ? 'alert' : 'status'}
    >
      <span class="toast-message">{t(toast.messageKey, toast.params ?? {})}</span>
      {toast.action !== undefined ? (
        <button
          type="button"
          class="button button-secondary toast-action"
          onClick={() => {
            toast.action?.run();
          }}
        >
          {t(toast.action.key)}
        </button>
      ) : null}
      <button
        type="button"
        class="icon-button toast-close"
        aria-label={t('common.dismiss')}
        onClick={() => {
          dismissToast(toast.id);
        }}
      >
        <Icon name="x" size={18} />
      </button>
    </div>
  );
}

export function ToastHost(): JSX.Element | null {
  const list = toasts.value;
  if (list.length === 0) return null;
  return (
    <div class="toast-host" data-testid="toast-host">
      {list.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
