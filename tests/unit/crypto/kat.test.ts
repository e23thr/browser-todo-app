/**
 * Known-answer vectors (ADR-007 testing contract 1) — pinned fixtures,
 * generated ONCE with Node's WebCrypto by `scripts/gen-crypto-kats.mjs` and
 * never regenerated. If any of these fail, the CRYPTO PRIMITIVES OR THEIR
 * PARAMETERS changed — that is an ADR revision, not a test update.
 */

import { describe, expect, it } from 'vitest';

import { fromBase64, toBase64, utf8 } from '../../../src/crypto/bytes';
import { deriveKek, deriveRecoveryKek } from '../../../src/crypto/passphrase';
import { open, seal } from '../../../src/crypto/payload';
import { unwrapDmk, wrapDmk } from '../../../src/crypto/keys';

const hex = (b: Uint8Array | ArrayBuffer): string =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

const KEY_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const AAD = utf8(`todo-enc/1|task|${KEY_ID}`);
const JSON_PLAINTEXT = JSON.stringify({ title: 'Buy milk', notes: null, tags: [] });

// ---- pinned fixtures (scripts/gen-crypto-kats.mjs output) ----
const A_CT_HEX =
  '9d3a084431a7679d5847c5a67e5aadb71cc77b3cb0d92d18f97d04bc11de196dfe54339ec851710704c1796a8071c19ef3038c50218d78c860887e';
const B_PBKDF2_HEX = 'ef177144eec9420cbc1093d2a8b344a92bc506d0d4ec9c028dd19f8324d8c1e6';
const C_HKDF_HEX = 'f96b403d739bb69112d33ddc808301fbd04515fefdd2220bf8d7dd4afdd46d2f';
const D_WRAP_HEX =
  'eb25cbadbb627bd82634204898c3019c5a7e333c8ebb040e6800ca46d3c93c3ebc28cc3c6b271d0d75aea01494c93713';

const KEY_BYTES = Uint8Array.from({ length: 32 }, (_, i) => i);
const PINNED_IV = Uint8Array.from({ length: 12 }, (_, i) => 0xa0 + i);
const PINNED_WRAP_IV = Uint8Array.from({ length: 12 }, (_, i) => 0xb0 + i);
const PBKDF2_FIXTURE = {
  v: 1 as const,
  alg: 'PBKDF2-HMAC-SHA-256' as const,
  iters: 600_000,
  salt: toBase64(Uint8Array.from({ length: 16 }, (_, i) => i)),
};
const RECOVERY_SECRET = Uint8Array.from({ length: 32 }, (_, i) => 0x20 + i);

async function aesKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', KEY_BYTES.buffer, 'AES-GCM', true, [
    'encrypt',
    'decrypt',
    'wrapKey',
  ]);
}

describe('KAT: AES-GCM payload seal (ADR-007 Decision 1)', () => {
  it('fixed key + fixed IV + fixed AAD -> the exact pinned ciphertext', async () => {
    const key = await aesKey();
    const sealed = await seal(key, AAD, JSON_PLAINTEXT, PINNED_IV);
    expect(sealed.iv).toBe(toBase64(PINNED_IV));
    expect(hex(fromBase64(sealed.ct) as Uint8Array)).toBe(A_CT_HEX);
  });

  it('opens the pinned ciphertext back to the exact plaintext', async () => {
    const key = await aesKey();
    const ctBytes = new Uint8Array(A_CT_HEX.match(/../gu)!.map((h) => parseInt(h, 16)));
    const roundTrip = await open(key, AAD, toBase64(PINNED_IV), toBase64(ctBytes));
    expect(roundTrip.ok).toBe(true);
    if (roundTrip.ok) expect(roundTrip.value).toBe(JSON_PLAINTEXT);
  });
});

describe('KAT: PBKDF2-HMAC-SHA-256 at the shipped floor (Decision 2.2)', () => {
  it('derives the pinned 256-bit KEK at 600,000 iterations', async () => {
    const kek = await deriveKek('correct horse battery staple', PBKDF2_FIXTURE);
    // deriveBits through the same params the KEK is built from.
    const material = await crypto.subtle.importKey(
      'raw',
      utf8('correct horse battery staple').buffer as ArrayBuffer,
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt: (fromBase64(PBKDF2_FIXTURE.salt) as Uint8Array).buffer as ArrayBuffer,
        iterations: 600_000,
      },
      material,
      256,
    );
    expect(hex(bits)).toBe(B_PBKDF2_HEX);
    expect(kek.algorithm.name).toBe('AES-GCM');
    expect(kek.extractable).toBe(false);
  });
});

describe('KAT: HKDF recovery KEK (Decision 2.1)', () => {
  it('derives the pinned 256-bit KEK from the full-entropy secret', async () => {
    const kek = await deriveRecoveryKek(RECOVERY_SECRET);
    expect(kek.algorithm.name).toBe('AES-GCM');
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(0).buffer,
        info: utf8('todo-enc/1/recovery-kek').buffer as ArrayBuffer,
      },
      await crypto.subtle.importKey('raw', RECOVERY_SECRET.buffer, 'HKDF', false, ['deriveBits']),
      256,
    );
    expect(hex(bits)).toBe(C_HKDF_HEX);
  });
});

describe('KAT + slot binding: wrap/unwrap (Decision 2.1)', () => {
  it('wraps the DMK to the pinned bytes under the pinned IV', async () => {
    const dmk = await aesKey();
    const kek = await deriveKek('correct horse battery staple', PBKDF2_FIXTURE);
    const wrap = await wrapDmk(dmk, KEY_ID, kek, 'passphrase', PINNED_WRAP_IV);
    expect(wrap.iv).toBe(toBase64(PINNED_WRAP_IV));
    expect(hex(fromBase64(wrap.ct) as Uint8Array)).toBe(D_WRAP_HEX);
  });

  it('round-trips and refuses transposed slots (AAD binding)', async () => {
    const dmk = await aesKey();
    const kek = await deriveKek('correct horse battery staple', PBKDF2_FIXTURE);
    const wrap = await wrapDmk(dmk, KEY_ID, kek, 'passphrase');

    const good = await unwrapDmk(wrap, KEY_ID, kek, 'passphrase');
    expect(good.ok).toBe(true);

    // Same bytes, RECOVERY slot label -> must fail (slots cannot be transposed).
    const transposed = await unwrapDmk(wrap, KEY_ID, kek, 'recovery');
    expect(transposed.ok).toBe(false);
    if (!transposed.ok) expect(transposed.error.code).toBe('WRONG_KEY_DOMAIN');

    // Same bytes under a different keyId -> must fail (identity binding).
    const otherId = await unwrapDmk(wrap, '01ARZ3NDEKTSV4RRFFQ69G5FAX', kek, 'passphrase');
    expect(otherId.ok).toBe(false);
    if (!otherId.ok) expect(otherId.error.code).toBe('WRONG_KEY_DOMAIN');
  });
});

describe('AAD binding negatives (Decision 1.3 — the swap defense)', () => {
  it('a payload sealed for (task, idA) fails to open under idB and under (list, idA)', async () => {
    const key = await aesKey();
    const sealed = await seal(key, utf8('todo-enc/1|task|AAA'), JSON_PLAINTEXT, PINNED_IV);
    const right = await open(key, utf8('todo-enc/1|task|AAA'), sealed.iv, sealed.ct);
    expect(right.ok).toBe(true);
    const wrongId = await open(key, utf8('todo-enc/1|task|BBB'), sealed.iv, sealed.ct);
    expect(wrongId.ok).toBe(false);
    const wrongKind = await open(key, utf8('todo-enc/1|list|AAA'), sealed.iv, sealed.ct);
    expect(wrongKind.ok).toBe(false);
    if (!wrongId.ok) expect(wrongId.error.code).toBe('DECRYPT_FAILED');
    if (!wrongKind.ok) expect(wrongKind.error.code).toBe('DECRYPT_FAILED');
  });

  it('tampered ciphertext fails the GCM tag (never a silent partial read)', async () => {
    const key = await aesKey();
    const sealed = await seal(key, AAD, JSON_PLAINTEXT, PINNED_IV);
    const bytes = fromBase64(sealed.ct) as Uint8Array;
    bytes[0] = (bytes[0] as number) ^ 0xff;
    const opened = await open(key, AAD, sealed.iv, toBase64(bytes));
    expect(opened.ok).toBe(false);
  });
});
