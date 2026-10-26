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
  { url: 'assets/LockedScreen-BaKfi8B5.js', sha256: '70d0f1cc8868279411d4586f98fe0250d2c2a359af104dcccf88104028a93b75' },
  { url: 'assets/SettingsView-TawGRd8C.js', sha256: 'a04a49ae9b0e3da9c20ada69fa4d50c91259d3a19da0858860c95a3ec1ed8cf7' },
  { url: 'assets/UnlockDialog-ByUPJ29D.js', sha256: 'c43a936899f33fa04a6fa8320258a51668b567112ba3df1ab12e1b12986d8c73' },
  { url: 'assets/actions-CuRqSOKJ.js', sha256: 'fd28d69d3bc4154bfbd5860233b7d9abe78f45934670069b4e86a3db43fc2aa5' },
  { url: 'assets/boot-DfxBQsHK.js', sha256: 'a6797256703327c81e26eb61e76f29071c242b5d2501104aed905753e4af586e' },
  { url: 'assets/constants-CIorjM2n.js', sha256: 'a39f51e3b22c9fc6ad7a39185c30d1e8998f1b61f65b0d5f94f4ba90dccaf96e' },
  { url: 'assets/errors-CEhwMt3t.js', sha256: '84f5e1598b25a013972453566adc0f87f74816cf798329bc424ab4fc8956d39b' },
  { url: 'assets/hash-CPOmKC_g.js', sha256: '1f655826b187339ba47285dafc8e93f2144e3875fb824cf9507a1ea0cd890db7' },
  { url: 'assets/i18n-sTZvOppf.js', sha256: '750a6219e499762d511f6db11788088e0525a4cd32527c0edbba10c9255d7a2f' },
  { url: 'assets/index-B_uJrt_2.js', sha256: 'be0bdfad3742a9c1cd89dea59fa2b5fd8d8564caecfa66becd9a55aad6da5d41' },
  { url: 'assets/index-DcLQ9C8y.css', sha256: '862ee014977b151cb5327fdb649641ebd61fbc0c230fdf87bf1807c8a087554d' },
  { url: 'assets/kernel-CZ7ZmPr3.js', sha256: '2808997dad760de982165192cdf6d01c94856f829792af2d30077342fdf9723e' },
  { url: 'assets/locale-en-B9Pcifsl.js', sha256: '9e26292c357b060cbaa850cf2ba802218c217274a2113fdfa6b3257976aa557a' },
  { url: 'assets/locale-th-_010ZMd-.js', sha256: '5b0e5592b8e401d650f2af70d4b765c4fff8f586596f035de91c3a7a9f317c71' },
  { url: 'assets/migrations-BZCckJ63.js', sha256: 'a0934f6abe7015acdefaf78f1097c939c94bbcfd70128197ce9fdd44cf552ddb' },
  { url: 'assets/portability-0wtRxjCq.js', sha256: 'd0603c8b76aa2ec7e0d38adfb0ff9d6f03ddf4cd3173824ee3a61c7bf66f23e8' },
  { url: 'assets/side-effects-DDxcl0NF.js', sha256: 'e3f14a777898ac0e81015aa5b405842d823f9bf2e547fc5a6b6d13016a3307be' },
  { url: 'assets/snapshots-CAV7T4yC.js', sha256: 'ba55c4e34e7e669d7f43485021a6e6ee873823eaa240dae90cbd50688fe8694f' },
  { url: 'assets/snapshots-api-D7YGZ9Oy.js', sha256: 'afe5abab5c168a2d06f5dd1ac4292450b7a2d7f82fa8262413874dffac066523' },
  { url: 'assets/syncHost-oiw_Ba1p.js', sha256: 'aaa71fbc0164945fe9f5b4cbaf4355aac74c2d6d98742b3ee42b9cab8edb32c5' },
  { url: 'assets/vault-DB9Ra3vV.js', sha256: '500186fcf63c220939900faae3c8b301d1efa89591a1fc58babb1a5db11fc379' },
  { url: 'assets/wiring-CfaAY1e8.js', sha256: 'cb78503222fb0b36174f7383802971b5d08d76cf5e50f0b6a84271510d474fb7' },
  { url: 'favicon.svg', sha256: 'a2305dd61251e9e30a194e6a3c5f0b7d83e49e985b31637d70219fe66dfed844' },
  { url: 'icons/apple-touch-icon-180.png', sha256: '1c002be7ffbbae4577261389c24549f5a7c6ddbde416e5290051d9d863b358cb' },
  { url: 'icons/icon-192.png', sha256: 'aba45f015692b51cbdc9f5d56dce199a62e16a1a3edd55190dff6fa0bf856df6' },
  { url: 'icons/icon-512.png', sha256: '18b765a253ba4962361a3bcb968b68af22789c2bd280a7bd434be948bbc1e122' },
  { url: 'icons/maskable-192.png', sha256: 'f7a9b1ece082c9ff592f1ea9cab710fdd2f6ee7d0002e773766ef02c94435ac3' },
  { url: 'icons/maskable-512.png', sha256: 'b01965796b4fb644b7688cdb6a01520d27d52d862ca48fb9e91f4e6666b5659a' },
  { url: 'index.html', sha256: '878cb341bafc71e9b3cf0fa325b31b7cfaec271363953932ce4af63f5575f7b1' },
];

/** Content-addressed shell version (first 16 hex chars of the manifest hash). */
export const SHELL_VERSION = '610e1a44d609fc84';
