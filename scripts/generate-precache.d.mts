/** Type surface for scripts/generate-precache.mjs (kept beside the script so tests stay typed). */

export interface PrecacheEntry {
  readonly url: string;
  readonly sha256: string;
}

export interface PrecacheManifest {
  readonly entries: PrecacheEntry[];
  readonly shellVersion: string;
}

export function shouldPrecache(relPath: string): boolean;

export function walkDist(dir: string, prefix?: string): string[];

export function buildPrecacheEntries(distDir: string): PrecacheManifest;

export function renderPrecacheModule(manifest: PrecacheManifest): string;

export function generatePrecache(input: { readonly distDir: string; readonly outFile: string }): {
  changed: boolean;
  outFile: string;
  count: number;
  shellVersion: string;
};
