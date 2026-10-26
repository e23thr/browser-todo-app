/**
 * ADR-007 Decision 4.1 / 2.3 — the crypto commit (c1ed860) added the
 * encrypted at-rest row shapes and the `crypto_state` singleton to
 * `src/storage/validate.ts` with no direct validator tests, which left
 * `./src/storage/**` branch coverage under the strict 80% gate and reddened
 * `npm run ci` for the whole board.
 *
 * These are pure-shape tests: they pin the strictness contract (plaintext
 * fields are NOT part of the encrypted shape — title/notes/tags are
 * ciphertext), the envelope format checks (AES-GCM/iv/payload base64 + caps),
 * and the key-ring structure (slots, KDF per slot kind, wrap bounds) that boot
 * validation and import rely on to quarantine instead of crash.
 */
import { describe, expect, it } from 'vitest';

import {
  validateCryptoState,
  validateEncryptedList,
  validateEncryptedTask,
  validateRow,
} from '../../../src/storage/validate';

import { newUlidSafe } from './fixtures-helpers';

const T0 = 1_700_000_000_000;

const issuesOf = (r: { ok: boolean; issues?: string[] }): string[] => r.issues ?? [];

/** base64 of exactly 12 bytes (GCM IV). */
const IV_B64 = Buffer.from(new Uint8Array(12)).toString('base64');
/** base64 of exactly 16 bytes (PBKDF2 salt). */
const SALT_B64 = Buffer.from(new Uint8Array(16)).toString('base64');
/** base64 of exactly 32 bytes (wrapped DMK — the lower cap bound). */
const WRAP_CT_B64 = Buffer.from(new Uint8Array(32)).toString('base64');
/** base64 of 36 bytes: length 48 >= 24 and <= MAX_PAYLOAD_B64. */
const PAYLOAD_B64 = Buffer.from(new Uint8Array(36)).toString('base64');
const SHA256_HEX = 'a'.repeat(64);

type Row = Record<string, unknown>;

function encTask(over: Row = {}): Row {
  return {
    id: newUlidSafe(),
    kind: 'task',
    updatedAt: T0,
    deviceId: newUlidSafe(),
    deletedAt: null,
    payloadHash: SHA256_HEX,
    enc: { alg: 'AES-GCM', v: 1, iv: IV_B64 },
    payload: PAYLOAD_B64,
    listId: newUlidSafe(),
    status: 'open',
    priority: 'P3',
    sortOrder: 'h',
    createdAt: T0,
    ...over,
  };
}

function encList(over: Row = {}): Row {
  return {
    id: newUlidSafe(),
    kind: 'list',
    updatedAt: T0,
    deviceId: newUlidSafe(),
    deletedAt: null,
    payloadHash: SHA256_HEX,
    enc: { alg: 'AES-GCM', v: 1, iv: IV_B64 },
    payload: PAYLOAD_B64,
    color: '#336699',
    sortOrder: 'h',
    createdAt: T0,
    ...over,
  };
}

function passphraseSlot(over: Row = {}): Row {
  return {
    kind: 'passphrase',
    kdf: { alg: 'PBKDF2-HMAC-SHA-256', v: 1, iters: 600_000, salt: SALT_B64 },
    wrap: { iv: IV_B64, ct: WRAP_CT_B64 },
    createdAt: T0,
    ...over,
  };
}

function recoverySlot(over: Row = {}): Row {
  return {
    kind: 'recovery',
    kdf: { v: 1, alg: 'HKDF-SHA-256', info: 'todo-enc/1/recovery-kek' },
    wrap: { iv: IV_B64, ct: WRAP_CT_B64 },
    createdAt: T0,
    ...over,
  };
}

function keyEntry(over: Row = {}): Row {
  return {
    keyId: newUlidSafe(),
    createdAt: T0,
    slots: [passphraseSlot(), recoverySlot()],
    ...over,
  };
}

function cryptoState(over: Row = {}): Row {
  return {
    id: 'crypto',
    status: 'on',
    enabledAt: T0,
    migration: null,
    keys: [keyEntry()],
    recoveryOfferedAt: null,
    lockAfterMinutes: 15,
    ...over,
  };
}

describe('encrypted at-rest row shapes (ADR-007 Decision 4.1)', () => {
  it('accepts valid encrypted task and list rows', () => {
    expect(validateEncryptedTask(encTask()).ok).toBe(true);
    expect(validateEncryptedList(encList()).ok).toBe(true);
    // Optional structural fields are accepted when well-formed.
    expect(
      validateEncryptedTask(
        encTask({
          dueDate: '2026-10-30',
          reminderAt: T0,
          completedAt: T0,
          parentTaskId: newUlidSafe(),
          recurrence: { freq: 'daily', interval: 2, until: '2026-12-31' },
        }),
      ).ok,
    ).toBe(true);
    // Theme-token colours are the second legal colour form.
    expect(validateEncryptedList(encList({ color: 'gray' })).ok).toBe(true);
    expect(validateEncryptedTask(encTask({ status: 'done', priority: 'P1' })).ok).toBe(true);
    expect(validateEncryptedTask(encTask({ deletedAt: T0 })).ok).toBe(true);
  });

  it('rejects a non-object and plaintext rows fed to the encrypted shape', () => {
    expect(validateEncryptedTask('nope').ok).toBe(false);
    expect(validateEncryptedList(null).ok).toBe(false);
    // title/notes/tags live in the ciphertext — a plaintext row must NOT pass.
    const plaintext = encTask({ title: 'Buy milk', notes: 'semi', tags: ['x'] });
    const r = validateEncryptedTask(plaintext);
    expect(r.ok).toBe(false);
    expect(issuesOf(r).join(' ')).toContain('title');
  });

  it('rejects malformed structural fields', () => {
    expect(validateEncryptedTask(encTask({ id: 'not-a-ulid' })).ok).toBe(false);
    expect(validateEncryptedTask(encTask({ kind: 'list' })).ok).toBe(false);
    expect(validateEncryptedTask(encTask({ listId: 'x' })).ok).toBe(false);
    expect(validateEncryptedTask(encTask({ status: 'maybe' })).ok).toBe(false);
    expect(validateEncryptedTask(encTask({ priority: 'P0' })).ok).toBe(false);
    expect(validateEncryptedTask(encTask({ sortOrder: '' })).ok).toBe(false);
    expect(validateEncryptedTask(encTask({ sortOrder: 'h0' })).ok).toBe(false);
    expect(validateEncryptedTask(encTask({ deviceId: 'x' })).ok).toBe(false);
    expect(validateEncryptedTask(encTask({ createdAt: 'now' })).ok).toBe(false);
    expect(validateEncryptedTask(encTask({ updatedAt: -1 })).ok).toBe(false);
    expect(validateEncryptedTask(encTask({ deletedAt: 'yesterday' })).ok).toBe(false);
    expect(validateEncryptedList(encList({ kind: 'task' })).ok).toBe(false);
    expect(validateEncryptedList(encList({ color: '#fff' })).ok).toBe(false);
    expect(validateEncryptedList(encList({ color: 'Red' })).ok).toBe(false);
    expect(validateEncryptedList(encList({ sortOrder: 42 })).ok).toBe(false);
    // Unknown top-level fields stay rejected (strict schema).
    expect(validateEncryptedTask(encTask({ surprise: 1 })).ok).toBe(false);
    // Forbidden prototype keys are rejected through JSON (own enumerable key).
    const polluted = JSON.parse(
      `{"id":"${newUlidSafe()}","kind":"task","__proto__":{"admin":true}}`,
    ) as unknown;
    expect(validateEncryptedTask(polluted).ok).toBe(false);
  });

  it('enforces optional-field formats when present', () => {
    const r1 = validateEncryptedTask(encTask({ dueDate: '2026-02-30' }));
    expect(r1.ok).toBe(false);
    expect(issuesOf(r1).join(' ')).toContain('dueDate');
    expect(validateEncryptedTask(encTask({ reminderAt: 'soon' })).ok).toBe(false);
    expect(validateEncryptedTask(encTask({ completedAt: 1.5 })).ok).toBe(false);
    expect(validateEncryptedTask(encTask({ parentTaskId: 'nope' })).ok).toBe(false);
    const rec = validateEncryptedTask(
      encTask({ recurrence: { freq: 'hourly', interval: 0, junk: 1 } }),
    );
    expect(rec.ok).toBe(false);
    expect(issuesOf(rec).join(' ')).toContain('recurrence');
    expect(validateEncryptedTask(encTask({ recurrence: 'daily' })).ok).toBe(false);
  });

  it('validates the enc envelope (alg/version/iv) strictly', () => {
    expect(validateEncryptedTask(encTask({ enc: 'sealed' })).ok).toBe(false);
    expect(validateEncryptedTask(encTask({ enc: { v: 1, iv: IV_B64 } })).ok).toBe(false);
    expect(validateEncryptedTask(encTask({ enc: { alg: 'AES-CBC', v: 1, iv: IV_B64 } })).ok).toBe(
      false,
    );
    expect(validateEncryptedTask(encTask({ enc: { alg: 'AES-GCM', v: 2, iv: IV_B64 } })).ok).toBe(
      false,
    );
    // IV must be base64 OF EXACTLY 12 bytes: wrong byte length…
    const shortIv = Buffer.from(new Uint8Array(11)).toString('base64');
    expect(validateEncryptedTask(encTask({ enc: { alg: 'AES-GCM', v: 1, iv: shortIv } })).ok).toBe(
      false,
    );
    // …not a string…
    expect(validateEncryptedTask(encTask({ enc: { alg: 'AES-GCM', v: 1, iv: 7 } })).ok).toBe(false);
    // …length not a multiple of 4 (fromBase64Len → null)…
    expect(
      validateEncryptedTask(encTask({ enc: { alg: 'AES-GCM', v: 1, iv: IV_B64.slice(0, 15) } })).ok,
    ).toBe(false);
    // …or not base64 at all.
    expect(
      validateEncryptedTask(encTask({ enc: { alg: 'AES-GCM', v: 1, iv: '!'.repeat(16) } })).ok,
    ).toBe(false);
    // Unknown + forbidden keys inside the envelope are rejected.
    expect(
      validateEncryptedTask(encTask({ enc: { alg: 'AES-GCM', v: 1, iv: IV_B64, mode: 'gcm' } })).ok,
    ).toBe(false);
    const badEnc = JSON.parse(
      `{"alg":"AES-GCM","v":1,"iv":"${IV_B64}","__proto__":{"x":1}}`,
    ) as Record<string, unknown>;
    expect(validateEncryptedTask(encTask({ enc: badEnc })).ok).toBe(false);
  });

  it('bounds the ciphertext payload and pins payloadHash to sha256 hex', () => {
    expect(validateEncryptedTask(encTask({ payload: 'short' })).ok).toBe(false);
    expect(validateEncryptedTask(encTask({ payload: 42 })).ok).toBe(false);
    // base64 of a wrong byte length (length % 4 !== 0 → not decodable base64).
    expect(validateEncryptedTask(encTask({ payload: 'A'.repeat(25) })).ok).toBe(false);
    // Over the 64 000-char corrupt-row cap.
    expect(validateEncryptedTask(encTask({ payload: 'A'.repeat(64_001) })).ok).toBe(false);
    expect(validateEncryptedTask(encTask({ payloadHash: 'deadbeef' })).ok).toBe(false);
    expect(validateEncryptedTask(encTask({ payloadHash: 'z'.repeat(64) })).ok).toBe(false);
    expect(validateEncryptedList(encList({ payload: '' })).ok).toBe(false);
    expect(validateEncryptedList(encList({ payloadHash: null })).ok).toBe(false);
  });
});

describe('crypto_state singleton (ADR-007 Decision 2.3)', () => {
  it('accepts the steady, migrating and on shapes', () => {
    expect(
      validateCryptoState({
        id: 'crypto',
        status: 'off',
        enabledAt: null,
        migration: null,
        keys: [],
        recoveryOfferedAt: null,
        lockAfterMinutes: 30,
      }).ok,
    ).toBe(true);
    expect(
      validateCryptoState(
        cryptoState({
          status: 'migrating',
          migration: { startedAt: T0, done: 3, total: 9, direction: 'encrypt' },
        }),
      ).ok,
    ).toBe(true);
    expect(
      validateCryptoState(
        cryptoState({
          status: 'on',
          migration: { startedAt: T0, done: 9, total: 9, direction: 'decrypt' },
          recoveryOfferedAt: T0,
          lockAfterMinutes: 60,
        }),
      ).ok,
    ).toBe(true);
    // A passphrase-only ring (no recovery slot) is legal: 1..2 slots.
    expect(
      validateCryptoState(cryptoState({ keys: [{ ...keyEntry(), slots: [passphraseSlot()] }] })).ok,
    ).toBe(true);
  });

  it('rejects malformed singletons', () => {
    expect(validateCryptoState('nope').ok).toBe(false);
    expect(validateCryptoState(cryptoState({ id: 'vault' })).ok).toBe(false);
    expect(validateCryptoState(cryptoState({ status: 'half' })).ok).toBe(false);
    expect(validateCryptoState(cryptoState({ enabledAt: 'today' })).ok).toBe(false);
    expect(validateCryptoState(cryptoState({ recoveryOfferedAt: 'soon' })).ok).toBe(false);
    expect(validateCryptoState(cryptoState({ lockAfterMinutes: 7 })).ok).toBe(false);
    // `migration` is REQUIRED: absent is a shape issue, null is steady state.
    const withoutMigration: Row = cryptoState();
    delete withoutMigration['migration'];
    expect(validateCryptoState(withoutMigration).ok).toBe(false);
    expect(validateCryptoState(cryptoState({ migration: 'running' })).ok).toBe(false);
    expect(validateCryptoState(cryptoState({ migration: 7 })).ok).toBe(false);
    const polluted = JSON.parse(
      '{"id":"crypto","status":"off","enabledAt":null,"migration":null,"keys":[],"recoveryOfferedAt":null,"lockAfterMinutes":5,"__proto__":{"x":1}}',
    ) as unknown;
    expect(validateCryptoState(polluted).ok).toBe(false);
    // Unknown top-level field.
    expect(validateCryptoState(cryptoState({ surprise: 1 })).ok).toBe(false);
  });

  it('validates migration progress when present', () => {
    const unknown = validateCryptoState(
      cryptoState({ migration: { startedAt: T0, done: 0, total: 1, direction: 'encrypt', x: 1 } }),
    );
    expect(unknown.ok).toBe(false);
    expect(issuesOf(unknown).join(' ')).toContain('migration.x');

    const badStart = validateCryptoState(
      cryptoState({
        migration: { startedAt: 'yesterday', done: 0, total: 1, direction: 'encrypt' },
      }),
    );
    expect(badStart.ok).toBe(false);
    // checkTimestamp reports the bare key (the migration object is passed as `fields`).
    expect(issuesOf(badStart).join(' ')).toContain('startedAt: format');

    expect(
      validateCryptoState(
        cryptoState({
          migration: { startedAt: T0, done: -1, total: 1, direction: 'encrypt' },
        }),
      ).ok,
    ).toBe(false);
    expect(
      validateCryptoState(
        cryptoState({ migration: { startedAt: T0, done: 0.5, total: 1, direction: 'encrypt' } }),
      ).ok,
    ).toBe(false);
    expect(
      validateCryptoState(
        cryptoState({ migration: { startedAt: T0, done: 0, total: 'many', direction: 'encrypt' } }),
      ).ok,
    ).toBe(false);
    expect(
      validateCryptoState(
        cryptoState({ migration: { startedAt: T0, done: 0, total: 1, direction: 'sideways' } }),
      ).ok,
    ).toBe(false);
  });

  it('bounds the key ring and each entry', () => {
    expect(validateCryptoState(cryptoState({ keys: 'ring' })).ok).toBe(false);
    const nine = Array.from({ length: 9 }, () => keyEntry());
    expect(validateCryptoState(cryptoState({ keys: nine })).ok).toBe(false);
    expect(validateCryptoState(cryptoState({ keys: ['not-an-entry'] })).ok).toBe(false);
    const extra = validateCryptoState(
      cryptoState({ keys: [{ ...keyEntry(), nickname: 'work laptop' }] }),
    );
    expect(extra.ok).toBe(false);
    expect(issuesOf(extra).join(' ')).toContain('nickname');
    expect(validateCryptoState(cryptoState({ keys: [{ ...keyEntry(), keyId: 'nope' }] })).ok).toBe(
      false,
    );
    expect(
      validateCryptoState(cryptoState({ keys: [{ ...keyEntry(), createdAt: 'today' }] })).ok,
    ).toBe(false);
    expect(validateCryptoState(cryptoState({ keys: [{ ...keyEntry(), slots: 'pair' }] })).ok).toBe(
      false,
    );
    expect(validateCryptoState(cryptoState({ keys: [{ ...keyEntry(), slots: [] }] })).ok).toBe(
      false,
    );
    expect(
      validateCryptoState(
        cryptoState({
          keys: [{ ...keyEntry(), slots: [passphraseSlot(), recoverySlot(), recoverySlot()] }],
        }),
      ).ok,
    ).toBe(false);
  });

  it('validates each key slot: kind, wrap bounds and per-kind KDF', () => {
    expect(
      validateCryptoState(cryptoState({ keys: [{ ...keyEntry(), slots: ['sealed'] }] })).ok,
    ).toBe(false);
    const extraSlotKey = validateCryptoState(
      cryptoState({ keys: [{ ...keyEntry(), slots: [{ ...passphraseSlot(), label: 'main' }] }] }),
    );
    expect(extraSlotKey.ok).toBe(false);
    expect(issuesOf(extraSlotKey).join(' ')).toContain('label');
    expect(
      validateCryptoState(
        cryptoState({
          keys: [{ ...keyEntry(), slots: [{ ...passphraseSlot(), kind: 'yubikey' }] }],
        }),
      ).ok,
    ).toBe(false);

    // wrap: record shape, unknown keys, iv byte length, ct byte length.
    expect(
      validateCryptoState(
        cryptoState({ keys: [{ ...keyEntry(), slots: [{ ...passphraseSlot(), wrap: 'blob' }] }] }),
      ).ok,
    ).toBe(false);
    expect(
      validateCryptoState(
        cryptoState({
          keys: [
            {
              ...keyEntry(),
              slots: [{ ...passphraseSlot(), wrap: { iv: IV_B64, ct: WRAP_CT_B64, aad: 'x' } }],
            },
          ],
        }),
      ).ok,
    ).toBe(false);
    expect(
      validateCryptoState(
        cryptoState({
          keys: [
            {
              ...keyEntry(),
              slots: [{ ...passphraseSlot(), wrap: { iv: IV_B64, ct: 'AA' } }],
            },
          ],
        }),
      ).ok,
    ).toBe(false);
    expect(
      validateCryptoState(
        cryptoState({
          keys: [
            { ...keyEntry(), slots: [{ ...passphraseSlot(), wrap: { iv: 7, ct: WRAP_CT_B64 } }] },
          ],
        }),
      ).ok,
    ).toBe(false);
    // ct over the 128-byte wrapped-key cap.
    const bigCt = Buffer.from(new Uint8Array(129)).toString('base64');
    expect(
      validateCryptoState(
        cryptoState({
          keys: [
            { ...keyEntry(), slots: [{ ...passphraseSlot(), wrap: { iv: IV_B64, ct: bigCt } }] },
          ],
        }),
      ).ok,
    ).toBe(false);

    // kdf: must be a record (checked before the per-kind branches).
    expect(
      validateCryptoState(
        cryptoState({ keys: [{ ...keyEntry(), slots: [{ ...passphraseSlot(), kdf: 'pbkdf2' }] }] }),
      ).ok,
    ).toBe(false);

    // passphrase KDF: alg/v/iters/salt each pinned.
    expect(
      validateCryptoState(
        cryptoState({
          keys: [
            {
              ...keyEntry(),
              slots: [
                {
                  ...passphraseSlot(),
                  kdf: { alg: 'scrypt', v: 1, iters: 600_000, salt: SALT_B64 },
                },
              ],
            },
          ],
        }),
      ).ok,
    ).toBe(false);
    expect(
      validateCryptoState(
        cryptoState({
          keys: [
            {
              ...keyEntry(),
              slots: [
                {
                  ...passphraseSlot(),
                  kdf: { alg: 'PBKDF2-HMAC-SHA-256', v: 2, iters: 600_000, salt: SALT_B64 },
                },
              ],
            },
          ],
        }),
      ).ok,
    ).toBe(false);
    expect(
      validateCryptoState(
        cryptoState({
          keys: [
            {
              ...keyEntry(),
              slots: [
                {
                  ...passphraseSlot(),
                  kdf: { alg: 'PBKDF2-HMAC-SHA-256', v: 1, iters: 0, salt: SALT_B64 },
                },
              ],
            },
          ],
        }),
      ).ok,
    ).toBe(false);
    expect(
      validateCryptoState(
        cryptoState({
          keys: [
            {
              ...keyEntry(),
              slots: [
                {
                  ...passphraseSlot(),
                  kdf: { alg: 'PBKDF2-HMAC-SHA-256', v: 1, iters: 600_000, salt: 'AAA' },
                },
              ],
            },
          ],
        }),
      ).ok,
    ).toBe(false);

    // recovery KDF: v/alg/info triple, fixed info string.
    expect(
      validateCryptoState(
        cryptoState({
          keys: [
            {
              ...keyEntry(),
              slots: [
                {
                  ...recoverySlot(),
                  kdf: { v: 1, alg: 'HKDF-SHA-256', info: 'todo-enc/2/other' },
                },
              ],
            },
          ],
        }),
      ).ok,
    ).toBe(false);
    expect(
      validateCryptoState(
        cryptoState({
          keys: [
            {
              ...keyEntry(),
              slots: [
                {
                  ...recoverySlot(),
                  kdf: { v: 1, alg: 'HKDF-SHA-1', info: 'todo-enc/1/recovery-kek' },
                },
              ],
            },
          ],
        }),
      ).ok,
    ).toBe(false);
    expect(
      validateCryptoState(
        cryptoState({
          keys: [
            {
              ...keyEntry(),
              slots: [
                {
                  ...recoverySlot(),
                  kdf: { v: 3, alg: 'HKDF-SHA-256', info: 'todo-enc/1/recovery-kek' },
                },
              ],
            },
          ],
        }),
      ).ok,
    ).toBe(false);
    // A recovery slot whose kdf carries the passphrase triple fails the else-branch check.
    expect(
      validateCryptoState(
        cryptoState({
          keys: [
            {
              ...keyEntry(),
              slots: [
                passphraseSlot(),
                {
                  ...recoverySlot(),
                  kdf: { alg: 'PBKDF2-HMAC-SHA-256', v: 1, iters: 1, salt: SALT_B64 },
                },
              ],
            },
          ],
        }),
      ).ok,
    ).toBe(false);
  });

  it('dispatches the encrypted and crypto stores through validateRow', () => {
    expect(validateRow('tasks', encTask()).ok).toBe(true);
    expect(validateRow('lists', encList()).ok).toBe(true);
    expect(validateRow('crypto_state', cryptoState()).ok).toBe(true);
    // Self-describing dispatch: a broken encrypted row fails via the enc path.
    expect(validateRow('tasks', encTask({ kind: 'nope' })).ok).toBe(false);
    expect(validateRow('lists', encList({ payload: 'x' })).ok).toBe(false);
    expect(validateRow('crypto_state', cryptoState({ status: 'bad' })).ok).toBe(false);
  });
});
