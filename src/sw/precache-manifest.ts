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
  { url: 'assets/SettingsView-CCwHXEpF.js', sha256: '9cf2556da7ae933624e7d4375f91f3713c76fb950375107ebb72c11c6e061001' },
  { url: 'assets/index-BTXZ-gyD.js', sha256: 'a36fdd8221dc032940154438387a2716929dd875d0b13e18ef2faa5036d57132' },
  { url: 'assets/index-H3yv7842.css', sha256: '2053184c5ade517bc36e490116edb7a3b1bcfc441551b0bdb1fc4de0730ba9ed' },
  { url: 'assets/locale-en-DptUTGYB.js', sha256: '320eda4484e5319ea5140542977a851e052f7cd4f2b82bb892f3039cbce4a761' },
  { url: 'assets/locale-th-C-9mtQcD.js', sha256: 'b12eb9f20f4bd414f63a1dab0240e1ab279be291a76d42437cb4b1e8791171f2' },
  { url: 'favicon.svg', sha256: 'a2305dd61251e9e30a194e6a3c5f0b7d83e49e985b31637d70219fe66dfed844' },
  { url: 'index.html', sha256: 'b19a0e49aa58372345568bd817eadabb69b39586ea1a5f4631c713a371162563' },
];

/** Content-addressed shell version (first 16 hex chars of the manifest hash). */
export const SHELL_VERSION = 'd0632b6a8cd841b2';
