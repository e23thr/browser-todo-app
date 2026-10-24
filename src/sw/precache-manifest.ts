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
  { url: 'assets/SettingsView-U64kLJKR.js', sha256: '840b1c629c0d29164cb1978946b73c76274f8687c657141104b8594cad33e596' },
  { url: 'assets/actions-BD68Wjt7.js', sha256: 'cf42724c93d80aa2838c093811750d277344519b795ed2ffd7c6a020d61769ca' },
  { url: 'assets/boot-B86E9KqD.js', sha256: 'd21fd0474a70ec03e62b9f026092a38587b780507469b8dfefc94b982832c5b1' },
  { url: 'assets/dbAccess-IyIQszo3.js', sha256: '1522f328722a780fa2d3f7e7a05586bb8370811e937f07b996ae34f6f11489df' },
  { url: 'assets/index-B7sWvTs_.css', sha256: '962668f1b912200822746dc2d5a862f7cedd516ac0a9b1b7a871755d44cfa7c4' },
  { url: 'assets/index-BsqOINXV.js', sha256: '895842ece46eaeb38062ac1bbc918655d6fa554cf70491413179ae25db7ea101' },
  { url: 'assets/locale-en-DcYtuBhM.js', sha256: 'f2e4827bb51bbc02816242b20caf627d0f116d96e7227347d59816a0052656ce' },
  { url: 'assets/locale-th-0z_UgMXl.js', sha256: 'edfdb308dda5b0740a7a55124e0c29bd8a7fddf49f16911809ba17d55aec175f' },
  { url: 'assets/snapshots-api-B23rPcZQ.js', sha256: '3e3ea7b6335e3e7e6923ea1aa884a5f1ca7a6332e2c963e8d3eeb29549fa2c38' },
  { url: 'favicon.svg', sha256: 'a2305dd61251e9e30a194e6a3c5f0b7d83e49e985b31637d70219fe66dfed844' },
  { url: 'index.html', sha256: '5e6df4e933536b4573c5c0c4c66a97eb11fbc4e45339e9a63caf521d442201ff' },
];

/** Content-addressed shell version (first 16 hex chars of the manifest hash). */
export const SHELL_VERSION = '9f16393985c5d7ca';
