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
  { url: 'assets/LockedScreen-DJ6Jl9FB.js', sha256: 'c2da4857492f88f36e52c81148d577a59d5d84bfa88cd7d4253b9aa90bbd38cc' },
  { url: 'assets/SettingsView-BL7aY0kz.js', sha256: 'f76305f24d5ff937230857c41978d92b7c77ec6f11ee6b96a650ee23433051f9' },
  { url: 'assets/UnlockDialog-B0g1KvqA.js', sha256: 'b7b0b6b9262b25e41e7246a81b83f01ac91654f0fbdaa7141536705cd501f75d' },
  { url: 'assets/actions-Cgk74Fzd.js', sha256: '246b2cce89d58e68c9c3889822bd2f470214695be372853f72ab8a365f213a3c' },
  { url: 'assets/boot-FKdPbS1G.js', sha256: 'ade22ada1f18a00c6e0227e92b08202305d8b2918229e422c94833ff80720bc3' },
  { url: 'assets/constants-BFXfhKxE.js', sha256: '88c60bdc740a1f8962638156c63d8124062ce383dbe520e7417763f24f86e933' },
  { url: 'assets/errors-CEhwMt3t.js', sha256: '84f5e1598b25a013972453566adc0f87f74816cf798329bc424ab4fc8956d39b' },
  { url: 'assets/hash-CPOmKC_g.js', sha256: '1f655826b187339ba47285dafc8e93f2144e3875fb824cf9507a1ea0cd890db7' },
  { url: 'assets/index-D1vUrJVC.js', sha256: '5116762ee144e01786c683295453c6d4ae6cb3fc362337ec27a2514f62437a8e' },
  { url: 'assets/index-DcLQ9C8y.css', sha256: '862ee014977b151cb5327fdb649641ebd61fbc0c230fdf87bf1807c8a087554d' },
  { url: 'assets/kernel-CZ7ZmPr3.js', sha256: '2808997dad760de982165192cdf6d01c94856f829792af2d30077342fdf9723e' },
  { url: 'assets/locale-en-DNL0G3aT.js', sha256: 'f4bfbd558fcb94b2b364c003175061f7b6cb59f5838b742f4010a71b5b9b780e' },
  { url: 'assets/locale-th-Cv_YeVdZ.js', sha256: 'cd96f1a22eafb7e46d6e003e2937ac3f01a08d1138ed9f5b1849dcc5935b9e46' },
  { url: 'assets/migrations-DxOhxynz.js', sha256: 'b5ff0cb4f67181f630760a60a869f9ae64789b5ed0ef524d3711689d7e0ed718' },
  { url: 'assets/notices-GQsqbKr_.js', sha256: 'cd4b490e3969fa9a34d73e9be50e3360f99fb1513cb3ab6164984990a5503c91' },
  { url: 'assets/portability-0wtRxjCq.js', sha256: 'd0603c8b76aa2ec7e0d38adfb0ff9d6f03ddf4cd3173824ee3a61c7bf66f23e8' },
  { url: 'assets/side-effects-D0lF5FSx.js', sha256: '3d3e2c3a9e889222722c91ad5e3be52d34ee6902247793e9e40039af2f9540d3' },
  { url: 'assets/snapshots-DtyTlsFt.js', sha256: '1c91ca1ec988d44660f9e368a10a8af988adba55b209c16cda5023734cc65054' },
  { url: 'assets/snapshots-api-DasYR0bA.js', sha256: '50718dd53e67bf2f8a085dd172c216d101d3d866a04031f5e4c1e0f9416b0bc0' },
  { url: 'assets/syncHost-B14MFzBj.js', sha256: '6c272e7cdc3feffd8d2cca470300786e3a0a8d78990904296d22db1424ceec04' },
  { url: 'assets/vault-Ck1bCjoi.js', sha256: '6e5b4aa666636f480a2d3bd01f54f5d62f444d6d95108fad5920ace7618849e3' },
  { url: 'assets/wiring-CS5KrTRQ.js', sha256: '2275689d799e155b1862d569e7fce25daa6853150f1446a226f21c092875c93e' },
  { url: 'favicon.svg', sha256: 'a2305dd61251e9e30a194e6a3c5f0b7d83e49e985b31637d70219fe66dfed844' },
  { url: 'icons/apple-touch-icon-180.png', sha256: '1c002be7ffbbae4577261389c24549f5a7c6ddbde416e5290051d9d863b358cb' },
  { url: 'icons/icon-192.png', sha256: 'aba45f015692b51cbdc9f5d56dce199a62e16a1a3edd55190dff6fa0bf856df6' },
  { url: 'icons/icon-512.png', sha256: '18b765a253ba4962361a3bcb968b68af22789c2bd280a7bd434be948bbc1e122' },
  { url: 'icons/maskable-192.png', sha256: 'f7a9b1ece082c9ff592f1ea9cab710fdd2f6ee7d0002e773766ef02c94435ac3' },
  { url: 'icons/maskable-512.png', sha256: 'b01965796b4fb644b7688cdb6a01520d27d52d862ca48fb9e91f4e6666b5659a' },
  { url: 'index.html', sha256: 'c7c15de7cdc14bd107ff6b24572108bef4e2d4c8352feedab6b3bf432c16214f' },
];

/** Content-addressed shell version (first 16 hex chars of the manifest hash). */
export const SHELL_VERSION = 'c2cef57283a6604e';
