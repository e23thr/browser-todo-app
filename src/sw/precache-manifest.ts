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
  { url: 'assets/LockedScreen-oDry587I.js', sha256: '669c87f7d3332f25d30903d4e806bacca1509bd29b76c01d42b22db0323944cb' },
  { url: 'assets/SettingsView-DElbyW4_.js', sha256: '2587c560df87ca6f1a1e06c97dfffa9cb4475c27e2f79d92ffd9c5858062f548' },
  { url: 'assets/UnlockDialog-Cg00Igxw.js', sha256: '119de11b1ddf1e55428fe2f3c364f7b28e377b04b9fea4832d212b9468eb46e5' },
  { url: 'assets/actions-CkC-2Jhh.js', sha256: 'dcfd8e16c37a64eeec1da44f0de7693d0127679ac4b591aafa23936edeaf783a' },
  { url: 'assets/boot-o9gt5UH6.js', sha256: 'a13004ec07e69d20e9d20d2ad37dee7a94cd86f604b3f7e67335084df012c7f2' },
  { url: 'assets/constants-BFXfhKxE.js', sha256: '88c60bdc740a1f8962638156c63d8124062ce383dbe520e7417763f24f86e933' },
  { url: 'assets/errors-CEhwMt3t.js', sha256: '84f5e1598b25a013972453566adc0f87f74816cf798329bc424ab4fc8956d39b' },
  { url: 'assets/hash-CPOmKC_g.js', sha256: '1f655826b187339ba47285dafc8e93f2144e3875fb824cf9507a1ea0cd890db7' },
  { url: 'assets/index-CKuwTKEW.js', sha256: '9548b27a8568ce98fb167ef3b7820e43f7d413e1aaf3adc947bcc671d0705315' },
  { url: 'assets/index-DcLQ9C8y.css', sha256: '862ee014977b151cb5327fdb649641ebd61fbc0c230fdf87bf1807c8a087554d' },
  { url: 'assets/kernel-CZ7ZmPr3.js', sha256: '2808997dad760de982165192cdf6d01c94856f829792af2d30077342fdf9723e' },
  { url: 'assets/locale-en-DNL0G3aT.js', sha256: 'f4bfbd558fcb94b2b364c003175061f7b6cb59f5838b742f4010a71b5b9b780e' },
  { url: 'assets/locale-th-Cv_YeVdZ.js', sha256: 'cd96f1a22eafb7e46d6e003e2937ac3f01a08d1138ed9f5b1849dcc5935b9e46' },
  { url: 'assets/migrations-Bdd493pz.js', sha256: 'fbfc41fa15669851171a6688b941428865de8670349fa38b62006fd9cd2b25ec' },
  { url: 'assets/notices-PyYKOdun.js', sha256: '17a060d752dbd676b84787127deb340dcca37c4575dd10efe462a542b2638e26' },
  { url: 'assets/portability-0wtRxjCq.js', sha256: 'd0603c8b76aa2ec7e0d38adfb0ff9d6f03ddf4cd3173824ee3a61c7bf66f23e8' },
  { url: 'assets/side-effects-D0lF5FSx.js', sha256: '3d3e2c3a9e889222722c91ad5e3be52d34ee6902247793e9e40039af2f9540d3' },
  { url: 'assets/snapshots-api-yCDcXqEe.js', sha256: '9fe31e2152ff0d72d2fe372ead5efb6b9d04da166727465824733cd7ab8ffde5' },
  { url: 'assets/snapshots-zt1bl3Ds.js', sha256: '786aabd866f27427b9be94f60a36808ff9af92d869377ccfc6889689fe8565c8' },
  { url: 'assets/syncHost-DZeAkAQI.js', sha256: '21d2bd5e1500600624e1258ea694f84f6611ceb253ab37322a4069168cdee7e3' },
  { url: 'assets/vault-CCtvdvHK.js', sha256: '9874c9682f37ab1d43b6ad0fdbac43a81ab72b5ceb94e8cf4ee43a6da0f31d7f' },
  { url: 'assets/wiring-CxlSelZX.js', sha256: '47d3a789f6bc43fdf8bea1e7392e6f99504fe545b3e8f141e37a4a63212e97a6' },
  { url: 'favicon.svg', sha256: 'a2305dd61251e9e30a194e6a3c5f0b7d83e49e985b31637d70219fe66dfed844' },
  { url: 'icons/apple-touch-icon-180.png', sha256: '1c002be7ffbbae4577261389c24549f5a7c6ddbde416e5290051d9d863b358cb' },
  { url: 'icons/icon-192.png', sha256: 'aba45f015692b51cbdc9f5d56dce199a62e16a1a3edd55190dff6fa0bf856df6' },
  { url: 'icons/icon-512.png', sha256: '18b765a253ba4962361a3bcb968b68af22789c2bd280a7bd434be948bbc1e122' },
  { url: 'icons/maskable-192.png', sha256: 'f7a9b1ece082c9ff592f1ea9cab710fdd2f6ee7d0002e773766ef02c94435ac3' },
  { url: 'icons/maskable-512.png', sha256: 'b01965796b4fb644b7688cdb6a01520d27d52d862ca48fb9e91f4e6666b5659a' },
  { url: 'index.html', sha256: '751b9837a4b97a4eadeccfdd9d715c1ffce4f7dd37e958d2eea9675814b1506c' },
];

/** Content-addressed shell version (first 16 hex chars of the manifest hash). */
export const SHELL_VERSION = 'ea1c721fad0f0779';
