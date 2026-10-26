/**
 * The sync run (ADR-006 Decision 5) — phases 2..10 of one single-flight run.
 *
 * Invariant (Decision 6, NORMATIVE): a sync failure never damages local data.
 * Phases before `apply` perform ZERO local writes; `apply` is ONE atomic
 * `readwrite` tx over ['lists','tasks','sync_state'] whose cursors advance only
 * on commit; push/compaction failures after a committed merge are reported but
 * never rolled back (the merged local state is correct and self-sufficient).
 * Sync is never required for local correctness (§6.2).
 *
 * Ordering guarantee: merge-before-push every run — a device always pushes a
 * state that has absorbed what it pulled.
 */

import type { EncryptedListRecord, EncryptedTaskRecord, List, Task } from '../domain/model';
import { rowKindOf } from '../domain/model';
import { err, ok } from '../domain/kernel';
import type { Result } from '../domain/kernel';
import type { AppDB, Tx } from '../storage/db';
import type { ErrorLog } from '../storage/errorLog';
import { unknownError } from '../storage/errors';
import type { StorageError } from '../storage/errors';
import { isUlid } from '../storage/id';
import { SYNC_KEY } from '../storage/schema';
import type { StoreName, SyncCursor, SyncShadowEntry, SyncStateRecord } from '../storage/types';
import { validateRow } from '../storage/validate';
import { decodeBatch, decodeSnapshot, encodeBatch, encodeSnapshot } from './batchCodec';
import type { DecodeErrorKind } from './batchCodec';
import { collectPushSet, planMerge } from './merge';
import type { ConflictSummary, SyncError, SyncNotice, SyncRecord, SyncRunSummary } from './types';
import type { WebDavClient } from './webdav';

/** Decision 5 step 7: re-pushing within the overlap is idempotent and cheap. */
export const PUSH_OVERLAP_MS = 5 * 60 * 1000;
/** Decision 2/5: batch files carry at most 500 records. */
export const BATCH_MAX_RECORDS = 500;
/** Cheap compaction check (Decision 5 step 9 / Decision 8 rule 2). */
export const COMPACT_BATCH_THRESHOLD = 30;
export const SNAPSHOT_PREFIX = 'todo-sync/v1/snapshots';
export const CHANGES_PREFIX = 'todo-sync/v1/changes';

export type EngineDeps = {
  db: AppDB;
  client: WebDavClient;
  now: () => number;
  newId: () => string;
  errorLog?: ErrorLog;
};

export type RunOutcome = {
  summary: SyncRunSummary;
  conflicts: ConflictSummary[];
  notices: SyncNotice[];
  state: SyncStateRecord;
};

function makeSyncError(
  code: SyncError['code'],
  message: string,
  retryable: boolean,
  detail?: string,
): SyncError {
  return detail === undefined ? { code, message, retryable } : { code, message, retryable, detail };
}

function decodeFail(kind: DecodeErrorKind, detail: string, artifact: string): SyncError {
  if (kind === 'newer-format') {
    return makeSyncError(
      'SYNC_FORMAT_NEWER',
      `remote contains a newer sync format (${artifact})`,
      false,
      detail,
    );
  }
  if (kind === 'unknown-format') {
    return makeSyncError(
      'SYNC_FORMAT_UNKNOWN',
      `unrecognized sync format in ${artifact}`,
      false,
      detail,
    );
  }
  return makeSyncError('CORRUPT_REMOTE', `corrupt remote artifact ${artifact}`, false, detail);
}

function seqName(seq: number): string {
  return `${String(seq).padStart(10, '0')}.json`;
}

/**
 * Wire record for a row — carrying its Addendum B causal parent (`base`, the
 * version it was built on) so peers can separate "supersedes my version" from
 * "concurrent with my version". Absent = unknown (shadow entries predating
 * Addendum B) — receivers fall back to the pre-Addendum behaviour then.
 */
function toSyncRecord(
  row: List | Task | EncryptedListRecord | EncryptedTaskRecord,
  shadow: Record<string, SyncShadowEntry>,
): SyncRecord {
  const base = shadow[row.id]?.base;
  return {
    kind: 'title' in row ? 'task' : 'list',
    record: row,
    ...(base === undefined ? {} : { base }),
  };
}

function baseName(path: string): string {
  const segments = path.split('/').filter((s) => s.length > 0);
  return decodeURIComponent(segments[segments.length - 1] ?? '');
}

/** Highest contiguous seq reachable from `cursor` given newly merged seqs. */
export function advanceContiguous(cursor: number, merged: Set<number>): number {
  let next = cursor;
  while (merged.has(next + 1)) next += 1;
  return next;
}

type Discovery = {
  snapshots: string[]; // file names, ascending
  batches: Map<string, number[]>; // deviceId -> ascending seqs
};

async function discover(client: WebDavClient): Promise<Result<Discovery, SyncError>> {
  const snapList = await client.list(SNAPSHOT_PREFIX);
  if (!snapList.ok) return snapList;
  const snapshots = snapList.value
    .filter((e) => !e.collection)
    .map((e) => baseName(e.path))
    .filter((n) => n.endsWith('.json'))
    .sort();

  const devList = await client.list(CHANGES_PREFIX);
  if (!devList.ok) return devList;
  const batches = new Map<string, number[]>();
  for (const entry of devList.value) {
    if (!entry.collection) continue;
    const deviceId = baseName(entry.path);
    // Device directories are ULIDs (Decision 2) — this also filters the
    // collection's own self-entry out of the Depth:1 listing.
    if (!isUlid(deviceId)) continue;
    const files = await client.list(`${CHANGES_PREFIX}/${deviceId}`);
    if (!files.ok) return files;
    const seqs = files.value
      .filter((e) => !e.collection)
      .map((e) => baseName(e.path))
      .map((n) => /^(\d{10})\.json$/u.exec(n))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
    batches.set(deviceId, seqs);
  }
  return ok({ snapshots, batches });
}

/**
 * One sync run. `state` is the working copy of the persisted row; the caller
 * persists it via the atomic apply / post-run writes below. Phases report
 * through `onPhase` for the Decision 9.2 `syncing` state surface.
 */
export async function runSyncOnce(
  deps: EngineDeps,
  options: {
    trigger: 'manual' | 'auto';
    state: SyncStateRecord;
    onPhase?: (phase: 'probe' | 'pull' | 'merge' | 'apply' | 'push' | 'compact') => void;
  },
): Promise<Result<RunOutcome, SyncError>> {
  const { db, client, now, newId } = deps;
  const startedAt = now();
  const phase = options.onPhase ?? ((): void => undefined);
  const record = (error: SyncError, detail?: string): void => {
    deps.errorLog?.record({
      layer: 'domain',
      op: `sync.${error.code}`,
      error,
      ...(detail === undefined ? {} : { detail }),
    });
  };

  const state = options.state;
  const fail = async (error: SyncError): Promise<Result<RunOutcome, SyncError>> => {
    record(error);
    await persistLast(db, { lastError: error.code });
    return err(error);
  };

  /* ---- phase 2: probe & ensure layout ---- */
  phase('probe');
  const probed = await client.probe();
  if (!probed.ok) return fail(probed.error);
  const layout = await client.ensureLayout(state.deviceId);
  if (!layout.ok) return fail(layout.error);

  /* ---- phase 3: discover ---- */
  const found = await discover(client);
  if (!found.ok) return fail(found.error);

  /* ---- phase 4: pull (read-only) ---- */
  phase('pull');
  const fetched: SyncRecord[] = [];
  const mergedSeqs = new Map<string, Set<number>>();
  const pulled = { snapshots: 0, batches: 0, records: 0 };
  const notices: SyncNotice[] = [];
  const cursor: SyncCursor = {
    pull: { ...state.cursor.pull },
    snapshotKey: state.cursor.snapshotKey,
    pushedUpTo: state.cursor.pushedUpTo,
    pushedSeq: state.cursor.pushedSeq,
    remoteCoveredUpTo: state.cursor.remoteCoveredUpTo,
  };
  cursor.pull[state.deviceId] = cursor.pushedSeq; // own batches are local state

  // Newest snapshot not yet merged; corrupt ones fall back to older (Decision 5).
  const snapshotCandidates = found.value.snapshots
    .filter((n) => cursor.snapshotKey === null || n > cursor.snapshotKey)
    .reverse();
  for (const name of snapshotCandidates) {
    const text = await client.get(`${SNAPSHOT_PREFIX}/${name}`);
    if (!text.ok) return fail(text.error);
    if (text.value === null) continue;
    const decoded = await decodeSnapshot(text.value);
    if (!decoded.ok) {
      if (decoded.kind === 'newer-format')
        return fail(decodeFail(decoded.kind, decoded.detail, name));
      // corrupt / unknown-format snapshots are SKIPPED with a visible warning —
      // snapshots are bandwidth optimizations; older ones + batches converge.
      record(decodeFail(decoded.kind, decoded.detail, name), `skipped snapshot ${name}`);
      notices.push({
        kind: 'list-conflict',
        recordId: name,
        title: `skipped unusable snapshot ${name}`,
        lostTo: { updatedAt: 0, deviceId: '' },
      });
      continue;
    }
    fetched.push(...decoded.value.parsed);
    pulled.snapshots += 1;
    pulled.records += decoded.value.parsed.length;
    for (const [device, seq] of Object.entries(decoded.value.covers)) {
      const merged = mergedSeqs.get(device) ?? new Set<number>();
      for (let s = 1; s <= seq; s += 1) merged.add(s);
      mergedSeqs.set(device, merged);
      cursor.pull[device] = Math.max(cursor.pull[device] ?? 0, seq);
    }
    cursor.snapshotKey = name;
    // Decision 8 rules 2/3: a verified snapshot retaining all our pushed batches
    // keeps every tombstone we have pushed alive remotely (purge gate).
    const covered = decoded.value.covers[state.deviceId] ?? 0;
    if (covered >= cursor.pushedSeq) {
      cursor.remoteCoveredUpTo = Math.max(cursor.remoteCoveredUpTo ?? 0, cursor.pushedUpTo);
    }
    break; // one snapshot per run (Decision 5: the newest covers the rest)
  }

  for (const [device, seqs] of found.value.batches) {
    if (device === state.deviceId) continue;
    const merged = mergedSeqs.get(device) ?? new Set<number>();
    for (const seq of seqs) {
      if (seq <= (cursor.pull[device] ?? 0)) {
        merged.add(seq);
        continue;
      }
      const text = await client.get(`${CHANGES_PREFIX}/${device}/${seqName(seq)}`);
      if (!text.ok) return fail(text.error);
      if (text.value === null) continue;
      const decoded = await decodeBatch(text.value);
      if (!decoded.ok)
        return fail(decodeFail(decoded.kind, decoded.detail, `${device}/${seqName(seq)}`));
      if (decoded.value.deviceId !== device || decoded.value.seq !== seq) {
        return fail(
          makeSyncError(
            'CORRUPT_REMOTE',
            `batch ${device}/${seqName(seq)} disagrees with its location`,
            false,
          ),
        );
      }
      fetched.push(...decoded.value.parsed);
      merged.add(seq);
      pulled.batches += 1;
      pulled.records += decoded.value.parsed.length;
    }
    cursor.pull[device] = advanceContiguous(cursor.pull[device] ?? 0, merged);
  }

  /* ---- phase 5: merge (pure) ---- */
  phase('merge');
  const local = await readAllRecords(db);
  if (!local.ok) return fail(local.error);
  const planned = await planMerge({
    localLists: local.value.lists,
    localTasks: local.value.tasks,
    fetched,
    shadow: state.shadow,
    deviceId: state.deviceId,
    now: startedAt,
    newId,
  });
  if (!planned.ok) return fail(planned.error);
  const plan = planned.value;

  // Decision 4.4: EVERY row is validated BEFORE the transaction opens. One
  // invalid row (corrupt remote content that passed the hash) refuses the whole
  // plan — no partial application, local byte-identical.
  for (const row of plan.puts) {
    const store = rowKindOf(row) === 'task' ? 'tasks' : 'lists';
    const checked = validateRow(store, row);
    if (!checked.ok) {
      return fail(
        makeSyncError(
          'CORRUPT_REMOTE',
          `remote record ${row.id} failed validation`,
          false,
          checked.issues.join('; '),
        ),
      );
    }
  }
  for (const copy of plan.copies) {
    const checked = validateRow('tasks', copy.row);
    if (!checked.ok) {
      return fail(
        makeSyncError(
          'CORRUPT_REMOTE',
          `conflict copy failed validation`,
          false,
          checked.issues.join('; '),
        ),
      );
    }
  }

  /* ---- phase 6: apply — the ONLY local write of phases 2..6 ---- */
  phase('apply');
  const shadow: Record<string, SyncShadowEntry> = { ...state.shadow, ...plan.shadowUpserts };
  const rawTx: <T>(
    stores: StoreName[],
    mode: 'readonly' | 'readwrite',
    fn: (t: Tx) => Promise<Result<T, StorageError>>,
  ) => Promise<Result<T, StorageError>> = (s, m, fn) =>
    // Method-call dispatch inside the wrapper: a detached `db.txRaw ?? …`
    // reference loses `this` and crashes (`txRaw` runs `this.#txWith`).
    // Fixed from the sync-UI card t_5f4fe7db while the ADR-007 card was mid-
    // refactor — see the hotspot comment on that card.
    db.txRaw === undefined ? db.tx(s, m, fn) : db.txRaw(s, m, fn);
  const applied = await rawTx(['lists', 'tasks', 'sync_state'], 'readwrite', async (t) => {
    for (const row of plan.puts) {
      // At-rest rows verbatim (ADR-007 Decision 8.1) — merge-applied rows never
      // pass through the app-surface transform. The decrypted-shaped row type is
      // the documented RowMap simplification; both at-rest shapes fit it.
      if (rowKindOf(row) === 'task') await t.put('tasks', row as Task);
      else await t.put('lists', row as List);
    }
    for (const copy of plan.copies) {
      await t.put('tasks', copy.row as Task);
    }
    const row = await t.get('sync_state', SYNC_KEY);
    if (row === undefined) {
      return err(unknownError(new Error('sync_state row vanished mid-run')));
    }
    await t.put('sync_state', {
      ...row,
      shadow,
      cursor,
      lastError: null,
    });
    return ok(undefined);
  });
  if (!applied.ok) {
    // Decision 6: the tx aborted → NOTHING changed locally and the cursor did
    // not advance; the next run re-fetches and re-merges (idempotent).
    return fail(
      makeSyncError(
        'LOCAL_STORAGE',
        'apply transaction failed — nothing was changed locally',
        true,
        applied.error.code,
      ),
    );
  }

  /* ---- phase 7: push (never rolls back the merge) ---- */
  phase('push');
  const scanStartedAt = now();
  const pushed = { batches: 0, records: 0 };
  const afterMerge = await readAllRecords(db);
  if (!afterMerge.ok) return fail(afterMerge.error);
  const pushRows = collectPushSet(
    [...afterMerge.value.lists, ...afterMerge.value.tasks],
    cursor.pushedUpTo,
    PUSH_OVERLAP_MS,
  );
  for (let i = 0; i < pushRows.length; i += BATCH_MAX_RECORDS) {
    const chunk = pushRows.slice(i, i + BATCH_MAX_RECORDS);
    const seq = cursor.pushedSeq + 1;
    const records: SyncRecord[] = chunk.map((row) => toSyncRecord(row, shadow));
    const { json } = await encodeBatch(records, {
      deviceId: state.deviceId,
      seq,
      createdAt: now(),
    });
    // Retry-reuses-seq: the cursor advances ONLY after the verified write.
    const written = await client.putVerified(
      `${CHANGES_PREFIX}/${state.deviceId}/${seqName(seq)}`,
      json,
    );
    if (!written.ok) return fail(written.error);
    cursor.pushedSeq = seq;
    pushed.batches += 1;
    pushed.records += chunk.length;
  }
  cursor.pushedUpTo = scanStartedAt - PUSH_OVERLAP_MS;
  // Our own batches are local state by definition (Decision 2): after a
  // verified push our pull cursor covers everything we have written.
  cursor.pull[state.deviceId] = cursor.pushedSeq;

  /* ---- phase 8: shadow for pushed rows (they are already in `shadow`) ---- */
  /* ---- phase 9: compact (cheap check; snapshot-before-prune, Decision 8) ---- */
  phase('compact');
  let compacted = false;
  const totalBatches = [...found.value.batches.values()].reduce((n, seqs) => n + seqs.length, 0);
  const covers: Record<string, number> = {};
  for (const [device, seq] of Object.entries(cursor.pull)) covers[device] = seq;
  covers[state.deviceId] = cursor.pushedSeq;
  const staleBatches: { deviceId: string; seq: number }[] = [];
  if (totalBatches >= COMPACT_BATCH_THRESHOLD) {
    const all = await readAllRecords(db);
    if (!all.ok) return fail(all.error);
    const snapshotRecords: SyncRecord[] = [...all.value.lists, ...all.value.tasks].map((row) =>
      toSyncRecord(row, shadow),
    );
    const takenAt = now();
    const name = `${String(takenAt)}-${state.deviceId}.json`;
    const { json } = await encodeSnapshot(snapshotRecords, {
      takenAt,
      byDeviceId: state.deviceId,
      covers,
    });
    const written = await client.putVerified(`${SNAPSHOT_PREFIX}/${name}`, json);
    if (!written.ok) return fail(written.error);
    // Rule 2: prune ONLY batches the verified snapshot covers.
    for (const [device, seqs] of found.value.batches) {
      const upTo = covers[device] ?? 0;
      for (const seq of seqs) {
        if (seq <= upTo) staleBatches.push({ deviceId: device, seq });
      }
    }
    for (const stale of staleBatches) {
      const removed = await client.remove(
        `${CHANGES_PREFIX}/${stale.deviceId}/${seqName(stale.seq)}`,
      );
      if (!removed.ok) return fail(removed.error);
    }
    // Our own snapshot retains every local tombstone (Decision 8 rule 2).
    cursor.remoteCoveredUpTo = Math.max(cursor.remoteCoveredUpTo ?? 0, scanStartedAt);
    compacted = true;
  }

  /* ---- phase 10: report + post-run cursor persistence ---- */
  const finishedAt = now();
  const summary: SyncRunSummary = {
    startedAt,
    finishedAt,
    trigger: options.trigger,
    pulled,
    pushed,
    applied: plan.puts.length + plan.copies.length,
    conflictsCreated: plan.copies.length,
    compacted,
    notices: [...notices, ...plan.notices],
  };
  const finalState: SyncStateRecord = {
    ...state,
    cursor,
    shadow,
    lastSyncAt: finishedAt,
    lastError: null,
  };
  const saved = await persistLast(db, {
    cursor,
    shadow,
    lastSyncAt: finishedAt,
    lastError: null,
  });
  if (!saved.ok)
    return fail(
      makeSyncError('LOCAL_STORAGE', 'failed to persist sync cursors', true, saved.error.code),
    );

  return ok({
    summary,
    conflicts: plan.copies.map((c) => c.summary),
    notices: summary.notices,
    state: finalState,
  });
}

/** Read every sync-visible row (tombstones included — they are sync records). */
export async function readAllRecords(
  db: AppDB,
): Promise<
  Result<
    { lists: (List | EncryptedListRecord)[]; tasks: (Task | EncryptedTaskRecord)[] },
    SyncError
  >
> {
  // AT-REST rows (ADR-007 Decision 8.1): the engine pushes/pulls ciphertext
  // verbatim — it never decrypts. Test doubles without `getAllRaw` are already
  // at-rest, so the fallback is correct for them.
  // (Method-call dispatch: `readRaw(store)` must keep `this` — a detached
  //  `db.getAllRaw ?? db.getAll` reference crashes on `this.queryWith`.
  //  Fixed from the sync-UI card t_5f4fe7db while the ADR-007 card was mid-
  //  refactor here — see the hotspot comment on that card.)
  const readRaw = (store: StoreName) =>
    db.getAllRaw === undefined ? db.getAll(store) : db.getAllRaw(store);
  const lists = (await readRaw('lists')) as Result<(List | EncryptedListRecord)[], StorageError>;
  if (!lists.ok)
    return err(makeSyncError('LOCAL_STORAGE', 'failed to read lists', true, lists.error.code));
  const tasks = (await readRaw('tasks')) as Result<(Task | EncryptedTaskRecord)[], StorageError>;
  if (!tasks.ok)
    return err(makeSyncError('LOCAL_STORAGE', 'failed to read tasks', true, tasks.error.code));
  return ok({ lists: lists.value, tasks: tasks.value });
}

/** Small bookkeeping write (lastError / cursors) outside the apply tx. */
export async function persistLast(
  db: AppDB,
  patch: Partial<Pick<SyncStateRecord, 'cursor' | 'shadow' | 'lastSyncAt' | 'lastError'>>,
): Promise<Result<void, SyncError>> {
  const saved = await db.tx(['sync_state'], 'readwrite', async (t: Tx) => {
    const row = await t.get('sync_state', SYNC_KEY);
    if (row === undefined) return err(unknownError(new Error('sync_state row missing')));
    await t.put('sync_state', { ...row, ...patch });
    return ok(undefined);
  });
  if (!saved.ok) {
    return err(
      makeSyncError('LOCAL_STORAGE', 'failed to persist sync state', true, saved.error.code),
    );
  }
  return ok(undefined);
}
