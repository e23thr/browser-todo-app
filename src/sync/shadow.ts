/**
 * The sync-shadow three-way test (ADR-006 Decision 4.2) — pure.
 *
 * For record `id` with local version `L`, remote version `R` (the LWW-best of
 * everything fetched) and shadow `S` (the last-synced version both sides are
 * known to have seen), classify the divergence. The RECORD OUTCOME is always
 * the LWW fold (Decision 4.1 — never regressive); this test answers exactly one
 * question: is a local change being displaced, and must it be preserved?
 *
 * Preservation principle (derived from Decision 4.3's "the losing version is
 * materialized" + "a tombstone is never copied into a visible row" + the
 * Decision 5 E2E assertion "concurrent edit → EXACTLY ONE visible conflict
 * copy"): a conflict copy is materialized exactly when the merge would
 * overwrite a locally-diverged LIVE version — on the winner side nothing is
 * displaced, so nothing is duplicated. Every device preserves its own displaced
 * work; the copies then propagate like ordinary rows.
 */

import { compareLww } from '../domain/merge';

export type Stamp = { updatedAt: number; deviceId: string };

export type ShadowEntry = {
  updatedAt: number;
  deviceId: string;
  contentHash: string;
};

/** One side of the test: a record version plus its prepared hash/liveness. */
export type Side = {
  stamp: Stamp;
  contentHash: string;
  tombstone: boolean;
};

export type Divergence =
  | 'nothing' // both sides absent — nothing to decide
  | 'same-change' // versions equal or contents identical — no displacement
  | 'only-remote-changed' // local == shadow (or absent): remote's change is free to apply
  | 'only-local-changed' // remote == shadow (or absent): local keeps, push later
  | 'concurrent-edit' // both live diverged since the shadow
  | 'delete-vs-edit' // one side tombstoned, the other edited, since the shadow
  | 'delete-vs-delete'; // both tombstoned since the shadow — no work diverged

/**
 * "Changed since the common version": STRICTLY newer than `S` in LWW order AND
 * content-different. A version older than `S` is a stale echo — it never
 * "changed after" the ancestor (and can never win the LWW fold), so it cannot
 * force a copy. With no shadow at all the conservative §6.2 rule applies:
 * divergent versions are treated as concurrent (conflict copies are the safe,
 * visible direction).
 */
export function divergedSince(side: Side, shadow: ShadowEntry | null): boolean {
  if (shadow === null) return true;
  if (side.contentHash === shadow.contentHash) return false;
  return compareLww(side.stamp, { updatedAt: shadow.updatedAt, deviceId: shadow.deviceId }) > 0;
}

export function sameVersion(a: Stamp, b: Stamp): boolean {
  return a.updatedAt === b.updatedAt && a.deviceId === b.deviceId;
}

/** Classify one record's (L, R, S) triple. Deterministic and order-insensitive. */
export function classifyDivergence(
  local: Side | null,
  remote: Side | null,
  shadow: ShadowEntry | null,
): Divergence {
  if (local === null && remote === null) return 'nothing';
  if (local === null) return 'only-remote-changed';
  if (remote === null) return 'only-local-changed';
  if (sameVersion(local.stamp, remote.stamp) || local.contentHash === remote.contentHash) {
    return 'same-change';
  }
  const localChanged = divergedSince(local, shadow);
  const remoteChanged = divergedSince(remote, shadow);
  if (localChanged && remoteChanged) {
    if (local.tombstone && remote.tombstone) return 'delete-vs-delete';
    if (local.tombstone || remote.tombstone) return 'delete-vs-edit';
    return 'concurrent-edit';
  }
  if (localChanged) return 'only-local-changed';
  if (remoteChanged) return 'only-remote-changed';
  // Neither side is a change since the shadow (stale echoes) — nothing displaced.
  return 'same-change';
}
