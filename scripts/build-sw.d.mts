/** Type surface for scripts/build-sw.mjs (kept beside the script so tests stay typed). */

export function buildServiceWorker(options?: {
  readonly root?: string;
  readonly outDir?: string;
  readonly precacheModule?: string;
}): Promise<void>;
