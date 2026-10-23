/**
 * Boot-time validation + quarantine (ADR-002 Decision 8 step 4, §5.4 / E4).
 *
 * Non-destructive by contract: invalid records are NEVER crashed on and NEVER
 * silently dropped. They stay in the database until the user explicitly purges
 * them; meanwhile they are excluded from app reads via an in-memory denylist and
 * surfaced through a downloadable "recovery" JSON file.
 *
 * RECOVERY FILE (binding): the downloadable document is ADR-004 Decision 7.1's
 * recovery envelope — ONE format, ONE writer (`serializeRecoveryDoc`, whose
 * shape E3's `src/portability/recovery-document.ts` reproduces exactly so the
 * swap is a drop-in). The `local-first-todo-recovery` format token marks the
 * file as deliberately NOT importable.
 */

import { err, ok } from './errors';
import type { Result, StorageError } from './errors';
import type { AppDBImpl } from './db';
import { isUlid } from './id';
import {
  recoveryFileName as recoveryFileNameFor,
  serializeRecoveryDoc as serializeAdr004RecoveryDoc,
} from '../portability/recovery-document';
import { APP_SCHEMA_VERSION } from './schema';
import { STORE_NAMES, type StoreName } from './types';
import { validateRow } from './validate';

export type QuarantineEntry = {
  store: StoreName;
  key: string;
  record: unknown;
  issues: string[];
};

/** ADR-004 Decision 7.1 envelope (recovery document). */
export type RecoveryDoc = {
  format: 'local-first-todo-recovery';
  formatVersion: number;
  schemaVersion: number;
  createdAt: number;
  deviceId: string;
  source: RecoverySource;
  entries: RecoveryDocEntry[];
};

/** ADR-004 Decision 7.1 `source` block. */
export type RecoverySource = {
  kind: 'boot-validation' | 'import';
  fileName: string | null;
  fileSchemaVersion: number;
};

/** ADR-004 Decision 7.1 entry: `raw` is the record exactly as read. */
export type RecoveryDocEntry = {
  store: string;
  id: string | null;
  issues: string[];
  raw: unknown;
};

export type RecoveryFile = {
  filename: string;
  json: string;
};

export const RECOVERY_FORMAT = 'local-first-todo-recovery';
export const RECOVERY_FORMAT_VERSION = 1;

export type QuarantineApi = {
  /** Invalid rows excluded from app reads (in-memory copies of what is in the DB). */
  list(): QuarantineEntry[];
  /** Downloadable recovery JSON: every quarantined record verbatim + issues. */
  recoveryFile(): RecoveryFile;
  /**
   * Explicit user action only ("Clean up storage"): hard-delete quarantined
   * rows. NEVER touches the `meta`/`settings` singletons — a quarantined `meta`
   * carries the device identity and deleting it would silently re-seed a NEW
   * `deviceId` on the next boot (ADR-002 Decision 3.1). Singleton entries stay
   * quarantined and downloadable; the returned count is rows actually deleted.
   */
  purge(): Promise<Result<number, StorageError>>;
};

function keyOf(store: StoreName, record: unknown): string {
  if (store === 'meta') return 'meta';
  const id = (record as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : '';
}

/**
 * Schema-check every record in every store. Returns the quarantine entries;
 * boot applies them as the read denylist. Records that pass are untouched.
 */
export async function runBootValidation(
  db: AppDBImpl,
): Promise<Result<QuarantineEntry[], StorageError>> {
  const entries: QuarantineEntry[] = [];
  for (const store of STORE_NAMES) {
    const rows = await db.readUnfiltered(store);
    if (!rows.ok) return err(rows.error);
    for (const record of rows.value) {
      const result = validateRow(store, record);
      if (!result.ok) {
        entries.push({ store, key: keyOf(store, record), record, issues: result.issues });
      }
    }
  }
  return ok(entries);
}

/** Filename convention shared with ADR-004 Decision 9 (UTC, no colons in the time). */
export function recoveryFileName(at: Date): string {
  return recoveryFileNameFor(at.getTime());
}

function toDocEntry(entry: QuarantineEntry): RecoveryDocEntry {
  const rawId = (entry.record as { id?: unknown } | null)?.id;
  // ADR-004 7.1: `id` is the record's id if present and parseable, else null.
  return {
    store: entry.store,
    id: typeof rawId === 'string' && isUlid(rawId) ? rawId : null,
    issues: [...entry.issues],
    raw: entry.record,
  };
}

/**
 * ADR-004 Decision 7.1 serializer — the ONLY recovery-file writer. This is a
 * thin delegate to `src/portability/recovery-document.ts`'s `serializeRecoveryDoc`
 * (ADR-004 contract 5: ONE format, ONE writer — E3's import quarantine and this
 * boot-validation quarantine produce the exact same shape), kept exported under
 * this name so the storage module's own callers/tests stay stable.
 */
export function serializeRecoveryDoc(
  entries: readonly RecoveryDocEntry[],
  source: RecoverySource,
  meta: { deviceId: string; schemaVersion: number; createdAt: number },
): string {
  return serializeAdr004RecoveryDoc(entries, source, meta);
}

export function buildRecoveryFile(
  entries: readonly QuarantineEntry[],
  options: { now?: () => number; schemaVersion?: number; deviceId?: string } = {},
): RecoveryFile {
  const now = options.now ?? Date.now;
  const createdAt = now();
  const schemaVersion = options.schemaVersion ?? APP_SCHEMA_VERSION;
  const source: RecoverySource = {
    kind: 'boot-validation',
    fileName: null,
    fileSchemaVersion: schemaVersion,
  };
  const json = serializeRecoveryDoc(entries.map(toDocEntry), source, {
    deviceId: options.deviceId ?? '',
    schemaVersion,
    createdAt,
  });
  return { filename: recoveryFileName(new Date(createdAt)), json };
}

export function makeQuarantineApi(db: AppDBImpl): QuarantineApi {
  return {
    list() {
      return [...db.quarantineEntries];
    },
    recoveryFile() {
      return buildRecoveryFile(db.quarantineEntries, {
        schemaVersion: db.schemaVersion,
        deviceId: db.deviceId,
      });
    },
    async purge() {
      const entries = db.quarantineEntries;
      const kept: QuarantineEntry[] = [];
      let purged = 0;
      let failure: StorageError | null = null;
      for (const entry of entries) {
        if (failure !== null) {
          kept.push(entry); // stop-at-first-failure: remaining rows stay quarantined
          continue;
        }
        // Identity safety (QA defect D2, ADR-002 Decision 3.1): the singletons
        // are NEVER destroyed. A corrupt `meta` still carries the profile's
        // deviceId/createdAt — deleting it makes the next boot silently re-seed
        // a NEW deviceId. Singletons stay quarantined + downloadable; the user
        // heals them via snapshot restore / import, never via purge.
        if (entry.store === 'meta' || entry.store === 'settings') {
          kept.push(entry);
          continue;
        }
        const deleted = await db.delete(entry.store, entry.key);
        if (!deleted.ok) {
          failure = deleted.error;
          kept.push(entry);
          continue;
        }
        purged += 1;
      }
      // In-memory state tracks reality: deleted rows leave the denylist even
      // when a later delete failed part-way through the pass.
      db.setQuarantine(kept);
      db.updateReport({ quarantined: kept.length });
      if (failure !== null) return err(failure);
      return ok(purged);
    },
  };
}
