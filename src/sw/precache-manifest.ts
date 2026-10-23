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
  { url: 'assets/SettingsView-B71srF5f.js', sha256: '4e1d89d86de2ced5870c07d135558f67925e184eee1437ac7f366401311f7861' },
  { url: 'assets/index-Dxwjfce1.js', sha256: 'd5506ad492e660fae4ff967b349a087cc4fc2649c3687e2d57ec8a4cd44f4075' },
  { url: 'assets/index-H3yv7842.css', sha256: '2053184c5ade517bc36e490116edb7a3b1bcfc441551b0bdb1fc4de0730ba9ed' },
  { url: 'assets/locale-en-DptUTGYB.js', sha256: '320eda4484e5319ea5140542977a851e052f7cd4f2b82bb892f3039cbce4a761' },
  { url: 'assets/locale-th-C-9mtQcD.js', sha256: 'b12eb9f20f4bd414f63a1dab0240e1ab279be291a76d42437cb4b1e8791171f2' },
  { url: 'favicon.svg', sha256: 'a2305dd61251e9e30a194e6a3c5f0b7d83e49e985b31637d70219fe66dfed844' },
  { url: 'index.html', sha256: '77894779298d4495841150dcbb754c3cd4f5600ebf4c8e2d0b94566a8e20389f' },
];

/** Content-addressed shell version (first 16 hex chars of the manifest hash). */
export const SHELL_VERSION = '2dddb7034a9ae4c4';
