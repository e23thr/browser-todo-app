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
  { url: 'assets/SettingsView-De_SYlfO.js', sha256: '16b14473d40dd4f3bb69eb545d6c9f6ca8a3b159a700bc196cb89f17b8ea0f45' },
  { url: 'assets/actions-11xY8Cg4.js', sha256: '3d582e3ba44fc92e5fec659c66c1dab1262792f78d2fe2829eb1bc7f1710e5f5' },
  { url: 'assets/boot-D00nLgRp.js', sha256: 'e3d4563b1d4c2f1462a9bfb7f529872b4f017aaf8c89ed64c3e98f4efe9a46db' },
  { url: 'assets/dbAccess-DmdpZIsW.js', sha256: 'bb0b63a0ed3b52f9599b608f8582b116b1ca1185c24e843ee2d5751047ecdd3e' },
  { url: 'assets/index-D2Ij-4b6.css', sha256: '506c17c569f26d42a5a42f3390747b3b4f1b08a79b37651fa895b058cfdae982' },
  { url: 'assets/index-Dit6or5O.js', sha256: '9d9fb4bfd66a79547508465983d27fdadb425b3ce67077b2865d1fad4c035446' },
  { url: 'assets/locale-en-csWIHdKa.js', sha256: 'e1d5c2b44dfb3814c6f4f9cd31118eb611a8d3f96fa122d69d233086b639cc35' },
  { url: 'assets/locale-th-CQ_GoZgb.js', sha256: '9c908bea8e74dba3996cd0bd16f23266e2d8bf66b951a99d0fcb2a9d851cf943' },
  { url: 'assets/snapshots-api-XQOHXUXb.js', sha256: 'bad79525d906cfbcc2a34837359b68a460bbd924f4284d1d5db9564df5502562' },
  { url: 'favicon.svg', sha256: 'a2305dd61251e9e30a194e6a3c5f0b7d83e49e985b31637d70219fe66dfed844' },
  { url: 'icons/apple-touch-icon-180.png', sha256: '1c002be7ffbbae4577261389c24549f5a7c6ddbde416e5290051d9d863b358cb' },
  { url: 'icons/icon-192.png', sha256: 'aba45f015692b51cbdc9f5d56dce199a62e16a1a3edd55190dff6fa0bf856df6' },
  { url: 'icons/icon-512.png', sha256: '18b765a253ba4962361a3bcb968b68af22789c2bd280a7bd434be948bbc1e122' },
  { url: 'icons/maskable-192.png', sha256: 'f7a9b1ece082c9ff592f1ea9cab710fdd2f6ee7d0002e773766ef02c94435ac3' },
  { url: 'icons/maskable-512.png', sha256: 'b01965796b4fb644b7688cdb6a01520d27d52d862ca48fb9e91f4e6666b5659a' },
  { url: 'index.html', sha256: 'c56b640aa8af817da42aa61ba207e59f9fe388002a867771266195ff7762e807' },
];

/** Content-addressed shell version (first 16 hex chars of the manifest hash). */
export const SHELL_VERSION = '692830d544000b32';
