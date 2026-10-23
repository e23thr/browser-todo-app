/**
 * Global live-region announcer (design §11.2).
 *
 * The shell mounts exactly ONE polite and ONE assertive region for the lifetime of the app;
 * announcements swap their text content. The nodes are never re-created or re-rendered,
 * because a live region has to stay mounted to be announced.
 *
 * Messages are cleared first and written on the next task boundary, which is what forces
 * screen readers to re-announce an identical message twice in a row.
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
const ANNOUNCE_DELAY_MS = 60;

let announceToken = 0;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

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
  };
}

/**
 * Announce `message` in the global region with the given politeness.
 * Announcing before the shell has registered its regions is a silent no-op.
 */
export function announce(message: string, politeness: Politeness = 'polite'): void {
  const region = politeness === 'assertive' ? regions.assertive : regions.polite;
  if (region === null || message === '') return;

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
