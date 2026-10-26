/**
 * E10 QA probes — sync convergence over ENCRYPTED stores (test card t_0a8e0c42).
 *
 * The impl's `encrypted-merge.test.ts` covers `planMerge` in isolation. This
 * suite drives REAL `runSyncOnce` runs over the in-memory WebDAV fake with both
 * devices holding C1 ciphertext, proving the ADR-007 Decision 8 contract end to
 * end:
 *
 *   S1  the wire carries NO plaintext (leak audit over the fake's file bytes)
 *   S2  two-device convergence through a key-file join: create on A → pull on B
 *       decrypts; concurrent edits produce exactly ONE conflict copy that BOTH
 *       sides decrypt (D3.2/D8.3)
 *   S3  a foreign-key device (mixed-key store, D3.3) defers non-destructively:
 *       ciphertext bytes preserved verbatim, nothing garbled, its own rows still
 *       decrypt
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { Task } from '../../../src/domain/model';
import { DEFAULT_SETTINGS } from '../../../src/domain/model';
import { isEncryptedRecord } from '../../../src/domain/model';
import type { AppDBImpl } from '../../../src/storage/db';
import { CryptoVault, registerVault } from '../../../src/crypto/vault';
import type { KeyFile } from '../../../src/crypto/recovery';
import { enableEncryption } from '../../../src/crypto/service';
import { resetRowCryptoSeam } from '../../../src/storage/cryptoSeam';
import { resetMergeCryptoSeam } from '../../../src/sync/mergeSeam';
import { WebDavClient } from '../../../src/sync/webdav';
import { bootDb, makeFakeWebDav, makeTask, runEngine, T0, testUlid } from './fixtures';

const PASSPHRASE = 'correct horse battery staple';
let clock = T0 + 10_000;
const now = (): number => (clock += 1000);

function clientFor(fake: ReturnType<typeof makeFakeWebDav>): WebDavClient {
  return new WebDavClient(
    { baseUrl: fake.baseUrl, user: 'u', password: 'p' },
    { fetch: fake.fetch },
  );
}

/** Enable C1 on a store and hand back the emergency kit (recovery key file). */
async function enableOn(db: AppDBImpl, vault: CryptoVault): Promise<{ keyFile: KeyFile }> {
  await db.put('settings', { ...DEFAULT_SETTINGS, lastBackupAt: now() });
  const enabled = await enableEncryption({
    db,
    vault,
    passphrase: PASSPHRASE,
    passphraseConfirm: PASSPHRASE,
    flowOpenedAt: now() - 5000,
    lostPassphraseAcknowledged: true,
    wantRecoveryKey: true,
    now,
    takePreMigrationSnapshot: async () => ({ ok: true, id: 'snap' }),
  });
  if (!enabled.ok || enabled.value.recovery === null) {
    throw new Error(`enable failed: ${enabled.ok ? 'no recovery' : enabled.error.code}`);
  }
  return { keyFile: enabled.value.recovery.keyFile };
}

/** All at-rest task rows, narrowed out of the Result envelope. */
async function rawTasks(db: AppDBImpl): Promise<Record<string, unknown>[]> {
  const read = await db.readUnfiltered('tasks');
  if (!read.ok) throw new Error(`readUnfiltered failed: ${read.error.code}`);
  return read.value;
}

async function rawTitle(db: AppDBImpl, id: string): Promise<unknown> {
  return (await rawTasks(db)).find((r) => r['id'] === id)?.['title'];
}

async function viewTitle(
  vault: CryptoVault,
  db: AppDBImpl,
  id: string,
): Promise<string | undefined> {
  const got = await db.readUnfiltered('tasks');
  if (!got.ok) throw new Error('readUnfiltered failed');
  const row = got.value.find((r) => r.id === id);
  if (row === undefined) return undefined;
  if (!isEncryptedRecord(row)) return row.title;
  const view = await vault.decryptRecord('tasks', row);
  return view.ok && view.value !== undefined ? (view.value as Task).title : undefined;
}

const opened: AppDBImpl[] = [];
async function freshBoot(): Promise<AppDBImpl> {
  const db = await bootDb();
  opened.push(db as unknown as AppDBImpl);
  return db as unknown as AppDBImpl;
}

afterEach(async () => {
  resetRowCryptoSeam();
  resetMergeCryptoSeam();
  for (const db of opened.splice(0)) db.close();
});

describe('encrypted sync — the wire and convergence', () => {
  it('S1: ciphertext travels the wire — no plaintext title in any pushed file', async () => {
    const dbA = await freshBoot();
    const vaultA = new CryptoVault({ now });
    await vaultA.attach(dbA);
    registerVault(vaultA);

    const secret = 'Buy oat milk (private)';
    await enableOn(dbA, vaultA);
    const taskId = testUlid('s1-task');
    const put = await dbA.put(
      'tasks',
      makeTask({ id: taskId, title: secret, deviceId: dbA.deviceId, updatedAt: now() }),
    );
    expect(put.ok).toBe(true);

    const fake = makeFakeWebDav();
    const run = await runEngine(dbA, clientFor(fake));
    expect(run.ok).toBe(true);

    // LEAK AUDIT: every byte the device pushed must lack the plaintext title.
    expect(fake.state.files.size).toBeGreaterThan(0);
    for (const [path, body] of fake.state.files) {
      expect(body, `plaintext leaked into ${path}`).not.toContain(secret);
    }
    // And the local at-rest row is ciphertext: no plaintext `title` field at all.
    const localRead = await dbA.readUnfiltered('tasks');
    expect(localRead.ok).toBe(true);
    const localRow = localRead.ok
      ? (localRead.value.find((r) => r.id === taskId) as Record<string, unknown> | undefined)
      : undefined;
    expect(localRow).toBeDefined();
    expect(isEncryptedRecord(localRow)).toBe(true);
    expect(localRow?.['title']).toBeUndefined();
    await vaultA.lock();
  });

  it.fails(
    'DEFECT E10-Q4: an encrypted TASK is pushed with wire kind "task" (engine.ts:103 infers kind from `title in row`, which ciphertext never has)',
    async () => {
      const dbA = await freshBoot();
      const vaultA = new CryptoVault({ now });
      await vaultA.attach(dbA);
      registerVault(vaultA);
      await enableOn(dbA, vaultA);
      const taskId = testUlid('s1b-task');
      await dbA.put(
        'tasks',
        makeTask({ id: taskId, title: 'wire kind', deviceId: dbA.deviceId, updatedAt: now() }),
      );

      const fake = makeFakeWebDav();
      expect((await runEngine(dbA, clientFor(fake))).ok).toBe(true);

      let wireKind: string | undefined;
      for (const [p, body] of fake.state.files) {
        if (!p.endsWith('.json') || !p.includes('/changes/')) continue;
        const doc = JSON.parse(body) as { records?: unknown };
        const recs = JSON.parse(String(doc.records)) as { kind: string; record: { id: string } }[];
        const mine = recs.find((r) => r.record.id === taskId);
        if (mine !== undefined) wireKind = mine.kind;
      }
      // EncryptedTaskRecord.self-describes `kind: 'task'` (domain/model.ts:166);
      // the wire must carry that, not a `'title' in row` guess.
      expect(wireKind).toBe('task');
      await vaultA.lock();
    },
  );

  it('S2: one-way convergence — B joins the key, pulls A ciphertext and decrypts it', async () => {
    const dbA = await freshBoot();
    const vaultA = new CryptoVault({ now });
    await vaultA.attach(dbA);
    registerVault(vaultA);
    const { keyFile } = await enableOn(dbA, vaultA);

    // Device B joins the SAME key (D3.2 device-join).
    const dbB = await freshBoot();
    const vaultB = new CryptoVault({ now });
    await vaultB.attach(dbB);
    const joined = await vaultB.joinWithKeyFile(keyFile, 'device b passphrase');
    expect(joined.ok).toBe(true);
    expect(vaultB.isUnlocked).toBe(true);

    const fake = makeFakeWebDav();
    const taskId = testUlid('s2-task');

    // A creates and pushes.
    registerVault(vaultA);
    const created = await dbA.put(
      'tasks',
      makeTask({ id: taskId, title: 'original on A', deviceId: dbA.deviceId, updatedAt: now() }),
    );
    expect(created.ok).toBe(true);
    expect((await runEngine(dbA, clientFor(fake))).ok).toBe(true);

    // B pulls: row arrives as ciphertext and B decrypts it.
    registerVault(vaultB);
    const pulled = await runEngine(dbB, clientFor(fake));
    expect(pulled.ok).toBe(true);
    expect(await rawTitle(dbB, taskId)).not.toBe('original on A'); // not plaintext at rest
    expect(await viewTitle(vaultB, dbB, taskId)).toBe('original on A');

    await vaultA.lock();
    await vaultB.lock();
  });

  it.fails(
    'DEFECT E10-Q5: a second version of an encrypted task hard-fails the peer sync — CORRUPT_REMOTE (retryable:false), so the conflict copy round trip never completes',
    async () => {
      const dbA = await freshBoot();
      const vaultA = new CryptoVault({ now });
      await vaultA.attach(dbA);
      registerVault(vaultA);
      const { keyFile } = await enableOn(dbA, vaultA);

      const dbB = await freshBoot();
      const vaultB = new CryptoVault({ now });
      await vaultB.attach(dbB);
      expect((await vaultB.joinWithKeyFile(keyFile, 'device b passphrase')).ok).toBe(true);

      const fake = makeFakeWebDav();
      const taskId = testUlid('s2b-task');

      registerVault(vaultA);
      expect(
        (
          await dbA.put(
            'tasks',
            makeTask({
              id: taskId,
              title: 'original on A',
              deviceId: dbA.deviceId,
              updatedAt: now(),
            }),
          )
        ).ok,
      ).toBe(true);
      expect((await runEngine(dbA, clientFor(fake))).ok).toBe(true);

      registerVault(vaultB);
      expect((await runEngine(dbB, clientFor(fake))).ok).toBe(true);
      expect(await viewTitle(vaultB, dbB, taskId)).toBe('original on A');

      // A edits and pushes version 2; B pulls it. B already holds the id, so
      // planMerge compares B's local kind ('task', from the tasks store)
      // against the wire kind ('list' — engine.ts:103 guesses from `title in
      // row`, which ciphertext never has) → CORRUPT_REMOTE, non-retryable.
      registerVault(vaultA);
      const aRow = (await rawTasks(dbA)).find((r) => r['id'] === taskId) as unknown as Task;
      await dbA.put('tasks', { ...aRow, title: 'A edit (version 2)', updatedAt: now() });
      expect((await runEngine(dbA, clientFor(fake))).ok).toBe(true);

      registerVault(vaultB);
      const bRun = await runEngine(dbB, clientFor(fake));

      // DESIRED: the pull succeeds and both sides converge to ONE conflict copy.
      if (!bRun.ok) throw new Error(`B pull failed: ${JSON.stringify(bRun.error)}`);
      expect(await viewTitle(vaultB, dbB, taskId)).toBe('A edit (version 2)');
      const bRows = await rawTasks(dbB);
      const copies = bRows.filter((r) => r['id'] !== taskId);
      expect(copies).toHaveLength(1);
      const copyId = (copies[0] as { id: string }).id;
      expect(await viewTitle(vaultB, dbB, copyId)).toBe('Conflict copy of original on A');

      registerVault(vaultA);
      const aRun = await runEngine(dbA, clientFor(fake));
      expect(aRun.ok).toBe(true);
      const aRows = await rawTasks(dbA);
      expect(aRows).toHaveLength(2);
      expect(await viewTitle(vaultA, dbA, copyId)).toBe('Conflict copy of original on A');

      await vaultA.lock();
      await vaultB.lock();
    },
  );

  it('S3: a foreign-key device defers non-destructively (D3.3 mixed-key store)', async () => {
    // Device A enables its OWN key — B never joins it.
    const dbA = await freshBoot();
    const vaultA = new CryptoVault({ now });
    await vaultA.attach(dbA);
    registerVault(vaultA);
    const secret = 'A private row';
    await enableOn(dbA, vaultA);
    const foreignId = testUlid('s3-foreign');
    await dbA.put(
      'tasks',
      makeTask({ id: foreignId, title: secret, deviceId: dbA.deviceId, updatedAt: now() }),
    );

    const fake = makeFakeWebDav();
    expect((await runEngine(dbA, clientFor(fake))).ok).toBe(true);
    // A's own at-rest ciphertext — the bytes that must arrive on B unchanged.
    const aRow = await dbA.readUnfiltered('tasks');
    expect(aRow.ok).toBe(true);
    const foreignPayload = aRow.ok
      ? ((aRow.value.find((r) => r.id === foreignId) as { payload: string } | undefined)?.payload ??
        null)
      : null;
    expect(foreignPayload).not.toBeNull();
    await vaultA.lock();

    // Device B has C1 on under a DIFFERENT key and one row of its own.
    const dbB = await freshBoot();
    const vaultB = new CryptoVault({ now });
    await vaultB.attach(dbB);
    registerVault(vaultB);
    const ownId = testUlid('s3-own');
    await enableOn(dbB, vaultB);
    await dbB.put(
      'tasks',
      makeTask({ id: ownId, title: 'B own row', deviceId: dbB.deviceId, updatedAt: now() }),
    );

    // Pull A's ciphertext into B's store.
    const pulled = await runEngine(dbB, clientFor(fake));
    expect(pulled.ok).toBe(true);

    const after = await dbB.readUnfiltered('tasks');
    expect(after.ok).toBe(true);
    const foreignAfter = after.ok ? after.value.find((r) => r.id === foreignId) : undefined;
    // The foreign ciphertext is preserved VERBATIM (non-destructive deferral)…
    expect(foreignAfter).toBeDefined();
    expect(isEncryptedRecord(foreignAfter)).toBe(true);
    expect((foreignAfter as unknown as { payload: string }).payload).toBe(foreignPayload);
    // …and B's OWN data still decrypts normally.
    expect(await viewTitle(vaultB, dbB, ownId)).toBe('B own row');

    await vaultB.lock();
  });
});
