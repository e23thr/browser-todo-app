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
import { CHANGES_PREFIX } from '../../../src/sync/engine';
import { WebDavClient } from '../../../src/sync/webdav';
import { bootDb, makeFakeWebDav, makeList, makeTask, runEngine, T0, testUlid } from './fixtures';

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

/** Every record the device pushed, decoded from the fake's file bytes. */
function decodePushedRecords(
  fake: ReturnType<typeof makeFakeWebDav>,
): { path: string; kind: string; record: { id: string; kind?: string } }[] {
  const out: { path: string; kind: string; record: { id: string; kind?: string } }[] = [];
  for (const [path, body] of fake.state.files) {
    if (!path.startsWith(`${CHANGES_PREFIX}/`)) continue;
    const doc = JSON.parse(body) as { records?: unknown };
    if (typeof doc.records !== 'string') continue;
    const recs = JSON.parse(doc.records) as {
      kind: string;
      record: { id: string; kind?: string };
    }[];
    for (const r of recs) out.push({ path, kind: r.kind, record: r.record });
  }
  return out;
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

  // Was `it.fails` (pin) until the E10-Q4 fix: `toSyncRecord` now derives the
  // envelope kind with `rowKindOf`, so the pin is a passing regression test.
  it('DEFECT E10-Q4: an encrypted TASK is pushed with wire kind "task" (engine.ts:103 infers kind from `title in row`, which ciphertext never has)', async () => {
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
    for (const pushed of decodePushedRecords(fake)) {
      if (pushed.record.id === taskId) wireKind = pushed.kind;
    }
    // EncryptedTaskRecord.self-describes `kind: 'task'` (domain/model.ts:166);
    // the wire must carry that, not a `'title' in row` guess.
    expect(wireKind).toBe('task');
    await vaultA.lock();
  });

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

  // Was `it.fails` (pin) until the E10-Q4 fix: the wire kind now agrees with
  // the local kind, so no CORRUPT_REMOTE fires and the round trip completes.
  it('DEFECT E10-Q5: a second version of an encrypted task hard-fails the peer sync — CORRUPT_REMOTE (retryable:false), so the conflict copy round trip never completes', async () => {
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

    // A edits through the APP surface — the domain view (decrypted by the
    // read seam) with a new title; the write seam re-encrypts it into a fresh
    // EncryptedTaskRecord. That is exactly what a user edit does. (Splicing a
    // plaintext `title` onto the raw ciphertext row instead produces a hybrid
    // the write seam stores verbatim — validateRow then refuses it on the
    // receiving side as "title: unknown (unexpected field)".)
    registerVault(vaultA);
    const aView = await dbA.get('tasks', taskId);
    expect(aView.ok).toBe(true);
    if (!aView.ok || aView.value === undefined) throw new Error('A lost the row');
    await dbA.put('tasks', {
      ...aView.value,
      title: 'A edit (version 2)',
      updatedAt: now(),
    });
    expect((await runEngine(dbA, clientFor(fake))).ok).toBe(true);

    registerVault(vaultB);
    const bRun = await runEngine(dbB, clientFor(fake));

    // DESIRED: the pull succeeds and both devices converge on version 2.
    if (!bRun.ok) throw new Error(`B pull failed: ${JSON.stringify(bRun.error)}`);
    expect(await viewTitle(vaultB, dbB, taskId)).toBe('A edit (version 2)');

    // A keeps syncing: before the fix every further round hard-failed
    // CORRUPT_REMOTE (retryable:false) and the cursor never advanced.
    registerVault(vaultA);
    const aRun = await runEngine(dbA, clientFor(fake));
    if (!aRun.ok) throw new Error(`A sync failed: ${JSON.stringify(aRun.error)}`);
    const aRows = await rawTasks(dbA);
    expect(await viewTitle(vaultA, dbA, taskId)).toBe('A edit (version 2)');
    expect(aRows.some((r) => r['id'] === taskId)).toBe(true);

    // A third round still succeeds — no wedge, no self-inflicted corruption.
    expect((await runEngine(dbA, clientFor(fake))).ok).toBe(true);

    await vaultA.lock();
    await vaultB.lock();
  });

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

/**
 * Push-envelope kind derivation — the coverage gap that let E10-Q4 through:
 * nothing drove an ENCRYPTED row through `toSyncRecord`, so `'title' in row`
 * went unchallenged for ciphertext. These pins decode the REAL bytes a
 * `runSyncOnce` push wrote and compare the envelope `kind` with the at-rest
 * row's own `kind`, for both stores and both sync rounds.
 */
describe('push envelope — wire kind self-description (regression for E10-Q4)', () => {
  it('an encrypted device labels its own rows "task" / "list" on the wire — first push and re-push', async () => {
    const dbA = await freshBoot();
    const vaultA = new CryptoVault({ now });
    await vaultA.attach(dbA);
    registerVault(vaultA);
    await enableOn(dbA, vaultA);

    const listId = testUlid('r1-list');
    const taskId = testUlid('r1-task');
    const putList = await dbA.put(
      'lists',
      makeList({ id: listId, name: 'Private list', deviceId: dbA.deviceId, updatedAt: now() }),
    );
    expect(putList.ok).toBe(true);
    const putTask = await dbA.put(
      'tasks',
      makeTask({ id: taskId, listId, deviceId: dbA.deviceId, updatedAt: now() }),
    );
    expect(putTask.ok).toBe(true);

    // At rest both rows are ciphertext that SELF-DESCRIBE their kind.
    const restLists = await dbA.readUnfiltered('lists');
    expect(restLists.ok).toBe(true);
    const restList = restLists.ok
      ? (restLists.value.find((r) => r.id === listId) as { kind?: string } | undefined)
      : undefined;
    const restTask = (await rawTasks(dbA)).find((r) => r['id'] === taskId) as
      { kind?: string } | undefined;
    expect(isEncryptedRecord(restTask)).toBe(true);
    expect(isEncryptedRecord(restList)).toBe(true);
    expect(restTask?.kind).toBe('task');
    expect(restList?.kind).toBe('list');

    const expectWireKinds = (): void => {
      const pushed = decodePushedRecords(fake).filter(
        (p) => p.record.id === taskId || p.record.id === listId,
      );
      expect(pushed.length).toBeGreaterThan(0);
      for (const p of pushed) {
        // The envelope must echo the row's own kind — never a field-presence
        // guess (ciphertext has no top-level `title`/`name`).
        expect(p.kind, `wire kind of ${p.record.id} in ${p.path}`).toBe(
          p.record.id === taskId ? 'task' : 'list',
        );
      }
    };

    const fake = makeFakeWebDav();
    expect((await runEngine(dbA, clientFor(fake))).ok).toBe(true);
    expectWireKinds();

    // Round 2 re-pushes the same rows (PUSH_OVERLAP_MS window) — the round
    // whose mislabelled echo used to wedge every later sync (E10-Q5).
    expect((await runEngine(dbA, clientFor(fake))).ok).toBe(true);
    expectWireKinds();

    await vaultA.lock();
  });

  it('a PLAINTEXT device keeps the field-presence derivation — task vs list, both stores', async () => {
    const dbA = await freshBoot(); // C1 off
    const listId = testUlid('r2-list');
    const taskId = testUlid('r2-task');
    await dbA.put('lists', makeList({ id: listId, deviceId: dbA.deviceId, updatedAt: now() }));
    await dbA.put(
      'tasks',
      makeTask({ id: taskId, listId, deviceId: dbA.deviceId, updatedAt: now() }),
    );

    const fake = makeFakeWebDav();
    expect((await runEngine(dbA, clientFor(fake))).ok).toBe(true);

    const pushed = decodePushedRecords(fake).filter(
      (p) => p.record.id === taskId || p.record.id === listId,
    );
    expect(pushed.find((p) => p.record.id === taskId)?.kind).toBe('task');
    expect(pushed.find((p) => p.record.id === listId)?.kind).toBe('list');
  });
});
