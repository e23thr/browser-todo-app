/**
 * The C1 session vault (ADR-007 Decisions 2/4/5) — ONE per tab (module-scoped
 * singleton; BroadcastChannel key-sharing is deliberately out, Decision 5.1).
 *
 * Owns: the `crypto_state` row cache, the in-memory DMK ring (non-extractable
 * `CryptoKey`s — raw bytes never leave WebCrypto), the `LockState` signal and
 * idle timer, the row seam (decrypt on read / encrypt on write at the AppDB
 * boundary), snapshot-payload wrapping (Decision 4.4), and the sync merge seam
 * (Decision 8.3 conflict-copy materialization).
 *
 * Memory hygiene (Decision 5.3, honest): JS cannot reliably zero memory —
 * `lock()` drops key references, decrypted caches and the search index;
 * plaintext survives only until GC.
 */

import type { Result } from '../domain/kernel';
import type {
  EncryptedListRecord,
  EncryptedTaskRecord,
  List,
  ListPayload,
  Task,
  TaskPayload,
} from '../domain/model';
import { isEncryptedRecord, rowKindOf } from '../domain/model';
import type { AppDBImpl } from '../storage/db';
import { setRowCryptoSeam } from '../storage/cryptoSeam';
import type { RowCryptoSeam } from '../storage/cryptoSeam';
import type { CryptoStateRecord, KeyEntry } from '../storage/types';
import { CRYPTO_KEY } from '../storage/schema';
import { defaultCryptoStateRow } from '../storage/migrations';
import type { StorageError } from '../storage/errors';
import { setMergeCryptoSeam } from '../sync/mergeSeam';
import type { MergeCryptoSeam, MergeCopyError } from '../sync/mergeSeam';
import { conflictCopyTitle } from '../domain/merge';
import { cryptoErr, cryptoOk } from './errors';
import type { CryptoResult } from './errors';
import {
  DEFAULT_LOCK_MINUTES,
  defaultIdleTimerEnv,
  fireLockDrops,
  IdleTimer,
  lockState,
  preLockWarning,
} from './lock';
import type { IdleTimerEnv } from './lock';
import { aadForSnapshot, open, openPayload, seal, sealPayload } from './payload';
import {
  addRecoverySlot,
  rewrapEntryWithPassphrase,
  unlockEntryWithRecovery,
  unlockRingWithPassphrase,
  unwrapDmk,
} from './keys';
import { decodeRecoveryCode, parseKeyFile, recoveryKek } from './recovery';
import type { KeyFile } from './recovery';

/** The self-contained at-rest wrapper for snapshot payload strings (Decision 4.4). */
export type WrappedSnapshotPayload = {
  format: 'todo-enc/1';
  v: 1;
  iv: string;
  ct: string;
};

const SNAPSHOT_WRAPPER_FORMAT = 'todo-enc/1';

/** Decrypted-field caps (Decision 4.1: enforced at decrypt time, then quarantined). */
const MAX_TITLE = 1000;
const MAX_NAME = 200;
const MAX_NOTES = 20_000;
const MAX_TAGS = 50;
const MAX_TAG_LEN = 100;

function storageBlocked(message: string): StorageError {
  return { code: 'BLOCKED', message: `LOCKED: ${message}` };
}

function payloadOfTask(task: Task): TaskPayload {
  return { title: task.title, notes: task.notes, tags: [...task.tags] };
}

function payloadOfList(list: List): ListPayload {
  return { name: list.name };
}

/** Structural rebuild after decrypt — field-by-field, never spread of ciphertext rows. */
function taskViewOf(row: EncryptedTaskRecord, payload: TaskPayload): Task {
  const view: Task = {
    id: row.id,
    listId: row.listId,
    title: payload.title,
    notes: payload.notes,
    status: row.status,
    priority: row.priority,
    tags: [...payload.tags],
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
    deviceId: row.deviceId,
  };
  if (row.dueDate !== undefined) view.dueDate = row.dueDate;
  if (row.reminderAt !== undefined) view.reminderAt = row.reminderAt;
  if (row.recurrence !== undefined) view.recurrence = row.recurrence;
  if (row.parentTaskId !== undefined) view.parentTaskId = row.parentTaskId;
  if (row.completedAt !== undefined) view.completedAt = row.completedAt;
  return view;
}

function listViewOf(row: EncryptedListRecord, payload: ListPayload): List {
  return {
    id: row.id,
    name: payload.name,
    color: row.color,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
    deviceId: row.deviceId,
  };
}

/** Caps on decrypted fields (Decision 4.1) — violations quarantine at read time. */
export function payloadWithinCaps(kind: 'task' | 'list', payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  if (kind === 'list') {
    const p = payload as Partial<ListPayload>;
    return (
      typeof p.name === 'string' &&
      p.name.trim().length >= 1 &&
      p.name.length <= MAX_NAME &&
      Object.keys(payload).every((k) => k === 'name')
    );
  }
  const p = payload as Partial<TaskPayload>;
  return (
    typeof p.title === 'string' &&
    p.title.trim().length >= 1 &&
    p.title.length <= MAX_TITLE &&
    (p.notes === null || (typeof p.notes === 'string' && p.notes.length <= MAX_NOTES)) &&
    Array.isArray(p.tags) &&
    p.tags.length <= MAX_TAGS &&
    p.tags.every(
      (t: unknown) => typeof t === 'string' && t.trim().length >= 1 && t.length <= MAX_TAG_LEN,
    ) &&
    Object.keys(payload).every((k) => k === 'title' || k === 'notes' || k === 'tags')
  );
}

export type VaultOptions = {
  now?: () => number;
  idleEnv?: IdleTimerEnv;
};

export class CryptoVault {
  readonly #now: () => number;
  readonly #idle: IdleTimer;
  #db: AppDBImpl | null = null;
  #state: CryptoStateRecord | null = null;
  #dmks = new Map<string, CryptoKey>();

  constructor(options: VaultOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#idle = new IdleTimer(options.idleEnv ?? defaultIdleTimerEnv(), {
      onPreLock: () => {
        preLockWarning.value = this.#now();
      },
      onLock: () => {
        void this.lock();
      },
    });
  }

  /** Attach the booted DB and load `crypto_state` (idempotent). */
  async attach(db: AppDBImpl): Promise<void> {
    this.#db = db;
    await this.refreshState();
    this.#syncLockState();
  }

  get db(): AppDBImpl | null {
    return this.#db;
  }

  /** Read-through `crypto_state` (default row when absent — pre-v4 DBs mid-boot). */
  async refreshState(): Promise<CryptoStateRecord | null> {
    const db = this.#db;
    if (db === null) return this.#state;
    const read = await db.get('crypto_state', CRYPTO_KEY);
    if (!read.ok) return this.#state;
    this.#state = read.value ?? defaultCryptoStateRow();
    return this.#state;
  }

  get state(): CryptoStateRecord | null {
    return this.#state;
  }

  /** The effective status (`off` before attach — C1 cannot be on without state). */
  get status(): 'off' | 'migrating' | 'on' {
    return this.#state?.status ?? 'off';
  }

  get isUnlocked(): boolean {
    return this.#dmks.size > 0;
  }

  get keyIds(): string[] {
    return [...this.#dmks.keys()];
  }

  get lockAfterMinutes(): number {
    return this.#state?.lockAfterMinutes ?? DEFAULT_LOCK_MINUTES;
  }

  /** Persist a `crypto_state` patch (one atomic write). */
  async saveState(patch: Partial<CryptoStateRecord>): Promise<CryptoResult<CryptoStateRecord>> {
    const db = this.#db;
    if (db === null) return cryptoErr('NOT_ENABLED', 'vault is not attached to a database');
    const current = this.#state ?? defaultCryptoStateRow();
    const next: CryptoStateRecord = { ...current, ...patch, id: 'crypto' };
    const written = await db.put('crypto_state', next);
    if (!written.ok) {
      return cryptoErr(
        written.error.code === 'QUOTA_EXCEEDED' ? 'QUOTA_EXCEEDED' : 'MIGRATION_FAILED',
        'failed to persist crypto state',
        written.error.code,
      );
    }
    this.#state = next;
    this.#syncLockState();
    return cryptoOk(next);
  }

  /* ------------------------------ unlock / lock ------------------------------ */

  /**
   * Unlock with the passphrase (Decision 6.3): `UNLOCK_FAILED` on a wrong
   * passphrase — retryable, nothing touched. PBKDF2's own cost is the rate
   * limit. Tries the whole key ring (mixed-key stores, Decision 2.3).
   */
  async unlockWithPassphrase(passphrase: string): Promise<CryptoResult<string[]>> {
    const state = this.#state;
    if (state === null) return cryptoErr('NOT_ENABLED', 'crypto state is unavailable');
    if (state.status === 'off') return cryptoErr('NOT_ENABLED', 'encryption is not enabled');
    const unlocked = await unlockRingWithPassphrase(state.keys, passphrase, {
      now: this.#now(),
    });
    if (!unlocked.ok) return cryptoErr(unlocked.error.code, unlocked.error.message);
    for (const entry of unlocked.value) this.#dmks.set(entry.keyId, entry.dmk);
    // Lazy kdf-floor upgrades (Decision 2.2) persist as part of unlock.
    const upgraded = unlocked.value.find((e) => e.upgradedSlot !== null);
    if (upgraded?.upgradedSlot != null) {
      const slot = upgraded.upgradedSlot;
      await this.saveState({
        keys: state.keys.map((k) =>
          k.keyId === upgraded.keyId
            ? { ...k, slots: k.slots.map((s) => (s.kind === 'passphrase' ? slot : s)) }
            : k,
        ),
      });
    }
    this.#afterUnlock();
    return cryptoOk(this.keyIds);
  }

  /**
   * Recovery-code unlock (Decision 3.1/6.3): checksum pre-check catches typos
   * before any crypto. The caller then prompts for a NEW passphrase
   * (`changePassphrase`) — the recovery path re-wraps the DMK, it never
   * re-encrypts records.
   */
  async unlockWithRecoveryCode(input: string): Promise<CryptoResult<string[]>> {
    const state = this.#state;
    if (state === null) return cryptoErr('NOT_ENABLED', 'crypto state is unavailable');
    const decoded = await decodeRecoveryCode(input);
    if (!decoded.ok) return decoded;
    return this.#unlockWithRecoverySecret(decoded.value);
  }

  /** Key-file unlock (Decision 3.1/3.2). */
  async unlockWithKeyFile(raw: unknown): Promise<CryptoResult<string[]>> {
    const parsed = parseKeyFile(raw);
    if (!parsed.ok) return parsed;
    return this.#unlockWithKeyFile(parsed.value, false);
  }

  async #unlockWithKeyFile(file: KeyFile, adopt: boolean): Promise<CryptoResult<string[]>> {
    const state = this.#state;
    if (state === null) return cryptoErr('NOT_ENABLED', 'crypto state is unavailable');
    const decoded = await decodeRecoveryCode(file.recoveryCode);
    if (!decoded.ok) return decoded;

    // A key file is a complete emergency kit for ITS OWN store (Decision 3.1) —
    // but on a store that already has keys, a file whose keyId matches nothing
    // is "a key file from a different store" (Decision 9): WRONG_KEY_DOMAIN,
    // nothing touched. Adoption into the ring is `joinWithKeyFile`'s explicit
    // action (Decision 3.3's mixed-key path) — that path skips the guard.
    if (!adopt && state.keys.length > 0 && !state.keys.some((k) => k.keyId === file.keyId)) {
      return cryptoErr('WRONG_KEY_DOMAIN', "this key file doesn't match this data");
    }

    // The file's own recovery-wrapped DMK — unwrap directly first.
    const kek = await recoveryKek(decoded.value);
    const direct = await unwrapDmk(file.wrappedDmk, file.keyId, kek, 'recovery');
    if (direct.ok) {
      this.#dmks.set(file.keyId, direct.value);
      await this.#adoptKeyEntry(file);
      this.#afterUnlock();
      return cryptoOk(this.keyIds);
    }
    // Fall back to the local ring (the file's key may already be registered).
    return this.#unlockWithRecoverySecret(decoded.value);
  }

  async #unlockWithRecoverySecret(secret: Uint8Array): Promise<CryptoResult<string[]>> {
    const state = this.#state;
    if (state === null) return cryptoErr('NOT_ENABLED', 'crypto state is unavailable');
    let any = false;
    for (const entry of state.keys) {
      const unlocked = await unlockEntryWithRecovery(entry, secret);
      if (unlocked.ok) {
        any = true;
        this.#dmks.set(entry.keyId, unlocked.value.dmk);
      }
    }
    if (!any) {
      return cryptoErr('WRONG_KEY_DOMAIN', "this key file doesn't match this data");
    }
    this.#afterUnlock();
    return cryptoOk(this.keyIds);
  }

  /**
   * Device join (Decision 3.2): unwrap via the key file, then create a LOCAL
   * passphrase slot over the same DMK (zero record re-encryption).
   */
  async joinWithKeyFile(file: KeyFile, localPassphrase: string): Promise<CryptoResult<string[]>> {
    const unlocked = await this.#unlockWithKeyFile(file, true);
    if (!unlocked.ok) return unlocked;
    const dmk = this.#dmks.get(file.keyId);
    const state = this.#state;
    if (dmk === undefined || state === null) {
      return cryptoErr('WRONG_KEY_DOMAIN', 'key file did not unlock');
    }
    const existing = state.keys.find((k) => k.keyId === file.keyId);
    const base: KeyEntry = existing ?? { keyId: file.keyId, slots: [], createdAt: this.#now() };
    const rewrapped = await rewrapEntryWithPassphrase(dmk, base, localPassphrase, this.#now());
    if (!rewrapped.ok) return rewrapped;
    await this.saveState({
      keys: [...state.keys.filter((k) => k.keyId !== file.keyId), rewrapped.value],
    });
    this.#afterUnlock();
    return cryptoOk(this.keyIds);
  }

  /** Adopt a key file's entry into the ring (its recovery slot, keyed by keyId). */
  async #adoptKeyEntry(file: KeyFile): Promise<void> {
    const state = this.#state;
    if (state === null || state.keys.some((k) => k.keyId === file.keyId)) return;
    const entry: KeyEntry = {
      keyId: file.keyId,
      slots: [
        {
          kind: 'recovery',
          kdf: { v: 1, alg: 'HKDF-SHA-256', info: 'todo-enc/1/recovery-kek' },
          wrap: file.wrappedDmk,
          createdAt: this.#now(),
        },
      ],
      createdAt: this.#now(),
    };
    await this.saveState({ keys: [...state.keys, entry] });
  }

  /**
   * Change the passphrase (Decision 9 table): re-wrap ONE key — zero record
   * re-encryption, zero sync traffic. Requires an unlocked session.
   */
  async changePassphrase(newPassphrase: string): Promise<CryptoResult<KeyEntry>> {
    const state = this.#state;
    const keyId = this.keyIds[0];
    const dmk = keyId === undefined ? undefined : this.#dmks.get(keyId);
    const entry = state?.keys.find((k) => k.keyId === keyId);
    if (state === null || dmk === undefined || entry === undefined) {
      return cryptoErr('LOCKED', 'unlock first');
    }
    const rewrapped = await rewrapEntryWithPassphrase(dmk, entry, newPassphrase, this.#now());
    if (!rewrapped.ok) return rewrapped;
    await this.saveState({
      keys: state.keys.map((k) => (k.keyId === entry.keyId ? rewrapped.value : k)),
    });
    return cryptoOk(rewrapped.value);
  }

  /** Issue the optional recovery slot (Decision 3.1) and build the key file. */
  async issueRecoveryKey(secret: Uint8Array, recoveryCode: string): Promise<CryptoResult<KeyFile>> {
    const state = this.#state;
    const keyId = this.keyIds[0];
    const dmk = keyId === undefined ? undefined : this.#dmks.get(keyId);
    const entry = state?.keys.find((k) => k.keyId === keyId);
    if (state === null || dmk === undefined || entry === undefined) {
      return cryptoErr('LOCKED', 'unlock first');
    }
    const issued = await addRecoverySlot(dmk, entry, secret, this.#now());
    if (!issued.ok) return issued;
    await this.saveState({
      keys: state.keys.map((k) => (k.keyId === entry.keyId ? issued.value.entry : k)),
      recoveryOfferedAt: this.#now(),
    });
    return cryptoOk({
      format: 'todo-key/1',
      createdAt: this.#now(),
      keyId: entry.keyId,
      recoveryCode,
      kdf: { v: 1, alg: 'HKDF-SHA-256', info: 'todo-enc/1/recovery-kek' },
      wrappedDmk: issued.value.wrap,
    });
  }

  /** Record the recovery-offer outcome (Decision 3.1 — the decline is recorded). */
  async recordRecoveryOffer(): Promise<CryptoResult<CryptoStateRecord>> {
    return this.saveState({ recoveryOfferedAt: this.#now() });
  }

  /**
   * Lock (Decision 5.2): drop the DMK ring, decrypted caches and the search
   * index; the next read path shows the locked screen. Idempotent.
   */
  async lock(): Promise<void> {
    this.#dmks.clear();
    this.#idle.stop();
    fireLockDrops();
    preLockWarning.value = null;
    this.#syncLockState();
    await Promise.resolve();
  }

  /** Manual "Lock now". */
  lockNow(): void {
    void this.lock();
  }

  /**
   * Adopt a freshly minted DMK into the session ring (enable flow — the key is
   * non-extractable and lives in memory only, Decision 5.1/5.3).
   */
  acceptSessionKey(keyId: string, dmk: CryptoKey): void {
    this.#dmks.set(keyId, dmk);
    this.#afterUnlock();
  }

  /**
   * Verify a passphrase against the ring WITHOUT unlocking (Decision 6.2's
   * disable confirmation). A wrong passphrase = `UNLOCK_FAILED`, nothing
   * touched.
   */
  async verifyPassphrase(passphrase: string): Promise<CryptoResult<null>> {
    const state = this.#state;
    if (state === null || state.keys.length === 0) {
      return cryptoErr('NOT_ENABLED', 'no key ring to verify against');
    }
    const checked = await unlockRingWithPassphrase(state.keys, passphrase, { now: this.#now() });
    return checked.ok ? cryptoOk(null) : cryptoErr('UNLOCK_FAILED', checked.error.message);
  }

  #afterUnlock(): void {
    preLockWarning.value = null;
    this.#syncLockState();
    if (this.isUnlocked) {
      this.#idle.configure(this.lockAfterMinutes);
    }
  }

  #syncLockState(): void {
    const state = this.#state;
    if (state === null || state.status === 'off') {
      lockState.value = { status: 'disabled' };
      return;
    }
    lockState.value = this.isUnlocked
      ? { status: 'unlocked', keyIds: this.keyIds }
      : { status: 'locked', since: this.#now() };
  }

  /* -------------------------------- row seam -------------------------------- */

  readonly rowSeam: RowCryptoSeam = {
    readRow: (store, row) => this.readRow(store, row),
    writeRow: (store, row) => this.writeRow(store, row),
  };

  /**
   * At-rest row -> domain view. Plaintext rows pass through; ciphertext rows
   * decrypt (ring keys in order — Decision 2.3). A decrypt failure returns
   * `undefined` = quarantine marker (the AppDB layer records the entry).
   * While LOCKED the raw row passes through: envelope operations keep working
   * and the UI is on the locked screen (Decision 4.3).
   */
  async readRow(store: 'tasks' | 'lists', row: unknown): Promise<Result<unknown, StorageError>> {
    if (!isEncryptedRecord(row)) return { ok: true, value: row };
    if (!this.isUnlocked) return { ok: true, value: row };
    const view = await this.decryptRecord(store, row);
    if (view.ok && view.value !== undefined) return { ok: true, value: view.value };
    return { ok: true, value: undefined };
  }

  /**
   * Domain view -> at-rest row. Encrypted rows are written VERBATIM (this is how
   * tombstoning-while-locked works — Decision 8.2). Plaintext rows encrypt when
   * C1 is on and unlocked; a plaintext write while locked is REFUSED — never
   * silently stored (Decision 4).
   */
  async writeRow(store: 'tasks' | 'lists', row: unknown): Promise<Result<unknown, StorageError>> {
    if (isEncryptedRecord(row)) return { ok: true, value: row };
    if (this.status === 'off') return { ok: true, value: row };
    if (!this.isUnlocked) {
      return { ok: false, error: storageBlocked('unlock to write task content') };
    }
    const sealed = await this.encryptRecord(store, row as Task | List);
    if (!sealed.ok) {
      return {
        ok: false,
        error: { code: 'INVALID_RECORD', store, issues: [sealed.error.message] },
      };
    }
    return { ok: true, value: sealed.value };
  }

  /**
   * Decrypt one at-rest row to its domain view. Returns `undefined` = the row
   * is unreadable under every ring key (or violates the field caps) — the
   * caller quarantines it (Decision 9: never crashed on, never dropped).
   */
  async decryptRecord(
    store: 'tasks' | 'lists',
    row: EncryptedTaskRecord | EncryptedListRecord,
  ): Promise<CryptoResult<Task | List | undefined>> {
    if (!isEncryptedRecord(row)) return cryptoOk(row as unknown as Task | List);
    const kind = store === 'tasks' ? 'task' : 'list';
    for (const dmk of this.#dmks.values()) {
      const opened = await openPayload<unknown>(dmk, kind, row.id, row.enc, row.payload);
      if (!opened.ok) {
        if (opened.error.code === 'NEWER_ENVELOPE') {
          return cryptoErr('NEWER_ENVELOPE', opened.error.message);
        }
        continue; // try the next ring key (mixed-key store, Decision 2.3)
      }
      if (!payloadWithinCaps(kind, opened.value)) return cryptoOk(undefined);
      if (kind === 'task') {
        return cryptoOk(
          taskViewOf(row as unknown as EncryptedTaskRecord, opened.value as TaskPayload),
        );
      }
      return cryptoOk(
        listViewOf(row as unknown as EncryptedListRecord, opened.value as ListPayload),
      );
    }
    return cryptoOk(undefined);
  }

  /** Encrypt one domain view to its at-rest shape (fresh IV — Decision 1.1). */
  async encryptRecord(
    store: 'tasks' | 'lists',
    view: Task | List,
  ): Promise<CryptoResult<EncryptedTaskRecord | EncryptedListRecord>> {
    const keyId = this.keyIds[0];
    const dmk = keyId === undefined ? undefined : this.#dmks.get(keyId);
    if (dmk === undefined) return cryptoErr('LOCKED', 'no session key');
    const kind = store === 'tasks' ? 'task' : 'list';
    const payload = kind === 'task' ? payloadOfTask(view as Task) : payloadOfList(view as List);
    const sealed = await sealPayload(dmk, kind, view.id, payload);
    const envelope = {
      id: view.id,
      updatedAt: view.updatedAt,
      deviceId: view.deviceId,
      deletedAt: view.deletedAt,
      payloadHash: sealed.payloadHash,
      enc: sealed.enc,
      payload: sealed.payload,
      sortOrder: view.sortOrder,
      createdAt: view.createdAt,
    };
    if (kind === 'task') {
      const t = view as Task;
      const out: EncryptedTaskRecord = {
        ...envelope,
        kind: 'task',
        listId: t.listId,
        status: t.status,
        priority: t.priority,
      };
      if (t.dueDate !== undefined) out.dueDate = t.dueDate;
      if (t.reminderAt !== undefined) out.reminderAt = t.reminderAt;
      if (t.recurrence !== undefined) out.recurrence = t.recurrence;
      if (t.parentTaskId !== undefined) out.parentTaskId = t.parentTaskId;
      if (t.completedAt !== undefined) out.completedAt = t.completedAt;
      return cryptoOk(out);
    }
    const l = view as List;
    return cryptoOk({ ...envelope, kind: 'list', color: l.color });
  }

  /* ----------------------- snapshot payloads (Decision 4.4) ----------------------- */

  /** Wrap a plaintext ADR-004 JSON payload for at-rest storage (Decision 4.4). */
  async wrapSnapshotPayload(snapshotId: string, json: string): Promise<CryptoResult<string>> {
    // C1 off / pre-enable: plaintext at rest is the documented state (D4.4:
    // wrap iff `status` protects the content).
    if (this.status === 'off') return cryptoOk(json);
    const dmk = this.#dmks.values().next().value;
    if (dmk === undefined) return cryptoErr('LOCKED', 'unlock to store snapshots');
    const { iv, ct } = await seal(dmk, aadForSnapshot(snapshotId), json);
    const wrapped: WrappedSnapshotPayload = { format: SNAPSHOT_WRAPPER_FORMAT, v: 1, iv, ct };
    return cryptoOk(JSON.stringify(wrapped));
  }

  /**
   * Unwrap a stored snapshot payload. Plaintext payloads (pre-C1 / C1-off
   * snapshots) pass through unchanged.
   */
  async unwrapSnapshotPayload(snapshotId: string, stored: string): Promise<CryptoResult<string>> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stored);
    } catch {
      return cryptoOk(stored); // not our wrapper — legacy plaintext payload
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { format?: unknown }).format !== SNAPSHOT_WRAPPER_FORMAT
    ) {
      return cryptoOk(stored);
    }
    const wrapped = parsed as WrappedSnapshotPayload;
    // A wrapper-shaped object with malformed iv/ct is a damaged payload —
    // typed failure, never a throw (contract 4).
    if (typeof wrapped.iv !== 'string' || typeof wrapped.ct !== 'string') {
      return cryptoErr('DECRYPT_FAILED', 'snapshot payload wrapper is malformed');
    }
    for (const dmk of this.#dmks.values()) {
      const opened = await open(dmk, aadForSnapshot(snapshotId), wrapped.iv, wrapped.ct);
      if (opened.ok) return cryptoOk(opened.value);
    }
    // Keys present but nothing opened -> damaged ciphertext. No keys -> locked.
    return this.#dmks.size === 0
      ? cryptoErr('LOCKED', 'snapshot payload is encrypted — unlock to restore')
      : cryptoErr('DECRYPT_FAILED', 'snapshot payload cannot be decrypted');
  }

  /* --------------------------- sync merge seam (D8.3) --------------------------- */

  readonly mergeSeam: MergeCryptoSeam = {
    canDecrypt: () => this.isUnlocked,
    displayTitle: async (row) => {
      const view = await this.decryptRecord(
        rowKindOf(row) === 'task' ? 'tasks' : 'lists',
        row as EncryptedTaskRecord | EncryptedListRecord,
      );
      if (!view.ok || view.value === undefined) return '(encrypted)';
      return rowKindOf(row) === 'task' ? (view.value as Task).title : (view.value as List).name;
    },
    conflictCopyRow: (loser, copyId, now, deviceId) =>
      this.conflictCopyRow(loser, copyId, now, deviceId),
  };

  /**
   * Decision 8.3: loser -> "Conflict copy of <title>" -> fresh id/IV under the
   * NEW identity (the AAD binds the copy to `copyId`).
   */
  async conflictCopyRow(
    loser: Task | EncryptedTaskRecord,
    copyId: string,
    now: number,
    deviceId: string,
  ): Promise<Result<Task | EncryptedTaskRecord, MergeCopyError>> {
    const keyId = this.keyIds[0];
    const dmk = keyId === undefined ? undefined : this.#dmks.get(keyId);
    if (dmk === undefined) {
      return { ok: false, error: { code: 'LOCKED', message: 'not unlocked' } };
    }
    let payload: TaskPayload;
    let structural: EncryptedTaskRecord;
    if (isEncryptedRecord(loser)) {
      const opened = await this.decryptRecord('tasks', loser);
      if (!opened.ok || opened.value === undefined) {
        return {
          ok: false,
          error: { code: 'DECRYPT_FAILED', message: 'losing version could not be decrypted' },
        };
      }
      payload = payloadOfTask(opened.value as Task);
      structural = loser;
    } else {
      payload = payloadOfTask(loser);
      structural = {
        id: loser.id,
        kind: 'task',
        updatedAt: loser.updatedAt,
        deviceId: loser.deviceId,
        deletedAt: loser.deletedAt,
        payloadHash: '',
        enc: { alg: 'AES-GCM', v: 1, iv: '' },
        payload: '',
        listId: loser.listId,
        status: loser.status,
        priority: loser.priority,
        sortOrder: loser.sortOrder,
        createdAt: loser.createdAt,
        ...(loser.dueDate !== undefined ? { dueDate: loser.dueDate } : {}),
        ...(loser.reminderAt !== undefined ? { reminderAt: loser.reminderAt } : {}),
        ...(loser.recurrence !== undefined ? { recurrence: loser.recurrence } : {}),
        ...(loser.parentTaskId !== undefined ? { parentTaskId: loser.parentTaskId } : {}),
        ...(loser.completedAt !== undefined ? { completedAt: loser.completedAt } : {}),
      };
    }
    payload = { ...payload, title: conflictCopyTitle(payload.title) };
    const sealed = await sealPayload(dmk, 'task', copyId, payload);
    const copy: EncryptedTaskRecord = {
      id: copyId,
      kind: 'task',
      updatedAt: now,
      deviceId,
      deletedAt: null,
      payloadHash: sealed.payloadHash,
      enc: sealed.enc,
      payload: sealed.payload,
      listId: structural.listId,
      status: structural.status,
      priority: structural.priority,
      sortOrder: structural.sortOrder,
      createdAt: now,
    };
    if (structural.dueDate !== undefined) copy.dueDate = structural.dueDate;
    if (structural.reminderAt !== undefined) copy.reminderAt = structural.reminderAt;
    if (structural.recurrence !== undefined) copy.recurrence = structural.recurrence;
    if (structural.parentTaskId !== undefined) copy.parentTaskId = structural.parentTaskId;
    return { ok: true, value: copy };
  }
}

/** The session vault (one per tab — Decision 5.1). */
export const vault = new CryptoVault();

/** Register a vault instance on the global seams (the app's = `vault`; tests build their own). */
export function registerVault(v: CryptoVault): void {
  setRowCryptoSeam(v.rowSeam);
  setMergeCryptoSeam(v.mergeSeam);
}

/** Register the default session vault on the global seams (app startup). */
export function initCryptoSeams(): void {
  registerVault(vault);
}
