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
  { url: 'assets/SettingsView-B_GBwdVH.js', sha256: '9721756c4888e71f692f31030f08f11372abc648bf9f74206394fb676ee2dc75' },
  { url: 'assets/actions-F7bSQL4I.js', sha256: '08d76a3c3a73c18e15ad38b2b899ae5babceb1aca56ab5716ca7a7e982a14df4' },
  { url: 'assets/boot-B5GQMxdJ.js', sha256: 'bcc5cb45beedb4b38af7b6a3fea649d902b5bf341a5edb51995bff2f0e572cff' },
  { url: 'assets/dbAccess-IyIQszo3.js', sha256: '1522f328722a780fa2d3f7e7a05586bb8370811e937f07b996ae34f6f11489df' },
  { url: 'assets/index-8NTjUiFy.js', sha256: '6bc7a2df5cff54e60c947443f15604b942faf34cdd4cc1186891bfe50c689018' },
  { url: 'assets/index-B7sWvTs_.css', sha256: '962668f1b912200822746dc2d5a862f7cedd516ac0a9b1b7a871755d44cfa7c4' },
  { url: 'assets/locale-en-DcYtuBhM.js', sha256: 'f2e4827bb51bbc02816242b20caf627d0f116d96e7227347d59816a0052656ce' },
  { url: 'assets/locale-th-0z_UgMXl.js', sha256: 'edfdb308dda5b0740a7a55124e0c29bd8a7fddf49f16911809ba17d55aec175f' },
  { url: 'assets/snapshots-api-B23rPcZQ.js', sha256: '3e3ea7b6335e3e7e6923ea1aa884a5f1ca7a6332e2c963e8d3eeb29549fa2c38' },
  { url: 'favicon.svg', sha256: 'a2305dd61251e9e30a194e6a3c5f0b7d83e49e985b31637d70219fe66dfed844' },
  { url: 'index.html', sha256: '99d9df4f13fd009a9e519060993ce07caca263a4a83c9d23edf6e72c21113f00' },
];

/** Content-addressed shell version (first 16 hex chars of the manifest hash). */
export const SHELL_VERSION = '8d0d9e185097e9f2';
