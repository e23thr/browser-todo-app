/**
 * Passphrase slot KDF (ADR-007 Decision 2.2) — PBKDF2-HMAC-SHA-256, 600,000
 * iterations (OWASP 2023), 16-byte random salt per slot, 256-bit AES-GCM KEK.
 *
 * Parameters are NORMATIVE (ADR-007 "Contracts" §1): changing them is an ADR
 * revision, never a code-side tuning knob. Per-slot `kdf` params are stored so
 * old slots keep unlocking after the floor rises (lazy re-wrap on unlock).
 *
 * Argon2id is explicitly REJECTED (§9.2: 0 WASM) — recorded in the ADR as an
 * accepted trade-off.
 */

import { fromBase64, randomBytes, toBase64, toBufferSource, utf8 } from './bytes';
import { cryptoErr, cryptoOk } from './errors';
import type { CryptoResult } from './errors';

export const PBKDF2_ALG = 'PBKDF2-HMAC-SHA-256';
/** The current floor. Stored params above it are honored; below it triggers a lazy re-wrap. */
export const PBKDF2_ITERATIONS = 600_000;
export const SALT_BYTES = 16;
/** §7.3 / Decision 6.1 step 3: min 12 characters (length over composition). */
export const MIN_PASSPHRASE_LENGTH = 12;

export type KdfParams = {
  v: 1;
  alg: typeof PBKDF2_ALG;
  iters: number;
  /** base64, 16 random bytes (salts are public — stored with the slot). */
  salt: string;
};

function subtle(): SubtleCrypto {
  const api = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (api === undefined) throw new Error('WebCrypto subtle API is unavailable');
  return api;
}

export function isKdfParams(v: unknown): v is KdfParams {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    r['v'] === 1 &&
    r['alg'] === PBKDF2_ALG &&
    typeof r['iters'] === 'number' &&
    Number.isInteger(r['iters']) &&
    r['iters'] >= 1 &&
    typeof r['salt'] === 'string' &&
    fromBase64(r['salt']) !== null
  );
}

/** Fresh per-slot params at the current floor. */
export function newKdfParams(iters: number = PBKDF2_ITERATIONS): KdfParams {
  return { v: 1, alg: PBKDF2_ALG, iters, salt: toBase64(randomBytes(SALT_BYTES)) };
}

/** Derive the 256-bit AES-GCM KEK from a passphrase (non-extractable). */
export async function deriveKek(passphrase: string, kdf: KdfParams): Promise<CryptoKey> {
  const salt = fromBase64(kdf.salt);
  if (salt === null) throw new Error('kdf salt is not valid base64');
  const material = await subtle().importKey(
    'raw',
    toBufferSource(utf8(passphrase)),
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey'],
  );
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: toBufferSource(salt), iterations: kdf.iters },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
  );
}

/**
 * Full-entropy secret -> 256-bit AES-GCM KEK via HKDF-SHA-256 (Decision 2.1:
 * stretching would add nothing — the secret is 256 random bits).
 */
export async function deriveRecoveryKek(secret: Uint8Array): Promise<CryptoKey> {
  const material = await subtle().importKey('raw', toBufferSource(secret), 'HKDF', false, [
    'deriveBits',
    'deriveKey',
  ]);
  return subtle().deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toBufferSource(new Uint8Array(0)),
      info: toBufferSource(utf8('todo-enc/1/recovery-kek')),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
  );
}

/** Decision 6.1 step 3 — enforceable part of the passphrase policy. */
export function passphraseIssue(passphrase: string): string | null {
  return passphrase.length >= MIN_PASSPHRASE_LENGTH
    ? null
    : `passphrase must be at least ${String(MIN_PASSPHRASE_LENGTH)} characters`;
}

export type Strength = 'weak' | 'fair' | 'strong';

/**
 * Advisory strength hint (Decision 6.1 step 3): zero-dep length/charset
 * estimate. Clearly advisory — never a gate beyond the 12-char minimum.
 */
export function strengthHint(passphrase: string): Strength {
  const classes =
    (/[a-z]/u.test(passphrase) ? 1 : 0) +
    (/[A-Z]/u.test(passphrase) ? 1 : 0) +
    (/[0-9]/u.test(passphrase) ? 1 : 0) +
    (/[^A-Za-z0-9]/u.test(passphrase) ? 1 : 0);
  const long = passphrase.length >= 20;
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) return 'weak';
  if (long && classes >= 2) return 'strong';
  if (passphrase.length >= 16 || classes >= 3) return 'fair';
  return 'weak';
}

/** Validate + derive in one step (the unlock path — policy is enable-time only). */
export async function deriveKekChecked(
  passphrase: string,
  kdf: KdfParams,
): Promise<CryptoResult<CryptoKey>> {
  // Unlock must accept anything that CAN decrypt — including short legacy
  // passphrases (the 12-char minimum is an enable-time rule, not an unlock rule).
  return cryptoOk(await deriveKek(passphrase, kdf));
}

/** Enable-flow policy rejection (Decision 6.1 step 3). */
export function rejectWeakPassphrase(passphrase: string): CryptoResult<null> {
  const issue = passphraseIssue(passphrase);
  return issue === null ? cryptoOk(null) : cryptoErr('POLICY', issue);
}
