/**
 * Per-record LWW + conflict-copy naming (ADR-003 Decision "LWW"; §6.2 policy is
 * PRE-DECIDED and recorded verbatim — never re-designed here): for two versions
 * of one record, the winner is the one with the greater `updatedAt`; if equal,
 * the greater `deviceId` (lexicographic). Deterministic under either argument
 * order. These are the primitives M11 import and ADR-006 sync call.
 */

export type LwwStamp = {
  updatedAt: number;
  deviceId: string;
};

/**
 * Sort-style comparator over the LWW order: `> 0` when `a` wins,
 * `< 0` when `b` wins, `0` when both are the same version.
 * Antisymmetric: `compareLww(a, b) === -compareLww(b, a)`.
 */
export function compareLww(a: LwwStamp, b: LwwStamp): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? 1 : -1;
  if (a.deviceId === b.deviceId) return 0;
  return a.deviceId > b.deviceId ? 1 : -1;
}

export const CONFLICT_COPY_PREFIX = 'Conflict copy of ';

/** ADR-002 Decision 5 / ADR-006: the losing version's visible row title, capped at 1000 chars. */
export function conflictCopyTitle(title: string): string {
  const full = `${CONFLICT_COPY_PREFIX}${title}`;
  return full.length <= 1000 ? full : full.slice(0, 1000);
}
