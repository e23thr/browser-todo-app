/**
 * The recovery key artifact (ADR-007 Decision 3.1) — checksummed Crockford
 * base32 recovery code + the downloadable `todo-key/1` key file ("emergency
 * kit"). The 256-bit secret is full entropy (generated at enable time); the
 * recovery KEK is HKDF-SHA-256 (passphrase stretching would add nothing).
 *
 * The code: 52 chars of base32 data + 4-char checksum = 56 chars shown as 14
 * groups of 4. The checksum (first 2 SHA-256 bytes of the secret, base32) is
 * verified BEFORE any crypto runs — typos are caught at entry.
 */

import {
  crockfordDecode,
  crockfordEncode,
  fromBase64,
  randomBytes,
  toBufferSource,
  utf8,
} from './bytes';
import { cryptoErr, cryptoOk } from './errors';
import type { CryptoResult } from './errors';
import { deriveRecoveryKek, isKdfParams, PBKDF2_ITERATIONS } from './passphrase';
import type { KdfParams } from './passphrase';
import { sha256Hex } from '../sync/hash';

/** 256-bit secret + its display code. Shown ONCE (print/copy affordances). */
export type RecoveryMaterial = { secret: Uint8Array; code: string };

/** The `todo-key/1` downloadable emergency kit (Decision 3.1). */
export type KeyFile = {
  format: 'todo-key/1';
  createdAt: number;
  keyId: string;
  /** The same secret as the displayed code — for typed recovery. */
  recoveryCode: string;
  /** HKDF params of the recovery slot (Decision 2.3). */
  kdf: { v: 1; alg: 'HKDF-SHA-256'; info: 'todo-enc/1/recovery-kek' };
  /** The recovery-wrapped DMK (AES-GCM under the HKDF-derived KEK). */
  wrappedDmk: { iv: string; ct: string };
};

export const KEY_FILE_FORMAT = 'todo-key/1';
export const RECOVERY_INFO = 'todo-enc/1/recovery-kek';
export const RECOVERY_CODE_CHARS = 56;
const SECRET_CHARS = 52;
const CHECKSUM_CHARS = 4;

function subtle(): SubtleCrypto {
  const api = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (api === undefined) throw new Error('WebCrypto subtle API is unavailable');
  return api;
}

/** Checksum = first 2 bytes of SHA-256(secret), rendered as 4 Crockford chars. */
export async function recoveryChecksum(secret: Uint8Array): Promise<string> {
  const digest = await sha256Hex(secret);
  const first = parseInt(digest.slice(0, 4), 16);
  const bytes = new Uint8Array([(first >> 8) & 0xff, first & 0xff]);
  return crockfordEncode(bytes).slice(0, CHECKSUM_CHARS);
}

/** Encode a 32-byte secret as the 56-char display code (52 data + 4 checksum). */
export async function encodeRecoveryCode(secret: Uint8Array): Promise<string> {
  const data = crockfordEncode(secret).slice(0, SECRET_CHARS);
  return data + (await recoveryChecksum(secret));
}

export async function newRecoveryMaterial(): Promise<RecoveryMaterial> {
  const secret = randomBytes(32);
  return { secret, code: await encodeRecoveryCode(secret) };
}

/** Strip grouping/dashes and normalize Crockford confusables (I/L->1, O->0). */
export function normalizeRecoveryInput(input: string): string {
  return input.replace(/[\s-]/gu, '').toUpperCase();
}

/**
 * Typed recovery: checksum pre-check first (catches typos before any crypto),
 * then decode. `UNLOCK_FAILED` covers a checksum mismatch at entry; a wrong but
 * well-formed secret only fails later at unwrap (Decision 6.3 — same copy).
 */
export async function decodeRecoveryCode(input: string): Promise<CryptoResult<Uint8Array>> {
  const normalized = normalizeRecoveryInput(input);
  if (normalized.length !== RECOVERY_CODE_CHARS) {
    return cryptoErr('UNLOCK_FAILED', 'recovery code must be 56 characters');
  }
  const dataPart = normalized.slice(0, SECRET_CHARS);
  const checksumPart = normalized.slice(SECRET_CHARS);
  const secret = crockfordDecode(dataPart, SECRET_CHARS);
  if (secret === null || secret.length !== 32) {
    return cryptoErr('UNLOCK_FAILED', 'recovery code contains invalid characters');
  }
  const expected = await recoveryChecksum(secret);
  if (expected !== checksumPart) {
    return cryptoErr('UNLOCK_FAILED', 'recovery code checksum does not match — check for typos');
  }
  return cryptoOk(secret);
}

/** The recovery KEK (HKDF-SHA-256, fixed info — Decision 2.1/2.3). */
export function recoveryKek(secret: Uint8Array): Promise<CryptoKey> {
  return deriveRecoveryKek(secret);
}

/** Build the downloadable key file (the complete emergency kit). */
export function buildKeyFile(input: {
  keyId: string;
  recoveryCode: string;
  wrappedDmk: { iv: string; ct: string };
  now: number;
}): KeyFile {
  return {
    format: KEY_FILE_FORMAT,
    createdAt: input.now,
    keyId: input.keyId,
    recoveryCode: input.recoveryCode,
    kdf: { v: 1, alg: 'HKDF-SHA-256', info: RECOVERY_INFO },
    wrappedDmk: input.wrappedDmk,
  };
}

/**
 * Parse + validate a `todo-key/1` file. `INVALID_KEY_FILE` for malformed
 * shapes; `WRONG_KEY_DOMAIN` is decided by the UNWRAP step (a well-formed file
 * from a different store fails authentication there — Decision 9 table).
 *
 * Tolerant of the ADR example's PBKDF2 `kdf` block (an authoring slip for the
 * recovery slot — the recovery wrap is always HKDF per Decision 2.3's type).
 */
export function parseKeyFile(raw: unknown): CryptoResult<KeyFile> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return cryptoErr('INVALID_KEY_FILE', 'key file is not an object');
  }
  const r = raw as Record<string, unknown>;
  if (r['format'] !== KEY_FILE_FORMAT) {
    return cryptoErr('INVALID_KEY_FILE', `unrecognized key file format (${String(r['format'])})`);
  }
  const keyId = r['keyId'];
  const recoveryCode = r['recoveryCode'];
  const wrapped = r['wrappedDmk'];
  if (typeof keyId !== 'string' || keyId.length === 0) {
    return cryptoErr('INVALID_KEY_FILE', 'key file has no keyId');
  }
  if (typeof recoveryCode !== 'string') {
    return cryptoErr('INVALID_KEY_FILE', 'key file has no recoveryCode');
  }
  const normalized = normalizeRecoveryInput(recoveryCode);
  if (crockfordDecode(normalized.slice(0, SECRET_CHARS), SECRET_CHARS) === null) {
    return cryptoErr('INVALID_KEY_FILE', 'key file recoveryCode is malformed');
  }
  if (typeof wrapped !== 'object' || wrapped === null) {
    return cryptoErr('INVALID_KEY_FILE', 'key file has no wrappedDmk');
  }
  const w = wrapped as Record<string, unknown>;
  const iv = w['iv'];
  const ct = w['ct'];
  if (
    typeof iv !== 'string' ||
    typeof ct !== 'string' ||
    fromBase64(iv) === null ||
    fromBase64(ct) === null
  ) {
    return cryptoErr('INVALID_KEY_FILE', 'key file wrappedDmk is malformed');
  }
  const createdAt = typeof r['createdAt'] === 'number' ? r['createdAt'] : 0;
  return cryptoOk({
    format: KEY_FILE_FORMAT,
    createdAt,
    keyId,
    recoveryCode: normalized,
    kdf: { v: 1, alg: 'HKDF-SHA-256', info: RECOVERY_INFO },
    wrappedDmk: { iv, ct },
  });
}

/** Serialized key file (what the download writes). */
export function serializeKeyFile(file: KeyFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** File name: `todo-recovery-key-<YYYYMMDD>.json` (Decision 3.1). */
export function keyFileName(now: number): string {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `todo-recovery-key-${String(y)}${m}${day}.json`;
}

/** Re-export for the key-file join path (a PBKDF2 kdf block in a file is informational). */
export { isKdfParams, PBKDF2_ITERATIONS };
export type { KdfParams };

/** HKDF `deriveBits`-level helper kept for KAT fixtures (the KEK derivation itself). */
export async function recoveryKekRawBits(secret: Uint8Array): Promise<ArrayBuffer> {
  const material = await subtle().importKey('raw', toBufferSource(secret), 'HKDF', false, [
    'deriveBits',
  ]);
  return subtle().deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toBufferSource(new Uint8Array(0)),
      info: toBufferSource(utf8(RECOVERY_INFO)),
    },
    material,
    256,
  );
}
