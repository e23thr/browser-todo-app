/**
 * E10 QA probes — independent reviewer probes for encryption at rest (test card
 * t_0a8e0c42, h_reviewer), complementary to the impl's acceptance battery:
 *
 *   Q1  forced-backup gate reads a REAL `exportBackup` receipt (impl tests seed
 *       `settings.lastBackupAt` by hand — this closes the export→gate loop).
 *   Q2  QUOTA fault injection MID-SWEEP (impl's QUOTA test admits it injects
 *       nothing): typed pause, mixed store with no half-written row, resume.
 *   Q3  crash resume wiring (ADR-007 D7.1 "resume on next unlock") — pinned as
 *       a defect: the app unlock path never sweeps.
 *   Q5  untested enable failure branches: snapshot-failure rollback, keyring
 *       persist failure, and the orphaned-recovery-slot defect (D6.1 order).
 *   Q6  pre-migration snapshot + rollback through the REAL (unstubbed) path,
 *       wrapped at rest, restore requires unlock.
 *   Q8  quarantine leak audit: recovery file carries ciphertext only.
 *   Q9  device join (D3.2): the joined store must end up `status: 'on'`.
 *
 * Defect pins use `it.fails` (E9 precedent): the body asserts the DESIRED
 * behavior; the test passes only while the defect exists.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openForTests } from '../../../src/storage/db';
import type { AppDBImpl } from '../../../src/storage/db';
import { CRYPTO_KEY } from '../../../src/storage/schema';
import { DEFAULT_SETTINGS, isEncryptedRecord, type Task } from '../../../src/domain/model';
import { CryptoVault, registerVault, vault as appVault } from '../../../src/crypto/vault';
import { backupGate, enableEncryption, resumeMigration } from '../../../src/crypto/service';
import { runSweep, sweepRemaining } from '../../../src/crypto/migrate';
import { mintKeyEntry } from '../../../src/crypto/keys';
import { restoreSnapshot } from '../../../src/portability/index';
import { exportBackup } from '../../../src/portability/export';
import type { CryptoStateRecord } from '../../../src/storage/types';
import { makeList, makeTask, quotaError } from '../storage/fixtures';

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
  const created = await openForTests({
    dbName: `e10-probe-${Math.random().toString(36).slice(2)}`,
  });
  if (!created.ok) throw new Error('db open failed');
  opened.push(created.value);
  return created.value;
}

/**
 * Fault injection: allow the first `allowed` IDB puts, then throw a
 * QuotaExceededError (same shape `injectQuotaOnPuts` uses — db.test.ts proves
 * `classifyUnknown` maps it to the typed QUOTA_EXCEEDED on the tx surface).
 */
function armQuotaAfter(allowed: number): () => void {
  const proto = IDBObjectStore.prototype as unknown as { put: (...args: unknown[]) => unknown };
  const original = proto.put;
  let seen = 0;
  proto.put = function put(this: IDBObjectStore, ...args: unknown[]): unknown {
    seen += 1;
    if (seen > allowed) throw quotaError();
    return original.apply(this, args);
  };
  return () => {
    proto.put = original;
  };
}

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

async function cryptoState(): Promise<CryptoStateRecord | undefined> {
  const read = await db.get('crypto_state', CRYPTO_KEY);
  if (!read.ok) throw new Error('crypto_state read failed');
  return read.value;
}

/** Seed a store already mid-enable (status migrating, session key live). */
async function seedMigrating(rows: number): Promise<void> {
  await seedSettings(T0 + 10);
  await seedTasks(Array.from({ length: rows }, (_, i) => `task-${String(i)}`));
  const minted = await mintKeyEntry({
    keyId: '01ARZ3NDEKTSV4RRFFQ69G5FKQ',
    passphrase: PASSPHRASE,
    now: now(),
    iters: 1000,
  });
  if (!minted.ok) throw new Error('mint failed');
  vault.acceptSessionKey(minted.value.entry.keyId, minted.value.dmk);
  await vault.saveState({
    status: 'migrating',
    migration: { startedAt: clock, done: 0, total: rows, direction: 'encrypt' },
    keys: [minted.value.entry],
  });
}

/**
 * Every row is EITHER valid plaintext OR fully decryptable ciphertext — never a
 * hybrid. `expectAllEncrypted` additionally forbids plaintext rows (post-resume).
 */
async function assertNoHalfWrittenRow(expectAllEncrypted: boolean): Promise<void> {
  const raw = await db.readUnfiltered('tasks');
  expect(raw.ok).toBe(true);
  if (!raw.ok) return;
  for (const row of raw.value) {
    if (isEncryptedRecord(row)) {
      const view = await vault.decryptRecord('tasks', row);
      expect(view.ok && view.value !== undefined).toBe(true);
      if (view.ok && view.value !== undefined) {
        expect((view.value as Task).title).toMatch(/^task-\d+$/u);
      }
    } else {
      if (expectAllEncrypted) throw new Error('plaintext row survived the completed sweep');
      expect(typeof row.title).toBe('string');
    }
  }
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

/* ------------------------ Q1: gate ↔ real export receipt ------------------------ */

describe('Q1 — the gate reads a receipt written by a REAL exportBackup', () => {
  it('export → gate passes; a pre-wizard (stale) export → NO_BACKUP', async () => {
    // A real export writes settings.lastBackupAt itself (portability/export.ts).
    await seedSettings(null);
    await seedTasks(['Buy milk']);
    const exported = await exportBackup({ db, now, download: false });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.value.document).toContain('Buy milk'); // backups are plaintext (D4.5)

    // Receipt from INSIDE the flow window passes.
    const gate = await backupGate(db, exported.value.exportedAt - 1);
    expect(gate.ok).toBe(true);

    // An export that finished BEFORE the wizard opened is stale (D6.1 step 1).
    const stale = await backupGate(db, exported.value.exportedAt + 1);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('NO_BACKUP');
  });
});

/* --------------------- Q2: real QUOTA fault injection mid-sweep -------------------- */

describe('Q2 — QUOTA_EXCEEDED mid-sweep pauses resumably (real fault injection)', () => {
  it('typed pause, mixed store, no half-written row, resume completes → status on', async () => {
    await seedMigrating(4);
    expect(vault.status).toBe('migrating');

    // Put budget: batch 1 writes 2 row puts + 1 progress saveState put (3 allowed);
    // batch 2's first row put is #4 → QuotaExceededError inside the batch tx.
    const restore = armQuotaAfter(3);
    let paused: Awaited<ReturnType<typeof runSweep>>;
    try {
      paused = await runSweep({
        db,
        vault,
        direction: 'encrypt',
        now,
        deviceId: db.deviceId,
        batchSize: 2,
      });
    } finally {
      restore();
    }
    expect(paused.ok).toBe(false);
    if (!paused.ok) expect(paused.error.code).toBe('QUOTA_EXCEEDED');

    // Pause contract: still migrating + direction recorded, store mixed, every
    // row intact (batch atomicity — no half-written hybrid row).
    const state = await cryptoState();
    expect(state?.status).toBe('migrating');
    expect(state?.migration?.direction).toBe('encrypt');
    expect(await sweepRemaining(db, 'encrypt')).toBe(2);
    await assertNoHalfWrittenRow(false);

    // The documented recovery: resume on next unlock (D9 QUOTA row) completes.
    const resumed = await resumeMigration(db, vault, now);
    expect(resumed.ok).toBe(true);
    expect(await sweepRemaining(db, 'encrypt')).toBe(0);
    expect(vault.status).toBe('on');
    await assertNoHalfWrittenRow(true);

    // Idempotent: a repeat sweep touches nothing.
    const again = await runSweep({ db, vault, direction: 'encrypt', now, deviceId: db.deviceId });
    expect(again.ok && again.value.skipped).toBe(again.ok ? again.value.total : -1);
  });
});

/* -------------------------- Q3: crash resume wiring ------------------------------ */

describe("Q3 — crash mid-sweep resumes on the app's unlock path (D7.1)", () => {
  // Was `it.fails` (pin) until the E10-Q1 fix: `unlockWithPassphrase` now
  // resumes the sweep in-line — D7.1's "resume on next unlock" has a caller.
  it('DEFECT E10-Q1: unlocking a crashed migrating store resumes the sweep (D7.1: "resume on next unlock")', async () => {
    await seedMigrating(2);
    const rows0 = await db.readUnfiltered('tasks');
    expect(rows0.ok).toBe(true);
    const first = rows0.ok ? rows0.value[0] : undefined;
    expect(first).toBeDefined();
    const sealed = await vault.encryptRecord('tasks', first as Task);
    expect(sealed.ok).toBe(true);
    if (sealed.ok) await db.putRaw('tasks', sealed.value as unknown as Task);
    await vault.lock();

    // The app boot/unlock path: attach a fresh session and unlock with the
    // passphrase — nothing else runs in src/ (resumeMigration has no caller).
    const rebooted = new CryptoVault({ now });
    await rebooted.attach(db);
    registerVault(rebooted);
    const unlocked = await rebooted.unlockWithPassphrase(PASSPHRASE);
    expect(unlocked.ok).toBe(true);

    // D7.1 desired: the sweep resumes and the store reaches 'on'.
    expect(await sweepRemaining(db, 'encrypt')).toBe(0);
    expect(rebooted.status).toBe('on');
    await rebooted.lock();
  });

  it('control: the resume API itself works when called directly (wiring-only gap)', async () => {
    await seedMigrating(2);
    const rows = await db.readUnfiltered('tasks');
    expect(rows.ok).toBe(true);
    const firstRow = rows.ok ? rows.value[0] : undefined;
    expect(firstRow).toBeDefined();
    const sealed = await vault.encryptRecord('tasks', firstRow as Task);
    expect(sealed.ok).toBe(true);
    if (sealed.ok) await db.putRaw('tasks', sealed.value as unknown as Task);
    expect(await sweepRemaining(db, 'encrypt')).toBe(1);

    const resumed = await resumeMigration(db, vault, now);
    expect(resumed.ok).toBe(true);
    expect(await sweepRemaining(db, 'encrypt')).toBe(0);
    expect(vault.status).toBe('on');
  });
});

/* --------------------- Q5: enable failure branches + orphan slot -------------------- */

describe('Q5 — enable failure branches degrade without touching user data', () => {
  it('snapshot failure rolls the store back to off with keys wiped and rows untouched', async () => {
    await seedSettings(T0 + 10);
    const before = await seedTasks(['alpha', 'bravo']);

    const result = await enableEncryption({
      db,
      vault,
      passphrase: PASSPHRASE,
      passphraseConfirm: PASSPHRASE,
      flowOpenedAt: T0,
      lostPassphraseAcknowledged: true,
      wantRecoveryKey: false,
      now,
      takePreMigrationSnapshot: async () => ({ ok: false }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MIGRATION_FAILED');

    // D6.1: "failure anywhere before step 5 leaves the store plaintext".
    expect(vault.status).toBe('off');
    const state = await cryptoState();
    expect(state?.status).toBe('off');
    expect(state?.keys).toEqual([]);
    const raw = await db.readUnfiltered('tasks');
    expect(raw.ok).toBe(true);
    if (raw.ok) {
      expect(raw.value).toHaveLength(before.length);
      for (const row of raw.value) expect(isEncryptedRecord(row)).toBe(false);
    }
  });

  it('a keyring persist failure (quota on the state write) touches no record', async () => {
    await seedSettings(T0 + 10);
    await seedTasks(['alpha', 'bravo']);

    // First put after arming = vault.saveState(status migrating) → fails.
    const restore = armQuotaAfter(0);
    let result: Awaited<ReturnType<typeof enableEncryption>>;
    try {
      result = await enableEncryption({
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
    } finally {
      restore();
    }
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MIGRATION_FAILED');
    expect(vault.status).toBe('off');
    const state = await cryptoState();
    expect(state?.keys ?? []).toEqual([]); // row never persisted (or keys wiped)
    const raw = await db.readUnfiltered('tasks');
    expect(raw.ok).toBe(true);
    if (raw.ok) for (const row of raw.value) expect(isEncryptedRecord(row)).toBe(false);
  });

  // Was `it.fails` (pin) until the E10-Q2 fix: the recovery slot is persisted
  // only at the offer acknowledgment (UI) or after a successful sweep
  // (headless) — never with the key ring, so a failed enable strands none.
  it('DEFECT E10-Q2: a sweep failure after a recovery opt-in leaves NO orphaned recovery slot (D6.1 order: the code is shown BEFORE migration)', async () => {
    await seedSettings(T0 + 10);
    await seedTasks(['alpha', 'bravo']);

    // saveState(migrating) is put #1 (allowed); the sweep's first row put is
    // #2 → the sweep fails while the recovery slot is already persisted.
    const restore = armQuotaAfter(1);
    let disclosed: { code: string } | null = null;
    let failed = false;
    try {
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
      failed = !result.ok;
      if (result.ok) disclosed = result.value.recovery;
    } finally {
      restore();
    }
    const state: CryptoStateRecord | undefined = await cryptoState();

    // Current behavior: sweep failed, slot persisted, code never disclosed.
    expect(failed).toBe(true);
    const orphaned =
      disclosed === null &&
      (state?.keys ?? []).some((k) => k.slots.some((s) => s.kind === 'recovery'));
    // Desired (D6.1 normative order — offer/ack BEFORE the migration sweep):
    // a failed enable can never strand a recovery slot whose secret nobody saw.
    expect(orphaned).toBe(false);
  });
});

/* ---------------- Q6: pre-migration snapshot + rollback (real path) ---------------- */

describe('Q6 — pre-migration snapshot exists, is wrapped at rest, and rolls back', () => {
  beforeEach(async () => {
    // Portability/snapshot paths read the APP vault singleton (production
    // wiring); use it here so the codec hooks match production exactly.
    await appVault.attach(db);
    registerVault(appVault);
  });

  afterEach(async () => {
    await appVault.lock();
  });

  it('enable (unstubbed default) snapshots first, wrapped at rest, and restore returns the original titles', async () => {
    await appVault.attach(db);
    await seedSettings(T0 + 10);
    // Restore runs the FULL import validation — tasks must reference a real
    // list or they are quarantined (task seed + its list, like a real store).
    const list = makeList({ id: '01ARZ3NDEKTSV4RRFFQ69G5FM1' });
    await db.put('lists', list);
    await db.put('tasks', makeTask({ title: 'pre-alpha', listId: list.id, updatedAt: now() }));
    await db.put('tasks', makeTask({ title: 'pre-bravo', listId: list.id, updatedAt: now() }));

    // No takePreMigrationSnapshot override → the production default runs.
    const enabled = await enableEncryption({
      db,
      vault: appVault,
      passphrase: PASSPHRASE,
      passphraseConfirm: PASSPHRASE,
      flowOpenedAt: T0,
      lostPassphraseAcknowledged: true,
      wantRecoveryKey: false,
      now,
    });
    expect(enabled.ok).toBe(true);
    expect(appVault.status).toBe('on');

    // A pre-migration snapshot exists…
    const snaps = await db.getAll('snapshots');
    expect(snaps.ok).toBe(true);
    const pre = snaps.ok ? snaps.value.find((s) => s.reason === 'pre-migration') : undefined;
    expect(pre).toBeDefined();

    // …and its payload is WRAPPED at rest (D4.4): no user text in the clear.
    const payload = await db.get('snapshot_payloads', pre!.id);
    expect(payload.ok && payload.value !== undefined).toBe(true);
    if (payload.ok && payload.value !== undefined) {
      expect(payload.value.payload).not.toContain('pre-alpha');
      expect(JSON.parse(payload.value.payload).format).toBe('todo-enc/1');
    }

    // Rollback — the restore half of this drill is asserted in a REAL browser
    // (`tests/e2e/e10-encryption.spec.ts`, "pre-migration snapshot restore"),
    // because fake-indexeddb deactivates a transaction when a `crypto.subtle`
    // await crosses its task boundary, while Chromium resolves the same await
    // as a microtask and keeps the transaction alive. That divergence is a
    // property of the double, NOT of the product: measured first-hand both ways
    // (unit: `UNAVAILABLE/InvalidStateError`; Chromium: restore succeeds with
    // every row still ciphertext). Assert here only what the double can settle:
    // the snapshot exists, is wrapped at rest, and a locked restore refuses
    // TYPED rather than corrupting (next test).
    const restoreAttempt = await restoreSnapshot(pre!.id, { db, now });
    if (restoreAttempt.ok) {
      // If the double ever behaves like the browser, verify the content too.
      const raw = await db.readUnfiltered('tasks');
      expect(raw.ok).toBe(true);
      if (raw.ok) {
        const titles: string[] = [];
        for (const row of raw.value) {
          if (isEncryptedRecord(row)) {
            const view = await appVault.decryptRecord('tasks', row);
            if (view.ok && view.value !== undefined) titles.push((view.value as Task).title);
          } else {
            titles.push(row.title);
          }
        }
        expect(titles).toContain('pre-alpha');
        expect(titles).toContain('pre-bravo');
      }
    } else {
      // Documented double-only outcome — must be the typed tx error, never a
      // partial/garbled store.
      expect(['UNAVAILABLE', 'QUOTA_EXCEEDED']).toContain(restoreAttempt.error.code);
      const raw = await db.readUnfiltered('tasks');
      expect(raw.ok).toBe(true);
      if (raw.ok) for (const row of raw.value) expect(isEncryptedRecord(row)).toBe(true);
    }
  });

  it('restore while LOCKED is refused typed (LOCKED) — never a garbled or partial restore (D4.4)', async () => {
    await appVault.attach(db);
    await seedSettings(T0 + 10);
    const list = makeList({ id: '01ARZ3NDEKTSV4RRFFQ69G5FM2' });
    await db.put('lists', list);
    await db.put('tasks', makeTask({ title: 'pre-alpha', listId: list.id, updatedAt: now() }));
    const enabled = await enableEncryption({
      db,
      vault: appVault,
      passphrase: PASSPHRASE,
      passphraseConfirm: PASSPHRASE,
      flowOpenedAt: T0,
      lostPassphraseAcknowledged: true,
      wantRecoveryKey: false,
      now,
    });
    expect(enabled.ok).toBe(true);

    const snaps = await db.getAll('snapshots');
    const pre = snaps.ok ? snaps.value.find((s) => s.reason === 'pre-migration') : undefined;
    expect(pre).toBeDefined();

    await appVault.lock();
    const refused = await restoreSnapshot(pre!.id, { db, now });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('LOCKED');
  });
});

/* ----------------------- Q8: quarantine leak audit ----------------------- */

describe('Q8 — quarantine recovery file leaks no plaintext (leak audit)', () => {
  it('tampered ciphertext is quarantined, bytes kept, recovery file carries ciphertext only', async () => {
    await seedSettings(T0 + 10);
    await seedTasks(['super secret title']);
    const enabled = await enableEncryption({
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
    expect(enabled.ok).toBe(true);

    const raw = await db.readUnfiltered('tasks');
    expect(raw.ok).toBe(true);
    const victim = raw.ok
      ? (raw.value[0] as unknown as { id: string; payload: string })
      : undefined;
    expect(victim).toBeDefined();
    const damaged = `${victim!.payload[0] === 'A' ? 'B' : 'A'}${victim!.payload.slice(1)}`;
    await db.putRaw('tasks', {
      ...(raw.ok ? raw.value[0] : {}),
      payload: damaged,
    } as unknown as Task);

    const view = await db.getAll('tasks');
    expect(view.ok).toBe(true);
    if (view.ok) expect(view.value.some((r) => r.id === victim!.id)).toBe(false); // excluded

    // Bytes kept verbatim…
    const kept = await db.readUnfiltered('tasks');
    expect(kept.ok && kept.value.some((r) => r.id === victim!.id)).toBe(true);
    expect(db.quarantine.list().length).toBeGreaterThanOrEqual(1);

    // …and the recovery file contains the CIPHERTEXT record — never the title.
    const file = db.quarantine.recoveryFile();
    expect(file.json).toContain(victim!.id);
    expect(file.json).not.toContain('super secret title');
    expect(JSON.stringify(db.quarantine.list())).not.toContain('super secret title');

    // Purge is explicit and announced (never automatic).
    const purged = await db.quarantine.purge();
    expect(purged.ok).toBe(true);
    const after = await db.readUnfiltered('tasks');
    expect(after.ok && after.value.some((r) => r.id === victim!.id)).toBe(false);
  });
});

/* --------------------------- Q9: device join --------------------------- */

describe('Q9 — device join via key file (D3.2)', () => {
  // Was `it.fails` (pin) until the E10-Q3 fix: a fresh-store join saves the
  // adopted ring under `status: 'on'` — the joined device locks and encrypts.
  it('DEFECT E10-Q3: joining a fresh store leaves it status "on" (a joined device must lock + encrypt its writes)', async () => {
    // Store A enables and hands over its emergency kit.
    await seedSettings(T0 + 10);
    await seedTasks(['alpha']);
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
    if (!enabled.ok || enabled.value.recovery === null) throw new Error('expected a recovery key');
    await vault.lock();

    // Fresh device B joins with A's key file under its own local passphrase.
    const dbB = await freshDb();
    const vaultB = new CryptoVault({ now });
    await vaultB.attach(dbB);
    registerVault(vaultB);
    const joined = await vaultB.joinWithKeyFile(
      enabled.value.recovery.keyFile,
      'device b local passphrase',
    );
    expect(joined.ok).toBe(true);

    // D3.2 desired: a joined device is an ENCRYPTED device — status 'on'
    // (otherwise lockState stays 'disabled', writeRow stores NEW user text in
    // PLAINTEXT, and after a reload the local passphrase slot cannot even be
    // used: unlockWithPassphrase refuses status 'off').
    expect(vaultB.status).toBe('on');
    await vaultB.lock();
    registerVault(vault);
  });
});
