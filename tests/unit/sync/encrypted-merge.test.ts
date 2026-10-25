/**
 * Encrypted-record + sync convergence (ADR-007 Decision 8 — testing contract
 * 6 + the impl card's acceptance criterion 3): LWW and conflict copies survive
 * encryption; tombstones propagate while LOCKED; a plan needing copies defers
 * `LOCKED` while a zero-copy plan applies; nothing is ever silently lost.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EncryptedTaskRecord, Task } from '../../../src/domain/model';
import { isEncryptedRecord } from '../../../src/domain/model';
import { planMerge, conflictCopyOf } from '../../../src/sync/merge';
import { setMergeCryptoSeam, resetMergeCryptoSeam } from '../../../src/sync/mergeSeam';
import { CryptoVault } from '../../../src/crypto/vault';
import { makeTask } from '../storage/fixtures';
import type { ShadowEntry } from '../../../src/sync/shadow';

const DEVICE_A = '01ARZ3NDEKTSV4RRFFQ69G5FAA';
const DEVICE_B = '01ARZ3NDEKTSV4RRFFQ69G5FBB';
const TASK_ID = '01ARZ3NDEKTSV4RRFFQ69G5FT1';

let vault: CryptoVault;
let clock = 2_000;
const now = (): number => (clock += 100);

async function encryptedTask(
  view: Partial<Task> & { id: string; updatedAt: number; deviceId: string },
): Promise<EncryptedTaskRecord> {
  const full = {
    ...makeTask({ title: 'Buy milk', notes: null, tags: [] }),
    ...view,
  };
  const sealed = await vault.encryptRecord('tasks', full);
  if (!sealed.ok) throw new Error('seal failed');
  return sealed.value as EncryptedTaskRecord;
}

beforeEach(() => {
  clock = 2_000;
  vault = new CryptoVault({ now });
});

afterEach(() => {
  resetMergeCryptoSeam();
});

/** Mint a real DMK into the vault through the public enable-less path. */
async function unlockVault(): Promise<void> {
  const { mintKeyEntry } = await import('../../../src/crypto/keys');
  const minted = await mintKeyEntry({
    keyId: '01ARZ3NDEKTSV4RRFFQ69G5FK1',
    passphrase: 'correct horse battery staple',
    now: clock,
    iters: 1000, // test speed only — production pins 600k (contract 1 covers params)
  });
  if (!minted.ok) throw new Error('mint failed');
  vault.acceptSessionKey(minted.value.entry.keyId, minted.value.dmk);
  setMergeCryptoSeam(vault.mergeSeam);
}

describe('encrypted merge convergence (Decision 8)', () => {
  it('LWW applies over ciphertext and a concurrent edit materializes ONE decryptable conflict copy', async () => {
    await unlockVault();
    const local = await encryptedTask({
      id: TASK_ID,
      title: 'Buy oat milk',
      updatedAt: 2_000,
      deviceId: DEVICE_A,
    });
    const remote = await encryptedTask({
      id: TASK_ID,
      title: 'Buy milk',
      notes: 'soy',
      updatedAt: 2_100,
      deviceId: DEVICE_B,
    });

    const planned = await planMerge({
      localLists: [],
      localTasks: [local],
      fetched: [{ kind: 'task', record: remote }],
      shadow: {
        [TASK_ID]: {
          updatedAt: 1_000,
          deviceId: DEVICE_A,
          contentHash: '0'.repeat(64),
        } satisfies ShadowEntry,
      },
      deviceId: DEVICE_A,
      now: 3_000,
      newId: () => '01ARZ3NDEKTSV4RRFFQ69G5FC1',
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    // The REMOTE wins the id (LWW) — its ciphertext lands verbatim.
    expect(planned.value.puts).toHaveLength(1);
    expect(isEncryptedRecord(planned.value.puts[0])).toBe(true);
    expect(planned.value.puts[0]?.updatedAt).toBe(2_100);

    // Exactly ONE visible copy of the displaced local edit — decryptable and
    // re-encrypted under the NEW id (fresh IV, new AAD).
    expect(planned.value.copies).toHaveLength(1);
    const copy = planned.value.copies[0]!;
    expect(isEncryptedRecord(copy.row)).toBe(true);
    expect((copy.row as EncryptedTaskRecord).id).toBe('01ARZ3NDEKTSV4RRFFQ69G5FC1');
    expect((copy.row as EncryptedTaskRecord).enc.iv).not.toBe(local.enc.iv);
    const view = await vault.decryptRecord('tasks', copy.row as never);
    expect(view.ok && (view.value as Task).title).toBe('Conflict copy of Buy oat milk');
  });

  it('tombstone-vs-edit: the tombstone wins the id; the edit survives as the copy', async () => {
    await unlockVault();
    const tombstone = await encryptedTask({
      id: TASK_ID,
      title: 'Buy milk',
      updatedAt: 2_500,
      deviceId: DEVICE_B,
      deletedAt: 2_500,
    });
    const localEdit = await encryptedTask({
      id: TASK_ID,
      title: 'Buy oat milk',
      notes: 'soy',
      updatedAt: 2_400,
      deviceId: DEVICE_A,
    });
    const planned = await planMerge({
      localLists: [],
      localTasks: [localEdit],
      fetched: [{ kind: 'task', record: tombstone }],
      shadow: {
        [TASK_ID]: { updatedAt: 1_000, deviceId: DEVICE_A, contentHash: '0'.repeat(64) },
      },
      deviceId: DEVICE_A,
      now: 3_000,
      newId: () => '01ARZ3NDEKTSV4RRFFQ69G5FC2',
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.puts[0]?.deletedAt).toBe(2_500); // tombstone outcome
    expect(planned.value.copies).toHaveLength(1); // the edit is never lost
  });

  it('a zero-copy plan applies while LOCKED (tombstone propagation — Decision 8.2/8.4)', async () => {
    await unlockVault();
    const local = await encryptedTask({
      id: TASK_ID,
      title: 'Buy milk',
      updatedAt: 1_000,
      deviceId: DEVICE_A,
      deletedAt: 1_000,
    });
    const remote = await encryptedTask({
      id: TASK_ID,
      title: 'Buy milk',
      updatedAt: 1_100,
      deviceId: DEVICE_B,
      deletedAt: 1_100,
    });
    await vault.lock(); // LOCKED: pure-envelope merge must still run
    const planned = await planMerge({
      localLists: [],
      localTasks: [local],
      fetched: [{ kind: 'task', record: remote }],
      shadow: {
        [TASK_ID]: { updatedAt: 1_000, deviceId: DEVICE_A, contentHash: 'x' },
      },
      deviceId: DEVICE_A,
      now: 3_000,
      newId: () => '01ARZ3NDEKTSV4RRFFQ69G5FC3',
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.copies).toHaveLength(0);
    expect(planned.value.puts[0]?.deletedAt).toBe(1_100); // newer tombstone wins
  });

  it('a plan needing ≥1 copy while LOCKED defers with LOCKED — NO partial apply (Decision 8.4)', async () => {
    await unlockVault();
    const local = await encryptedTask({
      id: TASK_ID,
      title: 'Buy oat milk',
      updatedAt: 2_000,
      deviceId: DEVICE_A,
    });
    const remote = await encryptedTask({
      id: TASK_ID,
      title: 'Buy milk',
      updatedAt: 2_100,
      deviceId: DEVICE_B,
    });
    await vault.lock();
    const planned = await planMerge({
      localLists: [],
      localTasks: [local],
      fetched: [{ kind: 'task', record: remote }],
      shadow: {
        [TASK_ID]: { updatedAt: 1_000, deviceId: DEVICE_A, contentHash: '0'.repeat(64) },
      },
      deviceId: DEVICE_A,
      now: 3_000,
      newId: () => '01ARZ3NDEKTSV4RRFFQ69G5FC4',
    });
    expect(planned.ok).toBe(false); // the WHOLE run defers
    if (!planned.ok) {
      expect(planned.error.code).toBe('LOCKED');
      expect(planned.error.retryable).toBe(true);
    }
    // Unlocked, the same input plans cleanly (resume is idempotent from cursors).
    await unlockVault();
    const resumed = await planMerge({
      localLists: [],
      localTasks: [local],
      fetched: [{ kind: 'task', record: remote }],
      shadow: {
        [TASK_ID]: { updatedAt: 1_000, deviceId: DEVICE_A, contentHash: '0'.repeat(64) },
      },
      deviceId: DEVICE_A,
      now: 3_100,
      newId: () => '01ARZ3NDEKTSV4RRFFQ69G5FC5',
    });
    expect(resumed.ok && resumed.value.copies).toHaveLength(1);
  });

  it('identical-edit degradation: same edit, different ciphertext -> conflict copy (safe direction)', async () => {
    await unlockVault();
    const base = { id: TASK_ID, title: 'Buy oat milk', updatedAt: 2_000 };
    const a = await encryptedTask({ ...base, deviceId: DEVICE_A });
    const b = await encryptedTask({ ...base, updatedAt: 2_001, deviceId: DEVICE_B });
    const planned = await planMerge({
      localLists: [],
      localTasks: [a],
      fetched: [{ kind: 'task', record: b }],
      shadow: {
        [TASK_ID]: { updatedAt: 1_000, deviceId: DEVICE_A, contentHash: '0'.repeat(64) },
      },
      deviceId: DEVICE_A,
      now: 3_000,
      newId: () => '01ARZ3NDEKTSV4RRFFQ69G5FC6',
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    // Same content, DIFFERENT ciphertext -> payloadHash differs -> the shadow
    // cannot demote to "same change" -> a copy (Decision 8.5: safe direction).
    expect(planned.value.copies).toHaveLength(1);
  });

  it('an UNDECRYPTABLE loser is preserved verbatim under the new id (never a silent drop)', async () => {
    await unlockVault();
    const local = await encryptedTask({
      id: TASK_ID,
      title: 'Buy oat milk',
      updatedAt: 2_000,
      deviceId: DEVICE_A,
    });
    // Corrupt the losing ciphertext AFTER sealing (simulates on-disk damage).
    const corruptLoser = {
      ...local,
      payload: `${local.payload[0] === 'A' ? 'B' : 'A'}${local.payload.slice(1)}`,
    } as EncryptedTaskRecord;
    const remote = await encryptedTask({
      id: TASK_ID,
      title: 'Buy milk',
      updatedAt: 2_100,
      deviceId: DEVICE_B,
    });
    const planned = await planMerge({
      localLists: [],
      localTasks: [corruptLoser],
      fetched: [{ kind: 'task', record: remote }],
      shadow: {
        [TASK_ID]: { updatedAt: 1_000, deviceId: DEVICE_A, contentHash: '0'.repeat(64) },
      },
      deviceId: DEVICE_A,
      now: 3_000,
      newId: () => '01ARZ3NDEKTSV4RRFFQ69G5FC7',
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.copies).toHaveLength(1);
    const copy = planned.value.copies[0]!.row as EncryptedTaskRecord;
    // The raw bytes SURVIVE under the new id (quarantined on read, recoverable).
    expect(copy.payload).toBe(corruptLoser.payload);
    expect(copy.id).toBe('01ARZ3NDEKTSV4RRFFQ69G5FC7');
    expect(copy.deletedAt).toBeNull();
  });

  it('plaintext stores keep the pure plaintext copy path (no seam required)', async () => {
    const local = { ...makeTask({ title: 'Buy oat milk' }), updatedAt: 2_000, deviceId: DEVICE_A };
    const remote = {
      ...makeTask({ id: local.id, title: 'Buy milk' }),
      updatedAt: 2_100,
      deviceId: DEVICE_B,
    };
    const planned = await planMerge({
      localLists: [],
      localTasks: [local],
      fetched: [{ kind: 'task', record: remote }],
      shadow: {
        [local.id]: { updatedAt: 1_000, deviceId: DEVICE_A, contentHash: '0'.repeat(64) },
      },
      deviceId: DEVICE_A,
      now: 3_000,
      newId: () => '01ARZ3NDEKTSV4RRFFQ69G5FC8',
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const copy = planned.value.copies[0]!.row as Task;
    expect(copy.title).toBe(conflictCopyOf(local, 'x', 0, '').title);
  });
});
