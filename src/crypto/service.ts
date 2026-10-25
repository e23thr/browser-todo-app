/**
 * The C1 enable/disable service (ADR-007 Decision 6 — §7.3's UX constraints
 * implemented EXACTLY and enforced MECHANICALLY, never by copy alone):
 *
 * 1. FORCED BACKUP (hard gate): `enableEncryption` refuses with `NO_BACKUP`
 *    unless `settings.lastBackupAt >= flowOpenedAt` — a pre-existing old backup
 *    does NOT satisfy the gate (the point is a fresh pre-encryption copy).
 * 2. LOST-PASSPHRASE WARNING: unskippable — the caller must pass the ticked
 *    confirmation (`lostPassphraseAcknowledged`), else `POLICY`.
 * 3. PASSPHRASE: min 12 characters (length over composition), confirm match.
 * 4. RECOVERY KEY OFFER: optional (§7.3 "offers", not "requires") — declining
 *    is recorded (`recoveryOfferedAt`).
 * 5. MIGRATION: pre-migration snapshot first (failure aborts before any record
 *    is touched), then the stamped enable sweep; the store rolls back to
 *    `off` before the sweep starts and resumes as `migrating` after a crash.
 *
 * All results are `Result` (Decision 9's error contract) — nothing throws.
 */

import type { AppDBImpl } from '../storage/db';
import { SETTINGS_KEY } from '../storage/schema';

import { newUlid } from '../storage/id';
import { cryptoErr, cryptoOk } from './errors';
import type { CryptoResult } from './errors';
import { mintKeyEntry } from './keys';
import { runSweep } from './migrate';
import { newRecoveryMaterial, buildKeyFile, encodeRecoveryCode } from './recovery';
import type { KeyFile } from './recovery';
import { passphraseIssue, rejectWeakPassphrase, MIN_PASSPHRASE_LENGTH } from './passphrase';
import type { CryptoVault } from './vault';

export type EnableInput = {
  db: AppDBImpl;
  vault: CryptoVault;
  passphrase: string;
  passphraseConfirm: string;
  /**
   * When the wizard opened (Decision 6.1 step 1): the gate passes iff
   * `settings.lastBackupAt >= flowOpenedAt`.
   */
  flowOpenedAt: number;
  /** §7.3: the explicit lost-passphrase warning must be acknowledged. */
  lostPassphraseAcknowledged: boolean;
  /** §7.3: the optional recovery key — offered, may be declined. */
  wantRecoveryKey: boolean;
  now: () => number;
  /** Test seam for the pre-migration snapshot (defaults to the portability API). */
  takePreMigrationSnapshot?: () => Promise<{ ok: true; id: string } | { ok: false }>;
  onProgress?: (progress: { done: number; total: number }) => void;
};

export type EnableResult = {
  /** Present when the recovery key was generated (show ONCE + download key file). */
  recovery: { code: string; keyFile: KeyFile } | null;
  migrated: { done: number; total: number };
};

/**
 * The §7.3 forced-backup gate (Decision 6.1 step 1). Exported separately so the
 * wizard UI can grey out step 2 until it passes — and so tests can prove the
 * gate is impossible to bypass WITHOUT going through `enableEncryption`.
 */
export async function backupGate(
  db: AppDBImpl,
  flowOpenedAt: number,
): Promise<CryptoResult<number>> {
  const settings = await db.get('settings', SETTINGS_KEY);
  if (!settings.ok) {
    return cryptoErr('NO_BACKUP', 'could not read settings to verify the backup receipt');
  }
  const lastBackupAt = settings.value?.lastBackupAt ?? null;
  if (lastBackupAt === null || lastBackupAt < flowOpenedAt) {
    return cryptoErr(
      'NO_BACKUP',
      'a fresh backup export is required before enabling encryption (it is your only recovery path)',
    );
  }
  return cryptoOk(lastBackupAt);
}

/** Enable encryption (the wizard's final step). The gate CANNOT be bypassed. */
export async function enableEncryption(input: EnableInput): Promise<CryptoResult<EnableResult>> {
  const { db, vault, now } = input;

  const state = await vault.refreshState();
  if (state !== null && state.status !== 'off') {
    return cryptoErr('ALREADY_ENABLED', 'encryption is already enabled or migrating');
  }

  // — Decision 6.1 step 1: the mechanical forced-backup gate. —
  const gate = await backupGate(db, input.flowOpenedAt);
  if (!gate.ok) return gate;

  // — Decision 6.1 step 2: the unskippable lost-passphrase warning. —
  if (!input.lostPassphraseAcknowledged) {
    return cryptoErr(
      'POLICY',
      'confirm that a lost passphrase means unrecoverable data before enabling',
    );
  }

  // — Decision 6.1 step 3: passphrase policy (min length over composition). —
  const policy = rejectWeakPassphrase(input.passphrase);
  if (!policy.ok) return policy;
  if (input.passphrase !== input.passphraseConfirm) {
    return cryptoErr('POLICY', 'passphrase confirmation does not match');
  }

  // — Decision 6.1 step 4: the recovery key offer (optional; decline recorded). —
  const keyId = newUlid(now());
  let recovery: { code: string; keyFile: KeyFile } | null = null;
  let recoverySecret: Uint8Array | undefined;
  let recoveryCode: string | undefined;
  if (input.wantRecoveryKey) {
    const material = await newRecoveryMaterial();
    recoverySecret = material.secret;
    recoveryCode = material.code;
  }

  const minted = await mintKeyEntry({
    keyId,
    passphrase: input.passphrase,
    now: now(),
    ...(recoverySecret === undefined ? {} : { recoverySecret }),
  });
  if (!minted.ok) return cryptoErr(minted.error.code, minted.error.message);
  const { entry, recoveryWrap } = minted.value;

  // Session key live immediately (the sweep needs it).
  vault.acceptSessionKey(keyId, minted.value.dmk);

  // — Pre-conditions atomic with the first batch (Decision 7.2): keys written
  //   + pre-migration snapshot FIRST (snapshot failure aborts, nothing touched). —
  const startedAt = now();
  const saved = await vault.saveState({
    status: 'migrating',
    enabledAt: startedAt,
    migration: { startedAt, done: 0, total: 0, direction: 'encrypt' },
    keys: [entry],
    ...(input.wantRecoveryKey ? {} : { recoveryOfferedAt: startedAt }),
  });
  if (!saved.ok) {
    vault.lockNow();
    return cryptoErr('MIGRATION_FAILED', 'could not persist the key ring', saved.error.detail);
  }

  const snapshot =
    input.takePreMigrationSnapshot ??
    (async () => {
      const { takeSnapshot } = await import('../portability/snapshots-api');
      const result = await takeSnapshot('pre-migration', { db, now });
      return result.ok ? { ok: true as const, id: result.value.id } : { ok: false as const };
    });
  const snap = await snapshot();
  if (!snap.ok) {
    // Roll back to plaintext (Decision 6.1): the forced export is harmless.
    await vault.saveState({
      status: 'off',
      enabledAt: null,
      migration: null,
      keys: [],
    });
    vault.lockNow();
    return cryptoErr('MIGRATION_FAILED', 'pre-migration snapshot failed — nothing was encrypted');
  }

  // — Decision 6.1 step 5 / Decision 7: the stamped enable sweep. —
  const swept = await runSweep({
    db,
    vault,
    direction: 'encrypt',
    now,
    deviceId: db.deviceId,
    ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
  });
  if (!swept.ok) {
    if (swept.error.code === 'QUOTA_EXCEEDED' || swept.error.code === 'MIGRATION_FAILED') {
      // Resumable pause (Decision 7.2): keep `migrating` + keys; the next
      // unlock resumes the sweep. The store is a legal mixed state.
      return cryptoErr(swept.error.code, swept.error.message);
    }
    await vault.saveState({ status: 'off', enabledAt: null, migration: null, keys: [] });
    vault.lockNow();
    return swept;
  }

  const done = await vault.saveState({ status: 'on', migration: null, enabledAt: startedAt });
  if (!done.ok) return cryptoErr('MIGRATION_FAILED', 'could not persist the enabled state');

  if (input.wantRecoveryKey && recoveryCode !== undefined && recoveryWrap !== null) {
    recovery = {
      code: recoveryCode,
      keyFile: buildKeyFile({
        keyId,
        recoveryCode,
        wrappedDmk: recoveryWrap,
        now: now(),
      }),
    };
  }

  return cryptoOk({ recovery, migrated: { done: swept.value.done, total: swept.value.total } });
}

export type DisableInput = {
  db: AppDBImpl;
  vault: CryptoVault;
  /** Decision 6.2: requires unlock + passphrase confirmation. */
  passphrase: string;
  now: () => number;
};

/** Disable (opt-out, Decision 6.2): decrypt-all sweep, then keys wiped. */
export async function disableEncryption(
  input: DisableInput,
): Promise<CryptoResult<{ migrated: { done: number; total: number } }>> {
  const { db, vault, now } = input;
  const state = await vault.refreshState();
  if (state === null || state.status === 'off') {
    return cryptoErr('NOT_ENABLED', 'encryption is not enabled');
  }
  const confirmed = await vault.verifyPassphrase(input.passphrase);
  if (!confirmed.ok) return confirmed;

  const swept = await runSweep({
    db,
    vault,
    direction: 'decrypt',
    now,
    deviceId: db.deviceId,
  });
  if (!swept.ok) {
    // Unreadable ciphertext aborts the disable (the keys must survive it).
    return cryptoErr(swept.error.code, swept.error.message);
  }

  await vault.saveState({
    status: 'off',
    enabledAt: null,
    migration: null,
    keys: [],
    recoveryOfferedAt: null,
  });
  await vault.lock();
  return cryptoOk({ migrated: { done: swept.value.done, total: swept.value.total } });
}

/**
 * Boot/unlock resume (Decision 7.1): `status: 'migrating'` continues the sweep
 * in its recorded direction once the key is in memory.
 */
export async function resumeMigration(
  db: AppDBImpl,
  vault: CryptoVault,
  now: () => number,
): Promise<CryptoResult<{ done: number; total: number } | null>> {
  const state = await vault.refreshState();
  if (state === null || state.status !== 'migrating' || state.migration === null) {
    return cryptoOk(null);
  }
  if (!vault.isUnlocked) return cryptoErr('LOCKED', 'unlock to resume the migration');
  const swept = await runSweep({
    db,
    vault,
    direction: state.migration.direction,
    now,
    deviceId: db.deviceId,
  });
  if (!swept.ok) return cryptoErr(swept.error.code, swept.error.message);
  const target = state.migration.direction === 'encrypt' ? 'on' : 'off';
  await vault.saveState({
    status: target,
    migration: null,
    ...(target === 'off' ? { keys: [], enabledAt: null } : {}),
  });
  return cryptoOk({ done: swept.value.done, total: swept.value.total });
}

export { MIN_PASSPHRASE_LENGTH, passphraseIssue, encodeRecoveryCode };
