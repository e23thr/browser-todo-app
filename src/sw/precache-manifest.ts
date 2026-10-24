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
  { url: 'assets/SettingsView-BxryR84k.js', sha256: 'ed90bb3880e05d9b71a1a3117e78876254d04549cdaf45a09841547eda2dac98' },
  { url: 'assets/actions-HulyxOCq.js', sha256: 'dbfe043e875342e5207dbabfe4e004fb284fef4fb633ee348e29048992616aa9' },
  { url: 'assets/boot-Dk8L185J.js', sha256: 'a36ddb7f7cc3aca2ec1a72b790930a8a852983184e66c06de95ee2e2d2ba64ca' },
  { url: 'assets/dbAccess-CstxqNjc.js', sha256: 'ee4479478f8059a2f07b4fe52e6f4940a2185742a562c371ab98da2d79b29db0' },
  { url: 'assets/index-D9b_3Up9.js', sha256: '1be42ad1a11f9b0a9a83a3bda8fa2043b8eb73ab0535af5d4044ae6935ed12a5' },
  { url: 'assets/index-nMDkf4M6.css', sha256: '35b76febae0330a6f9b2e03f6c3a523932915aa4ebc26adf25c4e0fd68e8a288' },
  { url: 'assets/locale-en-DF7NK-XI.js', sha256: '448760949a1993ea458af8627f351ef49a14528cc7079afe096a0b5201091d20' },
  { url: 'assets/locale-th-B7L6qacf.js', sha256: '24f8d4596fbeb27171c7548d991dd74fcf2f8f2eea57cf601ab53df266478c95' },
  { url: 'assets/snapshots-api-CZhc19nB.js', sha256: 'f6d9d93108e158974359ffc5df7b6c182da09a1fe2cd3fd6e707d89c335f73a8' },
  { url: 'favicon.svg', sha256: 'a2305dd61251e9e30a194e6a3c5f0b7d83e49e985b31637d70219fe66dfed844' },
  { url: 'index.html', sha256: '997f9c5e0da836176105e8e8ada04b157e1d2a645850260dbc110bd96337c805' },
];

/** Content-addressed shell version (first 16 hex chars of the manifest hash). */
export const SHELL_VERSION = '088ccdac287cd087';
