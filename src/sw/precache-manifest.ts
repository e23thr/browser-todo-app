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
  { url: 'assets/SettingsView-DqOJTIeC.js', sha256: '2c40fb9efb3802370a42835be93d04bbfbfad3723766b038d75ba26005433951' },
  { url: 'assets/actions-BHIObQ0Q.js', sha256: '0a785e5049f2f63c5f1d99598eb0ec221f42a2e1648143c90b9db037cdbfe898' },
  { url: 'assets/boot-CY-9L5mq.js', sha256: 'c68cc9e3dd8bcc0783c973ed88f78bb5466f3271b3527d9685e9e58afe6398c4' },
  { url: 'assets/dbAccess-ZRCugCBM.js', sha256: '14e63140e9eb7d003aa208f55a80f92011a53e33b12038c6a6686729f230497e' },
  { url: 'assets/index-B-cuz_ti.js', sha256: '08393eae00588f19b5b72bd5f0f82336fdbd4650535de10422fdcd89e256aaac' },
  { url: 'assets/index-B7sWvTs_.css', sha256: '962668f1b912200822746dc2d5a862f7cedd516ac0a9b1b7a871755d44cfa7c4' },
  { url: 'assets/locale-en-DcYtuBhM.js', sha256: 'f2e4827bb51bbc02816242b20caf627d0f116d96e7227347d59816a0052656ce' },
  { url: 'assets/locale-th-0z_UgMXl.js', sha256: 'edfdb308dda5b0740a7a55124e0c29bd8a7fddf49f16911809ba17d55aec175f' },
  { url: 'assets/snapshots-api-B23rPcZQ.js', sha256: '3e3ea7b6335e3e7e6923ea1aa884a5f1ca7a6332e2c963e8d3eeb29549fa2c38' },
  { url: 'favicon.svg', sha256: 'a2305dd61251e9e30a194e6a3c5f0b7d83e49e985b31637d70219fe66dfed844' },
  { url: 'index.html', sha256: 'd144765444ee1faa1fd7bf1d61b48da40adce2580116013ab6b1bcc9d6112e31' },
];

/** Content-addressed shell version (first 16 hex chars of the manifest hash). */
export const SHELL_VERSION = 'b5f23826e7c30536';
