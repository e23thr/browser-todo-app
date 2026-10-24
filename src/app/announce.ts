/**
 * Global live-region announcer (design §11.2).
 *
 * The shell mounts exactly ONE polite and ONE assertive region for the lifetime of the app;
 * announcements swap their text content. The nodes are never re-created or re-rendered,
 * because a live region has to stay mounted to be announced.
 *
 * Messages are cleared first and written on the next task boundary, which is what forces
 * screen readers to re-announce an identical message twice in a row.
 *
 * Within the delay window the newest message wins and the pending one is dropped — except
 * when the caller passes `{ deferred: true }`, which holds its message back past the window
 * so a status notice fired in the same tick cannot cancel the one in flight (M13-B1).
 */

/** `polite` = global status region, `assertive` = global alert region (design §11.2). */
export type Politeness = 'polite' | 'assertive';

/** The two persistent regions the shell registers on mount. */
export interface LiveRegions {
  readonly polite: HTMLElement | null;
  readonly assertive: HTMLElement | null;
}

/** Internal mutable holder; the public registration API stays readonly. */
interface MutableLiveRegions {
  polite: HTMLElement | null;
  assertive: HTMLElement | null;
}

const regions: MutableLiveRegions = { polite: null, assertive: null };

/** Delay before the message lands, long enough for assistive tech to observe the change. */
export const ANNOUNCE_DELAY_MS = 60;

/**
 * Extra wait before a `deferred` message enters that window.
 *
 * It has to clear `ANNOUNCE_DELAY_MS` by a comfortable margin so a message announced in the
 * same tick has already landed — and stayed on screen long enough to be read — before the
 * deferred one replaces it. Both status messages then reach the user, in order, instead of
 * the newer one silently cancelling the older one (WCAG 2.2 SC 4.1.3).
 */
export const DEFERRED_ANNOUNCE_DELAY_MS = 500;

/** Options accepted by {@link announce}. */
export interface AnnounceOptions {
  /**
   * Hold the message for `DEFERRED_ANNOUNCE_DELAY_MS` before announcing it (M13-B1 / E2 F-1).
   *
   * Use for a background status notice that fires in the same tick as a user-facing one —
   * Epic E3's first-write persistence notice vs. the composer's `a11y.taskAdded`: inside the
   * announce window the newer `announce()` supersedes the pending message, so announcing the
   * notice immediately would cancel the capture confirmation and leave the region with the
   * notice alone. A deferred message never enters the window early; it is dropped only when
   * the regions unregister (same as any pending message).
   */
  readonly deferred?: boolean;
}

let announceToken = 0;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

/** The message held back by {@link AnnounceOptions.deferred}, and the timer holding it. */
let deferred: { readonly message: string; readonly politeness: Politeness } | null = null;
let deferredTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Register the shell's regions. Returns a disposer that unregisters them and cancels
 * any announcement still in flight.
 */
export function registerLiveRegions(next: LiveRegions): () => void {
  regions.polite = next.polite;
  regions.assertive = next.assertive;
  return () => {
    regions.polite = null;
    regions.assertive = null;
    announceToken += 1;
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    if (deferredTimer !== null) {
      clearTimeout(deferredTimer);
      deferredTimer = null;
    }
    deferred = null;
  };
}

/**
 * Announce `message` in the global region with the given politeness.
 * Announcing before the shell has registered its regions is a silent no-op.
 */
export function announce(
  message: string,
  politeness: Politeness = 'polite',
  options?: AnnounceOptions,
): void {
  const region = politeness === 'assertive' ? regions.assertive : regions.polite;
  if (region === null || message === '') return;

  if (options?.deferred === true) {
    // One held slot, newest wins — the same supersede rule the normal path applies.
    if (deferredTimer !== null) clearTimeout(deferredTimer);
    deferred = { message, politeness };
    deferredTimer = setTimeout(() => {
      deferredTimer = null;
      const held = deferred;
      deferred = null;
      if (held === null) return;
      // Hand over to the normal path: by now the announce window of anything announced in
      // the original tick has closed, so this message lands instead of cancelling it.
      announce(held.message, held.politeness);
    }, DEFERRED_ANNOUNCE_DELAY_MS);
    return;
  }

  announceToken += 1;
  const token = announceToken;

  if (pendingTimer !== null) clearTimeout(pendingTimer);
  region.textContent = '';

  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    // A newer announcement (or an unmount) supersedes this one.
    if (token !== announceToken) return;
    region.textContent = message;
  }, ANNOUNCE_DELAY_MS);
}
