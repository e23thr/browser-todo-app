/**
 * `todo-sync/1` artifact codec (ADR-006 Decision 2) — batch + snapshot
 * document shapes, JSON-string payloads with SHA-256 over the exact string
 * bytes, and the Decision 2.3 format-versioning rules.
 *
 * Decode outcomes are typed so the ENGINE decides policy (Decision 6):
 * - `corrupt`         → torn/unparseable/hash-mismatch — never reaches the DB
 *                       (hard-fails the run for batches; snapshots fall back)
 * - `unknown-format`  → skipped + reported (`SYNC_FORMAT_UNKNOWN`)
 * - `newer-format`    → hard stop (`SYNC_FORMAT_NEWER`) — an old client must
 *                       never mangle data a newer client understands
 */

import type { SyncRecord, BatchDoc, SnapshotDoc, RemoteArtifact } from './types';
import { SYNC_FORMAT } from './types';
import { sha256OfUtf8 } from './hash';

export type DecodeErrorKind = 'corrupt' | 'unknown-format' | 'newer-format';

export type DecodeOutcome<T> =
  { ok: true; value: T } | { ok: false; kind: DecodeErrorKind; detail: string };

function corrupt(detail: string): DecodeOutcome<never> {
  return { ok: false, kind: 'corrupt', detail };
}

const FORMAT_RE = /^todo-sync\/(\d+)$/u;

/** Decision 2.3: `todo-sync/1` accepted, `2+` = newer-format, anything else unknown. */
export function classifyFormat(format: unknown): DecodeOutcome<string> {
  if (typeof format !== 'string')
    return { ok: false, kind: 'unknown-format', detail: 'missing format' };
  const m = FORMAT_RE.exec(format);
  if (m === null || m[1] === undefined) {
    return { ok: false, kind: 'unknown-format', detail: `unrecognized format ${format}` };
  }
  const n = Number(m[1]);
  if (n > 1) return { ok: false, kind: 'newer-format', detail: `remote speaks ${format}` };
  if (n !== 1)
    return { ok: false, kind: 'unknown-format', detail: `unrecognized format ${format}` };
  return { ok: true, value: format };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isSyncRecordArray(v: unknown): v is SyncRecord[] {
  return (
    Array.isArray(v) &&
    v.every(
      (item) =>
        isRecord(item) &&
        (item['kind'] === 'list' || item['kind'] === 'task') &&
        isRecord(item['record']),
    )
  );
}

async function verifyPayloadString(
  payload: string,
  hash: string,
  what: string,
): Promise<DecodeOutcome<SyncRecord[]>> {
  const actual = await sha256OfUtf8(payload);
  if (actual !== hash) return corrupt(`${what} hash mismatch`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return corrupt(`${what} payload is not valid JSON (torn upload?)`);
  }
  if (!isSyncRecordArray(parsed)) return corrupt(`${what} payload is not a record array`);
  return { ok: true, value: parsed };
}

/* ------------------------------- batch ------------------------------- */

export async function encodeBatch(
  records: SyncRecord[],
  meta: { deviceId: string; seq: number; createdAt: number },
): Promise<{ doc: BatchDoc; json: string }> {
  const recordsStr = JSON.stringify(records);
  const doc: BatchDoc = {
    format: SYNC_FORMAT,
    kind: 'batch',
    deviceId: meta.deviceId,
    seq: meta.seq,
    createdAt: meta.createdAt,
    recordsHash: await sha256OfUtf8(recordsStr),
    records: recordsStr,
  };
  return { doc, json: JSON.stringify(doc) };
}

export async function decodeBatch(
  text: string,
): Promise<DecodeOutcome<BatchDoc & { parsed: SyncRecord[] }>> {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return corrupt('batch is not valid JSON (torn upload?)');
  }
  if (!isRecord(doc)) return corrupt('batch is not an object');
  const format = classifyFormat(doc['format']);
  if (!format.ok) return format;
  if (doc['kind'] !== 'batch') return corrupt('artifact kind is not "batch"');
  const { deviceId, seq, createdAt, recordsHash, records } = doc;
  if (
    typeof deviceId !== 'string' ||
    typeof seq !== 'number' ||
    !Number.isSafeInteger(seq) ||
    seq < 1 ||
    typeof createdAt !== 'number' ||
    !Number.isSafeInteger(createdAt) ||
    typeof recordsHash !== 'string' ||
    typeof records !== 'string'
  ) {
    return corrupt('batch fields malformed');
  }
  const verified = await verifyPayloadString(records, recordsHash, 'batch');
  if (!verified.ok) return verified;
  return {
    ok: true,
    value: {
      format: format.value,
      kind: 'batch',
      deviceId,
      seq,
      createdAt,
      recordsHash,
      records,
      parsed: verified.value,
    },
  };
}

/* ------------------------------ snapshot ------------------------------ */

export async function encodeSnapshot(
  records: SyncRecord[],
  meta: { takenAt: number; byDeviceId: string; covers: Record<string, number> },
): Promise<{ doc: SnapshotDoc; json: string }> {
  const stateStr = JSON.stringify(records);
  const doc: SnapshotDoc = {
    format: SYNC_FORMAT,
    kind: 'snapshot',
    takenAt: meta.takenAt,
    byDeviceId: meta.byDeviceId,
    covers: { ...meta.covers },
    stateHash: await sha256OfUtf8(stateStr),
    state: stateStr,
  };
  return { doc, json: JSON.stringify(doc) };
}

export async function decodeSnapshot(
  text: string,
): Promise<DecodeOutcome<SnapshotDoc & { parsed: SyncRecord[] }>> {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return corrupt('snapshot is not valid JSON (torn upload?)');
  }
  if (!isRecord(doc)) return corrupt('snapshot is not an object');
  const format = classifyFormat(doc['format']);
  if (!format.ok) return format;
  if (doc['kind'] !== 'snapshot') return corrupt('artifact kind is not "snapshot"');
  const { takenAt, byDeviceId, covers, stateHash, state } = doc;
  if (
    typeof takenAt !== 'number' ||
    !Number.isSafeInteger(takenAt) ||
    typeof byDeviceId !== 'string' ||
    !isRecord(covers) ||
    typeof stateHash !== 'string' ||
    typeof state !== 'string'
  ) {
    return corrupt('snapshot fields malformed');
  }
  for (const [device, seq] of Object.entries(covers)) {
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
      return corrupt(`snapshot covers[${device}] malformed`);
    }
  }
  const verified = await verifyPayloadString(state, stateHash, 'snapshot');
  if (!verified.ok) return verified;
  return {
    ok: true,
    value: {
      format: format.value,
      kind: 'snapshot',
      takenAt,
      byDeviceId,
      covers: { ...covers } as Record<string, number>,
      stateHash,
      state,
      parsed: verified.value,
    },
  };
}

/** Uniform decode for discovery-driven fetches. */
export async function decodeArtifact(
  kind: 'batch' | 'snapshot',
  text: string,
): Promise<DecodeOutcome<(BatchDoc | SnapshotDoc) & { parsed: SyncRecord[] }>> {
  return kind === 'batch' ? decodeBatch(text) : decodeSnapshot(text);
}

export type { RemoteArtifact };
