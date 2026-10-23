/**
 * The import pipeline (ADR-004 Decision 5) — normative stage order:
 *
 *   [1] Stage A  parse + envelope + structural + malicious-shape  → whole-file REJECT
 *   [2] upgrade  schemaVersion chain over the in-memory adapter    → REJECT
 *   [3] Stage B  per-record validation + referential pass          → QUARANTINE
 *   [4] confirm  (UX) — `applyImport` only runs on a confirmed plan
 *   [5] snapshot automatic pre-import snapshot (the undo)
 *   [6] apply    ONE readwrite transaction: hard-delete + verbatim put
 *   [7] report   ImportReport (+ recovery download) + undo snapshot handle
 *
 * Stages 1–3 are `prepareImport` and are pure w.r.t. the database: reject means
 * literally zero side effects — no DB writes, no snapshot, no quota consumed.
 *
 * Untrusted input rules (Decision 6): never `eval`/`Function`; size cap before
 * read; whitelist record rebuild; `__proto__`/`constructor`/`prototype` reject
 * the file. MVP import is REPLACE-only (Decision 11) — no merge.
 */

import { err, ok } from '../storage/errors';
import type { Result, StorageError } from '../storage/errors';
import type { AppDBImpl } from '../storage/db';
import { productionMigrations, targetVersionOf } from '../storage/migrations';
import type { MigrationRegistry } from '../storage/migrations';
import { readImportText, parseBackupDocument } from './backup-document';
import { resolveDataSafetyDb } from './context';
import { validateRecords } from './records';
import { buildRecoveryDocumentFile } from './recovery-document';
import { takeSnapshot } from './snapshots-api';
import type { ImportPlan, ImportReport, ImportError } from './types';
import { upgradeRawBackup } from './upgrade';
import { broadcastDataReplaced, mirrorTheme } from './side-effects';

export type PrepareImportOptions = {
  /** Test seam: inject a migration registry (production uses `productionMigrations`). */
  migrations?: MigrationRegistry;
  /** File name for reports when importing from a raw string. */
  fileName?: string;
};

export type ApplyImportOptions = {
  /** Proceed even when the pre-import snapshot fails (explicit user opt-in). */
  allowWithoutSnapshot?: boolean;
  db?: AppDBImpl;
  now?: () => number;
};

function toImportError(e: StorageError): ImportError {
  switch (e.code) {
    case 'QUOTA_EXCEEDED':
    case 'TX_ABORTED':
    case 'UNAVAILABLE':
    case 'UNKNOWN':
      return e;
    case 'NEWER_SCHEMA':
      return e;
    case 'MIGRATION_FAILED':
      return { code: 'UPGRADE_FAILED', from: e.from, to: e.to, cause: e.cause };
    case 'BLOCKED':
    case 'INVALID_RECORD':
    case 'NOT_FOUND':
      return { code: 'UNKNOWN', cause: e };
  }
}

/**
 * Stages 1–3. Pure w.r.t. the database — safe to run on any file before the
 * user has confirmed anything.
 */
export async function prepareImport(
  input: File | string,
  opts: PrepareImportOptions = {},
): Promise<Result<ImportPlan, ImportError>> {
  const registry = opts.migrations ?? productionMigrations;
  const target = targetVersionOf(registry);

  const read = await readImportText(input);
  if (!read.ok) return err(read.error);

  const parsed = parseBackupDocument(read.value.text, { targetSchemaVersion: target });
  if (!parsed.ok) return err(parsed.error);

  const upgraded = await upgradeRawBackup(parsed.value, registry);
  if (!upgraded.ok) return err(upgraded.error);

  const stageB = validateRecords(upgraded.value);
  const raw = parsed.value;

  const fileName = opts.fileName ?? (typeof input === 'string' ? 'inline-import.json' : input.name);
  const recovery =
    stageB.entries.length > 0
      ? buildRecoveryDocumentFile(
          stageB.entries,
          { kind: 'import', fileName, fileSchemaVersion: raw.schemaVersion },
          {
            createdAt: Date.now(),
            deviceId: raw.deviceId,
            schemaVersion: upgraded.value.schemaVersion,
          },
        )
      : null;

  // Decision 5.1: 0 accepted = the file's entire restoreable payload is corrupt
  // — a corrupt file, not an empty backup. Snapshot metadata is informational-
  // only on import (Decisions 2.3/8 — never restored), so it must NOT count
  // toward the gate; accepted = settings + lists + tasks only.
  const accepted =
    (stageB.settings === null ? 0 : 1) + stageB.lists.length + stageB.tasks.length;
  if (accepted === 0) {
    // Reject with zero side effects; the recovery document rides the error so
    // the UX can offer the download (Decision 5.1 — quarantine is never silent).
    return err({
      code: 'NOTHING_TO_IMPORT',
      quarantined: stageB.entries.length,
      recoveryFile: recovery,
    });
  }

  const warnings = [...raw.warnings];
  if (raw.snapshots.length > 0) {
    warnings.push('snapshot metadata ignored — snapshot payloads are device-local');
  }
  if (raw.lists.length + raw.tasks.length > 0 && stageB.lists.length + stageB.tasks.length === 0) {
    warnings.push(
      'every declared list/task record was quarantined — this import replaces your data with none',
    );
  }

  return ok({
    fileSummary: {
      fileName,
      fileBytes: read.value.bytes,
      formatVersion: raw.formatVersion,
      schemaVersion: raw.schemaVersion,
      upgradedTo: upgraded.value.schemaVersion,
      kind: raw.kind,
    },
    accepted: {
      lists: stageB.lists.length,
      tasks: stageB.tasks.length,
      settings: stageB.settings !== null,
    },
    quarantined: stageB.entries,
    warnings,
    records: {
      settings: stageB.settings,
      lists: stageB.lists,
      tasks: stageB.tasks,
    },
    recovery,
  });
}

/**
 * Stages 5–7. MUST only run after explicit user confirmation whose copy names:
 * (a) this replaces ALL current data (with counts), (b) the pre-import snapshot
 * is the undo and where it lives, (c) old backups can resurrect deleted rows
 * (ADR-004 Decision 5.5 — the data-safety UX card owns the wording).
 */
export async function applyImport(
  plan: ImportPlan,
  opts: ApplyImportOptions = {},
): Promise<Result<ImportReport, ImportError>> {
  const resolved = resolveDataSafetyDb(opts.db);
  if (!resolved.ok) return err(resolved.error);
  const db = resolved.value;

  const warnings = [...plan.warnings];

  // Stage 5: automatic pre-import snapshot — the ONE undo for this import.
  let undoSnapshot: { id: string; takenAt: number } | null = null;
  const snap = await takeSnapshot('pre-import', {
    db,
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
  if (snap.ok) {
    undoSnapshot = { id: snap.value.id, takenAt: snap.value.takenAt };
  } else if (opts.allowWithoutSnapshot !== true) {
    return err({ code: 'SNAPSHOT_FAILED', cause: snap.error });
  } else {
    warnings.push('pre-import snapshot failed — applied without an undo snapshot (user opted in)');
  }

  // Collect EVERY existing row id first (quarantine-denylisted rows included —
  // the replace must hard-delete all of them), then apply in ONE transaction.
  const staleIds: { store: 'lists' | 'tasks'; id: string }[] = [];
  for (const store of ['lists', 'tasks'] as const) {
    const existing = await db.readUnfiltered(store);
    if (!existing.ok) return err(toImportError(existing.error));
    for (const row of existing.value) staleIds.push({ store, id: row.id });
  }

  const applied = await db.tx(['lists', 'tasks', 'settings'], 'readwrite', async (t) => {
    for (const { store, id } of staleIds) {
      await t.delete(store, id);
    }
    for (const list of plan.records.lists) await t.put('lists', list);
    for (const task of plan.records.tasks) await t.put('tasks', task);
    if (plan.records.settings !== null) await t.put('settings', plan.records.settings);
    return ok(undefined);
  });
  if (!applied.ok) {
    // Atomic abort: the database is exactly as before (IDB atomicity) and the
    // typed error surfaces — QUOTA_EXCEEDED is NEVER a silent write drop.
    return err(toImportError(applied.error));
  }

  // Stage 7 side effects: theme mirror (ADR-002 §3.4) + cross-tab notice (E5).
  mirrorTheme(plan.records.settings);
  broadcastDataReplaced();

  return ok({
    outcome: plan.quarantined.length > 0 ? 'partial' : 'applied',
    accepted: plan.accepted,
    quarantined: plan.quarantined.length,
    recoveryFileName: plan.recovery?.filename ?? null,
    recoveryFile: plan.recovery,
    undoSnapshot,
    warnings,
  });
}

/** `restoreSnapshot`'s zero-side-effect half: validate the stored payload first. */
export async function prepareSnapshotRestore(
  id: string,
  opts: { db?: AppDBImpl } = {},
): Promise<Result<ImportPlan, ImportError>> {
  const resolved = resolveDataSafetyDb(opts.db);
  if (!resolved.ok) return err(resolved.error);
  const payload = await resolved.value.get('snapshot_payloads', id);
  if (!payload.ok) return err(toImportError(payload.error));
  const stored = payload.value;
  if (stored === undefined) {
    return err({ code: 'UNKNOWN', cause: new Error(`snapshot payload ${id} not found`) });
  }
  return prepareImport(stored.payload, { fileName: `snapshot-${id}.json` });
}

/**
 * Undo / rollback (ADR-004 Decisions 8.1, 8.4): a snapshot payload IS a valid
 * import document, so restore = the full import pipeline on the stored payload —
 * including its own pre-import snapshot (undo of undo).
 */
export async function restoreSnapshot(
  id: string,
  opts: ApplyImportOptions = {},
): Promise<Result<ImportReport, ImportError>> {
  const prepared = await prepareSnapshotRestore(id, opts);
  if (!prepared.ok) return err(prepared.error);
  return applyImport(prepared.value, opts);
}
