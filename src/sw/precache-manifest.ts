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
  { url: 'assets/SettingsView-mwu1tf6n.js', sha256: '814d5e2b7a80d21999b1b30ec82c3fdcc2a86943a27c1e8e1506b834429155f5' },
  { url: 'assets/actions-BuCbLytY.js', sha256: '219500935b399079e49dd71fd9f75f71534972ec66f357bdf7b1d6feeaab0c99' },
  { url: 'assets/boot-CA6Zy-y0.js', sha256: 'e2f5743851d13c355b9511c55dac8f4a98f2a5114e43467ba855426eaee03f6a' },
  { url: 'assets/dbAccess-IyIQszo3.js', sha256: '1522f328722a780fa2d3f7e7a05586bb8370811e937f07b996ae34f6f11489df' },
  { url: 'assets/index-B7sWvTs_.css', sha256: '962668f1b912200822746dc2d5a862f7cedd516ac0a9b1b7a871755d44cfa7c4' },
  { url: 'assets/index-DDhhHp08.js', sha256: '4968657160070676184a6831d8b4371d705fc4fc955c5dd2d52e6262eadbf991' },
  { url: 'assets/locale-en-DcYtuBhM.js', sha256: 'f2e4827bb51bbc02816242b20caf627d0f116d96e7227347d59816a0052656ce' },
  { url: 'assets/locale-th-0z_UgMXl.js', sha256: 'edfdb308dda5b0740a7a55124e0c29bd8a7fddf49f16911809ba17d55aec175f' },
  { url: 'assets/snapshots-api-B23rPcZQ.js', sha256: '3e3ea7b6335e3e7e6923ea1aa884a5f1ca7a6332e2c963e8d3eeb29549fa2c38' },
  { url: 'favicon.svg', sha256: 'a2305dd61251e9e30a194e6a3c5f0b7d83e49e985b31637d70219fe66dfed844' },
  { url: 'index.html', sha256: 'e291c5456ed2168d4855afd0a5e021edece6ca2d4962ced38f23d1033fa223f6' },
];

/** Content-addressed shell version (first 16 hex chars of the manifest hash). */
export const SHELL_VERSION = 'cd100ada33605182';
