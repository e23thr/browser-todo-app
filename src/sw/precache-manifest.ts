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
  { url: 'assets/SettingsView-BUhGj5Rb.js', sha256: 'c3f0589e03c646e754707127a5d422a0034c5ddb1a1caa3decf2d399fe463b5a' },
  { url: 'assets/actions-CSkfuB5c.js', sha256: '7dd07a03a4636ffbb14feae52c2cfab23c5fd5212806946174d90e34c9a40b1a' },
  { url: 'assets/boot-BpBBncuz.js', sha256: '4387954cf4b4c14c54d4066df18765d4330060f1e9b080e0971aa9e80f576352' },
  { url: 'assets/dbAccess-Cn7SD0SD.js', sha256: '060b91b2a7e0f56b7d321c9c3d9d8f86064787862cb732d52608edac3ac25569' },
  { url: 'assets/index-B7sWvTs_.css', sha256: '962668f1b912200822746dc2d5a862f7cedd516ac0a9b1b7a871755d44cfa7c4' },
  { url: 'assets/index-DEwSTMyM.js', sha256: '2d81dd1c42231d7e1b0c1338dab1eab189cc5689200d6ce3fbb1cce8f5db023b' },
  { url: 'assets/locale-en-DcYtuBhM.js', sha256: 'f2e4827bb51bbc02816242b20caf627d0f116d96e7227347d59816a0052656ce' },
  { url: 'assets/locale-th-0z_UgMXl.js', sha256: 'edfdb308dda5b0740a7a55124e0c29bd8a7fddf49f16911809ba17d55aec175f' },
  { url: 'assets/snapshots-api-B23rPcZQ.js', sha256: '3e3ea7b6335e3e7e6923ea1aa884a5f1ca7a6332e2c963e8d3eeb29549fa2c38' },
  { url: 'favicon.svg', sha256: 'a2305dd61251e9e30a194e6a3c5f0b7d83e49e985b31637d70219fe66dfed844' },
  { url: 'index.html', sha256: '89182cdccff73f34957ae5d2aae5a59d555317f38ddf548c4d30f57e3d0d2c19' },
];

/** Content-addressed shell version (first 16 hex chars of the manifest hash). */
export const SHELL_VERSION = 'f6226dcbd3b80d65';
