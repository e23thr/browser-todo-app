/**
 * Foreign-import bridge (S12) — the seam that puts Todo.txt/CSV through the
 * SAME ADR-004 pipeline as a JSON backup (binding decision of this epic).
 *
 * The shape is deliberate: convert text → records, then hand the accepted
 * records to `prepareImport` as a synthetic ADR-004 document. Every stage the
 * epic binds therefore runs UNCHANGED — size cap before the read, Stage A
 * shape/malicious-shape checks, Stage B per-record validation + referential
 * pass, quarantine-to-recovery-file, the automatic pre-import snapshot and the
 * ONE-transaction atomic replace. There is no second validation path to drift.
 *
 * Two details make that composition honest:
 *
 *   - `data.settings` carries the TARGET profile's CURRENT settings verbatim.
 *     A Todo.txt/CSV file has no settings section, and a REPLACE import must
 *     not silently wipe theme/locale to defaults. Settings are copied through,
 *     never taken from the foreign file.
 *   - Line-level converter rejects (bad date, over-cap title, unknown status …)
 *     never enter the document: they are merged into the resulting
 *     `ImportPlan.quarantined` as recovery entries with the source line text,
 *     so the downloadable recovery file covers converter rejects AND Stage B
 *     rejects in one document (no silent loss, E4/E8).
 *
 * Whole-file converter failures (unterminated CSV quote, header with no title
 * column) come back as the same typed `ImportError`s a JSON file gets, with
 * zero side effects: nothing is written, no snapshot is taken.
 */

import { err, ok } from '../../storage/errors';
import type { Result } from '../../storage/errors';
import type { AppDBImpl } from '../../storage/db';
import { productionMigrations, targetVersionOf } from '../../storage/migrations';
import type { Settings } from '../../storage/types';
import { APP_NAME, APP_VERSION, DEFAULT_SETTINGS_RECORD } from '../constants';
import { buildBackupDocument, readImportText, serializeBackupDoc } from '../backup-document';
import { prepareImport } from '../import';
import { buildRecoveryDocumentFile } from '../recovery-document';
import { resolveDataSafetyDb } from '../context';
import type { ImportError, ImportPlan } from '../types';
import type { RecoveryEntry } from '../recovery-document';
import type { StorageError } from '../../storage/errors';
import { convertCsv } from './csv';
import { convertTodoTxt } from './todotxt';
import { defaultListName } from './record';
import type { ConvertContext, ForeignFormat, ImportFormat } from './types';

export type { ForeignFormat, ImportFormat, Conversion, ConvertContext, RejectedRow } from './types';
export { convertCsv, parseCsvTable } from './csv';
export { convertTodoTxt } from './todotxt';
export { defaultListName } from './record';

export type ForeignPrepareOptions = {
  /** Test seam / explicit profile handle (same convention as the rest of the pipeline). */
  db?: AppDBImpl;
  /** Override the source file name (reports + recovery documents). */
  fileName?: string;
  /** Fallback target list name (defaults to the file stem). */
  listName?: string;
  /** Injectable clock (test seam, same as `exportBackup`). */
  now?: () => number;
};

/** Same storage-error mapping `import.ts` applies — a settings read can only fail with these. */
function toImportError(e: StorageError): ImportError {
  switch (e.code) {
    case 'QUOTA_EXCEEDED':
    case 'TX_ABORTED':
    case 'UNAVAILABLE':
    case 'UNKNOWN':
    case 'NEWER_SCHEMA':
      return e;
    default:
      return { code: 'UNKNOWN', cause: e };
  }
}

/** Extension → format. `null` = no extension match (caller sniffs content). */
function formatFromName(fileName: string): ImportFormat | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.txt') || lower.endsWith('.todo')) return 'todotxt';
  return null;
}

/**
 * Content sniff for extension-less sources: a trimmed `{` is a JSON document
 * (every backup starts with the envelope object); a comma in the first non-blank
 * line is a CSV header row; anything else is a todo.txt line list.
 */
function formatFromContent(text: string): ImportFormat {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) return 'json';
  const firstLine = trimmed.split(/\r\n|\n|\r/u, 1)[0] ?? '';
  if (firstLine.includes(',')) return 'csv';
  return 'todotxt';
}

/** Detect the import format of a picked file (extension first, content fallback). */
export function detectImportFormat(input: File | string, text: string): ImportFormat {
  const name = typeof input === 'string' ? '' : input.name;
  return formatFromName(name) ?? formatFromContent(text);
}

/**
 * Prepare a Todo.txt/CSV import through the ADR-004 pipeline. Pure w.r.t. the
 * database (a read of the current settings record happens, but no write, no
 * snapshot) — the caller still only applies after explicit confirmation.
 *
 * JSON input short-circuits to `prepareImport` itself, so one call site can
 * serve the picker regardless of what the user picked.
 */
export async function prepareForeignImport(
  input: File | string,
  opts: ForeignPrepareOptions = {},
): Promise<Result<ImportPlan, ImportError>> {
  // Size cap BEFORE the read — same gate as a JSON backup (Decision 6.1.2).
  const read = await readImportText(input);
  if (!read.ok) return err(read.error);

  const fileName = opts.fileName ?? (typeof input === 'string' ? 'inline-import' : input.name);
  const format = detectImportFormat(input, read.value.text);
  if (format === 'json') return prepareImport(read.value.text, { fileName });

  const resolved = resolveDataSafetyDb(opts.db);
  if (!resolved.ok) return err(resolved.error);
  const db = resolved.value;

  const now = opts.now ?? Date.now;
  const settingsRead = await db.get('settings', 'settings');
  if (!settingsRead.ok) return err(toImportError(settingsRead.error));
  const settings: Settings = settingsRead.value ?? DEFAULT_SETTINGS_RECORD;

  const ctx: ConvertContext = {
    deviceId: db.deviceId,
    now: now(),
    listName: opts.listName ?? defaultListName(fileName, format),
  };

  const foreignFormat: ForeignFormat = format;
  const conversion =
    foreignFormat === 'csv'
      ? convertCsv(read.value.text, ctx)
      : ok(convertTodoTxt(read.value.text, ctx));
  // Whole-file converter failure: typed error, zero side effects (E8).
  if (!conversion.ok) return err(conversion.error);

  const { lists, tasks, rejected, notes } = conversion.value;
  const schemaVersion = db.schemaVersion;
  const rejectsToEntries = (): RecoveryEntry[] =>
    rejected.map((row) => ({
      store: 'tasks',
      id: null,
      issues: [...row.issues],
      raw: row.text,
    }));

  // Nothing the converter could accept: the file's entire restoreable payload
  // is un-importable — reject with zero side effects, recovery file riding the
  // error (Decision 5.1 semantics, mirrored for foreign formats).
  if (lists.length === 0 && tasks.length === 0) {
    const entries = rejectsToEntries();
    return err({
      code: 'NOTHING_TO_IMPORT',
      quarantined: entries.length,
      recoveryFile:
        entries.length > 0
          ? buildRecoveryDocumentFile(
              entries,
              { kind: 'import', fileName, fileSchemaVersion: schemaVersion },
              { createdAt: now(), deviceId: ctx.deviceId, schemaVersion },
            )
          : null,
    });
  }

  // Accepted records become a synthetic ADR-004 document and ride the SAME
  // pipeline: Stage A → upgrade → Stage B → quarantine (merged below).
  const document = serializeBackupDoc(
    buildBackupDocument({
      kind: 'export',
      exportedAt: now(),
      deviceId: ctx.deviceId,
      schemaVersion,
      settings,
      lists,
      tasks,
      snapshots: [],
      app: { name: APP_NAME, version: APP_VERSION },
    }),
  );
  const prepared = await prepareImport(document, { fileName });
  if (!prepared.ok) return err(prepared.error);

  const plan = prepared.value;
  const entries = [...plan.quarantined, ...rejectsToEntries()];
  const warnings = [...plan.warnings, ...notes];
  const recovery =
    entries.length > 0
      ? buildRecoveryDocumentFile(
          entries,
          { kind: 'import', fileName, fileSchemaVersion: plan.fileSummary.schemaVersion },
          {
            createdAt: now(),
            deviceId: ctx.deviceId,
            schemaVersion: targetVersionOf(productionMigrations),
          },
        )
      : null;

  return ok({ ...plan, quarantined: entries, warnings, recovery });
}
