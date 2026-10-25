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
  { url: 'assets/SettingsView-CzGVraZb.js', sha256: 'b4d4d8d3967a4e28e64ec55333b8263aec8dee9ff4b21b90efb0b57468515eff' },
  { url: 'assets/actions-CWBsAKcf.js', sha256: 'ff66811b761981f4e6cce2f2fd6249aff20480fa2667fd9102aa319bf179affb' },
  { url: 'assets/boot-CEC7OUWH.js', sha256: '02706944d3e6ce300bf4372c55adc9ac063a72bc140b6641e83d462f4ecbe8b3' },
  { url: 'assets/dbAccess-BQhOIbNS.js', sha256: '5170a4fde76674e9e8b6baa9922bda8b637ee2535e48ca501279f78657693628' },
  { url: 'assets/index-BPU4E2SW.css', sha256: '22148c7cdc3fdb6b4661329fb65de5213d91bc01745fdcd0b6d76b41f67aa8b3' },
  { url: 'assets/index-Dz_h9Rd3.js', sha256: '1d05a1111da36ebc8c8b75caa9d5d790c2c9810389a7c83a24a0cc0e7b0d64b3' },
  { url: 'assets/locale-en-fFwUrHqa.js', sha256: '2b8f8134437107700fca2b801a8610314f5da54303396daecab95b61a821021c' },
  { url: 'assets/locale-th-BYW6wTsF.js', sha256: 'ab708c52dc0bb12dff0616383d47b68b5ff6d358cf2a9a859f2615eddbbcd696' },
  { url: 'assets/snapshots-api-B23rPcZQ.js', sha256: '3e3ea7b6335e3e7e6923ea1aa884a5f1ca7a6332e2c963e8d3eeb29549fa2c38' },
  { url: 'favicon.svg', sha256: 'a2305dd61251e9e30a194e6a3c5f0b7d83e49e985b31637d70219fe66dfed844' },
  { url: 'icons/apple-touch-icon-180.png', sha256: '1c002be7ffbbae4577261389c24549f5a7c6ddbde416e5290051d9d863b358cb' },
  { url: 'icons/icon-192.png', sha256: 'aba45f015692b51cbdc9f5d56dce199a62e16a1a3edd55190dff6fa0bf856df6' },
  { url: 'icons/icon-512.png', sha256: '18b765a253ba4962361a3bcb968b68af22789c2bd280a7bd434be948bbc1e122' },
  { url: 'icons/maskable-192.png', sha256: 'f7a9b1ece082c9ff592f1ea9cab710fdd2f6ee7d0002e773766ef02c94435ac3' },
  { url: 'icons/maskable-512.png', sha256: 'b01965796b4fb644b7688cdb6a01520d27d52d862ca48fb9e91f4e6666b5659a' },
  { url: 'index.html', sha256: '69a80751463f7f49356deca434663ddc71cc1c829e19868741ce4a463d9b5be0' },
];

/** Content-addressed shell version (first 16 hex chars of the manifest hash). */
export const SHELL_VERSION = 'd0dff95e793de4c7';
