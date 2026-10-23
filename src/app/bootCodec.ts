/**
 * Composition-root boot codec (E3 / ADR-004).
 *
 * `boot()` is a singleton keyed by database name: the FIRST caller wins, and in this app that
 * is whichever of the three boot paths gets there first — the i18n locale load (before first
 * render), the settings load (an App effect) or the data-safety start. Every one of them must
 * therefore pass the ADR-004 codec, or a pre-migration snapshot could be serialized with the
 * fallback raw codec.
 *
 * The codec is loaded through a dynamic import so the engine stays OUT of the initial JS
 * closure (§9.2 budget): the chunk is fetched once, on the first boot, alongside storage.
 */

import type { SnapshotCodec } from '../storage/snapshots';

let codecPromise: Promise<SnapshotCodec> | null = null;

/** The ADR-004 snapshot codec, fetched once and shared by every `boot()` call site. */
export function bootCodec(): Promise<SnapshotCodec> {
  codecPromise ??= import('../portability/snapshots-api').then((module) => module.adr004Codec);
  return codecPromise;
}
