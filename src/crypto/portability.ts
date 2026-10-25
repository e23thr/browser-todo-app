/**
 * C1 <-> portability integration (ADR-007 Decisions 4.4/4.5):
 *
 * - EXPORTS ARE ALWAYS PLAINTEXT (Decision 4.5): a backup that needs the lost
 *   passphrase is no backup. Every at-rest row is decrypted before the ADR-004
 *   document is built; a locked store surfaces `LOCKED` (an unlock prompt —
 *   never a silently truncated file); an unreadable row fails the export with
 *   the count (the recovery file is the channel for those bytes).
 * - USER SNAPSHOT PAYLOADS are byte-identical plaintext ADR-004 JSON WRAPPED at
 *   rest (Decision 4.4) — `cryptoCodecHooks` plugs the async wrap/unwrap into
 *   the `SnapshotCodec` seam. The MIGRATION chain's rollback snapshots use the
 *   RAW codec on purpose (byte-identical restore, works while locked).
 */

import type { List, ListRowLike, Task, TaskRowLike } from '../domain/model';
import { isEncryptedRecord } from '../domain/model';
import type { SnapshotSource } from '../storage/snapshots';
import type { StorageError } from '../storage/errors';
import { cryptoErr, cryptoOk } from './errors';
import type { CryptoResult } from './errors';
import type { CryptoVault } from './vault';

/** Decrypt every at-rest row to its plaintext domain shape (export/snapshot dumps). */
export async function decryptRowsForDocument(
  vault: CryptoVault,
  stores: { lists: ListRowLike[]; tasks: TaskRowLike[] },
): Promise<CryptoResult<{ lists: List[]; tasks: Task[] }>> {
  const lists: List[] = [];
  const tasks: Task[] = [];
  let unreadable = 0;
  let encrypted = 0;

  for (const row of stores.lists) {
    if (!isEncryptedRecord(row)) {
      lists.push(row);
      continue;
    }
    encrypted += 1;
    const view = await vault.decryptRecord('lists', row);
    if (!view.ok || view.value === undefined) unreadable += 1;
    else lists.push(view.value as List);
  }
  for (const row of stores.tasks) {
    if (!isEncryptedRecord(row)) {
      tasks.push(row);
      continue;
    }
    encrypted += 1;
    const view = await vault.decryptRecord('tasks', row);
    if (!view.ok || view.value === undefined) unreadable += 1;
    else tasks.push(view.value as Task);
  }

  // Decision 4.5: "Export is refused (LOCKED) while locked" — the refusal wins
  // over per-row accounting (a locked vault can't even attempt the decryptions,
  // so "unreadable" would be a lie).
  if (encrypted > 0 && !vault.isUnlocked) {
    return cryptoErr('LOCKED', 'unlock to export — the backup file is plaintext');
  }
  if (unreadable > 0) {
    return cryptoErr(
      'DECRYPT_FAILED',
      `${String(unreadable)} record(s) cannot be decrypted — download the recovery file for those bytes; no backup was written`,
    );
  }
  return cryptoOk({ lists, tasks });
}

/**
 * Snapshot-payload at-rest policy (Decision 4.4): wrap iff the payload would
 * otherwise leak user text while C1 protects it — `on`, or the enable sweep.
 * The DISABLE sweep deliberately does NOT wrap (its keys are about to be
 * wiped — a wrapped payload there would be unreadable forever).
 */
export function shouldWrapSnapshotPayloads(vault: CryptoVault): boolean {
  const state = vault.state;
  if (state === null || state.status === 'off') return false;
  if (state.status === 'on') return true;
  return state.migration?.direction === 'encrypt';
}

/**
 * The `SnapshotCodec` async hooks for USER snapshots (Decision 4.4): decrypt
 * rows before serialization (the JSON inside is the plaintext ADR-004 export
 * format) and wrap/unwrap the serialized string at rest.
 */
export function cryptoCodecHooks(vault: CryptoVault): {
  preSerialize: (
    source: SnapshotSource,
  ) => Promise<{ ok: true; value: SnapshotSource } | { ok: false; error: StorageError }>;
  seal: (
    snapshotId: string,
    json: string,
  ) => Promise<{ ok: true; value: string } | { ok: false; error: StorageError }>;
  open: (
    snapshotId: string,
    stored: string,
  ) => Promise<{ ok: true; value: string } | { ok: false; error: StorageError }>;
} {
  return {
    async preSerialize(source) {
      const decrypted = await decryptRowsForDocument(vault, {
        lists: source.stores.lists,
        tasks: source.stores.tasks,
      });
      if (!decrypted.ok) {
        return {
          ok: false,
          error: { code: 'BLOCKED', message: `LOCKED: ${decrypted.error.message}` },
        };
      }
      return {
        ok: true,
        value: {
          ...source,
          stores: {
            ...source.stores,
            lists: decrypted.value.lists,
            tasks: decrypted.value.tasks,
          },
        },
      };
    },
    async seal(snapshotId, json) {
      if (!shouldWrapSnapshotPayloads(vault)) return { ok: true, value: json };
      const wrapped = await vault.wrapSnapshotPayload(snapshotId, json);
      return wrapped.ok
        ? { ok: true, value: wrapped.value }
        : {
            ok: false,
            error: { code: 'BLOCKED', message: `LOCKED: ${wrapped.error.message}` },
          };
    },
    async open(snapshotId, stored) {
      const opened = await vault.unwrapSnapshotPayload(snapshotId, stored);
      return opened.ok
        ? { ok: true, value: opened.value }
        : {
            ok: false,
            error: { code: 'BLOCKED', message: `LOCKED: ${opened.error.message}` },
          };
    },
  };
}

/** Locked-state guard for write flows (import/restore) — Decision 4.5. */
export function requireUnlockedForWrite(vault: CryptoVault): CryptoResult<null> {
  const state = vault.state;
  if (state === null || state.status === 'off') return cryptoOk(null);
  return vault.isUnlocked
    ? cryptoOk(null)
    : cryptoErr('LOCKED', 'unlock to import or restore into encrypted storage');
}

export { cryptoOk, cryptoErr };
