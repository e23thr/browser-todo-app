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
  /** Explicit user action only ("Clean up storage"): hard-delete quarantined rows. */
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
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${RECOVERY_FORMAT}-${String(at.getUTCFullYear())}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}` +
    `T${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}Z.json`
  );
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
 * ADR-004 Decision 7.1 serializer — the ONLY recovery-file writer. E3's
 * `serializeRecoveryDoc(entries, source, meta)` replaces this function body
 * (same signature, same envelope); field names and the format token are pinned
 * so the swap stays trivial and the file stays recognizable as NOT importable.
 * `meta` is the DB `meta` row (or a structural subset of it).
 */
export function serializeRecoveryDoc(
  entries: readonly RecoveryDocEntry[],
  source: RecoverySource,
  meta: { deviceId: string; schemaVersion: number; createdAt: number },
): string {
  const doc: RecoveryDoc = {
    format: RECOVERY_FORMAT,
    formatVersion: RECOVERY_FORMAT_VERSION,
    schemaVersion: meta.schemaVersion,
    createdAt: meta.createdAt,
    deviceId: meta.deviceId,
    source,
    entries: [...entries],
  };
  // Human-inspectable: pretty-printed JSON per ADR-004 Decision 2.4 convention.
  return `${JSON.stringify(doc, null, 2)}\n`;
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
      let purged = 0;
      for (const entry of entries) {
        const deleted = await db.delete(entry.store, entry.key);
        if (!deleted.ok) return err(deleted.error);
        purged += 1;
      }
      db.setQuarantine([]);
      db.updateReport({ quarantined: 0 });
      return ok(purged);
    },
  };
}
