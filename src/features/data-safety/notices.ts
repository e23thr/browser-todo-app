/**
 * Notice orchestration (design §2 warning hierarchy, §5.5/§5.6/§5.8).
 *
 * Three queues, one rule each:
 *   - banners: candidates live in a signal; §2 caps the VISIBLE set at two, ordered by
 *     `BANNER_PRIORITY`, with the remainder behind the "N more notices" overflow control.
 *     Snoozes/dismissals are durable (`flags.ts`), so they are re-read through `snoozeTick`.
 *   - dialogs: T3 kinds are mutually exclusive — "queue, don't stack" (§2). `openDialog`
 *     returns a promise so a caller can await the verdict (import confirm, delete-all).
 *   - toasts: T4, auto-dismissed by the host after `TOAST_LIFETIME_MS`, except the undo toast,
 *     which sets `persistent` until the user has interacted with it (§5.8).
 */

import { signal } from '@preact/signals';

import { BANNER_PRIORITY, MAX_VISIBLE_BANNERS, SNOOZE_DAYS, type BannerId } from './constants';
import { isSuppressed, snooze } from './flags';
import type { DataCounts, ImportPreview, SnapshotMeta } from './types';

/* --------------------------------- banners --------------------------------- */

export type BannerParams = Readonly<Record<string, string | number>>;

export interface ActiveBanner {
  readonly id: BannerId;
  readonly params: BannerParams;
}

const candidates = signal<readonly ActiveBanner[]>([]);
/** Bumped whenever a durable snooze/dismissal changes, so renderers re-read localStorage. */
const snoozeTick = signal(0);

/** Add or (with `null`) remove one banner candidate. */
export function setBanner(id: BannerId, params: BannerParams | null): void {
  const next =
    params === null
      ? candidates.value.filter((banner) => banner.id !== id)
      : [...candidates.value.filter((banner) => banner.id !== id), { id, params }];
  candidates.value = next;
}

/** Drop every candidate (used by tests and by the recovery screen). */
export function clearBanners(): void {
  candidates.value = [];
}

/**
 * §2 escalation: the two highest-priority non-snoozed candidates, plus how many are hidden.
 * Reads `candidates` and `snoozeTick`, so callers re-render on either changing.
 */
export function visibleBanners(now: number = Date.now()): {
  readonly visible: readonly ActiveBanner[];
  readonly overflow: number;
  /** Monotonic revision of the durable flags — bumped by every snooze/dismiss. */
  readonly revision: number;
} {
  const revision = snoozeTick.value;
  const eligible = candidates.value.filter((banner) => !isSuppressed(banner.id, now));
  const ordered = BANNER_PRIORITY.map((id) => eligible.find((banner) => banner.id === id)).filter(
    (banner): banner is ActiveBanner => banner !== undefined,
  );
  return {
    visible: ordered.slice(0, MAX_VISIBLE_BANNERS),
    overflow: Math.max(0, ordered.length - MAX_VISIBLE_BANNERS),
    revision,
  };
}

/** §6.3/§9: banner close and "Remind me later" are the same 7-day snooze. */
export function snoozeBanner(id: BannerId, days: number = SNOOZE_DAYS): void {
  snooze(id, days);
  snoozeTick.value += 1;
}

/** Force a re-read of the durable flags (called when a suppression is cleared). */
export function refreshNotices(): void {
  snoozeTick.value += 1;
}

/* --------------------------------- dialogs --------------------------------- */

/** Payloads the T3 dialogs render from (§5.6 typed union, minus the handler props). */
export type DialogRequest =
  | { readonly kind: 'quota-exceeded'; readonly pendingCount: number }
  | {
      readonly kind: 'import-confirm';
      readonly preview: ImportPreview;
      readonly currentCounts: DataCounts;
      readonly quarantined: number;
    }
  | { readonly kind: 'delete-all-confirm'; readonly dataCounts: DataCounts }
  | { readonly kind: 'private-browsing' }
  | {
      readonly kind: 'restore-confirm';
      readonly snapshot: SnapshotMeta;
      readonly currentCounts: DataCounts;
    };

export interface QueuedDialog {
  readonly id: number;
  readonly request: DialogRequest;
  /**
   * §5.6 `busy`: the confirming action was taken and the awaiting flow is running its write.
   * A busy dialog stays mounted (buttons disabled, Escape inert) until `closeDialog()`.
   */
  readonly busy: boolean;
}

const dialogQueue = signal<readonly QueuedDialog[]>([]);
const resolvers = new Map<number, (confirmed: boolean) => void>();
let dialogSeq = 0;

/** The dialog the host renders right now (`null` = none). */
export function currentDialog(): QueuedDialog | null {
  return dialogQueue.value[0] ?? null;
}

/**
 * Enqueue a T3 dialog and resolve with the verdict: `true` = the confirming action ran,
 * `false` = cancel / Escape / safe path. Queued dialogs render one at a time (§2).
 *
 * A `true` verdict does NOT pop the dialog: the flow still has to run the destructive write,
 * and §5.6/§10.6 require the dialog to stay up in its `busy` state while it does. The flow
 * calls `closeDialog()` when the write is over (success or failure).
 */
export function openDialog(request: DialogRequest): Promise<boolean> {
  dialogSeq += 1;
  const id = dialogSeq;
  dialogQueue.value = [...dialogQueue.value, { id, request, busy: false }];
  return new Promise<boolean>((resolve) => {
    resolvers.set(id, resolve);
  });
}

/**
 * Answer the dialog at the head of the queue: `false` closes it at once, `true` flips it into
 * the §5.6 `busy` state and hands the verdict to the awaiting flow, which finishes with
 * `closeDialog()`.
 */
export function answerDialog(confirmed: boolean): void {
  const head = dialogQueue.value[0];
  if (head === undefined) return;
  const resolve = resolvers.get(head.id);
  resolvers.delete(head.id);
  if (confirmed) {
    dialogQueue.value = dialogQueue.value.map((queued) =>
      queued.id === head.id ? { ...queued, busy: true } : queued,
    );
    resolve?.(true);
    return;
  }
  dialogQueue.value = dialogQueue.value.slice(1);
  resolve?.(false);
}

/** Close the head dialog once the confirming write has finished (§5.6 `busy` → closed). */
export function closeDialog(): void {
  const head = dialogQueue.value[0];
  // Only a dialog that reported `true` is a flow's to close — anything else (already answered,
  // or queued behind ours) belongs to whoever opened it.
  if (head === undefined || !head.busy) return;
  dialogQueue.value = dialogQueue.value.slice(1);
  const resolve = resolvers.get(head.id);
  resolvers.delete(head.id);
  resolve?.(false);
}

/** Test/teardown seam: drop every queued dialog and reject nothing (resolve as cancel). */
export function resetDialogs(): void {
  for (const queued of dialogQueue.value) {
    resolvers.get(queued.id)?.(false);
    resolvers.delete(queued.id);
  }
  dialogQueue.value = [];
}

/* --------------------------------- toasts ---------------------------------- */

export interface ToastRequest {
  readonly message: string;
  readonly variant: 'success' | 'error';
  /** Present = the toast renders an action button (undo, "Open snapshots"). */
  readonly action?: { readonly label: string; readonly run: () => void };
  /**
   * Optional second action (ADR-004 Decision 5.5 (b)): the undo toast also offers the
   * `downloadSnapshot` escape hatch, because the rolling-3 can evict the undo snapshot.
   */
  readonly secondaryAction?: { readonly label: string; readonly run: () => void };
  /** Undo toast: no auto-dismiss until the user interacts with it (§5.8). */
  readonly persistent?: boolean;
}

export interface Toast extends ToastRequest {
  readonly id: number;
}

export const toasts = signal<readonly Toast[]>([]);
let toastSeq = 0;

/** Push a T4 toast; returns its id so the caller can dismiss it early. */
export function pushToast(request: ToastRequest): number {
  toastSeq += 1;
  toasts.value = [...toasts.value, { ...request, id: toastSeq }];
  return toastSeq;
}

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((toast) => toast.id !== id);
}

/** Test seam. */
export function resetToasts(): void {
  toasts.value = [];
}
