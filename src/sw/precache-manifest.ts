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
  { url: 'assets/SettingsView-DxTp-nI4.js', sha256: 'c56632822b32d762fedc0fe2d7bd6a4faa98e98b93f292b35a8cf8a86e479523' },
  { url: 'assets/index-H3yv7842.css', sha256: '2053184c5ade517bc36e490116edb7a3b1bcfc441551b0bdb1fc4de0730ba9ed' },
  { url: 'assets/index-fVTNgnkb.js', sha256: '7583802071ba28de812079eb1ed1633305c83d41e4c8c0a120bed1c9430698a2' },
  { url: 'assets/locale-en-DptUTGYB.js', sha256: '320eda4484e5319ea5140542977a851e052f7cd4f2b82bb892f3039cbce4a761' },
  { url: 'assets/locale-th-C-9mtQcD.js', sha256: 'b12eb9f20f4bd414f63a1dab0240e1ab279be291a76d42437cb4b1e8791171f2' },
  { url: 'favicon.svg', sha256: 'a2305dd61251e9e30a194e6a3c5f0b7d83e49e985b31637d70219fe66dfed844' },
  { url: 'index.html', sha256: '7f15513900e57c7528357ad92c11210c16da0ba24be3162b758f1c0a5a9064eb' },
];

/** Content-addressed shell version (first 16 hex chars of the manifest hash). */
export const SHELL_VERSION = 'f20337fa33af42fd';
