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
  { url: 'assets/SettingsView-CFjQRyIz.js', sha256: 'ada8457447f2ac4ea8afe096ec66b2be6458c7d49da769e493118897408530f3' },
  { url: 'assets/actions-DSnv5lw1.js', sha256: '2944a2a6bc540442d090e86fdd108a3b188b1e265adcc3626ae76da9da248214' },
  { url: 'assets/boot--pObDJvB.js', sha256: '5045fa1853d9c3b953dc5b9e5d0c12391276cf12f03c0cef1d5ff34caeeb9707' },
  { url: 'assets/dbAccess-bHYp81fq.js', sha256: '9e8a8b24431aa15167a6726f332531ffc8b6bd9185921627c7f1eb505da5902f' },
  { url: 'assets/index-B7sWvTs_.css', sha256: '962668f1b912200822746dc2d5a862f7cedd516ac0a9b1b7a871755d44cfa7c4' },
  { url: 'assets/index-pfbslj_w.js', sha256: '8e67faaa29df955fc9fcaae1ad19e49575333fce0985d0c02085bb76f6a323ae' },
  { url: 'assets/locale-en-DcYtuBhM.js', sha256: 'f2e4827bb51bbc02816242b20caf627d0f116d96e7227347d59816a0052656ce' },
  { url: 'assets/locale-th-0z_UgMXl.js', sha256: 'edfdb308dda5b0740a7a55124e0c29bd8a7fddf49f16911809ba17d55aec175f' },
  { url: 'assets/snapshots-api-CZhc19nB.js', sha256: 'f6d9d93108e158974359ffc5df7b6c182da09a1fe2cd3fd6e707d89c335f73a8' },
  { url: 'favicon.svg', sha256: 'a2305dd61251e9e30a194e6a3c5f0b7d83e49e985b31637d70219fe66dfed844' },
  { url: 'index.html', sha256: 'bff38e66f4900bd4518f54d14559ecb7a26529b9405f1cb6b04d674a78a60002' },
];

/** Content-addressed shell version (first 16 hex chars of the manifest hash). */
export const SHELL_VERSION = 'e08c9b56e63f4047';
