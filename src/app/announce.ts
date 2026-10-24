/**
 * Global live-region announcer (design ux-foundation §11.2, core-domain §5.5).
 *
 * The shell mounts exactly ONE polite and ONE assertive region for the lifetime of the app;
 * announcements swap their text content. The nodes are never re-created or re-rendered,
 * because a live region has to stay mounted to be announced.
 *
 * Messages are cleared first and written on the next task boundary, which is what forces
 * screen readers to re-announce an identical message twice in a row.
 *
 * Each region owns its PENDING slot: within one region's delay window the newest message wins
 * and the pending one is dropped — but the polite and assertive regions are independent, so a
 * message in one NEVER cancels a pending message in the other (WCAG 2.2 SC 4.1.3: a status
 * message the app announced must actually reach the user). The only carve-out from same-region
 * supersede is the caller passing `{ deferred: true }`, which holds its message back past the
 * window so a status notice fired in the same tick cannot cancel the one in flight (M13-B1) —
 * the deferred hold is per-region as well.
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

/**
 * One pending slot per region: the supersede token and timer for the message in flight,
 * plus the deferred hold (M13-B1) and its timer. A region only ever reads its own slot,
 * so nothing one region does can cancel what the other one is about to say.
 */
interface PendingSlot {
  token: number;
  timer: ReturnType<typeof setTimeout> | null;
  deferred: { readonly message: string } | null;
  deferredTimer: ReturnType<typeof setTimeout> | null;
}

const newSlot = (): PendingSlot => ({ token: 0, timer: null, deferred: null, deferredTimer: null });

const slots: Record<Politeness, PendingSlot> = { polite: newSlot(), assertive: newSlot() };

/** Cancel everything a region still holds in flight (unregister / test reset). */
function clearSlot(slot: PendingSlot): void {
  slot.token += 1;
  if (slot.timer !== null) {
    clearTimeout(slot.timer);
    slot.timer = null;
  }
  if (slot.deferredTimer !== null) {
    clearTimeout(slot.deferredTimer);
    slot.deferredTimer = null;
  }
  slot.deferred = null;
}

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
    clearSlot(slots.polite);
    clearSlot(slots.assertive);
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
  const slot = slots[politeness];

  if (options?.deferred === true) {
    // One held slot PER REGION, newest wins — the same supersede rule the normal path
    // applies, scoped to this region only.
    if (slot.deferredTimer !== null) clearTimeout(slot.deferredTimer);
    slot.deferred = { message };
    slot.deferredTimer = setTimeout(() => {
      slot.deferredTimer = null;
      const held = slot.deferred;
      slot.deferred = null;
      if (held === null) return;
      // Hand over to the normal path: by now the announce window of anything announced in
      // the original tick has closed, so this message lands instead of cancelling it.
      announce(held.message, politeness);
    }, DEFERRED_ANNOUNCE_DELAY_MS);
    return;
  }

  slot.token += 1;
  const token = slot.token;

  if (slot.timer !== null) clearTimeout(slot.timer);
  region.textContent = '';

  slot.timer = setTimeout(() => {
    slot.timer = null;
    // A newer announcement in THIS region (or an unmount) supersedes this one —
    // never a message in the other region.
    if (token !== slot.token) return;
    region.textContent = message;
  }, ANNOUNCE_DELAY_MS);
}
