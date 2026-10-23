/**
 * Boot-time validation + quarantine (ADR-002 Decision 8 step 4, §5.4 / E4).
 *
 * Non-destructive by contract: invalid records are NEVER crashed on and NEVER
 * silently dropped. They stay in the database until the user explicitly purges
 * them; meanwhile they are excluded from app reads via an in-memory denylist and
 * surfaced through a downloadable "recovery" JSON file.
 */

import { err, ok } from './errors';
import type { Result, StorageError } from './errors';
import type { AppDBImpl } from './db';
import { APP_SCHEMA_VERSION } from './schema';
import { STORE_NAMES, type StoreName } from './types';
import { validateRow } from './validate';

export type QuarantineEntry = {
  store: StoreName;
  key: string;
  record: unknown;
  issues: string[];
};

export type RecoveryFile = {
  filename: string;
  json: string;
};

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
export async function runBootValidation(db: AppDBImpl): Promise<Result<QuarantineEntry[], StorageError>> {
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

export function buildRecoveryFile(
  entries: readonly QuarantineEntry[],
  options: { now?: () => number; schemaVersion?: number } = {},
): RecoveryFile {
  const now = options.now ?? Date.now;
  const stamp = new Date(now());
  const pad = (n: number): string => String(n).padStart(2, '0');
  const filename =
    `recovery-${String(stamp.getUTCFullYear())}${pad(stamp.getUTCMonth() + 1)}${pad(stamp.getUTCDate())}` +
    `-${pad(stamp.getUTCHours())}${pad(stamp.getUTCMinutes())}${pad(stamp.getUTCSeconds())}.json`;
  const json = JSON.stringify(
    {
      generatedAt: stamp.toISOString(),
      schemaVersion: options.schemaVersion ?? APP_SCHEMA_VERSION,
      note: 'Invalid records quarantined at boot. Nothing was deleted; import or merge manually after fixing.',
      quarantine: entries,
    },
    null,
    2,
  );
  return { filename, json };
}

export function makeQuarantineApi(db: AppDBImpl): QuarantineApi {
  return {
    list() {
      return [...db.quarantineEntries];
    },
    recoveryFile() {
      return buildRecoveryFile(db.quarantineEntries, { schemaVersion: db.schemaVersion });
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
