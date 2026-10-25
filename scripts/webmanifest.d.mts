/** Type surface for scripts/webmanifest.mjs (kept beside the script so tests stay typed). */

export function normalizeBase(raw: string | undefined): string;

export function buildWebManifest(base: string): Record<string, unknown>;

export function renderWebManifest(base: string): string;
