/**
 * Byte/encoding helpers for the C1 crypto module (ADR-007).
 *
 * ENCODING ONLY — this module contains no cryptography (PROJECT_ANALYSIS §7.2:
 * "no hand-rolled primitives" applies to cryptographic primitives; base64 /
 * base32 / hex codecs are byte plumbing). Every actual primitive (AES-GCM,
 * PBKDF2, HKDF, SHA-256, random) is WebCrypto `subtle` / `getRandomValues`.
 */

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP: number[] = (() => {
  const table = new Array<number>(256).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i += 1) table[B64_ALPHABET.charCodeAt(i)] = i;
  // URL-safe variants are accepted on decode (defensive interop).
  table['-'.charCodeAt(0)] = 62;
  table['_'.charCodeAt(0)] = 63;
  return table;
})();

/** Crockford base32 (no I/L/O/U) — the recovery-code alphabet (ADR-007 Decision 3.1). */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const C32_LOOKUP: number[] = (() => {
  const table = new Array<number>(256).fill(-1);
  for (let i = 0; i < CROCKFORD_ALPHABET.length; i += 1) {
    table[CROCKFORD_ALPHABET.charCodeAt(i)] = i;
  }
  // Crockford's canonical confusables: I/L -> 1, O -> 0. U is deliberately
  // excluded from the alphabet and never accepted (accidental obscenity).
  table['I'.charCodeAt(0)] = 1;
  table['L'.charCodeAt(0)] = 1;
  table['O'.charCodeAt(0)] = 0;
  return table;
})();

/** UTF-8 encode. */
export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * `ArrayBuffer` copy of a byte view — TS 6's `BufferSource` is invariant over
 * `Uint8Array<ArrayBufferLike>`, so WebCrypto calls take this (same workaround
 * as `src/sync/hash.ts`).
 */
export function toBufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** UTF-8 decode. */
export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64_ALPHABET[b0 >> 2] ?? '';
    out += B64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)] ?? '';
    out += b1 === undefined ? '=' : (B64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)] ?? '');
    out += b2 === undefined ? '=' : (B64_ALPHABET[b2 & 0x3f] ?? '');
  }
  return out;
}

/** Strict base64 decode: `null` on any malformed input (never throws, never guesses). */
export function fromBase64(text: string): Uint8Array | null {
  if (text.length % 4 !== 0) return null;
  const clean = text.replace(/=+$/u, '');
  const out = new Uint8Array((clean.length * 3) >> 2);
  let outIndex = 0;
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64_LOOKUP[ch.charCodeAt(0)] ?? -1;
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex] = (acc >> bits) & 0xff;
      outIndex += 1;
    }
  }
  return outIndex === out.length ? out : out.subarray(0, outIndex);
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Cryptographically random bytes (WebCrypto). */
export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/**
 * Crockford base32 encode (MSB-first bit stream, zero-padded tail). `32` bytes
 * -> 52 chars; 2 checksum bytes -> 4 chars (ADR-007 Decision 3.1).
 */
export function crockfordEncode(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD_ALPHABET[(acc >> bits) & 0x1f] ?? '';
    }
  }
  if (bits > 0) out += CROCKFORD_ALPHABET[(acc << (5 - bits)) & 0x1f] ?? '';
  return out;
}

/**
 * Crockford base32 decode of exactly `expectedChars` significant characters.
 * Confusables I/L/O are normalized; anything else (including U) is a decode
 * failure. The tail's padding bits are ignored.
 */
export function crockfordDecode(text: string, expectedChars: number): Uint8Array | null {
  const normalized = text.replace(/[\s-]/gu, '').toUpperCase();
  if (normalized.length !== expectedChars) return null;
  const out = new Uint8Array(Math.floor((expectedChars * 5) / 8));
  let outIndex = 0;
  let acc = 0;
  let bits = 0;
  for (const ch of normalized) {
    const v = C32_LOOKUP[ch.charCodeAt(0)] ?? -1;
    if (v < 0) return null;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex] = (acc >> bits) & 0xff;
      outIndex += 1;
    }
  }
  return out;
}

/** Canonical display form: uppercase, grouped in 4s (56 chars -> 14 groups). */
export function groupCode(code: string): string {
  return (code.match(/.{1,4}/gu) ?? []).join(' ');
}
