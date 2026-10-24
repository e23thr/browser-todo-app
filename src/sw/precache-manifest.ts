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
  { url: 'assets/SettingsView-D3Y8jjM2.js', sha256: 'e82078b5633b757189e99ef6d5fa6b3c3e3640a2d691194a9399887064f639d6' },
  { url: 'assets/actions-C_Xie0gS.js', sha256: '639d6f816d2deee2166fba6aaf197236e8b89f2ed6d0404b1ac9ea16f7137938' },
  { url: 'assets/boot-cOAlweuT.js', sha256: '312d3ea14f766e7566398a9ce06a5106eb7af76c348bcaae727eb9257042acc4' },
  { url: 'assets/dbAccess-IyIQszo3.js', sha256: '1522f328722a780fa2d3f7e7a05586bb8370811e937f07b996ae34f6f11489df' },
  { url: 'assets/index-B7sWvTs_.css', sha256: '962668f1b912200822746dc2d5a862f7cedd516ac0a9b1b7a871755d44cfa7c4' },
  { url: 'assets/index-BINKz2Di.js', sha256: '070b873445a4113fba0d8954aafd25b7eacee8d6bf3cc4446be6a3c3a57e4400' },
  { url: 'assets/locale-en-DcYtuBhM.js', sha256: 'f2e4827bb51bbc02816242b20caf627d0f116d96e7227347d59816a0052656ce' },
  { url: 'assets/locale-th-0z_UgMXl.js', sha256: 'edfdb308dda5b0740a7a55124e0c29bd8a7fddf49f16911809ba17d55aec175f' },
  { url: 'assets/snapshots-api-B23rPcZQ.js', sha256: '3e3ea7b6335e3e7e6923ea1aa884a5f1ca7a6332e2c963e8d3eeb29549fa2c38' },
  { url: 'favicon.svg', sha256: 'a2305dd61251e9e30a194e6a3c5f0b7d83e49e985b31637d70219fe66dfed844' },
  { url: 'index.html', sha256: '4b3044d1044b97e1eee883aa7b85fe0e940291a685988601914fdda850bcfc2b' },
];

/** Content-addressed shell version (first 16 hex chars of the manifest hash). */
export const SHELL_VERSION = 'd2abdb3a926e48ed';
