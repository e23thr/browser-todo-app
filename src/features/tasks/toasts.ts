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
  toasts.value = toasts.value.filter((toast) => toast.id !== id);
}

/** Test seam. */
export function clearToasts(): void {
  toasts.value = [];
}
