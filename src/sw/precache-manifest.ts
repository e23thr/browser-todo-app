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
  { url: 'assets/LockedScreen-Cw0ZDnj1.js', sha256: 'bc0da29acd85441fee46b1e4f922285e395b831dbb56a632ad104cf17bef379c' },
  { url: 'assets/SettingsView-DeeDlFTO.js', sha256: '56a591ed88f3f61dffed2c8bedbafe9fb57f7ef111f745839dee0c3a4463b0ab' },
  { url: 'assets/UnlockDialog-CMujbsOD.js', sha256: '92936b2a803fe37ccdc06a0ea4c6f9546a121da5217729c21478d8df24c2fe25' },
  { url: 'assets/actions-3X3pktr2.js', sha256: '83af289822866b8fdad61a740a44d24f53b29127f7d5e304f8f83d3b2b1ee473' },
  { url: 'assets/boot-Dr3uzWjw.js', sha256: 'b0c5b4a70b013f94a4e51d91d6a53b72e5ec7eaf461356a01d3fcc2bcffc532e' },
  { url: 'assets/constants-BFXfhKxE.js', sha256: '88c60bdc740a1f8962638156c63d8124062ce383dbe520e7417763f24f86e933' },
  { url: 'assets/errors-CEhwMt3t.js', sha256: '84f5e1598b25a013972453566adc0f87f74816cf798329bc424ab4fc8956d39b' },
  { url: 'assets/hash-CPOmKC_g.js', sha256: '1f655826b187339ba47285dafc8e93f2144e3875fb824cf9507a1ea0cd890db7' },
  { url: 'assets/index-DcLQ9C8y.css', sha256: '862ee014977b151cb5327fdb649641ebd61fbc0c230fdf87bf1807c8a087554d' },
  { url: 'assets/index-nGNr-Aum.js', sha256: 'adcdc7e68a5dc9e0dd60e150a8356c75204b6c0d1be4046e71e0c8b2abfbf47a' },
  { url: 'assets/kernel-CZ7ZmPr3.js', sha256: '2808997dad760de982165192cdf6d01c94856f829792af2d30077342fdf9723e' },
  { url: 'assets/locale-en-BqlpDVCK.js', sha256: 'ec819c4c4a6895c6c181db2bdae20400fc820c3d25e0c4957281e4bcb19df04c' },
  { url: 'assets/locale-th-Dgp6tnut.js', sha256: '03dc6f43328a9e26ddb8c6924eef857b6f03f05c3eafe5cea85d70c9760af3cf' },
  { url: 'assets/migrations-Bdd493pz.js', sha256: 'fbfc41fa15669851171a6688b941428865de8670349fa38b62006fd9cd2b25ec' },
  { url: 'assets/notices-BI-nzbON.js', sha256: '0ec3a17b821f304fc183f6c550274cbc69ea291444070ebc8f81fa39b3c09d4f' },
  { url: 'assets/portability-0wtRxjCq.js', sha256: 'd0603c8b76aa2ec7e0d38adfb0ff9d6f03ddf4cd3173824ee3a61c7bf66f23e8' },
  { url: 'assets/side-effects-D0lF5FSx.js', sha256: '3d3e2c3a9e889222722c91ad5e3be52d34ee6902247793e9e40039af2f9540d3' },
  { url: 'assets/snapshots-api-34T0QD0x.js', sha256: 'bc9d753bb28a92d605f4b4a2e4e7e787c0066f6a3e76e0399130824f4c364ab2' },
  { url: 'assets/snapshots-zt1bl3Ds.js', sha256: '786aabd866f27427b9be94f60a36808ff9af92d869377ccfc6889689fe8565c8' },
  { url: 'assets/syncHost-CxFwqugG.js', sha256: 'faeafd47bfad3e8d75dfc15039c8a088f6ba1ee539f12c4d4abafd745c7c1e8c' },
  { url: 'assets/vault-DdVW6fUy.js', sha256: '567ddc39b18da99e3bfcc997cff8630613c23ded819504f53331baa02ac0b159' },
  { url: 'assets/wiring-B1hXPvJl.js', sha256: 'abc66e2b5e82ee0eb71d8c8f029952fb4cf3a8d476c63ef99a4cf75a30f143d0' },
  { url: 'favicon.svg', sha256: 'a2305dd61251e9e30a194e6a3c5f0b7d83e49e985b31637d70219fe66dfed844' },
  { url: 'icons/apple-touch-icon-180.png', sha256: '1c002be7ffbbae4577261389c24549f5a7c6ddbde416e5290051d9d863b358cb' },
  { url: 'icons/icon-192.png', sha256: 'aba45f015692b51cbdc9f5d56dce199a62e16a1a3edd55190dff6fa0bf856df6' },
  { url: 'icons/icon-512.png', sha256: '18b765a253ba4962361a3bcb968b68af22789c2bd280a7bd434be948bbc1e122' },
  { url: 'icons/maskable-192.png', sha256: 'f7a9b1ece082c9ff592f1ea9cab710fdd2f6ee7d0002e773766ef02c94435ac3' },
  { url: 'icons/maskable-512.png', sha256: 'b01965796b4fb644b7688cdb6a01520d27d52d862ca48fb9e91f4e6666b5659a' },
  { url: 'index.html', sha256: 'f6aa9ec462ef40c9e5665aed51d0c0888687d196231e4d6f0e1b21092b85d43b' },
];

/** Content-addressed shell version (first 16 hex chars of the manifest hash). */
export const SHELL_VERSION = '7271dcde1a19dea4';
