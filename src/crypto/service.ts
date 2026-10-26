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
 * 4. RECOVERY KEY OFFER — Decision 6.1's ORDER is structural, not copy: the
 *    generated material is disclosed through `onRecoveryOffer` BEFORE the
 *    sweep runs, and the slot is persisted only on the caller's `'saved'`
 *    acknowledgment — a recovery slot can never exist whose code was never
 *    shown. Headless callers (no seam — tests, one-shot flows) get their slot
 *    issued only AFTER a successful sweep: a failed enable cannot strand one
 *    either. Declining is recorded (`recoveryOfferedAt`).
 * 5. MIGRATION: pre-migration snapshot first (failure aborts before any record
 *    is touched), then the stamped enable sweep; the store rolls back to
 *    `off` before the sweep starts and resumes as `migrating` after a crash.
 *
 * `status: 'migrating'` is QUARANTINE-FREE (Decision 9): a paused or crashed
 * enable is a legal mixed store. Resume (Decision 7.1) is wired into the
 * unlock path (`CryptoVault`) and `refreshAfterUnlock`; `migrationRun` carries
 * live progress and the paused state for the retry UI.
 *
 * All results are `Result` (Decision 9's error contract) — nothing throws.
 */

import { signal } from '@preact/signals';

import type { AppDBImpl } from '../storage/db';
import { SETTINGS_KEY } from '../storage/schema';

import { newUlid } from '../storage/id';
import { foreignCiphertext } from './foreignData';
import { cryptoErr, cryptoOk } from './errors';
import type { CryptoErrorCode, CryptoResult } from './errors';
import { addRecoverySlot, mintKeyEntry } from './keys';
import { runSweep } from './migrate';
import type { SweepOptions, SweepOutcome } from './migrate';
import { newRecoveryMaterial, buildKeyFile, encodeRecoveryCode } from './recovery';
import type { KeyFile } from './recovery';
import { passphraseIssue, rejectWeakPassphrase, MIN_PASSPHRASE_LENGTH } from './passphrase';
import type { CryptoVault } from './vault';

/** Live enable/resume sweep state — features render progress / the paused retry from it. */
export type MigrationRunState = {
  phase: 'idle' | 'running' | 'paused';
  done: number;
  total: number;
  code: CryptoErrorCode | null;
  message: string | null;
};

export const migrationRun = signal<MigrationRunState>({
  phase: 'idle',
  done: 0,
  total: 0,
  code: null,
  message: null,
});

/**
 * One sweep at a time: an in-flight enable and a resume (Decision 7.1) must
 * never interleave batch writes on the same rows — every sweep funnels through
 * a single in-flight promise; a second caller AWAITS the first and re-checks
 * the state afterwards (see `resumeMigration`).
 */
let activeSweep: Promise<CryptoResult<SweepOutcome>> | null = null;
function sweepOnce(options: SweepOptions): Promise<CryptoResult<SweepOutcome>> {
  const running = activeSweep;
  if (running !== null) return running;
  const fresh = runSweep(options);
  activeSweep = fresh;
  const clear = (): void => {
    if (activeSweep === fresh) activeSweep = null;
  };
  fresh.then(clear, clear);
  return fresh;
}

export type RecoveryOffer = { code: string; keyFile: KeyFile };

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
  /**
   * Decision 6.1 step 4 seam (the wizard): called after the key-ring write and
   * BEFORE the snapshot/sweep, with the generated recovery material — or
   * `null` when the user declined at step 3. Resolve `'saved'` to persist the
   * recovery slot (only THEN — the code was on screen), `'skipped'` for a
   * decline, or `'cancelled'` to abort: before step 5 commits the store rolls
   * back to plaintext (Decision 6.1). Headless callers omit this and receive
   * their slot in the result after a successful sweep.
   */
  onRecoveryOffer?: (offer: RecoveryOffer | null) => Promise<'saved' | 'skipped' | 'cancelled'>;
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

/** Enable encryption (the wizard's steps, Decision 6.1). The gate CANNOT be bypassed. */
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

  // Recovery material for step 4 is minted UP FRONT, but its SLOT is never part
  // of the key-ring write: persisted at acknowledgment (offer seam) or after a
  // successful sweep (headless) — so no slot can strand undisclosed (D6.1).
  const keyId = newUlid(now());
  const material = input.wantRecoveryKey ? await newRecoveryMaterial() : null;

  const minted = await mintKeyEntry({ keyId, passphrase: input.passphrase, now: now() });
  if (!minted.ok) return cryptoErr(minted.error.code, minted.error.message);
  const { entry, dmk } = minted.value;

  // Session key live immediately (the sweep needs it).
  vault.acceptSessionKey(keyId, dmk);

  // — Pre-conditions (Decision 7.2): keys written FIRST, atomic with the state.
  //   The snapshot follows the offer — Decision 6.1's step order. —
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

  /** Failure before step 5 commits => the store stays plaintext (Decision 6.1). */
  const rollbackToPlaintext = async (): Promise<void> => {
    await vault.saveState({ status: 'off', enabledAt: null, migration: null, keys: [] });
    vault.lockNow();
  };

  let recovery: { code: string; keyFile: KeyFile } | null = null;

  // — Decision 6.1 step 4: DISCLOSE the recovery offer BEFORE the sweep. —
  if (input.onRecoveryOffer !== undefined) {
    let offer: RecoveryOffer | null = null;
    if (material !== null) {
      const preview = await addRecoverySlot(dmk, entry, material.secret, now());
      if (!preview.ok) {
        await rollbackToPlaintext();
        return cryptoErr(preview.error.code, preview.error.message);
      }
      offer = {
        code: material.code,
        keyFile: buildKeyFile({
          keyId,
          recoveryCode: material.code,
          wrappedDmk: preview.value.wrap,
          now: now(),
        }),
      };
    }
    const verdict = await input.onRecoveryOffer(offer);
    if (verdict === 'cancelled') {
      await rollbackToPlaintext();
      return cryptoErr('POLICY', 'setup was cancelled before the migration started');
    }
    if (verdict === 'saved' && material !== null) {
      // Persist ONLY now — the code has been on screen (Decision 6.1 order).
      const issued = await vault.issueRecoveryKey(material.secret, material.code);
      if (!issued.ok) {
        await rollbackToPlaintext();
        return cryptoErr(issued.error.code, issued.error.message);
      }
      recovery = { code: material.code, keyFile: issued.value };
    } else if (material !== null) {
      // Declined at the offer step — record it (a step-3 decline was recorded
      // with the key-ring write above).
      const recorded = await vault.recordRecoveryOffer();
      if (!recorded.ok) {
        await rollbackToPlaintext();
        return cryptoErr(recorded.error.code, recorded.error.message);
      }
    }
  }

  // — Decision 6.1 step 5 / Decision 7: pre-migration snapshot first (failure
  //   aborts before any record is touched). —
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
    await rollbackToPlaintext();
    return cryptoErr('MIGRATION_FAILED', 'pre-migration snapshot failed — nothing was encrypted');
  }

  // — the stamped enable sweep (Decision 7), progress mirrored to `migrationRun`. —
  migrationRun.value = {
    phase: 'running',
    done: 0,
    total: 0,
    code: null,
    message: null,
  };
  const swept = await sweepOnce({
    db,
    vault,
    direction: 'encrypt',
    now,
    deviceId: db.deviceId,
    onProgress: (progress) => {
      migrationRun.value = {
        phase: 'running',
        done: progress.done,
        total: progress.total,
        code: null,
        message: null,
      };
      input.onProgress?.(progress);
    },
  });
  if (!swept.ok) {
    if (swept.error.code === 'QUOTA_EXCEEDED' || swept.error.code === 'MIGRATION_FAILED') {
      // Resumable pause (Decision 7.2): keep `migrating` + keys; the next
      // unlock resumes the sweep. The store is a legal mixed state.
      migrationRun.value = {
        phase: 'paused',
        done: 0,
        total: 0,
        code: swept.error.code,
        message: swept.error.message,
      };
      return cryptoErr(swept.error.code, swept.error.message);
    }
    migrationRun.value = { phase: 'idle', done: 0, total: 0, code: null, message: null };
    await rollbackToPlaintext();
    return swept;
  }

  // Headless callers (no offer seam): issue the recovery slot only AFTER the
  // sweep succeeded — a failed enable never strands an undisclosed slot.
  if (recovery === null && material !== null && input.onRecoveryOffer === undefined) {
    const issued = await vault.issueRecoveryKey(material.secret, material.code);
    if (!issued.ok) {
      // Sweep done, slot write failed: stay `migrating` — the resume path
      // finishes the state flip (no disclosure claim, nothing stranded).
      migrationRun.value = {
        phase: 'paused',
        done: swept.value.done,
        total: swept.value.total,
        code: issued.error.code,
        message: issued.error.message,
      };
      return cryptoErr(issued.error.code, issued.error.message);
    }
    recovery = { code: material.code, keyFile: issued.value };
  }

  const done = await vault.saveState({ status: 'on', migration: null, enabledAt: startedAt });
  if (!done.ok) {
    migrationRun.value = {
      phase: 'paused',
      done: swept.value.done,
      total: swept.value.total,
      code: 'MIGRATION_FAILED',
      message: 'could not persist the enabled state',
    };
    return cryptoErr('MIGRATION_FAILED', 'could not persist the enabled state');
  }
  migrationRun.value = {
    phase: 'idle',
    done: swept.value.done,
    total: swept.value.total,
    code: null,
    message: null,
  };
  return cryptoOk({ recovery, migrated: { done: swept.value.done, total: swept.value.total } });
}

export type DisableInput = {
  db: AppDBImpl;
  vault: CryptoVault;
  /** Decision 6.2: requires unlock + passphrase confirmation. */
  passphrase: string;
  now: () => number;
  onProgress?: (progress: { done: number; total: number }) => void;
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

  const swept = await sweepOnce({
    db,
    vault,
    direction: 'decrypt',
    now,
    deviceId: db.deviceId,
    ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
  });
  if (!swept.ok) {
    // Unreadable ciphertext aborts the disable (the keys must survive it).
    return cryptoErr(swept.error.code, swept.error.message);
  }

  const wiped = await vault.saveState({
    status: 'off',
    enabledAt: null,
    migration: null,
    keys: [],
    recoveryOfferedAt: null,
  });
  if (!wiped.ok) return cryptoErr('MIGRATION_FAILED', 'could not persist the disabled state');
  // Everything is plaintext again — nothing can be ciphertext-blocked (D3.3).
  foreignCiphertext.value = false;
  await vault.lock();
  return cryptoOk({ migrated: { done: swept.value.done, total: swept.value.total } });
}

export type ResumeOptions = {
  onProgress?: (progress: { done: number; total: number }) => void;
  /** Test seam for the pre-migration receipt check (Decision 7.2, review N2). */
  ensureReceipt?: () => Promise<void>;
};

/**
 * Boot/unlock resume (Decision 7.1): `status: 'migrating'` continues the sweep
 * in its recorded direction once the key is in memory. Before an `encrypt`
 * resume it verifies the pre-migration rollback receipt exists — taking one if
 * a crash slipped between the key-ring write and the snapshot (review N2);
 * best-effort, because the forced plaintext export stays the primary recovery
 * path (§7.3 / review N2).
 */
export async function resumeMigration(
  db: AppDBImpl,
  vault: CryptoVault,
  now: () => number,
  options: ResumeOptions = {},
): Promise<CryptoResult<{ done: number; total: number } | null>> {
  const state = await vault.refreshState();
  if (state === null || state.status !== 'migrating' || state.migration === null) {
    migrationRun.value = { phase: 'idle', done: 0, total: 0, code: null, message: null };
    return cryptoOk(null);
  }
  if (!vault.isUnlocked) return cryptoErr('LOCKED', 'unlock to resume the migration');

  const { direction, done: doneBefore, total: totalBefore } = state.migration;

  if (direction === 'encrypt') {
    const ensure =
      options.ensureReceipt ??
      (async () => {
        try {
          const { listSnapshots, takeSnapshot } = await import('../portability/snapshots-api');
          const listed = await listSnapshots({ db, now });
          if (listed.ok && listed.value.some((s) => s.reason === 'pre-migration')) return;
          await takeSnapshot('pre-migration', { db, now });
        } catch {
          /* best-effort — see the doc comment */
        }
      });
    await ensure();
  }

  migrationRun.value = {
    phase: 'running',
    done: doneBefore,
    total: totalBefore,
    code: null,
    message: null,
  };
  const swept = await sweepOnce({
    db,
    vault,
    direction,
    now,
    deviceId: db.deviceId,
    onProgress: (progress) => {
      migrationRun.value = {
        phase: 'running',
        done: progress.done,
        total: progress.total,
        code: null,
        message: null,
      };
      options.onProgress?.(progress);
    },
  });
  if (!swept.ok) {
    const resumable =
      swept.error.code === 'QUOTA_EXCEEDED' || swept.error.code === 'MIGRATION_FAILED';
    migrationRun.value = resumable
      ? {
          phase: 'paused',
          done: doneBefore,
          total: totalBefore,
          code: swept.error.code,
          message: swept.error.message,
        }
      : { phase: 'idle', done: doneBefore, total: totalBefore, code: null, message: null };
    return cryptoErr(swept.error.code, swept.error.message);
  }

  // Re-read before flipping: a shared sweep may have been finalized (or rolled
  // back) by its original owner while this caller awaited it — never resurrect
  // a state the other path already settled.
  const after = await vault.refreshState();
  if (after === null || after.status !== 'migrating') {
    migrationRun.value = {
      phase: 'idle',
      done: swept.value.done,
      total: swept.value.total,
      code: null,
      message: null,
    };
    return cryptoOk({ done: swept.value.done, total: swept.value.total });
  }

  const target = direction === 'encrypt' ? 'on' : 'off';
  const flipped = await vault.saveState({
    status: target,
    migration: null,
    ...(target === 'off' ? { keys: [], enabledAt: null } : {}),
  });
  if (!flipped.ok) {
    migrationRun.value = {
      phase: 'paused',
      done: swept.value.done,
      total: swept.value.total,
      code: 'MIGRATION_FAILED',
      message: 'could not persist the migrated state',
    };
    return cryptoErr(
      'MIGRATION_FAILED',
      'could not persist the migrated state',
      flipped.error.detail,
    );
  }
  if (target === 'off') foreignCiphertext.value = false; // plaintext store — nothing blocked
  migrationRun.value = {
    phase: 'idle',
    done: swept.value.done,
    total: swept.value.total,
    code: null,
    message: null,
  };
  return cryptoOk({ done: swept.value.done, total: swept.value.total });
}

export { MIN_PASSPHRASE_LENGTH, passphraseIssue, encodeRecoveryCode };
