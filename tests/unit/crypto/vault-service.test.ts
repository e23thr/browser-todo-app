/**
 * C1 acceptance battery (ADR-007 testing contracts 3–7): unlock/lock flows,
 * the mechanical forced-backup gate, the enable/disable sweeps at the service
 * layer, and every failure path degrading WITHOUT silent data loss.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openForTests } from '../../../src/storage/db';
import type { AppDBImpl } from '../../../src/storage/db';
import { CRYPTO_KEY } from '../../../src/storage/schema';
import { DEFAULT_SETTINGS, type Task } from '../../../src/domain/model';
import { CryptoVault, registerVault } from '../../../src/crypto/vault';
import { backupGate, disableEncryption, enableEncryption } from '../../../src/crypto/service';
import { isEncryptedRecord } from '../../../src/domain/model';
import { makeTask } from '../storage/fixtures';

const T0 = 1_700_000_000_000;
const PASSPHRASE = 'correct horse battery staple';

let db: AppDBImpl;
let vault: CryptoVault;
let clock = T0;
const opened: AppDBImpl[] = [];

function now(): number {
  clock += 1000;
  return clock;
}

async function freshDb(): Promise<AppDBImpl> {
  const created = await openForTests({ dbName: `crypto-${Math.random().toString(36).slice(2)}` });
  if (!created.ok) throw new Error('db open failed');
  opened.push(created.value);
  return created.value;
}

beforeEach(async () => {
  clock = T0;
  db = await freshDb();
  vault = new CryptoVault({ now });
  await vault.attach(db);
  // The AppDB row seam is a global registration (one vault per tab) — tests
  // register their own instance, exactly like `initCryptoSeams` does in the app.
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

async function seedSettings(lastBackupAt: number | null): Promise<void> {
  await db.put('settings', { ...DEFAULT_SETTINGS, lastBackupAt });
}

async function seedTasks(titles: string[]): Promise<Task[]> {
  const rows: Task[] = [];
  for (const title of titles) {
    const task = makeTask({ title, updatedAt: now() });
    await db.put('tasks', task);
    rows.push(task);
  }
  return rows;
}

/** Enable with every gate satisfied; returns the service result. */
async function enableHappyPath(overrides: Partial<Parameters<typeof enableEncryption>[0]> = {}) {
  await seedSettings(T0 + 10);
  await seedTasks(['Buy milk', 'Walk dog']);
  return enableEncryption({
    db,
    vault,
    passphrase: PASSPHRASE,
    passphraseConfirm: PASSPHRASE,
    flowOpenedAt: T0,
    lostPassphraseAcknowledged: true,
    wantRecoveryKey: false,
    now,
    takePreMigrationSnapshot: async () => ({ ok: true, id: 'snap' }),
    ...overrides,
  });
}

/* ------------------------ contract 4: the forced-backup gate ------------------------ */

describe('forced-backup gate (Decision 6.1 step 1) — enabling without a fresh export is IMPOSSIBLE', () => {
  it('refuses with NO_BACKUP when no export receipt exists', async () => {
    await seedSettings(null);
    const result = await enableEncryption({
      db,
      vault,
      passphrase: PASSPHRASE,
      passphraseConfirm: PASSPHRASE,
      flowOpenedAt: T0,
      lostPassphraseAcknowledged: true,
      wantRecoveryKey: false,
      now,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NO_BACKUP');
    expect(vault.status).toBe('off'); // nothing enabled
  });

  it('a STALE receipt (before the flow opened) does not pass the gate', async () => {
    await seedSettings(T0 - 1); // exported BEFORE the wizard opened
    const gate = await backupGate(db, T0);
    expect(gate.ok).toBe(false);
    const result = await enableEncryption({
      db,
      vault,
      passphrase: PASSPHRASE,
      passphraseConfirm: PASSPHRASE,
      flowOpenedAt: T0,
      lostPassphraseAcknowledged: true,
      wantRecoveryKey: false,
      now,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NO_BACKUP');
  });

  it('a receipt exactly at flow-open time passes (lastBackupAt >= flowOpenedAt)', async () => {
    await seedSettings(T0);
    const gate = await backupGate(db, T0);
    expect(gate.ok).toBe(true);
  });

  it('policy rejections: unacknowledged warning and weak/mismatched passphrases', async () => {
    await seedSettings(T0 + 10);
    const base = {
      db,
      vault,
      flowOpenedAt: T0,
      wantRecoveryKey: false,
      now,
      takePreMigrationSnapshot: async () => ({ ok: true, id: 'snap' }),
    };
    const noAck = await enableEncryption({
      ...base,
      passphrase: PASSPHRASE,
      passphraseConfirm: PASSPHRASE,
      lostPassphraseAcknowledged: false,
    });
    expect(!noAck.ok && noAck.error.code).toBe('POLICY');
    const weak = await enableEncryption({
      ...base,
      passphrase: 'short',
      passphraseConfirm: 'short',
      lostPassphraseAcknowledged: true,
    });
    expect(!weak.ok && weak.error.code).toBe('POLICY');
    const mismatch = await enableEncryption({
      ...base,
      passphrase: PASSPHRASE,
      passphraseConfirm: 'something else entirely',
      lostPassphraseAcknowledged: true,
    });
    expect(!mismatch.ok && mismatch.error.code).toBe('POLICY');
  });
});

/* ------------------ contracts 1/3: unlock, wrong passphrase, re-lock ------------------ */

describe('unlock / lock flows (Decision 5/6.3)', () => {
  it('enable -> records encrypted at rest; wrong passphrase unlocks NOTHING and touches NOTHING', async () => {
    const enabled = await enableHappyPath();
    expect(enabled.ok).toBe(true);

    const rawRows = await db.readUnfiltered('tasks');
    expect(rawRows.ok).toBe(true);
    if (!rawRows.ok) return;
    expect(rawRows.value).toHaveLength(2);
    for (const row of rawRows.value) {
      expect(isEncryptedRecord(row)).toBe(true); // ciphertext at rest
      expect(JSON.stringify(row)).not.toContain('Buy milk'); // no plaintext leak
    }

    await vault.lock();
    expect(vault.isUnlocked).toBe(false);

    const wrong = await vault.unlockWithPassphrase('wrong passphrase entirely');
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.code).toBe('UNLOCK_FAILED');
    expect(vault.isUnlocked).toBe(false);
    // Slots untouched: the right passphrase still works after a wrong try.
    const right = await vault.unlockWithPassphrase(PASSPHRASE);
    expect(right.ok).toBe(true);
  });

  it('re-lock drops the key AND the decrypted view (read seam returns raw rows while locked)', async () => {
    await enableHappyPath();
    const view = await db.getAll('tasks');
    expect(view.ok).toBe(true);
    if (view.ok) {
      expect((view.value[0] as Task).title).toBe('Buy milk'); // decrypted view
    }
    await vault.lock();
    const lockedView = await db.getAll('tasks');
    expect(lockedView.ok).toBe(true);
    if (lockedView.ok) {
      // Raw at-rest rows pass through (envelope ops keep working; the UI is on
      // the locked screen) — no decrypted content is handed out.
      expect((lockedView.value[0] as { title?: string }).title).toBeUndefined();
      expect(isEncryptedRecord(lockedView.value[0])).toBe(true);
    }
    // Re-lock state is a first-class signal (Decision 5.1).
    const { lockState } = await import('../../../src/crypto/lock');
    expect(lockState.value.status).toBe('locked');
  });

  it('a plaintext write while locked is REFUSED — never silently stored', async () => {
    await enableHappyPath();
    await vault.lock();
    const write = await db.put('tasks', makeTask({ title: 'sneaky' }));
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.error.code).toBe('BLOCKED');
    const raw = await db.readUnfiltered('tasks');
    expect(raw.ok && raw.value.some((r) => JSON.stringify(r).includes('sneaky'))).toBe(false);
  });

  it('tombstoning while locked works (verbatim envelope write — Decision 8.2)', async () => {
    await enableHappyPath();
    const rows = await db.readUnfiltered('tasks');
    const target = (rows.ok ? rows.value : [])[0] as Task;
    await vault.lock();
    const tomb = await db.put('tasks', {
      ...target,
      deletedAt: T0 + 999,
      updatedAt: T0 + 999,
    });
    expect(tomb.ok).toBe(true);
    const after = await db.readUnfiltered('tasks');
    const found = (after.ok ? after.value : []).find((r) => r.id === target.id) as
      { deletedAt: number | null } | undefined;
    expect(found?.deletedAt).toBe(T0 + 999);
  });
});

/* ------------------------ recovery key + wrong-key-domain paths ------------------------ */

describe('recovery key (Decision 3.1) and wrong-key-domain (Decision 9)', () => {
  it('recovery-code unlock + passphrase change re-wraps ONE key (records untouched)', async () => {
    await seedSettings(T0 + 10);
    await seedTasks(['Keep me']);
    const enabled = await enableEncryption({
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
    expect(enabled.ok).toBe(true);
    if (!enabled.ok) return;
    expect(enabled.value.recovery).not.toBeNull();
    const before = await db.readUnfiltered('tasks');

    // Lose the passphrase: recovery code unlocks, then a NEW passphrase re-wraps.
    await vault.lock();
    const viaCode = await vault.unlockWithRecoveryCode(enabled.value.recovery!.code);
    expect(viaCode.ok).toBe(true);
    const changed = await vault.changePassphrase('a brand new long passphrase');
    expect(changed.ok).toBe(true);
    await vault.lock();
    const oldPass = await vault.unlockWithPassphrase(PASSPHRASE);
    expect(oldPass.ok).toBe(false); // old slot replaced
    const newPass = await vault.unlockWithPassphrase('a brand new long passphrase');
    expect(newPass.ok).toBe(true);
    const after = await db.readUnfiltered('tasks');
    expect(after.ok && after.value).toEqual(before.ok ? before.value : []);
  });

  it('a well-formed key from another store fails with WRONG_KEY_DOMAIN — nothing touched', async () => {
    await enableHappyPath();
    const otherDb = await freshDb();
    const otherVault = new CryptoVault({ now });
    await otherVault.attach(otherDb);
    await otherDb.put('settings', { ...DEFAULT_SETTINGS, lastBackupAt: clock + 10 });
    const foreign = await enableEncryption({
      db: otherDb,
      vault: otherVault,
      passphrase: PASSPHRASE,
      passphraseConfirm: PASSPHRASE,
      flowOpenedAt: T0,
      lostPassphraseAcknowledged: true,
      wantRecoveryKey: true,
      now,
      takePreMigrationSnapshot: async () => ({ ok: true, id: 'snap' }),
    });
    expect(foreign.ok).toBe(true);
    if (!foreign.ok) return;
    await vault.lock();
    const tried = await vault.unlockWithKeyFile(foreign.value.recovery!.keyFile);
    expect(tried.ok).toBe(false);
    if (!tried.ok) expect(tried.error.code).toBe('WRONG_KEY_DOMAIN');
    expect(vault.isUnlocked).toBe(false);
  });
});

/* ------------------------- failure paths: quarantine, never loss ------------------------- */

describe('corrupt ciphertext (Decision 9): quarantine, never a silent drop', () => {
  it('a tampered payload is excluded from reads, kept verbatim, downloadable, purge-only', async () => {
    await enableHappyPath();
    const raw = await db.readUnfiltered('tasks');
    const victim = (raw.ok ? raw.value : [])[0] as unknown as { id: string; payload: string };
    // Corrupt the ciphertext bytes in place (simulates on-disk damage).
    const damaged = `${victim.payload[0] === 'A' ? 'B' : 'A'}${victim.payload.slice(1)}`;
    await db.putRaw('tasks', {
      ...(raw.ok ? raw.value[0] : {}),
      payload: damaged,
    } as unknown as Task);

    const view = await db.getAll('tasks');
    expect(view.ok).toBe(true);
    if (view.ok) {
      expect(view.value.some((r) => r.id === victim.id)).toBe(false); // excluded from reads
    }
    // Non-destructive: the bytes are still in the DB and in the recovery file.
    const kept = await db.readUnfiltered('tasks');
    expect(kept.ok && kept.value.some((r) => r.id === victim.id)).toBe(true);
    const file = db.quarantine.recoveryFile();
    expect(file.json).toContain(victim.id);
    expect(db.quarantine.list().length).toBeGreaterThanOrEqual(1);
    // Explicit purge is the only way the row leaves (and it is announced).
    const purged = await db.quarantine.purge();
    expect(purged.ok).toBe(true);
  });

  it('an oversized decrypted field quarantines at read time (caps enforced post-decrypt)', async () => {
    await enableHappyPath();
    const raw = await db.readUnfiltered('tasks');
    const row = (raw.ok ? raw.value[0] : undefined) as unknown as Task & {
      enc: unknown;
      payload: string;
    };
    const view = await vault.decryptRecord('tasks', row as never);
    expect(view.ok).toBe(true);
    if (!view.ok || view.value === undefined) return;
    // Build a validly-encrypted row whose decrypted title violates the cap.
    const oversized = { ...(view.value as Task), title: 'x'.repeat(1001) };
    const sealed = await vault.encryptRecord('tasks', oversized);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    await db.putRaw('tasks', sealed.value as unknown as Task);
    const after = await db.getAll('tasks');
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.value.some((r) => r.id === row.id)).toBe(false); // quarantined
    }
    const kept = await db.readUnfiltered('tasks');
    expect(kept.ok && kept.value.some((r) => r.id === row.id)).toBe(true); // never dropped
  });
});

/* ---------------------------- disable (Decision 6.2) ---------------------------- */

describe('disable (Decision 6.2): decrypt-all, then keys wiped', () => {
  it('round-trips back to plaintext rows and refuses a wrong confirmation', async () => {
    await enableHappyPath();
    const wrongConfirm = await disableEncryption({
      db,
      vault,
      passphrase: 'not the passphrase',
      now,
    });
    expect(wrongConfirm.ok).toBe(false);
    if (!wrongConfirm.ok) expect(wrongConfirm.error.code).toBe('UNLOCK_FAILED');
    expect(vault.status).toBe('on'); // still enabled

    const disabled = await disableEncryption({ db, vault, passphrase: PASSPHRASE, now });
    expect(disabled.ok).toBe(true);
    expect(vault.status).toBe('off');
    const raw = await db.readUnfiltered('tasks');
    expect(raw.ok).toBe(true);
    if (raw.ok) {
      for (const row of raw.value) {
        expect(isEncryptedRecord(row)).toBe(false); // plaintext again
        expect(row.title.length).toBeGreaterThan(0);
      }
    }
    const state = await db.get('crypto_state', CRYPTO_KEY);
    expect(state.ok && state.value?.keys).toEqual([]);
  });
});

/* ------------------- snapshot payload wrapping (Decision 4.4) ------------------- */

describe('snapshot payloads (Decision 4.4)', () => {
  it('wrap at rest when on, unwrap to the exact JSON, and pass plaintext payloads through', async () => {
    const json = '{"format":"todo-backup/1","hello":"world"}';
    // Before enable: passthrough (C1 off).
    const plain = await vault.wrapSnapshotPayload('snap-1', json);
    expect(plain.ok && plain.value).toBe(json);

    await enableHappyPath();
    const wrapped = await vault.wrapSnapshotPayload('snap-2', json);
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;
    expect(wrapped.value).not.toContain('world'); // no user text at rest
    expect(JSON.parse(wrapped.value).format).toBe('todo-enc/1');
    const opened = await vault.unwrapSnapshotPayload('snap-2', wrapped.value);
    expect(opened.ok && opened.value).toBe(json);
    // The legacy plaintext payload still passes through the open path.
    const legacy = await vault.unwrapSnapshotPayload('snap-1', json);
    expect(legacy.ok && legacy.value).toBe(json);
  });
});
