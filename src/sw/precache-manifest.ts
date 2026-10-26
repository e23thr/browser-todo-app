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
  { url: 'assets/LockedScreen-C-43o5Ep.js', sha256: '186964bee9e64c967fc78ca508c4617e03f2759797e43290826d21d6ad851a91' },
  { url: 'assets/SettingsView-3ciiKKvF.js', sha256: 'a37654e235effffb3edcce1684859db5c928b3a30bb89a4a25a59b1824f5e000' },
  { url: 'assets/UnlockDialog-BYpMkFjR.js', sha256: '5586cf96022bd12f15e0cc7560ab1f13c15ead2938d64074be29f527941f9c48' },
  { url: 'assets/actions-Di3KYGlI.js', sha256: '21423bd9844044e5f988e3c35c58756d564484478ee025cbcaee4ad4d573d3a4' },
  { url: 'assets/boot-QIKXLZQ-.js', sha256: '8d38c510ae1184d32156064fb257d981624361df76e88c03c4714b038fbd70aa' },
  { url: 'assets/constants-Z4R30km9.js', sha256: 'fb6ec024c6749a158f2eb929c7f40c7a0f32d47621b201db46efb6dae5214736' },
  { url: 'assets/errors-CEhwMt3t.js', sha256: '84f5e1598b25a013972453566adc0f87f74816cf798329bc424ab4fc8956d39b' },
  { url: 'assets/hash-CPOmKC_g.js', sha256: '1f655826b187339ba47285dafc8e93f2144e3875fb824cf9507a1ea0cd890db7' },
  { url: 'assets/i18n-DGNLpkca.js', sha256: '81590d2a1a69b58ed088019614ffb3ac66788efc496b47b7c573a913f3eeeda8' },
  { url: 'assets/index-DBwo0HP-.js', sha256: 'db9b8ae31ab5fc8a48072bdd7fb6afc06f45ce6ea5b1d9dfe2a2f9ed7c0a2ec8' },
  { url: 'assets/index-DcLQ9C8y.css', sha256: '862ee014977b151cb5327fdb649641ebd61fbc0c230fdf87bf1807c8a087554d' },
  { url: 'assets/kernel-CZ7ZmPr3.js', sha256: '2808997dad760de982165192cdf6d01c94856f829792af2d30077342fdf9723e' },
  { url: 'assets/locale-en-B9Pcifsl.js', sha256: '9e26292c357b060cbaa850cf2ba802218c217274a2113fdfa6b3257976aa557a' },
  { url: 'assets/locale-th-_010ZMd-.js', sha256: '5b0e5592b8e401d650f2af70d4b765c4fff8f586596f035de91c3a7a9f317c71' },
  { url: 'assets/migrations-BZCckJ63.js', sha256: 'a0934f6abe7015acdefaf78f1097c939c94bbcfd70128197ce9fdd44cf552ddb' },
  { url: 'assets/portability-0wtRxjCq.js', sha256: 'd0603c8b76aa2ec7e0d38adfb0ff9d6f03ddf4cd3173824ee3a61c7bf66f23e8' },
  { url: 'assets/side-effects-C68DtX-G.js', sha256: '8b0539aaba7d4c8fefb8385861e42c8fc275dd70cd5214a0e0739bb55ce5a3a4' },
  { url: 'assets/snapshots-CAV7T4yC.js', sha256: 'ba55c4e34e7e669d7f43485021a6e6ee873823eaa240dae90cbd50688fe8694f' },
  { url: 'assets/snapshots-api-Cc7r9bb3.js', sha256: '964dfd5636ede15206b520524653d5d0c69df1c0bd7a0efef620cd6456a83a7f' },
  { url: 'assets/syncHost-Cl3jtC5z.js', sha256: '12a688fc58cb2c287181a4ec9f4afde9deab33aac0819d54f07922f24c7bbf45' },
  { url: 'assets/vault-DrLspDg4.js', sha256: '9fbef9b1552b7e7365415ae81259a4343172b67f512eec756be543d589a1fb68' },
  { url: 'assets/wiring-DB9B7N4x.js', sha256: '4f33d48b96345aeaf5e40ad8eea825fb7931430c4b2c4888bc4087b5004382a4' },
  { url: 'favicon.svg', sha256: 'a2305dd61251e9e30a194e6a3c5f0b7d83e49e985b31637d70219fe66dfed844' },
  { url: 'icons/apple-touch-icon-180.png', sha256: '1c002be7ffbbae4577261389c24549f5a7c6ddbde416e5290051d9d863b358cb' },
  { url: 'icons/icon-192.png', sha256: 'aba45f015692b51cbdc9f5d56dce199a62e16a1a3edd55190dff6fa0bf856df6' },
  { url: 'icons/icon-512.png', sha256: '18b765a253ba4962361a3bcb968b68af22789c2bd280a7bd434be948bbc1e122' },
  { url: 'icons/maskable-192.png', sha256: 'f7a9b1ece082c9ff592f1ea9cab710fdd2f6ee7d0002e773766ef02c94435ac3' },
  { url: 'icons/maskable-512.png', sha256: 'b01965796b4fb644b7688cdb6a01520d27d52d862ca48fb9e91f4e6666b5659a' },
  { url: 'index.html', sha256: '2a1323e7b7bb67916e02a3153ccf90d26f568c933b1554f50cbde1d2d2684f18' },
];

/** Content-addressed shell version (first 16 hex chars of the manifest hash). */
export const SHELL_VERSION = '9bf0fc201d298b78';
