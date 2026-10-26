/**
 * Toast host (design §7 S8) — bottom-center on compact / bottom-left on wide, max
 * width 360 px. Error toasts are `role="alert"` (the assertive channel) and persist
 * until dismissed or 8 s; an optional action (Retry / S7 Undo) is a real 44 px button.
 * A toast is never the only channel for a message: the store also announces every
 * toast in the shell's global live regions (§5.5).
 *
 * S7 undo-toast contract (WCAG 2.2 AA):
 * - announced live: `role="status"` (polite) / `role="alert"` (errors) PLUS the
 *   store's global-region announcement — an inserted live region alone is not
 *   reliably announced by assistive tech, so the toast is never the only channel;
 * - keyboard-dismissible: the close button is a focusable ≥ 44 px button, and
 *   `Escape` dismisses the newest toast from anywhere (this host never holds
 *   focus, so it listens at the document while anything is on screen);
 * - never steals focus: nothing here focuses, and the host is not a focus
 *   target — SC 2.4.3 stays with the control that triggered the toast;
 * - lifetime: `toast.durationMs` when set (the S7 undo window is 10 s),
 *   otherwise the 8 s error default.
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
    }, toast.durationMs ?? AUTO_DISMISS_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [toast.id, toast.durationMs]);

  return (
    <div
      class={`toast toast-${toast.tone}`}
      data-variant={toast.tone}
      data-testid={`toast-${toast.id}`}
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

/** Escape dismisses the newest toast (keyboard-dismissible, no focus required). */
function useEscapeDismiss(list: readonly Toast[]): void {
  useEffect(() => {
    if (list.length === 0) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      const newest = list[list.length - 1];
      if (newest !== undefined) dismissToast(newest.id);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [list]);
}

export function ToastHost(): JSX.Element | null {
  const list = toasts.value;
  useEscapeDismiss(list);
  if (list.length === 0) return null;
  return (
    <div class="toast-host" data-testid="toast-host">
      {list.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
