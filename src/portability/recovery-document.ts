/**
 * Recovery document (ADR-004 Decision 7) — the downloadable "recovery" file.
 *
 * `serializeRecoveryDoc` is the ONLY recovery-file writer (ADR-004 contract 5):
 * import quarantine (E3) and boot-validation quarantine (E1's
 * `src/storage/quarantine.ts`) both produce this exact shape. Recovery files are
 * deliberately NOT importable — their `format` token differs from the backup
 * token on purpose.
 *
 * Quarantined records are NEVER persisted (no shadow copies, §7.4): the document
 * is built in memory and handed to the user as a download only.
 */

import { RECOVERY_FORMAT, RECOVERY_FORMAT_VERSION, recoveryFileName } from './constants';

/**
 * One quarantined record.
 *
 * `store` is the ADR-002 store name. §7.1 lists the four data stores an import
 * can quarantine from; boot-validation can additionally quarantine `meta` and
 * `snapshot_payloads` rows, so the union is widened to all six rather than
 * silently dropping those entries (no-silent-loss beats a narrower enum).
 */
export type RecoveryStore =
  'lists' | 'tasks' | 'settings' | 'snapshots' | 'meta' | 'snapshot_payloads';

export type RecoveryEntry = {
  store: RecoveryStore;
  /** The record's `id` when present and parseable, else `null` (§7.1). */
  id: string | null;
  /** Human-readable `"field: reason"` strings — enough to repair by hand. */
  issues: string[];
  /** The record exactly as it appeared in the source (in-file row / DB row). */
  raw: unknown;
};

/**
 * Structural entry shape the serializer accepts — `store` is widened to
 * `string` so E1's quarantine types (and any future store additions) can hand
 * entries over without casts; `RecoveryEntry` is the typed form used inside the
 * import pipeline.
 */
export type RecoveryEntryInput = {
  store: string;
  id: string | null;
  issues: string[];
  raw: unknown;
};

export type RecoverySource = {
  kind: 'import' | 'boot-validation';
  /** The import file name; `null` for boot-validation (§7.1). */
  fileName: string | null;
  /** The schemaVersion of the source (file's, or the DB's for boot-validation). */
  fileSchemaVersion: number;
};

export type RecoveryMeta = {
  createdAt: number;
  /** `meta.deviceId` of the profile generating the file (provenance only). */
  deviceId: string;
  /** The generating profile's schemaVersion. */
  schemaVersion: number;
};

export type RecoveryFile = {
  filename: string;
  json: string;
};

/**
 * Serialize a recovery document (pretty-printed 2-space JSON + trailing LF —
 * same human-repairable conventions as the backup document).
 */
export function serializeRecoveryDoc(
  entries: readonly RecoveryEntryInput[],
  source: RecoverySource,
  meta: RecoveryMeta,
): string {
  const doc = {
    format: RECOVERY_FORMAT,
    formatVersion: RECOVERY_FORMAT_VERSION,
    schemaVersion: meta.schemaVersion,
    createdAt: meta.createdAt,
    deviceId: meta.deviceId,
    source: {
      kind: source.kind,
      fileName: source.fileName,
      fileSchemaVersion: source.fileSchemaVersion,
    },
    entries: entries.map((e) => ({
      store: e.store,
      id: e.id,
      issues: [...e.issues],
      raw: e.raw,
    })),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Build the complete downloadable file (name + JSON) for a set of entries. */
export function buildRecoveryDocumentFile(
  entries: readonly RecoveryEntryInput[],
  source: RecoverySource,
  meta: RecoveryMeta,
): RecoveryFile {
  return {
    filename: recoveryFileName(meta.createdAt),
    json: serializeRecoveryDoc(entries, source, meta),
  };
}

export { recoveryFileName };
