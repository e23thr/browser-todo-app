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
  { url: 'assets/SettingsView-aJRLNMiK.js', sha256: '473e2b5442058cbf2765de5975f0a96f0bef57db32be1cbd7c26bf9ad4957fa8' },
  { url: 'assets/actions-RqUM6giO.js', sha256: 'ace935768bbb871749bb6b6dcd9f4b7f24eb3a6e1bbb3e592815ab10c0c11128' },
  { url: 'assets/boot-CfHSOXc3.js', sha256: 'a9d0428a691f6dfb31ad9ea058a0ee562c827c41d49f6895de2561e3c38dad88' },
  { url: 'assets/dbAccess-IyIQszo3.js', sha256: '1522f328722a780fa2d3f7e7a05586bb8370811e937f07b996ae34f6f11489df' },
  { url: 'assets/index-1BQEVDbO.js', sha256: 'f78ae76139dee94f990aa925dc4fe23c57da18b86efe5e21536f19e5a92eb011' },
  { url: 'assets/index-B7sWvTs_.css', sha256: '962668f1b912200822746dc2d5a862f7cedd516ac0a9b1b7a871755d44cfa7c4' },
  { url: 'assets/locale-en-DcYtuBhM.js', sha256: 'f2e4827bb51bbc02816242b20caf627d0f116d96e7227347d59816a0052656ce' },
  { url: 'assets/locale-th-0z_UgMXl.js', sha256: 'edfdb308dda5b0740a7a55124e0c29bd8a7fddf49f16911809ba17d55aec175f' },
  { url: 'assets/snapshots-api-B23rPcZQ.js', sha256: '3e3ea7b6335e3e7e6923ea1aa884a5f1ca7a6332e2c963e8d3eeb29549fa2c38' },
  { url: 'favicon.svg', sha256: 'a2305dd61251e9e30a194e6a3c5f0b7d83e49e985b31637d70219fe66dfed844' },
  { url: 'index.html', sha256: '0238e20de5589a28affaddb1e166a17792e8ecd3d1804ea201b6e61d781e62f1' },
];

/** Content-addressed shell version (first 16 hex chars of the manifest hash). */
export const SHELL_VERSION = '192bfe8e4c30d6e5';
