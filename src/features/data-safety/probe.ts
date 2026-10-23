/**
 * Pre-boot `meta` probe (E3) — reads this profile's `lastOpenedAt`/`createdAt` BEFORE
 * `boot()` bumps `lastOpenedAt` in its step 5.
 *
 * Kept in its own tiny module (storage only, no portability imports) so `main.tsx` can start
 * it statically at the top of boot while the rest of the data-safety engine arrives as a lazy
 * chunk (§9.2). The run is memoized: `startDataSafety()` awaits this exact promise, so the
 * classification always sees the pre-boot timestamp no matter which path boots first.
 *
 * Bounded by `PROBE_TIMEOUT_MS` — a hung IndexedDB must never block first paint (§9.4).
 */

import { openRawAppDB } from '../../storage/db';
import { META_KEY } from '../../storage/schema';
import type { Meta } from '../../storage/types';

/** What the app knew about this profile before `boot()` rewrote `meta.lastOpenedAt`. */
export interface PriorUseProbe {
  readonly createdAt: number;
  readonly lastOpenedAt: number;
}

/** Bound for the pre-boot read: 1.5 s, then we classify without it. */
const PROBE_TIMEOUT_MS = 1_500;

let probeRun: Promise<PriorUseProbe | null> | null = null;

/**
 * Start (or join) the pre-boot `meta` read. Call it ONCE from `main.tsx` before the first
 * render — and therefore before anything else can call `boot()`.
 */
export function beginPriorUseProbe(): Promise<PriorUseProbe | null> {
  probeRun ??= Promise.race([probeMeta(), timeoutAfter(PROBE_TIMEOUT_MS)]);
  return probeRun;
}

/** Test seam: forget the memoized probe so the next run re-reads `meta`. */
export function resetPriorUseProbe(): void {
  probeRun = null;
}

function timeoutAfter(ms: number): Promise<null> {
  return new Promise<null>((resolve) => {
    setTimeout(() => {
      resolve(null);
    }, ms);
  });
}

async function probeMeta(): Promise<PriorUseProbe | null> {
  try {
    const opened = await openRawAppDB({});
    if (!opened.ok) return null;
    const raw = opened.value;
    try {
      const meta = (await raw.get('meta', META_KEY)) as Meta | undefined;
      if (meta === undefined) return null;
      return { createdAt: meta.createdAt, lastOpenedAt: meta.lastOpenedAt };
    } finally {
      raw.close();
    }
  } catch {
    return null;
  }
}
