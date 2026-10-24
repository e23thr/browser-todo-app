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
  { url: 'assets/SettingsView-Cn2jIUtY.js', sha256: 'b763ca0a611bd80f9ce06637232dd39467415edbdca7255e7c923ba40fcd2373' },
  { url: 'assets/actions-Tuan_pGm.js', sha256: '18955bceb72366f98561a88e4f18d2511fe2e9312c09ac4f2dabf4cbd5b15b9d' },
  { url: 'assets/boot-KuZ3_S6d.js', sha256: 'afad5923fdfa5764234bd3d9482174669fde4449d2ba45638fcb7b8d4a0756c4' },
  { url: 'assets/dbAccess-IyIQszo3.js', sha256: '1522f328722a780fa2d3f7e7a05586bb8370811e937f07b996ae34f6f11489df' },
  { url: 'assets/index-B7sWvTs_.css', sha256: '962668f1b912200822746dc2d5a862f7cedd516ac0a9b1b7a871755d44cfa7c4' },
  { url: 'assets/index-Gguj8gcL.js', sha256: 'e2792ca4ca5f27274d0d959ddbff9e71a91b70091c9ee04f894e1fca294065e8' },
  { url: 'assets/locale-en-DcYtuBhM.js', sha256: 'f2e4827bb51bbc02816242b20caf627d0f116d96e7227347d59816a0052656ce' },
  { url: 'assets/locale-th-0z_UgMXl.js', sha256: 'edfdb308dda5b0740a7a55124e0c29bd8a7fddf49f16911809ba17d55aec175f' },
  { url: 'assets/snapshots-api-B23rPcZQ.js', sha256: '3e3ea7b6335e3e7e6923ea1aa884a5f1ca7a6332e2c963e8d3eeb29549fa2c38' },
  { url: 'favicon.svg', sha256: 'a2305dd61251e9e30a194e6a3c5f0b7d83e49e985b31637d70219fe66dfed844' },
  { url: 'index.html', sha256: 'dca5bc55498cffd9bac098280e3186b256a1c072a0c00b02ba3fe9c7ee665baf' },
];

/** Content-addressed shell version (first 16 hex chars of the manifest hash). */
export const SHELL_VERSION = 'c6bef87e0491796c';
