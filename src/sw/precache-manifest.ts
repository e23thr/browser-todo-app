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
  { url: 'assets/SettingsView-DT6GFg7C.js', sha256: 'd64386c1dfce33f00dd2382672e79c8ffd5481d4f21f7b8f54032e57ed634e35' },
  { url: 'assets/actions-DJqtYKgv.js', sha256: 'de89d364e3dd6d418596359455131445ac57bc50a2e42d0461ca71173f57ebef' },
  { url: 'assets/boot-2LtZJV6m.js', sha256: '59034a1fc04af9799b9f47972b3b4f38823c05ecf847d962ca330516b2b8a29a' },
  { url: 'assets/dbAccess-DNMmN3V6.js', sha256: 'a915f3293401cc16cad20425202d148e9397923fb76901fdc9b13d648ba19278' },
  { url: 'assets/index-B7sWvTs_.css', sha256: '962668f1b912200822746dc2d5a862f7cedd516ac0a9b1b7a871755d44cfa7c4' },
  { url: 'assets/index-BSTJpIqG.js', sha256: '40f6ff5b3b84710ae4e44df4375d9206790c9e1b879cbf2e6122d5a8ceff19b4' },
  { url: 'assets/locale-en-DcYtuBhM.js', sha256: 'f2e4827bb51bbc02816242b20caf627d0f116d96e7227347d59816a0052656ce' },
  { url: 'assets/locale-th-0z_UgMXl.js', sha256: 'edfdb308dda5b0740a7a55124e0c29bd8a7fddf49f16911809ba17d55aec175f' },
  { url: 'assets/snapshots-api-CZhc19nB.js', sha256: 'f6d9d93108e158974359ffc5df7b6c182da09a1fe2cd3fd6e707d89c335f73a8' },
  { url: 'favicon.svg', sha256: 'a2305dd61251e9e30a194e6a3c5f0b7d83e49e985b31637d70219fe66dfed844' },
  { url: 'index.html', sha256: 'd82001b57e6c498af0fe56db1239af51d6b51e29d187036b6534ab331efd9828' },
];

/** Content-addressed shell version (first 16 hex chars of the manifest hash). */
export const SHELL_VERSION = 'a2b4295fc74b4808';
