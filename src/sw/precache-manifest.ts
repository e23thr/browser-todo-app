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
  { url: 'assets/SettingsView-CeS_pji5.js', sha256: 'f5ad39840b0a9b7cc755773e9ee3708603e44963da1084c0d7df98c5941e6135' },
  { url: 'assets/actions-CzBSyqmI.js', sha256: 'bd497dee94b1b1af204c7b86c255ccfdbcef808b9b7b24c7bbadba12a0730213' },
  { url: 'assets/boot-Dup1tdrr.js', sha256: 'e18ccdbfea0ecb3399d9f3cfadf5151b536de8dab99dd440b2ccda858a42649f' },
  { url: 'assets/dbAccess-Bav5MJsG.js', sha256: '0705369f81683119a910d8c1b9dc8962e203bcd7a08546a9841760f5413ce2ad' },
  { url: 'assets/index-BEoM4_nd.css', sha256: '7ef61f06811f2db1de89eed989f7725a7db628ef369e0c1a3db8150027aad210' },
  { url: 'assets/index-BnqkoMgT.js', sha256: 'a6b99ccdd5f3f5f90026890542695c43adfdfaa0950482c5d0c67cffb0320748' },
  { url: 'assets/locale-en-QwUFp39B.js', sha256: '2e9b81d73b04d24802910eaa558e6bb8030f63304f848c0ef8794143555a4815' },
  { url: 'assets/locale-th-B0dTFccO.js', sha256: '180843d2f7e37f7f07678d767c1f48cfd2841863621e1cbba97fa59bc5828ca4' },
  { url: 'assets/snapshots-api-B23rPcZQ.js', sha256: '3e3ea7b6335e3e7e6923ea1aa884a5f1ca7a6332e2c963e8d3eeb29549fa2c38' },
  { url: 'favicon.svg', sha256: 'a2305dd61251e9e30a194e6a3c5f0b7d83e49e985b31637d70219fe66dfed844' },
  { url: 'icons/apple-touch-icon-180.png', sha256: '1c002be7ffbbae4577261389c24549f5a7c6ddbde416e5290051d9d863b358cb' },
  { url: 'icons/icon-192.png', sha256: 'aba45f015692b51cbdc9f5d56dce199a62e16a1a3edd55190dff6fa0bf856df6' },
  { url: 'icons/icon-512.png', sha256: '18b765a253ba4962361a3bcb968b68af22789c2bd280a7bd434be948bbc1e122' },
  { url: 'icons/maskable-192.png', sha256: 'f7a9b1ece082c9ff592f1ea9cab710fdd2f6ee7d0002e773766ef02c94435ac3' },
  { url: 'icons/maskable-512.png', sha256: 'b01965796b4fb644b7688cdb6a01520d27d52d862ca48fb9e91f4e6666b5659a' },
  { url: 'index.html', sha256: '56fdda4641aa7f053e153823f1bc9112465100e59952a89928b6807b94c03c01' },
];

/** Content-addressed shell version (first 16 hex chars of the manifest hash). */
export const SHELL_VERSION = 'd1a0ec114236465d';
