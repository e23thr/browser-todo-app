/**
 * Vault/key-ring edge coverage (ADR-007 Decisions 2/3/5): ring gaps, recovery
 * slot gaps, re-wrap guards, snapshot wrap edge cases, and the portability
 * seam's failure paths — the branches the acceptance battery doesn't reach.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openForTests } from '../../../src/storage/db';
import type { AppDBImpl } from '../../../src/storage/db';
import { isEncryptedRecord } from '../../../src/domain/model';
import { CryptoVault, registerVault } from '../../../src/crypto/vault';
import {
  addRecoverySlot,
  mintKeyEntry,
  rewrapEntryWithPassphrase,
  unlockEntryWithRecovery,
  unlockRingWithPassphrase,
} from '../../../src/crypto/keys';
import {
  decryptRowsForDocument,
  requireUnlockedForWrite,
  cryptoCodecHooks,
} from '../../../src/crypto/portability';
import { keyFileName, normalizeRecoveryInput, parseKeyFile } from '../../../src/crypto/recovery';
import { toBase64, randomBytes } from '../../../src/crypto/bytes';
import { enableEncryption } from '../../../src/crypto/service';
import { DEFAULT_SETTINGS } from '../../../src/domain/model';
import { makeTask } from '../storage/fixtures';

const T0 = 1_700_000_000_000;
const PASSPHRASE = 'correct horse battery staple';

let db: AppDBImpl;
let vault: CryptoVault;
let clock = T0;
const opened: AppDBImpl[] = [];
const now = (): number => (clock += 1000);

async function freshDb(): Promise<AppDBImpl> {
  const created = await openForTests({ dbName: `edges-${Math.random().toString(36).slice(2)}` });
  if (!created.ok) throw new Error('open failed');
  opened.push(created.value);
  return created.value;
}

beforeEach(async () => {
  clock = T0;
  db = await freshDb();
  vault = new CryptoVault({ now });
  await vault.attach(db);
  registerVault(vault);
});

afterEach(async () => {
  await vault.lock();
  const { resetRowCryptoSeam } = await import('../../../src/storage/cryptoSeam');
  const { resetMergeCryptoSeam } = await import('../../../src/sync/mergeSeam');
  resetRowCryptoSeam();
  resetMergeCryptoSeam();
  for (const d of opened.splice(0)) d.close();
});

async function enableHappyPath(): Promise<void> {
  await db.put('settings', { ...DEFAULT_SETTINGS, lastBackupAt: T0 + 10 });
  await db.put('tasks', makeTask({ title: 'Buy milk', updatedAt: now() }));
  const result = await enableEncryption({
    db,
    vault,
    passphrase: PASSPHRASE,
    passphraseConfirm: PASSPHRASE,
    flowOpenedAt: T0,
    lostPassphraseAcknowledged: true,
    wantRecoveryKey: true,
    now,
    takePreMigrationSnapshot: async () => ({ ok: true, id: 'snap' }),
  });
  if (!result.ok) throw new Error(`enable failed: ${result.error.message}`);
}

describe('key-ring edges (Decision 2/3)', () => {
  it('ring unlock fails cleanly when no entry matches', async () => {
    const minted = await mintKeyEntry({
      keyId: '01ARZ3NDEKTSV4RRFFQ69G5FK9',
      passphrase: PASSPHRASE,
      now: clock,
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const ring = await unlockRingWithPassphrase([minted.value.entry], 'wrong wrong wrong', {
      now: clock,
    });
    expect(ring.ok).toBe(false); // wrong passphrase across the ring
    if (!ring.ok) expect(ring.error.code).toBe('UNLOCK_FAILED');

    const empty = await unlockRingWithPassphrase([], PASSPHRASE, { now: clock });
    expect(empty.ok).toBe(false); // no passphrase slot at all
    if (!empty.ok) expect(empty.error.code).toBe('UNLOCK_FAILED');
  });

  it('recovery unlock of an entry with NO recovery slot fails typed', async () => {
    const minted = await mintKeyEntry({
      keyId: '01ARZ3NDEKTSV4RRFFQ69G5FKA',
      passphrase: PASSPHRASE,
      now: clock,
      // no recoverySecret -> passphrase slot only
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const opened = await unlockEntryWithRecovery(minted.value.entry, randomBytes(32));
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error.code).toBe('WRONG_KEY_DOMAIN');
  });

  it('device join adopts a foreign key file and re-wraps it under the local passphrase', async () => {
    // Device B's emergency kit, minted independently (its own store + DMK).
    const foreignDb = await freshDb();
    const foreignVault = new CryptoVault({ now });
    await foreignVault.attach(foreignDb);
    await foreignDb.put('settings', { ...DEFAULT_SETTINGS, lastBackupAt: T0 + 10 });
    const foreignEnable = await enableEncryption({
      db: foreignDb,
      vault: foreignVault,
      passphrase: 'device b local passphrase',
      passphraseConfirm: 'device b local passphrase',
      flowOpenedAt: T0,
      lostPassphraseAcknowledged: true,
      wantRecoveryKey: true,
      now,
      takePreMigrationSnapshot: async () => ({ ok: true, id: 'snap-b' }),
    });
    if (!foreignEnable.ok || foreignEnable.value.recovery === null) {
      throw new Error('foreign enable failed');
    }
    const foreignFile = foreignEnable.value.recovery.keyFile;

    // This device has its own store + passphrase, then JOINS the file (D3.3).
    await enableHappyPath();
    const joined = await vault.joinWithKeyFile(foreignFile, PASSPHRASE);
    expect(joined.ok).toBe(true);
    if (joined.ok) {
      expect(joined.value).toContain(foreignFile.keyId); // the ring carries both keys
    }
    // The joined key unlocks under THIS device's passphrase now (re-wrapped).
    await vault.lock();
    const relocked = await vault.unlockWithPassphrase(PASSPHRASE);
    expect(relocked.ok).toBe(true);
    if (relocked.ok) expect(relocked.value).toContain(foreignFile.keyId);
  });

  it('vault-level changePassphrase + issueRecoveryKey re-wrap ONE key each (records untouched)', async () => {
    await enableHappyPath();
    const before = await db.readUnfiltered('tasks');

    const changed = await vault.changePassphrase('a brand new long passphrase');
    expect(changed.ok).toBe(true);
    await vault.lock();
    expect((await vault.unlockWithPassphrase(PASSPHRASE)).ok).toBe(false); // old gone
    expect((await vault.unlockWithPassphrase('a brand new long passphrase')).ok).toBe(true);

    const issued = await vault.issueRecoveryKey(
      randomBytes(32),
      'ABCD EFGH JKMN PQRS TVWX YZ01 2345 6789 ABCD EFGH JKMN PQRS TVWX YZ01',
    );
    expect(issued.ok).toBe(true);
    if (issued.ok) {
      expect(issued.value.keyId).toBe(vault.keyIds[0]);
    }

    // Records untouched by both re-wraps (the whole point of the envelope).
    const after = await db.readUnfiltered('tasks');
    expect(after.ok && after.value).toEqual(before.ok ? before.value : []);
  });

  it('re-wrap keeps the recovery slot; addRecoverySlot replaces it once', async () => {
    const secret = randomBytes(32);
    const minted = await mintKeyEntry({
      keyId: '01ARZ3NDEKTSV4RRFFQ69G5FKB',
      passphrase: PASSPHRASE,
      recoverySecret: secret,
      now: clock,
    });
    if (!minted.ok) throw new Error('mint failed');
    const entry = minted.value.entry;

    // The single-wrap passphrase change (Decision 6.2) carries the recovery slot.
    const rewrapped = await rewrapEntryWithPassphrase(
      minted.value.dmk,
      entry,
      'a brand new long passphrase',
      now(),
    );
    expect(rewrapped.ok).toBe(true);
    if (rewrapped.ok) {
      expect(rewrapped.value.slots.filter((s) => s.kind === 'recovery')).toHaveLength(1);
      // And the rewrapped entry still unlocks with the recovery code.
      const viaRecovery = await unlockEntryWithRecovery(rewrapped.value, secret);
      expect(viaRecovery.ok).toBe(true);
    }

    // addRecoverySlot re-issues exactly one recovery slot.
    const reissued = await addRecoverySlot(minted.value.dmk, entry, randomBytes(32), now());
    expect(reissued.ok).toBe(true);
    if (reissued.ok) {
      expect(reissued.value.entry.slots.filter((s) => s.kind === 'recovery')).toHaveLength(1);
      // The OLD recovery secret no longer opens the new slot.
      const stale = await unlockEntryWithRecovery(reissued.value.entry, secret);
      expect(stale.ok).toBe(false);
    }
  });
});

describe('vault snapshot wrap edges (Decision 4.4)', () => {
  it('wrapped snapshot payloads round-trip and corrupted wrappers fail typed', async () => {
    await enableHappyPath();
    const snapshotId = '01ARZ3NDEKTSV4RRFFQ69G5FSP';
    const json = '{"format":"todo-backup/1","stores":{}}';
    const wrapped = await vault.wrapSnapshotPayload(snapshotId, json);
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;
    expect(wrapped.value).not.toContain('todo-backup/1'); // wrapped at rest
    const unwrapped = await vault.unwrapSnapshotPayload(snapshotId, wrapped.value);
    expect(unwrapped.ok && unwrapped.value).toBe(json);

    const corrupt = await vault.unwrapSnapshotPayload(
      snapshotId,
      JSON.stringify({
        format: 'todo-enc/1',
        v: 1,
        iv: toBase64(randomBytes(12)),
        ct: 'AAAA', // garbage ciphertext -> DECRYPT_FAILED (never a throw)
      }),
    );
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok) expect(corrupt.error.code).toBe('DECRYPT_FAILED');

    // A wrapper-shaped object with no iv/ct is refused the same typed way.
    const malformed = await vault.unwrapSnapshotPayload(
      snapshotId,
      JSON.stringify({ format: 'todo-enc/1', v: 1 }),
    );
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe('DECRYPT_FAILED');
  });

  it('verifyPassphrase powers the disable confirmation (Decision 6.2)', async () => {
    await enableHappyPath();
    const good = await vault.verifyPassphrase(PASSPHRASE);
    expect(good.ok).toBe(true);
    const bad = await vault.verifyPassphrase('wrong wrong wrong');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('UNLOCK_FAILED');
    // Confirming does NOT leave the vault unlocked if it was locked.
    expect(vault.status).toBe('on');
    await vault.lock();
    expect(vault.isUnlocked).toBe(false);
    await vault.unlockWithPassphrase(PASSPHRASE);
    expect(vault.isUnlocked).toBe(true);
  });
});

describe('portability seam failure paths (Decision 4.5)', () => {
  it('decryptRowsForDocument errors typed while locked and reports unreadable rows', async () => {
    await enableHappyPath();
    const rows = await db.readUnfiltered('tasks');
    const encryptedRows = rows.ok ? rows.value : [];

    await vault.lock();
    const locked = await decryptRowsForDocument(vault, {
      lists: [],
      tasks: encryptedRows,
    });
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.error.code).toBe('LOCKED');

    await vault.unlockWithPassphrase(PASSPHRASE);
    const plain = await decryptRowsForDocument(vault, {
      lists: [],
      tasks: encryptedRows,
    });
    expect(plain.ok).toBe(true);
    if (plain.ok) {
      expect(isEncryptedRecord(plain.value.tasks[0])).toBe(false);
    }

    // A damaged row -> typed DECRYPT_FAILED carrying the reason.
    const raw = encryptedRows[0] as unknown as { payload: string };
    const damaged = {
      ...(encryptedRows[0] as unknown as Record<string, unknown>),
      payload: `${raw.payload[0] === 'A' ? 'B' : 'A'}${raw.payload.slice(1)}`,
    };
    const failed = await decryptRowsForDocument(vault, {
      lists: [],
      tasks: [damaged as unknown as never],
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe('DECRYPT_FAILED');
  });

  it('imports are refused while locked; codec hooks defer the same way', async () => {
    await enableHappyPath();
    await vault.lock();
    const refused = requireUnlockedForWrite(vault);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('LOCKED');

    const hooks = cryptoCodecHooks(vault);
    const snapshotId = '01ARZ3NDEKTSV4RRFFQ69G5FSQ';
    // Sealing a user snapshot needs the DMK (the payload is wrapped at rest),
    // so a LOCKED session refuses — the snapshots layer defers `ok(null)`
    // upstream (Decision 4.4 + the scheduled-snapshot rule).
    const sealed = await hooks.seal(snapshotId, '{"format":"todo-backup/1"}');
    expect(sealed.ok).toBe(false);
    // The codec hook speaks the STORAGE error vocabulary (BLOCKED), not
    // CryptoErrorCode — the typed refusal is what matters here.

    await vault.unlockWithPassphrase(PASSPHRASE);
    const sealedNow = await hooks.seal(snapshotId, '{"format":"todo-backup/1"}');
    expect(sealedNow.ok).toBe(true);
    if (sealedNow.ok) {
      const opened = await hooks.open(snapshotId, sealedNow.value);
      expect(opened.ok).toBe(true);
      if (opened.ok) expect(opened.value).toBe('{"format":"todo-backup/1"}');
    }
  });
});

describe('emergency-kit file helpers (Decision 3.1)', () => {
  it('key file names are date-stamped and parse rejects malformed kdf blocks', () => {
    expect(keyFileName(T0)).toMatch(/^todo-recovery-key-\d{8}\.json$/u);
    // Normalization: separators dropped, Crockford uppercase (Decision 3.1's
    // "formatting groups of four with spaces or dashes").
    expect(normalizeRecoveryInput('abcd-efgh ijkl')).toBe('ABCDEFGHIJKL');

    // kdf blocks are parsed TOLERANTLY (the ADR example showed the passphrase
    // slot's PBKDF2 block on a recovery slot — an authoring slip).
    const tolerant = parseKeyFile({
      format: 'todo-key/1',
      createdAt: T0,
      keyId: '01ARZ3NDEKTSV4RRFFQ69G5FKC',
      recoveryCode: 'x'.repeat(56),
      kdf: { v: 1, alg: 'PBKDF2-HMAC-SHA-256', iters: 600_000, salt: toBase64(randomBytes(16)) },
      wrappedDmk: { iv: toBase64(randomBytes(12)), ct: toBase64(randomBytes(40)) },
    });
    expect(tolerant.ok).toBe(true);

    // But a missing/ragged wrappedDmk is INVALID_KEY_FILE.
    const bad = parseKeyFile({
      format: 'todo-key/1',
      createdAt: T0,
      keyId: '01ARZ3NDEKTSV4RRFFQ69G5FKC',
      recoveryCode: 'x'.repeat(56),
      kdf: { v: 1, alg: 'HKDF-SHA-256', info: 'todo-enc/1/recovery-kek' },
      wrappedDmk: { iv: 7, ct: null },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('INVALID_KEY_FILE');
  });
});
