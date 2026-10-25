/**
 * One-shot KAT fixture generator (ADR-007 testing contract 1: "generated once
 * with Node's WebCrypto, committed as test fixtures"). Run: node
 * scripts/gen-crypto-kats.mjs — the printed constants are pasted into
 * tests/unit/crypto/kat.test.ts and never regenerated (they are KNOWN-ANSWER
 * pins, not snapshots).
 */
import { webcrypto } from 'node:crypto';

const subtle = webcrypto.subtle;
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const utf8 = (s) => new TextEncoder().encode(s);

const keyBytes = Uint8Array.from({ length: 32 }, (_, i) => i);
const iv = Uint8Array.from({ length: 12 }, (_, i) => 0xa0 + i);
const aad = utf8('todo-enc/1|task|01ARZ3NDEKTSV4RRFFQ69G5FAV');
const json = JSON.stringify({ title: 'Buy milk', notes: null, tags: [] });
const key = await subtle.importKey('raw', keyBytes, 'AES-GCM', true, ['encrypt', 'wrapKey']);
const ct = await subtle.encrypt(
  { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
  key,
  utf8(json),
);
console.log('A_CT_HEX=' + hex(ct));

const salt = Uint8Array.from({ length: 16 }, (_, i) => i);
const base = await subtle.importKey('raw', utf8('correct horse battery staple'), 'PBKDF2', false, [
  'deriveBits',
]);
const bits = await subtle.deriveBits(
  { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600000 },
  base,
  256,
);
console.log('B_PBKDF2_HEX=' + hex(bits));

const secret = Uint8Array.from({ length: 32 }, (_, i) => 0x20 + i);
const hbase = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
const hbits = await subtle.deriveBits(
  { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8('todo-enc/1/recovery-kek') },
  hbase,
  256,
);
console.log('C_HKDF_HEX=' + hex(hbits));

const wrapIv = Uint8Array.from({ length: 12 }, (_, i) => 0xb0 + i);
const wrapAad = utf8('todo-enc/1|wrap|01ARZ3NDEKTSV4RRFFQ69G5FAV|passphrase');
const kek = await subtle.importKey('raw', bits, 'AES-GCM', false, ['wrapKey', 'unwrapKey']);
const wr = await subtle.wrapKey('raw', key, kek, {
  name: 'AES-GCM',
  iv: wrapIv,
  additionalData: wrapAad,
  tagLength: 128,
});
console.log('D_WRAP_HEX=' + hex(wr));
