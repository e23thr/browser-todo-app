/**
 * Per-record payload sealing (ADR-007 Decision 1) — AES-GCM-256 via WebCrypto
 * `subtle`, 96-bit random IV per encryption (fresh on every re-encrypt), 128-bit
 * tag (WebCrypto default), identity-bound AAD.
 *
 * AAD (Decision 1.2, normative): `UTF-8("todo-enc/1|<kind>|<id>")` — timestamps
 * are deliberately NOT bound so tombstoning/stamping works while locked.
 *
 * No hand-rolled primitives: `subtle.encrypt/decrypt` and `subtle.digest` only.
 */

import { fromBase64, toBase64, toBufferSource, utf8 } from './bytes';
import { cryptoErr, cryptoOk } from './errors';
import type { CryptoResult } from './errors';
import { sha256OfUtf8 } from '../sync/hash';
import type { EncEnvelope } from '../domain/model';

export type { EncEnvelope };

export const ENC_ALG = 'AES-GCM';
export const ENC_V = 1;

function subtle(): SubtleCrypto {
  const api = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (api === undefined) throw new Error('WebCrypto subtle API is unavailable');
  return api;
}

/** `todo-enc/1|<kind>|<id>` — the record-identity AAD (Decision 1.2). */
export function aadFor(kind: 'task' | 'list', id: string): Uint8Array {
  return utf8(`todo-enc/1|${kind}|${id}`);
}

/** `todo-enc/1|snapshot|<snapshotId>` — snapshot payload AAD (Decision 4.4). */
export function aadForSnapshot(snapshotId: string): Uint8Array {
  return utf8(`todo-enc/1|snapshot|${snapshotId}`);
}

/** `todo-enc/1|wrap|<keyId>|<passphrase|recovery>` — slot-bound wrap AAD (Decision 2.1). */
export function wrapAad(keyId: string, slot: 'passphrase' | 'recovery'): Uint8Array {
  return utf8(`todo-enc/1|wrap|${keyId}|${slot}`);
}

/**
 * SHA-256 (lowercase hex) over the exact UTF-8 bytes of the `payload` string —
 * the ADR-006 Decision 10 `payloadHash` wire field. NOT a MAC: it is change
 * detection for the shadow test, not an integrity control (Decision 1.2).
 */
export function payloadHashOf(payload: string): Promise<string> {
  return sha256OfUtf8(payload);
}

/** AES-GCM encrypt of a JSON string. `iv` is test-only pinning; production draws fresh randomness. */
export async function seal(
  key: CryptoKey,
  aad: Uint8Array,
  json: string,
  iv?: Uint8Array,
): Promise<{ iv: string; ct: string }> {
  const nonce = iv ?? crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle().encrypt(
    {
      name: ENC_ALG,
      iv: toBufferSource(nonce),
      additionalData: toBufferSource(aad),
      tagLength: 128,
    },
    key,
    toBufferSource(utf8(json)),
  );
  return { iv: toBase64(nonce), ct: toBase64(new Uint8Array(ct)) };
}

/** AES-GCM decrypt; `DECRYPT_FAILED` on tag failure (never throws, never guesses). */
export async function open(
  key: CryptoKey,
  aad: Uint8Array,
  iv: string,
  ct: string,
): Promise<CryptoResult<string>> {
  const nonce = fromBase64(iv);
  const bytes = fromBase64(ct);
  if (nonce === null || bytes === null || nonce.length !== 12) {
    return cryptoErr('CORRUPT_KEY', 'ciphertext envelope is malformed');
  }
  try {
    const plain = await subtle().decrypt(
      {
        name: ENC_ALG,
        iv: toBufferSource(nonce),
        additionalData: toBufferSource(aad),
        tagLength: 128,
      },
      key,
      toBufferSource(bytes),
    );
    return cryptoOk(new TextDecoder().decode(plain));
  } catch {
    return cryptoErr('DECRYPT_FAILED', 'authentication failed — wrong key or tampered ciphertext');
  }
}

/** One sealed payload: `payload` (base64 ct+tag), `enc` envelope, `payloadHash`. */
export type SealedPayload = { enc: EncEnvelope; payload: string; payloadHash: string };

export async function sealPayload(
  key: CryptoKey,
  kind: 'task' | 'list',
  id: string,
  payload: unknown,
  iv?: Uint8Array,
): Promise<SealedPayload> {
  const { iv: ivB64, ct } = await seal(key, aadFor(kind, id), JSON.stringify(payload), iv);
  return {
    enc: { alg: ENC_ALG, v: ENC_V, iv: ivB64 },
    payload: ct,
    payloadHash: await payloadHashOf(ct),
  };
}

export async function openPayload<T>(
  key: CryptoKey,
  kind: 'task' | 'list',
  id: string,
  enc: EncEnvelope,
  payload: string,
): Promise<CryptoResult<T>> {
  // Runtime validation of untrusted on-wire data — the static type says
  // AES-GCM/v1 but the row comes from IndexedDB / the remote.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (enc.alg !== ENC_ALG || enc.v !== ENC_V) {
    return cryptoErr('NEWER_ENVELOPE', `unsupported payload envelope ${enc.alg}/v${String(enc.v)}`);
  }
  const opened = await open(key, aadFor(kind, id), enc.iv, payload);
  if (!opened.ok) return opened;
  try {
    return cryptoOk(JSON.parse(opened.value) as T);
  } catch {
    return cryptoErr('DECRYPT_FAILED', 'decrypted payload is not valid JSON');
  }
}
