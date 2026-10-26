/**
 * Toasts (design core-domain S8) — the visual half of the write-feedback surface.
 *
 * Errors render with `role="alert"` (the assertive channel of §5.5) and persist until
 * dismissed or 8 s; a toast may carry one action (Retry). Toasts are never the ONLY
 * channel: the same failure is also announced in the global live regions, so a screen
 * reader user hears the rollback without seeing the toast.
 *
 * Brief success confirmations are deliberately NOT toasts (§5.6): the result is visible
 * in place, and announcements carry the feedback.
 */

import { signal } from '@preact/signals';

export interface ToastAction {
  readonly key: string;
  readonly run: () => void;
}

export interface Toast {
  readonly id: string;
  readonly tone: 'info' | 'error' | 'success';
  readonly messageKey: string;
  readonly params?: Readonly<Record<string, string | number>>;
  readonly action?: ToastAction;
  /**
   * Auto-dismiss lifetime (S7 undo toasts use the 10 s undo window; the default
   * stays the 8 s error-toast lifetime the host already shipped with).
   */
  readonly durationMs?: number;
  /**
   * Called when the toast leaves the screen by ANY route — its action, the close
   * button, `Escape`, or auto-expiry. The S7 undo offer hooks this: a dismissed
   * toast is an abandoned offer, since its Undo button was the offer's only
   * affordance and the offer must not outlive it.
   */
  readonly onDismiss?: () => void;
}

export const toasts = signal<readonly Toast[]>([]);

let counter = 0;

/** Mint a toast id up front so an action closure can dismiss its own toast. */
export function newToastId(): string {
  counter += 1;
  return `toast-${String(counter)}`;
}

/** Add a toast. Returns its id (already known when minted via `newToastId`). */
export function pushToast(toast: Toast): string {
  toasts.value = [...toasts.value.filter((existing) => existing.id !== toast.id), toast];
  return toast.id;
}

export function dismissToast(id: string): void {
  const target = toasts.value.find((toast) => toast.id === id);
  toasts.value = toasts.value.filter((toast) => toast.id !== id);
  target?.onDismiss?.();
}

/**
 * Test seam. Fires each toast's `onDismiss` so a dismissed offer never survives
 * the clear (same rule as a per-toast dismissal).
 */
export function clearToasts(): void {
  const pending = toasts.value;
  toasts.value = [];
  for (const toast of pending) toast.onDismiss?.();
}
