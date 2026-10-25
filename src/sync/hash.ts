/**
 * SHA-256 via WebCrypto `subtle.digest` (ADR-006 Decision 1 — zero new deps,
 * no hand-rolled primitives). Used for artifact integrity (`recordsHash` /
 * `stateHash` over exact string bytes) and the shadow's `contentHash`.
 */

import type { RowLike } from '../domain/model';

function subtle(): SubtleCrypto {
  // Some embedded hosts lack WebCrypto; typed as optional so the guard is real.
  const api = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (api === undefined) throw new Error('WebCrypto subtle API is unavailable');
  return api;
}

/** Lowercase hex SHA-256 over exact bytes. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await subtle().digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 over the exact UTF-8 bytes of a string (the wire hash contract). */
export async function sha256OfUtf8(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}

/**
 * Deterministic JSON: object keys sorted, arrays kept in order. Needed because
 * `contentHash` must agree across devices regardless of field order in transit.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const text = JSON.stringify(value) as string | undefined;
    return text ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec)
    .filter((k) => rec[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(',')}}`;
}

/**
 * The shadow's `contentHash` (ADR-006 Decision 4.2): a hash of the record's
 * content EXCLUDING `updatedAt`/`deviceId` (the LWW key) — so two versions with
 * identical content but different stamps demote to "Same change". `deletedAt` IS
 * included: tombstoning is a content change for the three-way test.
 *
 * Encrypted rows (ADR-007 Decision 8.1): the same computation over the AT-REST
 * row — `payloadHash` is the content stand-in (no decrypted content is ever
 * compared; identical-edit detection degrades exactly as Decision 8.5 records),
 * and `deletedAt` staying in the hash is what keeps tombstoning-while-locked a
 * content change for the three-way test.
 */
export async function contentHashOf(record: RowLike): Promise<string> {
  const content: Record<string, unknown> = { ...(record as unknown as Record<string, unknown>) };
  delete content['updatedAt'];
  delete content['deviceId'];
  return sha256OfUtf8(stableStringify(content));
}
