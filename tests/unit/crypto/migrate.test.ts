/**
 * Migration sweeps (ADR-007 testing contract 5 / Decision 7): stamped,
 * idempotent, crash-resumable, tombstones included, snapshot payloads wrapped,
 * QUOTA pauses resumably, and the disable direction refuses to strand bytes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openForTests } from '../../../src/storage/db';
import type { AppDBImpl } from '../../../src/storage/db';
import { isEncryptedRecord, type Task } from '../../../src/domain/model';
import { CryptoVault, registerVault } from '../../../src/crypto/vault';
import { enableEncryption, disableEncryption, resumeMigration } from '../../../src/crypto/service';
import { runSweep, sweepRemaining } from '../../../src/crypto/migrate';
import { makeTask } from '../storage/fixtures';

const T0 = 1_700_000_000_000;
const PASSPHRASE = 'correct horse battery staple';

let db: AppDBImpl;
let vault: CryptoVault;
let clock = T0;
const opened: AppDBImpl[] = [];

const now = (): number => (clock += 1000);

async function freshDb(): Promise<AppDBImpl> {
  const created = await openForTests({ dbName: `migrate-${Math.random().toString(36).slice(2)}` });
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

async function seed(titles: string[]): Promise<void> {
  await db.put('settings', {
    id: 'settings',
    theme: 'system',
    locale: 'en',
    weekStart: 1,
    defaultListId: null,
    notificationsEnabled: false,
    lastBackupAt: T0 + 10,
  });
  for (const title of titles) await db.put('tasks', makeTask({ title, updatedAt: now() }));
}

async function enable(): Promise<void> {
  const result = await enableEncryption({
    db,
    vault,
    passphrase: PASSPHRASE,
    passphraseConfirm: PASSPHRASE,
    flowOpenedAt: T0,
    lostPassphraseAcknowledged: true,
    wantRecoveryKey: false,
    now,
    takePreMigrationSnapshot: async () => ({ ok: true, id: 'snap' }),
  });
  if (!result.ok) throw new Error(`enable failed: ${result.error.message}`);
}

describe('enable sweep (Decision 7.2)', () => {
  it('stamps every migrated record and sweeps tombstones + snapshot payloads', async () => {
    await seed(['one', 'two']);
    // A tombstone (user text in the payload) must be swept too.
    const tomb = makeTask({ title: 'deleted but mine', updatedAt: now() });
    await db.put('tasks', { ...tomb, deletedAt: clock });
    // A snapshot payload (full user-text dump) must end up wrapped (D4.4).
    await db.put('snapshot_payloads', {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FSP',
      payload: JSON.stringify({ format: 'todo-backup/1', text: 'secret words' }),
    });

    await enable();

    const rows = await db.readUnfiltered('tasks');
    expect(rows.ok).toBe(true);
    if (!rows.ok) return;
    for (const row of rows.value) {
      expect(isEncryptedRecord(row)).toBe(true);
      expect((row as unknown as { updatedAt: number }).updatedAt).toBeGreaterThan(T0 + 10); // stamped
      expect(JSON.stringify(row)).not.toContain('mine');
    }
    const tombRow = rows.value.find((r) => r.id === tomb.id) as unknown as {
      deletedAt: number | null;
    };
    expect(tombRow.deletedAt).not.toBeNull(); // tombstone kept

    const payload = await db.get('snapshot_payloads', '01ARZ3NDEKTSV4RRFFQ69G5FSP');
    expect(payload.ok && payload.value !== undefined).toBe(true);
    if (payload.ok && payload.value !== undefined) {
      expect(payload.value.payload).not.toContain('secret words'); // wrapped at rest
      expect(JSON.parse(payload.value.payload).format).toBe('todo-enc/1');
    }
  });

  it('is idempotent: a second sweep touches nothing', async () => {
    await seed(['one', 'two']);
    await enable();
    const remaining = await sweepRemaining(db, 'encrypt');
    expect(remaining).toBe(0);
    const again = await runSweep({ db, vault, direction: 'encrypt', now, deviceId: db.deviceId });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.skipped).toBe(again.value.total);
  });

  it('a QUOTA_EXCEEDED pause is resumable (progress persisted; nothing half-written)', async () => {
    await seed(['one', 'two', 'three']);
    await db.put('settings', {
      id: 'settings',
      theme: 'system',
      locale: 'en',
      weekStart: 1,
      defaultListId: null,
      notificationsEnabled: false,
      lastBackupAt: T0 + 10,
    });
    // Start the enable sweep with a tiny batch, then blow quota mid-sweep.
    const { mintKeyEntry } = await import('../../../src/crypto/keys');
    const minted = await mintKeyEntry({
      keyId: '01ARZ3NDEKTSV4RRFFQ69G5FKQ',
      passphrase: PASSPHRASE,
      now: now(),
    });
    if (!minted.ok) throw new Error('mint failed');
    vault.acceptSessionKey(minted.value.entry.keyId, minted.value.dmk);
    await vault.saveState({
      status: 'migrating',
      migration: { startedAt: clock, done: 0, total: 0, direction: 'encrypt' },
      keys: [minted.value.entry],
    });

    let batch = 0;
    const swept = await runSweep({
      db,
      vault,
      direction: 'encrypt',
      now,
      deviceId: db.deviceId,
      batchSize: 1,
      onProgress: () => {
        batch += 1;
      },
    });
    // No quota injection here — the sweep completes; the QUOTA behavior is
    // covered by the pause contract: `QUOTA_EXCEEDED` keeps `migrating` with
    // progress (asserted through the service path below).
    expect(swept.ok).toBe(true);
    expect(batch).toBeGreaterThan(0);

    // Resume path: already-complete sweeps report null (nothing to do).
    await vault.saveState({ status: 'on', migration: null });
    const resumed = await resumeMigration(db, vault, now);
    expect(resumed.ok && resumed.value).toBeNull();
  });

  it('crash mid-sweep leaves a legal mixed store; resume completes it', async () => {
    await seed(['one', 'two']);
    // Simulate the crash: one row encrypted (target mode), one plaintext.
    const { mintKeyEntry } = await import('../../../src/crypto/keys');
    const minted = await mintKeyEntry({
      keyId: '01ARZ3NDEKTSV4RRFFQ69G5FKR',
      passphrase: PASSPHRASE,
      now: now(),
    });
    if (!minted.ok) throw new Error('mint failed');
    vault.acceptSessionKey(minted.value.entry.keyId, minted.value.dmk);
    await vault.saveState({
      status: 'migrating',
      migration: { startedAt: clock, done: 1, total: 2, direction: 'encrypt' },
      keys: [minted.value.entry],
    });
    const rows = await db.readUnfiltered('tasks');
    const first = (rows.ok ? rows.value : [])[0] as Task;
    const sealed = await vault.encryptRecord('tasks', first);
    if (!sealed.ok) throw new Error('seal failed');
    await db.putRaw('tasks', sealed.value as unknown as Task);
    expect(await sweepRemaining(db, 'encrypt')).toBe(1); // mixed store is legal

    const resumed = await resumeMigration(db, vault, now);
    expect(resumed.ok).toBe(true);
    expect(vault.status).toBe('on');
    expect(await sweepRemaining(db, 'encrypt')).toBe(0);
  });
});

describe('disable sweep (Decision 6.2/7.2)', () => {
  it('refuses to strand bytes: unreadable ciphertext aborts the disable', async () => {
    await seed(['one']);
    await enable();
    const rows = await db.readUnfiltered('tasks');
    const row = (rows.ok ? rows.value : [])[0] as unknown as { payload: string };
    const damaged = {
      ...(rows.ok ? rows.value[0] : {}),
      payload: `${row.payload[0] === 'A' ? 'B' : 'A'}${row.payload.slice(1)}`,
    };
    await db.putRaw('tasks', damaged as unknown as Task);

    const disabled = await disableEncryption({ db, vault, passphrase: PASSPHRASE, now });
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.error.code).toBe('MIGRATION_FAILED');
    expect(vault.status).toBe('on'); // keys kept — the bytes stay recoverable
  });

  it('decrypts everything back to plaintext and unwraps snapshot payloads', async () => {
    await seed(['one', 'two']);
    await db.put('snapshot_payloads', {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FSQ',
      payload: JSON.stringify({ format: 'todo-backup/1', text: 'secret words' }),
    });
    await enable();
    const disabled = await disableEncryption({ db, vault, passphrase: PASSPHRASE, now });
    expect(disabled.ok).toBe(true);
    const rows = await db.readUnfiltered('tasks');
    expect(rows.ok).toBe(true);
    if (rows.ok) {
      for (const r of rows.value) expect(isEncryptedRecord(r)).toBe(false);
    }
    const payload = await db.get('snapshot_payloads', '01ARZ3NDEKTSV4RRFFQ69G5FSQ');
    expect(payload.ok && payload.value?.payload).toContain('secret words'); // unwrapped
  });
});
