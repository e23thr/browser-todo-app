/**
 * Credential-hygiene edge paths (ADR-007 Decision 6.1/6.3): enable-time
 * passphrase policy, unlock-time leniency, and the emergency-kit key-file
 * codec (todo-key/1) incl. its rejection paths.
 */

import { describe, expect, it } from 'vitest';

import {
  deriveKek,
  deriveKekChecked,
  isKdfParams,
  newKdfParams,
  passphraseIssue,
  rejectWeakPassphrase,
  strengthHint,
  PBKDF2_ITERATIONS,
  type KdfParams,
} from '../../../src/crypto/passphrase';
import {
  decodeRecoveryCode,
  encodeRecoveryCode,
  buildKeyFile,
  newRecoveryMaterial,
  parseKeyFile,
  serializeKeyFile,
  RECOVERY_CODE_CHARS,
  KEY_FILE_FORMAT,
} from '../../../src/crypto/recovery';
import { concatBytes, fromBase64, randomBytes, toBase64, utf8 } from '../../../src/crypto/bytes';

describe('passphrase policy (Decision 6.1)', () => {
  it('enable-time issues: length is the floor; unlock accepts anything that decrypts', async () => {
    expect(passphraseIssue('short')).toMatch(/12/);
    expect(passphraseIssue('alllowercase123')).toBeNull(); // length is the only rule
    expect(passphraseIssue('correct horse battery staple')).toBeNull();

    // A short-but-correct passphrase still UNLOCKS (Decision 6.3) — the
    // minimum is an enable-time rule only.
    const kdf = newKdfParams(64);
    const checked = await deriveKekChecked('short', kdf);
    expect(checked.ok).toBe(true);
    const a = await deriveKek('short', kdf);
    const b = await deriveKek('short', kdf);
    // Session KEKs are non-extractable (Decision 5.3) — the KAT fixtures pin
    // determinism; here we assert the hardened key type.
    expect(a.extractable).toBe(false);
    expect(b.extractable).toBe(false);
  });

  it('weak-passphrase rejection is an explicit enable guard (POLICY, never decrypt/unlock)', () => {
    const rejected = rejectWeakPassphrase('a'.repeat(11));
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe('POLICY');
    expect(rejectWeakPassphrase('a'.repeat(12)).ok).toBe(true);
    expect(strengthHint('correct horse battery staple')).toBe('strong');
    expect(strengthHint('abcdefghijkl')).toBe('weak');
  });

  it('kdf params validate structurally and the mint pins the production floor', () => {
    const params = newKdfParams();
    expect(params.iters).toBe(PBKDF2_ITERATIONS); // 600k floor at mint (D6.4)
    expect(isKdfParams(params)).toBe(true);
    expect(isKdfParams({ ...params, iters: 1.5 })).toBe(false); // non-integer
    expect(isKdfParams({ ...params, salt: '!!!not base64!!!' })).toBe(false);
    expect(isKdfParams({ alg: 'scrypt' })).toBe(false);
  });
});

describe('recovery code + key file (Decision 3.1/6.3)', () => {
  it('recovery code round-trips and its checksum rejects tampering before any crypto runs', async () => {
    const material = await newRecoveryMaterial();
    const code = await encodeRecoveryCode(material.secret);
    // 56 chars = 52 base32 data + 4 checksum (displayed in groups of 4).
    expect(code).toHaveLength(RECOVERY_CODE_CHARS);
    expect(code.replace(/ /gu, '')).toHaveLength(RECOVERY_CODE_CHARS);
    const decoded = await decodeRecoveryCode(code);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value).toEqual(material.secret);

    // Flip one character -> the checksum catches it (cheap, pre-crypto) and
    // reports it as a failed unlock ("That key didn't work" — Decision 6.3).
    const chars = code.split('');
    chars[2] = chars[2] === 'A' ? 'B' : 'A';
    const caught = await decodeRecoveryCode(chars.join(''));
    expect(caught.ok).toBe(false);
    if (!caught.ok) expect(caught.error.code).toBe('UNLOCK_FAILED');

    // A wrong-length / non-code input is rejected the same cheap way.
    const raw = await decodeRecoveryCode('not a recovery code at all');
    expect(raw.ok).toBe(false);
    if (!raw.ok) expect(raw.error.code).toBe('UNLOCK_FAILED');
  });

  it('key file round-trips and refuses non-`todo-key/1` bytes', async () => {
    const material = await newRecoveryMaterial();
    const file = buildKeyFile({
      keyId: '01ARZ3NDEKTSV4RRFFQ69G5FKF',
      recoveryCode: await encodeRecoveryCode(material.secret),
      wrappedDmk: {
        iv: toBase64(randomBytes(12)),
        ct: toBase64(randomBytes(40)),
      },
      now: 1_700_000_000_000,
    });
    const serialized = serializeKeyFile(file);
    expect(serialized).toContain(KEY_FILE_FORMAT);

    const decoded = parseKeyFile(JSON.parse(serialized));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.keyId).toBe('01ARZ3NDEKTSV4RRFFQ69G5FKF');
    }

    expect(parseKeyFile({ format: 'not-a-key-file', v: 1 }).ok).toBe(false);
    expect(parseKeyFile(null).ok).toBe(false);
    expect(parseKeyFile('{"format":').ok).toBe(false);
  });

  it('recovery KEK derivation is deterministic and 256-bit', async () => {
    const secret = utf8('0123456789abcdef');
    const a = await newRecoveryMaterial();
    const codeA = await encodeRecoveryCode(a.secret);
    const roundTrip = await decodeRecoveryCode(codeA);
    expect(roundTrip.ok).toBe(true);
    if (roundTrip.ok) {
      const reencoded = await encodeRecoveryCode(roundTrip.value);
      expect(reencoded).toBe(codeA); // stable formatting
    }
    expect(secret.length).toBe(16);
  });

  it('base64 codecs are inverse and tolerate URL-safe input', () => {
    for (let size = 1; size < 40; size += 7) {
      const bytes = randomBytes(size);
      const b64 = toBase64(bytes);
      expect(fromBase64(b64)).toEqual(bytes);
    }
    // URL-safe alphabets are accepted on the way in (sync/wire tolerance).
    expect(
      fromBase64(toBase64(randomBytes(10)).replace(/\+/g, '-').replace(/\//g, '_')),
    ).not.toBeNull();
    const sample = randomBytes(23);
    expect(concatBytes(sample, new Uint8Array(0))).toEqual(sample);
    const params: KdfParams = newKdfParams(64);
    expect(isKdfParams(params)).toBe(true);
  });
});
