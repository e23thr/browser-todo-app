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
  { url: 'assets/SettingsView-CE6yhkEo.js', sha256: '660d9580a2e6aa3a4dcf565d7b6027835040849369016bd117a86a9558139625' },
  { url: 'assets/actions-CzpjsjBC.js', sha256: 'f0047d1b5da6149804267807ae2afa4b9f35bb2fcf6c37220748c2235e30d650' },
  { url: 'assets/boot-E5EmPMU-.js', sha256: '1cfd8f4c872c6d841b54396ded26969bdc36cc63465987ce03b98e1542d00038' },
  { url: 'assets/dbAccess-DabT-c3z.js', sha256: '86ead44c6793ab945f31d787e61a6cebde632e0d12246b9918c6679af3f92cfe' },
  { url: 'assets/index-BpBL3MUj.css', sha256: 'd7708bccbceb5a2a8423f844267b85afd4a040f377dc448245c152ca0f10678e' },
  { url: 'assets/index-CUC-K4we.js', sha256: 'd238e88a32fa1a58d17ce0e99ca158c3d9ac42b6ced7a10839c9357857dea4f1' },
  { url: 'assets/locale-en-CGAu8ZB3.js', sha256: '0ce0de704ec8cee3087da39aeb02083783c5259585420d62e322cfe3b01fd62b' },
  { url: 'assets/locale-th-CCUmD8mT.js', sha256: '8334b94eccc9bb2f2c224cfe6c48ecff9cfa0f4513a07c1046ccf4033fde67d6' },
  { url: 'assets/snapshots-api-Dgh4Znpq.js', sha256: 'b7a90b603d5135660fd8d0880dacacbcb8e9c68b1c6eb8b5a9a8acd66fbcb0b3' },
  { url: 'favicon.svg', sha256: 'a2305dd61251e9e30a194e6a3c5f0b7d83e49e985b31637d70219fe66dfed844' },
  { url: 'index.html', sha256: '7e385437a9f58ea849f991f50be45f21decceebd25f68da0c029b8c0f91aba08' },
];

/** Content-addressed shell version (first 16 hex chars of the manifest hash). */
export const SHELL_VERSION = 'f4ee382c90f7ed57';
