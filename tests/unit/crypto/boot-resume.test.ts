/**
 * F1b (review F1) — boot/unlock resume through the PRODUCTION path (D7.1):
 * a persisted `migrating` store reaches `status: 'on'` through
 * `initCryptoForApp` + the app's own unlock/refresh sequence, with
 * `resumeMigration` never called directly: it must not be a test-only
 * function (the E10-Q1 pin proves the vault-level path; this file proves the
 * WIRING — seams attach, the singleton vault, `refreshAfterUnlock`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openForTests } from '../../../src/storage/db';
import type { AppDBImpl } from '../../../src/storage/db';
import { CRYPTO_KEY } from '../../../src/storage/schema';
import { DEFAULT_SETTINGS, isEncryptedRecord } from '../../../src/domain/model';
import { vault as appVault } from '../../../src/crypto/vault';
import { mintKeyEntry } from '../../../src/crypto/keys';
import { sweepRemaining } from '../../../src/crypto/migrate';
import { migrationRun } from '../../../src/crypto/service';
import {
  initCryptoForApp,
  refreshAfterUnlock,
  resumeMigrationFlow,
} from '../../../src/features/crypto/wiring';
import { resetRowCryptoSeam } from '../../../src/storage/cryptoSeam';
import { resetMergeCryptoSeam } from '../../../src/sync/mergeSeam';
import { makeTask } from '../storage/fixtures';

const T0 = 1_700_000_000_000;
const PASSPHRASE = 'correct horse battery staple';
/** Fast mint for seeds — the slot stores its own KDF parameters. */
const KEY_ITERS = 1000;

let db: AppDBImpl;
let clock = T0;

function now(): number {
  clock += 1000;
  return clock;
}

async function freshDb(): Promise<AppDBImpl> {
  const created = await openForTests({
    dbName: `boot-resume-${Math.random().toString(36).slice(2)}`,
  });
  if (!created.ok) throw new Error('db open failed');
  return created.value;
}

/** Seed mid-enable: `status: 'migrating'` + persisted ring + plaintext rows left to sweep. */
async function seedMigrating(titles: string[]): Promise<void> {
  await db.put('settings', { ...DEFAULT_SETTINGS, lastBackupAt: T0 + 10 });
  const keyId = `key-${Math.random().toString(36).slice(2)}`;
  const minted = await mintKeyEntry({ keyId, passphrase: PASSPHRASE, now: T0, iters: KEY_ITERS });
  if (!minted.ok) throw new Error('mint failed');
  appVault.acceptSessionKey(keyId, minted.value.dmk);
  const saved = await appVault.saveState({
    status: 'migrating',
    enabledAt: T0,
    migration: { startedAt: T0, done: 0, total: titles.length, direction: 'encrypt' },
    keys: [minted.value.entry],
    lockAfterMinutes: 15,
  });
  if (!saved.ok) throw new Error('seed saveState failed');
  for (const title of titles) {
    await db.put('tasks', makeTask({ title, updatedAt: now() }));
  }
}

beforeEach(async () => {
  db = await freshDb();
  await initCryptoForApp(db); // production wiring: seams + the singleton vault attach
  migrationRun.value = { phase: 'idle', done: 0, total: 0, code: null, message: null };
});

afterEach(() => {
  appVault.lockNow();
  resetRowCryptoSeam();
  resetMergeCryptoSeam();
});

describe('F1b — a crashed migrating store completes on the app unlock path (D7.1)', () => {
  it('unlock (after a simulated reboot) finishes the sweep — no direct resumeMigration call', async () => {
    await seedMigrating(['alpha', 'bravo']);
    appVault.lockNow(); // the crash boundary: memory-only keys are gone
    await appVault.attach(db); // the reboot: state re-read from the store

    const unlocked = await appVault.unlockWithPassphrase(PASSPHRASE);
    expect(unlocked.ok).toBe(true);

    expect(appVault.status).toBe('on');
    expect(appVault.state?.migration ?? null).toBeNull();
    expect(await sweepRemaining(db, 'encrypt')).toBe(0);
    const rows = await db.readUnfiltered('tasks');
    expect(rows.ok).toBe(true);
    if (rows.ok) for (const row of rows.value) expect(isEncryptedRecord(row)).toBe(true);
  });

  it('an in-session pause resumes through refreshAfterUnlock (the UI flow) and lands on', async () => {
    await seedMigrating(['charlie']);
    // Session key still live — a QUOTA-style pause that survived in-session.
    refreshAfterUnlock(); // notify + resume flow (fire-and-forget by design)
    for (let i = 0; i < 100 && appVault.status === 'migrating'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(appVault.status).toBe('on');
    expect(migrationRun.value.phase).toBe('idle');
  });

  it('resumeMigrationFlow resolves null when there is nothing to migrate', async () => {
    const nothing = await resumeMigrationFlow(db);
    expect(nothing.ok).toBe(true);
    if (nothing.ok) expect(nothing.value).toBeNull();
  });

  it('the seed is honest: crypto_state really was migrating before the unlock', async () => {
    await seedMigrating(['delta']);
    appVault.lockNow();
    await appVault.attach(db);
    const read = await db.get('crypto_state', CRYPTO_KEY);
    expect(read.ok && read.value?.status).toBe('migrating');
    expect(appVault.status).toBe('migrating');
    expect(appVault.isUnlocked).toBe(false);
  });
});
