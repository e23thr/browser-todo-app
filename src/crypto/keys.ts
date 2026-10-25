/**
 * Key hierarchy (ADR-007 Decision 2): one random 256-bit DMK per store,
 * envelope-wrapped by credential slots. Consequences (the point of the
 * envelope): a passphrase change re-wraps ONE 32-byte key — zero record
 * re-encryption, zero sync traffic — and multiple credentials (passphrase +
 * recovery) can open the same data.
 *
 * WebCrypto discipline (Decision 5.1): raw DMK bytes exist only inside WebCrypto
 * during generation/wrap; app code NEVER calls `exportKey`. Session keys are
 * non-extractable (re-unwrapped from a fresh wrap right after generation).
 * Wrap/unwrap go through `subtle.wrapKey/unwrapKey` only.
 */

import { fromBase64, randomBytes, toBase64, toBufferSource } from './bytes';
import { cryptoErr, cryptoOk } from './errors';
import type { CryptoResult } from './errors';
import { deriveKek, newKdfParams, PBKDF2_ITERATIONS } from './passphrase';
import { recoveryKek } from './recovery';
import { wrapAad } from './payload';
import type { KeyEntry, KeySlot, PassphraseSlot, RecoverySlot } from '../storage/types';

/** The persisted key-material shapes are canonically `src/storage/types.ts` (ADR-002 rows). */
export type { KeyEntry, KeySlot, PassphraseSlot, RecoverySlot };

export type Wrap = { iv: string; ct: string };

function subtle(): SubtleCrypto {
  const api = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (api === undefined) throw new Error('WebCrypto subtle API is unavailable');
  return api;
}

const DMK_IMPORT = { name: 'AES-GCM', length: 256 } as const;

function isWrap(v: unknown): v is Wrap {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r['iv'] === 'string' && typeof r['ct'] === 'string';
}

export function isKeySlot(v: unknown): v is KeySlot {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  if (r['kind'] === 'passphrase') {
    return typeof r['createdAt'] === 'number' && isWrap(r['wrap']);
  }
  if (r['kind'] === 'recovery') {
    return typeof r['createdAt'] === 'number' && isWrap(r['wrap']);
  }
  return false;
}

export function isKeyEntry(v: unknown): v is KeyEntry {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['keyId'] === 'string' &&
    typeof r['createdAt'] === 'number' &&
    Array.isArray(r['slots']) &&
    r['slots'].every(isKeySlot)
  );
}

/** Wrap the DMK under a KEK, bound to `(keyId, slot kind)` by the wrap AAD. */
export async function wrapDmk(
  dmk: CryptoKey,
  keyId: string,
  kek: CryptoKey,
  slot: 'passphrase' | 'recovery',
  iv?: Uint8Array,
): Promise<Wrap> {
  const nonce = iv ?? randomBytes(12);
  const ct = await subtle().wrapKey('raw', dmk, kek, {
    name: 'AES-GCM',
    iv: toBufferSource(nonce),
    additionalData: toBufferSource(wrapAad(keyId, slot)),
    tagLength: 128,
  });
  return { iv: toBase64(nonce), ct: toBase64(new Uint8Array(ct)) };
}

/** Unwrap the DMK. `extractable` is true for session keys — Decision 5.1's
 * "non-extractable where wrapping allows": the re-wrap flows (passphrase change,
 * recovery issuance, device join) MUST `wrapKey` the DMK, which requires an
 * extractable key. App code still never calls `exportKey` — raw bytes leave
 * WebCrypto only through `wrapKey`. */
export async function unwrapDmk(
  wrap: Wrap,
  keyId: string,
  kek: CryptoKey,
  slot: 'passphrase' | 'recovery',
  extractable = true,
): Promise<CryptoResult<CryptoKey>> {
  const ct = fromBase64(wrap.ct);
  const iv = fromBase64(wrap.iv);
  if (ct === null || iv === null || iv.length !== 12) {
    return cryptoErr('CORRUPT_KEY', 'wrapped key bytes are malformed');
  }
  try {
    const key = await subtle().unwrapKey(
      'raw',
      toBufferSource(ct),
      kek,
      {
        name: 'AES-GCM',
        iv: toBufferSource(iv),
        additionalData: toBufferSource(wrapAad(keyId, slot)),
        tagLength: 128,
      },
      DMK_IMPORT,
      extractable,
      ['encrypt', 'decrypt'],
    );
    return cryptoOk(key);
  } catch {
    return cryptoErr('WRONG_KEY_DOMAIN', 'this key does not open this data');
  }
}

/**
 * Mint a fresh DMK + its first entry. The session key is re-unwrapped from the
 * just-made wrap so the in-memory key is NON-EXTRACTABLE (Decision 5.1).
 */
export async function mintKeyEntry(input: {
  keyId: string;
  passphrase: string;
  recoverySecret?: Uint8Array;
  now: number;
  iters?: number;
}): Promise<CryptoResult<{ entry: KeyEntry; dmk: CryptoKey; recoveryWrap: Wrap | null }>> {
  const generated = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
    'wrapKey',
    'unwrapKey',
  ]);
  const kdf = newKdfParams(input.iters ?? PBKDF2_ITERATIONS);
  const passKek = await deriveKek(input.passphrase, kdf);
  const passWrap = await wrapDmk(generated, input.keyId, passKek, 'passphrase');

  let recoveryWrap: Wrap | null = null;
  let recoverySlot: RecoverySlot | null = null;
  if (input.recoverySecret !== undefined) {
    const recKek = await recoveryKek(input.recoverySecret);
    recoveryWrap = await wrapDmk(generated, input.keyId, recKek, 'recovery');
    recoverySlot = {
      kind: 'recovery',
      kdf: { v: 1, alg: 'HKDF-SHA-256', info: 'todo-enc/1/recovery-kek' },
      wrap: recoveryWrap,
      createdAt: input.now,
    };
  }

  const passphraseSlot: PassphraseSlot = {
    kind: 'passphrase',
    kdf,
    wrap: passWrap,
    createdAt: input.now,
  };
  const entry: KeyEntry = {
    keyId: input.keyId,
    slots: recoverySlot === null ? [passphraseSlot] : [passphraseSlot, recoverySlot],
    createdAt: input.now,
  };

  // Re-unwrap through the fresh wrap -> the session key the vault holds (an
  // extractable key — `wrapKey` for re-wrap flows requires it; `exportKey` is
  // never called, Decision 5.1/5.3).
  const session = await unwrapDmk(passWrap, input.keyId, passKek, 'passphrase');
  if (!session.ok) return session;
  return cryptoOk({ entry, dmk: session.value, recoveryWrap });
}

export type UnlockedEntry = {
  keyId: string;
  dmk: CryptoKey;
  /** Set when the passphrase slot was lazily re-wrapped at the current floor. */
  upgradedSlot: PassphraseSlot | null;
};

/** Unlock one entry with a passphrase (tries its passphrase slot only). */
export async function unlockEntryWithPassphrase(
  entry: KeyEntry,
  passphrase: string,
  options: { now: number; floorIters?: number },
): Promise<CryptoResult<UnlockedEntry>> {
  const slot = entry.slots.find((s): s is PassphraseSlot => s.kind === 'passphrase');
  if (slot === undefined) {
    return cryptoErr('CORRUPT_KEY', 'key entry has no passphrase slot');
  }
  const kek = await deriveKek(passphrase, slot.kdf);
  const opened = await unwrapDmk(slot.wrap, entry.keyId, kek, 'passphrase', true);
  if (!opened.ok) {
    return cryptoErr('UNLOCK_FAILED', 'wrong passphrase');
  }
  const floor = options.floorIters ?? PBKDF2_ITERATIONS;
  // Lazy upgrade (Decision 2.2): derive at the old count (done), re-wrap at the
  // floor. One extra write; no record touched. Stored params ABOVE the floor
  // are honored (never silently downgrade).
  if (slot.kdf.iters < floor) {
    const fresh = newKdfParams(floor);
    const freshKek = await deriveKek(passphrase, fresh);
    const rewrap = await wrapDmk(opened.value, entry.keyId, freshKek, 'passphrase');
    const session = await unwrapDmk(rewrap, entry.keyId, freshKek, 'passphrase');
    if (!session.ok) return session;
    return cryptoOk({
      keyId: entry.keyId,
      dmk: session.value,
      upgradedSlot: { kind: 'passphrase', kdf: fresh, wrap: rewrap, createdAt: options.now },
    });
  }
  const session = await unwrapDmk(slot.wrap, entry.keyId, kek, 'passphrase');
  if (!session.ok) return session;
  return cryptoOk({ keyId: entry.keyId, dmk: session.value, upgradedSlot: null });
}

/** Unlock one entry with the recovery secret (Decision 3.1). */
export async function unlockEntryWithRecovery(
  entry: KeyEntry,
  secret: Uint8Array,
): Promise<CryptoResult<UnlockedEntry>> {
  const slot = entry.slots.find((s): s is RecoverySlot => s.kind === 'recovery');
  if (slot === undefined) {
    return cryptoErr('WRONG_KEY_DOMAIN', 'this key has no recovery slot');
  }
  const kek = await recoveryKek(secret);
  const opened = await unwrapDmk(slot.wrap, entry.keyId, kek, 'recovery');
  if (!opened.ok) return opened;
  return cryptoOk({ keyId: entry.keyId, dmk: opened.value, upgradedSlot: null });
}

/** Try the whole ring in order (mixed-key stores — Decision 2.3/3.3). */
export async function unlockRingWithPassphrase(
  entries: readonly KeyEntry[],
  passphrase: string,
  options: { now: number; floorIters?: number },
): Promise<CryptoResult<UnlockedEntry[]>> {
  const out: UnlockedEntry[] = [];
  let sawPassphraseSlot = false;
  for (const entry of entries) {
    if (!entry.slots.some((s) => s.kind === 'passphrase')) continue;
    sawPassphraseSlot = true;
    const unlocked = await unlockEntryWithPassphrase(entry, passphrase, options);
    if (unlocked.ok) out.push(unlocked.value);
  }
  if (out.length > 0) return cryptoOk(out);
  return cryptoErr(
    'UNLOCK_FAILED',
    sawPassphraseSlot ? 'wrong passphrase' : 'no passphrase slot in the key ring',
  );
}

/**
 * Re-key (Decision 2 consequences): a passphrase change re-wraps the DMK under
 * a new slot — zero record re-encryption, zero sync traffic. Returns the new
 * entry (recovery slot carried over unchanged).
 */
export async function rewrapEntryWithPassphrase(
  dmk: CryptoKey,
  entry: KeyEntry,
  newPassphrase: string,
  now: number,
  iters: number = PBKDF2_ITERATIONS,
): Promise<CryptoResult<KeyEntry>> {
  const kdf = newKdfParams(iters);
  const kek = await deriveKek(newPassphrase, kdf);
  const wrap = await wrapDmk(dmk, entry.keyId, kek, 'passphrase');
  const slot: PassphraseSlot = { kind: 'passphrase', kdf, wrap, createdAt: now };
  const kept = entry.slots.filter((s) => s.kind === 'recovery');
  return cryptoOk({ ...entry, slots: [slot, ...kept] });
}

/** Issue a recovery slot for an existing session key (post-enable offer). */
export async function addRecoverySlot(
  dmk: CryptoKey,
  entry: KeyEntry,
  secret: Uint8Array,
  now: number,
): Promise<CryptoResult<{ entry: KeyEntry; wrap: Wrap }>> {
  const kek = await recoveryKek(secret);
  const wrap = await wrapDmk(dmk, entry.keyId, kek, 'recovery');
  const slot: RecoverySlot = {
    kind: 'recovery',
    kdf: { v: 1, alg: 'HKDF-SHA-256', info: 'todo-enc/1/recovery-kek' },
    wrap,
    createdAt: now,
  };
  const slots = [...entry.slots.filter((s) => s.kind !== 'recovery'), slot];
  return cryptoOk({ entry: { ...entry, slots }, wrap });
}
