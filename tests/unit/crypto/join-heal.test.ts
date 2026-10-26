/**
 * F4 (review) / ADR-007 D3.2+D3.3 — the ciphertext-blocked store: rows from
 * another device's ring quarantine HONESTLY on a never-enabled store (excluded
 * from reads, kept verbatim for the recovery file — never leaked through as
 * garbage "domain views"), and a device join adopts the key file, heals the
 * quarantine and clears the blocked signal.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { openForTests } from '../../../src/storage/db';
import type { AppDBImpl } from '../../../src/storage/db';
import { DEFAULT_SETTINGS, isEncryptedRecord } from '../../../src/domain/model';
import type { EncryptedTaskRecord, Task } from '../../../src/domain/model';
import { CryptoVault, registerVault } from '../../../src/crypto/vault';
import { mintKeyEntry } from '../../../src/crypto/keys';
import type { KeyEntry } from '../../../src/storage/types';
import { buildKeyFile, newRecoveryMaterial } from '../../../src/crypto/recovery';
import { foreignCiphertext } from '../../../src/crypto/foreignData';
import { resetRowCryptoSeam } from '../../../src/storage/cryptoSeam';
import { resetMergeCryptoSeam } from '../../../src/sync/mergeSeam';
import { makeTask } from '../storage/fixtures';

const T0 = 1_700_000_000_000;
const PASSPHRASE = 'correct horse battery staple';
const OTHER_PASSPHRASE = 'another device passphrase';
/** Fast mint for tests — the slot stores its own KDF parameters. */
const ITERS = 1000;

let clock = T0;

function now(): number {
  clock += 1000;
  return clock;
}

async function freshDb(name: string): Promise<AppDBImpl> {
  const created = await openForTests({ dbName: `${name}-${Math.random().toString(36).slice(2)}` });
  if (!created.ok) throw new Error('db open failed');
  return created.value;
}

type Minted = { keyId: string; entry: KeyEntry };

/** Mint a fast session key on the vault (the acting "device" ring). */
async function mintSession(vault: CryptoVault, passphrase: string): Promise<Minted> {
  const keyId = `key-${Math.random().toString(36).slice(2)}`;
  const minted = await mintKeyEntry({ keyId, passphrase, now: now(), iters: ITERS });
  if (!minted.ok) throw new Error('mint failed');
  vault.acceptSessionKey(keyId, minted.value.dmk);
  return { keyId, entry: minted.value.entry };
}

/** A device's emergency key file (passphrase + recovery slots over its DMK). */
async function keyFileOf(vault: CryptoVault, passphrase: string) {
  const keyId = `key-${Math.random().toString(36).slice(2)}`;
  const material = await newRecoveryMaterial();
  const minted = await mintKeyEntry({
    keyId,
    passphrase,
    recoverySecret: material.secret,
    now: now(),
    iters: ITERS,
  });
  if (!minted.ok || minted.value.recoveryWrap === null) throw new Error('mint failed');
  vault.acceptSessionKey(keyId, minted.value.dmk);
  return buildKeyFile({
    keyId,
    recoveryCode: material.code,
    wrappedDmk: minted.value.recoveryWrap,
    now: now(),
  });
}

/** One task encrypted under the vault's live session key. */
async function encryptedRow(vault: CryptoVault, title: string): Promise<EncryptedTaskRecord> {
  const sealed = await vault.encryptRecord('tasks', makeTask({ title, updatedAt: now() }));
  if (!sealed.ok) throw new Error('encrypt failed');
  return sealed.value as EncryptedTaskRecord;
}

/** Seed an at-rest (possibly encrypted) row — the seam passes ciphertext verbatim. */
async function putRaw(db: AppDBImpl, row: EncryptedTaskRecord | Task): Promise<void> {
  await db.put('tasks', row as Task);
}

/** Seam-processed read of every task row (domain views). */
async function readAllTasks(db: AppDBImpl): Promise<unknown[]> {
  const rows = await db.getAll('tasks');
  if (!rows.ok) throw new Error('getAll failed');
  return rows.value;
}

const titleOf = (row: unknown): string => (row as { title?: string }).title ?? '';

afterEach(() => {
  resetRowCryptoSeam();
  resetMergeCryptoSeam();
  foreignCiphertext.value = false;
});

describe('F4 — a never-enabled store quarantines foreign ciphertext honestly (D3.3)', () => {
  it('the pulled row is excluded from reads, kept verbatim, and raises the blocked signal', async () => {
    // Device A encrypts a task in its own store — the "other device" row.
    const dbA = await freshDb('quarantine-a');
    const vaultA = new CryptoVault({ now });
    await vaultA.attach(dbA);
    await mintSession(vaultA, PASSPHRASE);
    const foreign = await encryptedRow(vaultA, 'from another device');

    // Device B has NEVER enabled (status off) — the row pulls in from sync.
    const dbB = await freshDb('quarantine-b');
    const vaultB = new CryptoVault({ now });
    registerVault(vaultB);
    await vaultB.attach(dbB);
    await dbB.put('settings', { ...DEFAULT_SETTINGS, lastBackupAt: null });
    await dbB.put('tasks', makeTask({ title: 'local plaintext', updatedAt: now() }));
    await putRaw(dbB, foreign);

    const rows = await readAllTasks(dbB);
    expect(rows).toHaveLength(1);
    expect(titleOf(rows[0])).toBe('local plaintext');
    expect(isEncryptedRecord(rows[0])).toBe(false); // a domain view, not an envelope
    // Quarantined VERBATIM (recoverable — never dropped), and the blocked
    // signal the banner + join affordance read is up.
    expect(dbB.quarantineEntries.some((entry) => entry.key === foreign.id)).toBe(true);
    expect(foreignCiphertext.value).toBe(true);
  });
});

describe('F4 — device join heals the blocked store (D3.2/3.3)', () => {
  it('joining the other device’s key file makes the quarantined row readable and clears the signal', async () => {
    // Device C: its own store, its own ring — produces a real key file.
    const dbC = await freshDb('join-c');
    const vaultC = new CryptoVault({ now });
    await vaultC.attach(dbC);
    const fileC = await keyFileOf(vaultC, OTHER_PASSPHRASE);
    const foreign = await encryptedRow(vaultC, 'heal me');

    // Device B: encryption ON with its own key — the foreign row fails to
    // decrypt under every ring key (the mixed-store blocked state).
    const dbB = await freshDb('join-b');
    const vaultB = new CryptoVault({ now });
    registerVault(vaultB);
    await vaultB.attach(dbB);
    await dbB.put('settings', { ...DEFAULT_SETTINGS, lastBackupAt: T0 });
    const own = await mintSession(vaultB, PASSPHRASE);
    const seeded = await vaultB.saveState({
      status: 'on',
      enabledAt: T0,
      keys: [own.entry],
      lockAfterMinutes: 15,
    });
    expect(seeded.ok).toBe(true);
    await dbB.put('tasks', makeTask({ title: 'my own task', updatedAt: now() }));
    await putRaw(dbB, foreign);

    const blockedBefore = await readAllTasks(dbB);
    expect(blockedBefore.map(titleOf)).toEqual(['my own task']);
    expect(dbB.quarantineEntries.some((entry) => entry.key === foreign.id)).toBe(true);
    expect(foreignCiphertext.value).toBe(true);

    // D3.3's fix: adopt the other device's key file (local passphrase over the
    // same DMK — zero re-encryption).
    const joined = await vaultB.joinWithKeyFile(fileC, OTHER_PASSPHRASE);
    expect(joined.ok).toBe(true);

    expect(vaultB.status).toBe('on'); // a mixed-key store, still on
    expect(foreignCiphertext.value).toBe(false); // blocked signal cleared
    expect(dbB.quarantineEntries.some((entry) => entry.key === foreign.id)).toBe(false); // healed
    const after = await readAllTasks(dbB);
    expect(after.map(titleOf).sort()).toEqual(['heal me', 'my own task']);
  });

  it('a fresh (never-enabled) join flips the store to on — the joined device locks and encrypts', async () => {
    const dbC = await freshDb('join-c2');
    const vaultC = new CryptoVault({ now });
    await vaultC.attach(dbC);
    const fileC = await keyFileOf(vaultC, OTHER_PASSPHRASE);

    const dbB = await freshDb('join-b2');
    const vaultB = new CryptoVault({ now });
    registerVault(vaultB);
    await vaultB.attach(dbB); // status off — the never-enabled device
    await dbB.put('settings', { ...DEFAULT_SETTINGS, lastBackupAt: null });
    await dbB.put('tasks', makeTask({ title: 'plaintext before the join', updatedAt: now() }));

    const joined = await vaultB.joinWithKeyFile(fileC, PASSPHRASE);
    expect(joined.ok).toBe(true);

    // E10-Q3's behavior, asserted on an independent vault instance: status on,
    // locked after the fact, and fresh writes encrypt.
    expect(vaultB.status).toBe('on');
    expect(vaultB.isUnlocked).toBe(true);
    vaultB.lockNow();
    expect(vaultB.isUnlocked).toBe(false);
    const relocked = await vaultB.unlockWithPassphrase(PASSPHRASE);
    expect(relocked.ok).toBe(true);
    await dbB.put('tasks', makeTask({ title: 'encrypted after the join', updatedAt: now() }));
    const raw = await dbB.readUnfiltered('tasks');
    expect(raw.ok).toBe(true);
    if (raw.ok) {
      const fresh = raw.value.find((row) =>
        isEncryptedRecord(row)
          ? false
          : (row as { title?: string }).title === 'encrypted after the join',
      );
      // The domain view is fine; the AT-REST row must be ciphertext.
      expect(fresh).toBeUndefined();
      const encrypted = raw.value.find(
        (row) => (row as { payload?: string }).payload !== undefined,
      );
      expect(encrypted !== undefined && isEncryptedRecord(encrypted)).toBe(true);
    }
  });
});
