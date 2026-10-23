/**
 * GENERATED FILE — created by scripts/generate-precache.mjs during `npm run build`.
 * Do not edit by hand: the precache set is derived from the build output (ADR-005 Decision 2).
 * Commit the refreshed file whenever a build changes it.
 */

export interface PrecacheEntry {
  readonly url: string;
  readonly sha256: string;
}

/** Whole-artifact precache set, URLs relative to the service worker scope. */
export const PRECACHE_ENTRIES: readonly PrecacheEntry[] = [
  { url: 'assets/SettingsView-CyNX0yAt.js', sha256: '1f1cdbcb2c8dea98cfbae0739cdc3bc6c761327bd8cc4a2b96309db8a3d7ff40' },
  { url: 'assets/index-B96ib677.js', sha256: 'c2ea7d019f3d88e9e63132b6101bcf393927a95d97f854108e81b47fc562c691' },
  { url: 'assets/index-DIFCu9ls.css', sha256: '6a18f0976fc0bf5011acf81845a613d6a6b7fcb14f30a790e653217c8f35d216' },
  { url: 'favicon.svg', sha256: 'a2305dd61251e9e30a194e6a3c5f0b7d83e49e985b31637d70219fe66dfed844' },
  { url: 'index.html', sha256: '762fd13b71d5d74761ad1d902cc4e70bbb4523361b219fa57357e41738c11b6a' },
];

/** Content-addressed shell version (first 16 hex chars of the manifest hash). */
export const SHELL_VERSION = '17c4394dce452376';
