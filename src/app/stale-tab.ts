import { signal } from '@preact/signals';

/**
 * Stale-tab guard (ADR-005 Decision 3).
 *
 * After an update is applied in another tab, this tab keeps running old code whose hashed lazy
 * chunks are gone from both the cache and the server. The first failing lazy `import()` lands
 * here: the app shows a non-blocking "updated elsewhere — reload to continue" notice with an
 * explicit Refresh button and NEVER auto-reloads (E9).
 */

export const chunkLoadFailed = signal(false);

/** Report a lazy chunk load failure (called from the router's lazy-import catch). */
export function notifyChunkLoadFailure(): void {
  chunkLoadFailed.value = true;
}
