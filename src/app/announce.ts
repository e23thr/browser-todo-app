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
 * message the app announced must actually reach the user). Two carve-outs from same-region
 * supersede, both for the caller passing `{ deferred: true }` (M13-B1, t_bb9053ec):
 *
 * 1. The message sits in a per-region hold and, when the hold expires, QUEUES behind whatever
 *    the region still has in flight instead of superseding it — it waits out a pending
 *    message's landing window (and the observation window after that) rather than bumping the
 *    token, so both messages reach the user, in order.
 * 2. Once it has waited its turn and entered the region, it is never silently dropped before
 *    it lands: a newer message hands its slot back to the hold (no remaining hold) and it
 *    queues behind the newcomer instead. A deferred message is dropped only when the regions
 *    unregister (or a newer deferred message replaces it — newest held message wins).
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
   * notice alone. A deferred message never enters the window early; when the hold expires it
   * queues behind any message the region still has in flight instead of cancelling it, and
   * once in flight it is re-queued — never dropped — if a newer message supersedes it. It
   * disappears only when the regions unregister (or a newer deferred message replaces it).
   */
  readonly deferred?: boolean;
}

/**
 * One pending slot per region: the supersede token and timers for the message in flight
 * (landing + observation window), the handed-over deferred message currently in flight (which
 * is protected from supersede until it lands), plus the deferred hold (M13-B1) and its timer.
 * A region only ever reads its own slot, so nothing one region does can cancel what the other
 * one is about to say.
 */
interface PendingSlot {
  token: number;
  timer: ReturnType<typeof setTimeout> | null;
  settle: ReturnType<typeof setTimeout> | null;
  committed: string | null;
  deferred: { readonly message: string } | null;
  deferredTimer: ReturnType<typeof setTimeout> | null;
}

const newSlot = (): PendingSlot => ({
  token: 0,
  timer: null,
  settle: null,
  committed: null,
  deferred: null,
  deferredTimer: null,
});

const slots: Record<Politeness, PendingSlot> = { polite: newSlot(), assertive: newSlot() };

/** Cancel everything a region still holds in flight (unregister / test reset). */
function clearSlot(slot: PendingSlot): void {
  slot.token += 1;
  if (slot.timer !== null) {
    clearTimeout(slot.timer);
    slot.timer = null;
  }
  if (slot.settle !== null) {
    clearTimeout(slot.settle);
    slot.settle = null;
  }
  if (slot.deferredTimer !== null) {
    clearTimeout(slot.deferredTimer);
    slot.deferredTimer = null;
  }
  slot.committed = null;
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
 * Hand a hold-expired deferred message over to the normal path — but never cancel what the
 * region is still saying. While a non-deferred message is inside its landing window (or the
 * observation window right after it), the hand-over waits its turn: the region's own timers
 * re-invoke this until the way is clear, so both messages reach the user, in order
 * (t_bb9053ec, WCAG 2.2 SC 4.1.3). The message then enters {@link speak} marked `committed`:
 * it has already waited its turn, so a newer message re-queues it instead of dropping it.
 */
function deliverDeferred(slot: PendingSlot, politeness: Politeness): void {
  const held = slot.deferred;
  // Nothing held, or the hold is still running (a newer deferred message re-armed it).
  if (held === null || slot.deferredTimer !== null) return;
  const region = politeness === 'assertive' ? regions.assertive : regions.polite;
  if (region === null) {
    // Regions went away without the disposer: drop the hold like clearSlot would.
    slot.deferred = null;
    return;
  }
  if (slot.timer !== null || slot.settle !== null) return; // in flight — retried from `settle`
  slot.deferred = null;
  speak(slot, region, politeness, held.message, true);
}

/**
 * Put `message` in the region's landing window (`committed` = it came from the deferred
 * hand-over and must not be dropped). Same-region supersede applies as usual — except that a
 * committed message goes back to the hold slot instead of being lost.
 */
function speak(
  slot: PendingSlot,
  region: HTMLElement,
  politeness: Politeness,
  message: string,
  committed: boolean,
): void {
  if (slot.committed !== null) {
    // The message in flight is a deferred hand-over that has not landed yet: hand its slot
    // back to the hold with NO remaining hold, so deliverDeferred queues it behind this one.
    const returned = slot.committed;
    slot.committed = null;
    if (slot.deferredTimer !== null) clearTimeout(slot.deferredTimer);
    slot.deferred = { message: returned };
    slot.deferredTimer = setTimeout(() => {
      slot.deferredTimer = null;
      deliverDeferred(slot, politeness);
    }, 0);
  }

  slot.token += 1;
  const token = slot.token;

  if (slot.timer !== null) clearTimeout(slot.timer);
  if (slot.settle !== null) clearTimeout(slot.settle);
  region.textContent = '';
  slot.committed = committed ? message : null;

  slot.timer = setTimeout(() => {
    slot.timer = null;
    // A newer announcement in THIS region (or an unmount) supersedes this one —
    // never a message in the other region. A superseded committed message was already
    // returned to the hold slot above.
    if (token !== slot.token) return;
    region.textContent = message;
    if (committed) slot.committed = null; // landed — the re-queue protection ends here
  }, ANNOUNCE_DELAY_MS);

  // Observation window: the landed text stays up ANNOUNCE_DELAY_MS so assistive tech can
  // observe it before anything replaces it. It also gates the deferred hand-over — when the
  // window closes, a held message gets its turn (deliverDeferred) instead of bumping the
  // token mid-flight and silently dropping this one.
  slot.settle = setTimeout(() => {
    slot.settle = null;
    if (token !== slot.token) return;
    deliverDeferred(slot, politeness);
  }, ANNOUNCE_DELAY_MS * 2);
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
      deliverDeferred(slot, politeness);
    }, DEFERRED_ANNOUNCE_DELAY_MS);
    return;
  }

  speak(slot, region, politeness, message, false);
}
