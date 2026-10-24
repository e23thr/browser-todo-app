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
  { url: 'assets/SettingsView-DRBCHdok.js', sha256: 'ee40c66cce95261abc2b474b863ad47886d540284c54848f8c1135c98f837e29' },
  { url: 'assets/actions-DVSJjgX7.js', sha256: '7db856aace887b2fe077b436488dfe8e31333ac7a510003aeb241c4865eb050e' },
  { url: 'assets/boot-Bc1XWy9_.js', sha256: '3be2c1c30d7c9fbf62693e1fb3011e09f015c519b06ffb3a47c3f5a7c38444d4' },
  { url: 'assets/dbAccess-IyIQszo3.js', sha256: '1522f328722a780fa2d3f7e7a05586bb8370811e937f07b996ae34f6f11489df' },
  { url: 'assets/index-B7sWvTs_.css', sha256: '962668f1b912200822746dc2d5a862f7cedd516ac0a9b1b7a871755d44cfa7c4' },
  { url: 'assets/index-BI9Iga5c.js', sha256: '38689e33a352321b5085eed3ddf2f0dbb70a1e95faf41b1b533a7bd3558b1241' },
  { url: 'assets/locale-en-DcYtuBhM.js', sha256: 'f2e4827bb51bbc02816242b20caf627d0f116d96e7227347d59816a0052656ce' },
  { url: 'assets/locale-th-0z_UgMXl.js', sha256: 'edfdb308dda5b0740a7a55124e0c29bd8a7fddf49f16911809ba17d55aec175f' },
  { url: 'assets/snapshots-api-B23rPcZQ.js', sha256: '3e3ea7b6335e3e7e6923ea1aa884a5f1ca7a6332e2c963e8d3eeb29549fa2c38' },
  { url: 'favicon.svg', sha256: 'a2305dd61251e9e30a194e6a3c5f0b7d83e49e985b31637d70219fe66dfed844' },
  { url: 'index.html', sha256: 'b9083cfcc0430b309cc194dadacfadacd9a3232d997e2cbee45972f73b6a52e7' },
];

/** Content-addressed shell version (first 16 hex chars of the manifest hash). */
export const SHELL_VERSION = '21c214d77a180e29';
