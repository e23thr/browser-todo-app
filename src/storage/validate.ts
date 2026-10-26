/**
 * Hand-rolled record validators (ADR-002 Decision 11). No zod (§7.2 minimal deps).
 *
 * Two consumers share this one module:
 *   1. Boot validation (ADR-002 Decision 8 step 4) — quarantine flow, non-destructive.
 *   2. Import validation (§7.1 threat (d)) — size caps, schema validation, never eval'd.
 *
 * Validation is STRICT: unknown fields, forbidden prototype-pollution keys
 * (`__proto__`, `constructor`, `prototype`), and wrong shapes are all issues.
 */

import { isCanonicalOrderKey } from './orderKey';
import { isUlid } from './id';
import type { StoreName } from './types';

export type ValidationResult = { ok: true } | { ok: false; issues: string[] };

const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'] as const;

const MAX_NAME = 200;
const MAX_TITLE = 1000;
const MAX_NOTES = 20_000;
// Caps are the ADR-004 §6.2 binding table (ADR-002 Decision 11 left tags,
// color tokens and locale open — that table governs).
const MAX_TAG_LEN = 100;
const MAX_TAGS = 50;
const MAX_LOCALE = 35;
const MIN_EPOCH_MS = 0;

// ADR-004 §6.2: timestamps are non-negative safe integers (epoch ms UTC) —
// no upper year cap (any safe integer passes).
function isEpochMs(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= MIN_EPOCH_MS;
}

/** `YYYY-MM-DD` against a real calendar — rejects `2026-02-30` (ADR-002 Decision 5). */
export function isLocalDateString(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(v)) return false;
  const year = Number(v.slice(0, 4));
  const month = Number(v.slice(5, 7));
  const day = Number(v.slice(8, 10));
  if (year < 1000 || month < 1 || month > 12 || day < 1) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

function isColor(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  // ADR-004 §6.2: `#rrggbb` or theme token `^[a-z][a-z0-9-]{0,31}$`.
  return /^#[0-9a-fA-F]{6}$/u.test(v) || /^[a-z][a-z0-9-]{0,31}$/u.test(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

type ShapeIssue = {
  path: string;
  kind: 'missing' | 'type' | 'range' | 'format' | 'unknown' | 'forbidden';
  detail?: string;
};

function checkShape(
  value: unknown,
  allowed: readonly string[],
): { fields: Record<string, unknown>; issues: ShapeIssue[] } {
  const issues: ShapeIssue[] = [];
  if (!isRecord(value)) {
    return { fields: {}, issues: [{ path: '(record)', kind: 'type', detail: 'not an object' }] };
  }
  const fields: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if ((FORBIDDEN_KEYS as readonly string[]).includes(key)) {
      issues.push({ path: key, kind: 'forbidden', detail: 'prototype-pollution key' });
      continue;
    }
    if (!allowed.includes(key)) {
      issues.push({ path: key, kind: 'unknown', detail: 'unexpected field' });
      continue;
    }
    fields[key] = value[key];
  }
  return { fields, issues };
}

function push(
  issues: ShapeIssue[],
  path: string,
  cond: boolean,
  kind: ShapeIssue['kind'],
  detail: string,
): void {
  if (!cond) issues.push({ path, kind, detail });
}

function formatIssues(issues: ShapeIssue[]): string[] {
  return issues.map((i) =>
    i.detail === undefined ? `${i.path}: ${i.kind}` : `${i.path}: ${i.kind} (${i.detail})`,
  );
}

function checkTimestamp(
  issues: ShapeIssue[],
  fields: Record<string, unknown>,
  path: string,
  optional = false,
): void {
  const v = fields[path];
  if (v === undefined && optional) return;
  push(issues, path, isEpochMs(v), 'format', 'epoch ms UTC safe integer');
}

function checkString(
  issues: ShapeIssue[],
  fields: Record<string, unknown>,
  path: string,
  opts: { minTrimmed: number; max: number; allowNull?: boolean },
): void {
  const v = fields[path];
  if (v === null && opts.allowNull === true) return;
  if (typeof v !== 'string') {
    push(issues, path, false, 'type', opts.allowNull === true ? 'string or null' : 'string');
    return;
  }
  const trimmed = v.trim();
  push(
    issues,
    path,
    trimmed.length >= opts.minTrimmed && v.length <= opts.max,
    'range',
    `${String(opts.minTrimmed)}..${String(opts.max)} chars (trimmed min)`,
  );
}

function resultOf(issues: ShapeIssue[]): ValidationResult {
  return issues.length === 0 ? { ok: true } : { ok: false, issues: formatIssues(issues) };
}

const META_FIELDS = [
  'schemaVersion',
  'deviceId',
  'createdAt',
  'lastOpenedAt',
  'lastPurgeAt',
] as const;
const LIST_FIELDS = [
  'id',
  'name',
  'color',
  'sortOrder',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'deviceId',
] as const;
const TASK_FIELDS = [
  'id',
  'listId',
  'title',
  'notes',
  'status',
  'priority',
  'dueDate',
  'reminderAt',
  'recurrence',
  'tags',
  'parentTaskId',
  'sortOrder',
  'createdAt',
  'updatedAt',
  'completedAt',
  'deletedAt',
  'deviceId',
] as const;
const SETTINGS_FIELDS = [
  'id',
  'theme',
  'locale',
  'weekStart',
  'defaultListId',
  'notificationsEnabled',
  'lastBackupAt',
] as const;
const SNAPSHOT_FIELDS = [
  'id',
  'takenAt',
  'kind',
  'reason',
  'sizeBytes',
  'schemaVersion',
  'payloadRef',
] as const;
const PAYLOAD_FIELDS = ['id', 'payload'] as const;

// ADR-007 Decision 4.1: the encrypted at-rest shapes — plaintext envelope +
// structural fields + ciphertext payload (user text is NOT a field).
const ENCRYPTED_TASK_FIELDS = [
  'id',
  'kind',
  'updatedAt',
  'deviceId',
  'deletedAt',
  'payloadHash',
  'enc',
  'payload',
  'listId',
  'status',
  'priority',
  'dueDate',
  'reminderAt',
  'recurrence',
  'parentTaskId',
  'sortOrder',
  'createdAt',
  'completedAt',
] as const;
const ENCRYPTED_LIST_FIELDS = [
  'id',
  'kind',
  'updatedAt',
  'deviceId',
  'deletedAt',
  'payloadHash',
  'enc',
  'payload',
  'color',
  'sortOrder',
  'createdAt',
] as const;

export function validateMeta(value: unknown): ValidationResult {
  const { fields, issues } = checkShape(value, META_FIELDS);
  push(
    issues,
    'schemaVersion',
    typeof fields['schemaVersion'] === 'number' &&
      Number.isInteger(fields['schemaVersion']) &&
      fields['schemaVersion'] >= 1,
    'range',
    'integer >= 1',
  );
  push(issues, 'deviceId', isUlid(fields['deviceId']), 'format', 'ULID');
  checkTimestamp(issues, fields, 'createdAt');
  checkTimestamp(issues, fields, 'lastOpenedAt');
  if (fields['lastPurgeAt'] !== undefined) checkTimestamp(issues, fields, 'lastPurgeAt');
  return resultOf(issues);
}

function checkTombstone(issues: ShapeIssue[], fields: Record<string, unknown>): void {
  const v = fields['deletedAt'];
  push(issues, 'deletedAt', v === null || isEpochMs(v), 'format', 'null or epoch ms UTC');
}

export function validateList(value: unknown): ValidationResult {
  const { fields, issues } = checkShape(value, LIST_FIELDS);
  push(issues, 'id', isUlid(fields['id']), 'format', 'ULID');
  checkString(issues, fields, 'name', { minTrimmed: 1, max: MAX_NAME });
  push(issues, 'color', isColor(fields['color']), 'format', '#rrggbb or theme token id');
  push(
    issues,
    'sortOrder',
    isCanonicalOrderKey(fields['sortOrder']),
    'format',
    'canonical order key',
  );
  checkTimestamp(issues, fields, 'createdAt');
  checkTimestamp(issues, fields, 'updatedAt');
  checkTombstone(issues, fields);
  push(issues, 'deviceId', isUlid(fields['deviceId']), 'format', 'ULID');
  return resultOf(issues);
}

function checkRecurrence(issues: ShapeIssue[], fields: Record<string, unknown>): void {
  const rec = fields['recurrence'];
  if (rec === undefined) return;
  if (!isRecord(rec)) {
    push(issues, 'recurrence', false, 'type', 'object');
    return;
  }
  const allowed = ['freq', 'interval', 'until'];
  for (const key of Object.keys(rec)) {
    if ((FORBIDDEN_KEYS as readonly string[]).includes(key)) {
      issues.push({
        path: `recurrence.${key}`,
        kind: 'forbidden',
        detail: 'prototype-pollution key',
      });
    } else if (!allowed.includes(key)) {
      issues.push({ path: `recurrence.${key}`, kind: 'unknown', detail: 'unexpected field' });
    }
  }
  const freq = rec['freq'];
  push(
    issues,
    'recurrence.freq',
    freq === 'daily' || freq === 'weekly' || freq === 'monthly' || freq === 'weekdays',
    'format',
    'daily|weekly|monthly|weekdays',
  );
  push(
    issues,
    'recurrence.interval',
    typeof rec['interval'] === 'number' &&
      Number.isInteger(rec['interval']) &&
      rec['interval'] >= 1,
    'range',
    'integer >= 1',
  );
  if (rec['until'] !== undefined)
    push(issues, 'recurrence.until', isLocalDateString(rec['until']), 'format', 'YYYY-MM-DD');
}

function checkTags(issues: ShapeIssue[], fields: Record<string, unknown>): void {
  const tags = fields['tags'];
  if (!Array.isArray(tags)) {
    push(issues, 'tags', false, 'type', 'string[]');
    return;
  }
  push(issues, 'tags', tags.length <= MAX_TAGS, 'range', `at most ${String(MAX_TAGS)} tags`);
  push(
    issues,
    'tags',
    tags.every((t) => typeof t === 'string' && t.trim().length >= 1 && t.length <= MAX_TAG_LEN),
    'format',
    `each tag 1..${String(MAX_TAG_LEN)} chars`,
  );
}

export function validateTask(value: unknown): ValidationResult {
  const { fields, issues } = checkShape(value, TASK_FIELDS);
  push(issues, 'id', isUlid(fields['id']), 'format', 'ULID');
  push(issues, 'listId', isUlid(fields['listId']), 'format', 'ULID');
  checkString(issues, fields, 'title', { minTrimmed: 1, max: MAX_TITLE });
  checkString(issues, fields, 'notes', { minTrimmed: 0, max: MAX_NOTES, allowNull: true });
  push(
    issues,
    'status',
    fields['status'] === 'open' || fields['status'] === 'done' || fields['status'] === 'archived',
    'format',
    'open|done|archived',
  );
  push(
    issues,
    'priority',
    fields['priority'] === 'P1' ||
      fields['priority'] === 'P2' ||
      fields['priority'] === 'P3' ||
      fields['priority'] === 'P4',
    'format',
    'P1|P2|P3|P4',
  );
  if (fields['dueDate'] !== undefined)
    push(
      issues,
      'dueDate',
      isLocalDateString(fields['dueDate']),
      'format',
      'YYYY-MM-DD (real calendar day)',
    );
  if (fields['reminderAt'] !== undefined) checkTimestamp(issues, fields, 'reminderAt');
  if (fields['completedAt'] !== undefined) checkTimestamp(issues, fields, 'completedAt');
  checkRecurrence(issues, fields);
  checkTags(issues, fields);
  if (fields['parentTaskId'] !== undefined)
    push(issues, 'parentTaskId', isUlid(fields['parentTaskId']), 'format', 'ULID');
  push(
    issues,
    'sortOrder',
    isCanonicalOrderKey(fields['sortOrder']),
    'format',
    'canonical order key',
  );
  checkTimestamp(issues, fields, 'createdAt');
  checkTimestamp(issues, fields, 'updatedAt');
  checkTombstone(issues, fields);
  push(issues, 'deviceId', isUlid(fields['deviceId']), 'format', 'ULID');
  return resultOf(issues);
}

export function validateSettings(value: unknown): ValidationResult {
  const { fields, issues } = checkShape(value, SETTINGS_FIELDS);
  push(issues, 'id', fields['id'] === 'settings', 'format', "literal 'settings'");
  push(
    issues,
    'theme',
    fields['theme'] === 'light' || fields['theme'] === 'dark' || fields['theme'] === 'system',
    'format',
    'light|dark|system',
  );
  push(
    issues,
    'locale',
    typeof fields['locale'] === 'string' &&
      fields['locale'].length >= 1 &&
      fields['locale'].length <= MAX_LOCALE &&
      /^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/u.test(fields['locale']),
    'format',
    `BCP-47-ish language tag (1..${String(MAX_LOCALE)} chars)`,
  );
  push(
    issues,
    'weekStart',
    fields['weekStart'] === 0 || fields['weekStart'] === 1,
    'format',
    '0|1',
  );
  push(
    issues,
    'defaultListId',
    fields['defaultListId'] === null || isUlid(fields['defaultListId']),
    'format',
    'ULID or null',
  );
  push(
    issues,
    'notificationsEnabled',
    typeof fields['notificationsEnabled'] === 'boolean',
    'type',
    'boolean',
  );
  push(
    issues,
    'lastBackupAt',
    fields['lastBackupAt'] === null || isEpochMs(fields['lastBackupAt']),
    'format',
    'null or epoch ms UTC',
  );
  return resultOf(issues);
}

export function validateSnapshot(value: unknown): ValidationResult {
  const { fields, issues } = checkShape(value, SNAPSHOT_FIELDS);
  push(issues, 'id', isUlid(fields['id']), 'format', 'ULID');
  checkTimestamp(issues, fields, 'takenAt');
  push(
    issues,
    'kind',
    fields['kind'] === 'auto' || fields['kind'] === 'manual',
    'format',
    'auto|manual',
  );
  push(
    issues,
    'reason',
    fields['reason'] === 'scheduled' ||
      fields['reason'] === 'pre-migration' ||
      fields['reason'] === 'pre-import' ||
      fields['reason'] === 'manual',
    'format',
    'scheduled|pre-migration|pre-import|manual',
  );
  push(
    issues,
    'sizeBytes',
    typeof fields['sizeBytes'] === 'number' &&
      Number.isSafeInteger(fields['sizeBytes']) &&
      fields['sizeBytes'] >= 0,
    'range',
    'safe integer >= 0',
  );
  push(
    issues,
    'schemaVersion',
    typeof fields['schemaVersion'] === 'number' &&
      Number.isInteger(fields['schemaVersion']) &&
      fields['schemaVersion'] >= 1,
    'range',
    'integer >= 1',
  );
  push(
    issues,
    'payloadRef',
    typeof fields['payloadRef'] === 'string' && fields['payloadRef'].length >= 1,
    'format',
    'non-empty string',
  );
  push(
    issues,
    'payloadRef',
    fields['payloadRef'] === fields['id'],
    'format',
    'payloadRef == id (ADR-002 §3.6 convention)',
  );
  return resultOf(issues);
}

export function validateSnapshotPayload(value: unknown): ValidationResult {
  const { fields, issues } = checkShape(value, PAYLOAD_FIELDS);
  push(issues, 'id', isUlid(fields['id']), 'format', 'ULID');
  const payload = fields['payload'];
  if (typeof payload !== 'string') {
    push(issues, 'payload', false, 'type', 'JSON string');
  } else {
    try {
      const parsed: unknown = JSON.parse(payload);
      push(issues, 'payload', isRecord(parsed), 'format', 'JSON object');
    } catch {
      push(issues, 'payload', false, 'format', 'valid JSON');
    }
  }
  return resultOf(issues);
}

const SYNC_STATE_FIELDS = [
  'id',
  'enabled',
  'remoteUrl',
  'remoteUser',
  'remotePassword',
  'autoSync',
  'deviceId',
  'cursor',
  'shadow',
  'lastSyncAt',
  'lastError',
] as const;
const SYNC_CURSOR_FIELDS = [
  'pull',
  'snapshotKey',
  'pushedUpTo',
  'pushedSeq',
  'remoteCoveredUpTo',
] as const;
const SYNC_SHADOW_FIELDS = ['updatedAt', 'deviceId', 'contentHash', 'base'] as const;
// The ADR-006 Decision 6 code table, closed (a persisted code outside this set
// is corruption, quarantined like any other invalid row).
const SYNC_ERROR_CODES = [
  'CONFIG',
  'AUTH',
  'CORS',
  'NETWORK',
  'REMOTE_MISSING',
  'CONFLICT_WRITE',
  'CORRUPT_REMOTE',
  'SYNC_FORMAT_UNKNOWN',
  'SYNC_FORMAT_NEWER',
  'REMOTE_FULL',
  'LOCAL_STORAGE',
  'LOCKED',
  'ABORTED',
] as const;

function checkNullableTimestamp(
  issues: ShapeIssue[],
  fields: Record<string, unknown>,
  path: string,
): void {
  const v = fields[path];
  push(issues, path, v === null || isEpochMs(v), 'format', 'null or epoch ms UTC');
}

/** Singleton `sync_state` row (ADR-006 Decision 3) — strict like every validator. */
export function validateSyncState(value: unknown): ValidationResult {
  const { fields, issues } = checkShape(value, SYNC_STATE_FIELDS);
  push(issues, 'id', fields['id'] === 'sync', 'format', "singleton key 'sync'");
  push(issues, 'enabled', typeof fields['enabled'] === 'boolean', 'type', 'boolean');
  push(issues, 'autoSync', typeof fields['autoSync'] === 'boolean', 'type', 'boolean');
  push(issues, 'remoteUrl', typeof fields['remoteUrl'] === 'string', 'type', 'string');
  push(issues, 'remoteUser', typeof fields['remoteUser'] === 'string', 'type', 'string');
  push(issues, 'remotePassword', typeof fields['remotePassword'] === 'string', 'type', 'string');
  push(
    issues,
    'deviceId',
    typeof fields['deviceId'] === 'string' &&
      (fields['deviceId'] === '' || isUlid(fields['deviceId'])),
    'format',
    'ULID or empty',
  );

  const cursor = fields['cursor'];
  if (!isRecord(cursor)) {
    push(issues, 'cursor', false, 'type', 'object');
  } else {
    for (const key of Object.keys(cursor)) {
      if ((FORBIDDEN_KEYS as readonly string[]).includes(key)) {
        issues.push({
          path: `cursor.${key}`,
          kind: 'forbidden',
          detail: 'prototype-pollution key',
        });
      } else if (!(SYNC_CURSOR_FIELDS as readonly string[]).includes(key)) {
        issues.push({ path: `cursor.${key}`, kind: 'unknown', detail: 'unexpected field' });
      }
    }
    const pull = cursor['pull'];
    if (!isRecord(pull)) {
      push(issues, 'cursor.pull', false, 'type', 'object');
    } else {
      for (const [device, seq] of Object.entries(pull)) {
        push(
          issues,
          `cursor.pull.${device}`,
          isUlid(device) && typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0,
          'format',
          'ULID -> non-negative integer seq',
        );
      }
    }
    const snapshotKey = cursor['snapshotKey'];
    push(
      issues,
      'cursor.snapshotKey',
      snapshotKey === null || typeof snapshotKey === 'string',
      'type',
      'string or null',
    );
    push(
      issues,
      'cursor.pushedUpTo',
      isEpochMs(cursor['pushedUpTo']),
      'format',
      'epoch ms UTC safe integer',
    );
    push(
      issues,
      'cursor.pushedSeq',
      typeof cursor['pushedSeq'] === 'number' &&
        Number.isSafeInteger(cursor['pushedSeq']) &&
        cursor['pushedSeq'] >= 0,
      'range',
      'safe integer >= 0',
    );
    const covered = cursor['remoteCoveredUpTo'];
    push(
      issues,
      'cursor.remoteCoveredUpTo',
      covered === null || isEpochMs(covered),
      'format',
      'null or epoch ms UTC',
    );
  }

  const shadow = fields['shadow'];
  if (!isRecord(shadow)) {
    push(issues, 'shadow', false, 'type', 'object');
  } else {
    for (const [id, entry] of Object.entries(shadow)) {
      const path = `shadow.${id}`;
      push(issues, path, isUlid(id), 'format', 'ULID key');
      if (!isRecord(entry)) {
        push(issues, path, false, 'type', 'object entry');
        continue;
      }
      for (const key of Object.keys(entry)) {
        if (
          (FORBIDDEN_KEYS as readonly string[]).includes(key) ||
          !(SYNC_SHADOW_FIELDS as readonly string[]).includes(key)
        ) {
          issues.push({ path: `${path}.${key}`, kind: 'unknown', detail: 'unexpected field' });
        }
      }
      push(
        issues,
        `${path}.updatedAt`,
        isEpochMs(entry['updatedAt']),
        'format',
        'epoch ms UTC safe integer',
      );
      push(issues, `${path}.deviceId`, isUlid(entry['deviceId']), 'format', 'ULID');
      push(
        issues,
        `${path}.contentHash`,
        typeof entry['contentHash'] === 'string' && /^[0-9a-f]{64}$/u.test(entry['contentHash']),
        'format',
        'sha256 hex',
      );
      // Addendum B causal parent: ABSENT = unknown (legacy entry), `null` = root
      // version, or a strict {updatedAt, deviceId} version reference.
      if (entry['base'] !== undefined) {
        const base = entry['base'];
        const baseOk =
          base === null ||
          (isRecord(base) &&
            Object.keys(base).every((k) => k === 'updatedAt' || k === 'deviceId') &&
            isEpochMs(base['updatedAt']) &&
            isUlid(base['deviceId']));
        push(issues, `${path}.base`, baseOk, 'format', 'null or {updatedAt, deviceId} version ref');
      }
    }
  }

  checkNullableTimestamp(issues, fields, 'lastSyncAt');
  const lastError = fields['lastError'];
  push(
    issues,
    'lastError',
    lastError === null ||
      (typeof lastError === 'string' &&
        (SYNC_ERROR_CODES as readonly string[]).includes(lastError)),
    'format',
    'null or ADR-006 Decision 6 code',
  );
  return resultOf(issues);
}

/* ------------------- C1 encrypted record shapes (ADR-007 Decision 4.1) ------------------- */

// The ciphertext is bounded by the plaintext caps (title 1000 + notes 20000 +
// 50 tags x 100 chars) plus GCM overhead — 64 KB of base64 leaves headroom and
// keeps a corrupt row from costing an unbounded read.
const MAX_PAYLOAD_B64 = 64_000;

function checkEncEnvelope(issues: ShapeIssue[], fields: Record<string, unknown>): void {
  const enc = fields['enc'];
  if (!isRecord(enc)) {
    push(issues, 'enc', false, 'type', 'object');
    return;
  }
  for (const key of Object.keys(enc)) {
    if ((FORBIDDEN_KEYS as readonly string[]).includes(key) || !['alg', 'v', 'iv'].includes(key)) {
      issues.push({ path: `enc.${key}`, kind: 'unknown', detail: 'unexpected field' });
    }
  }
  push(issues, 'enc.alg', enc['alg'] === 'AES-GCM', 'format', "'AES-GCM'");
  push(issues, 'enc.v', enc['v'] === 1, 'format', '1 (payload envelope version)');
  const iv = enc['iv'];
  push(
    issues,
    'enc.iv',
    typeof iv === 'string' && fromBase64Len(iv) === 12,
    'format',
    'base64 of 12 bytes',
  );
}

function fromBase64Len(text: string): number | null {
  if (typeof text !== 'string' || text.length % 4 !== 0) return null;
  const clean = text.replace(/=+$/u, '');
  if (!/^[A-Za-z0-9+/_-]*$/u.test(clean)) return null;
  return Math.floor((clean.length * 3) / 4);
}

function checkCiphertext(issues: ShapeIssue[], fields: Record<string, unknown>): void {
  const payload = fields['payload'];
  push(
    issues,
    'payload',
    typeof payload === 'string' &&
      payload.length >= 24 &&
      payload.length <= MAX_PAYLOAD_B64 &&
      fromBase64Len(payload) !== null,
    'format',
    `base64 ciphertext (${String(MAX_PAYLOAD_B64)} chars max)`,
  );
  push(
    issues,
    'payloadHash',
    typeof fields['payloadHash'] === 'string' && /^[0-9a-f]{64}$/u.test(fields['payloadHash']),
    'format',
    'sha256 hex of `payload`',
  );
}

/**
 * The encrypted `tasks` at-rest shape: plaintext envelope + structural fields +
 * one ciphertext payload. Caps on the CIPHERTEXT apply here; caps on decrypted
 * fields are enforced at decrypt time (Decision 4.1 — "rejected then,
 * quarantined, never crashed on").
 */
export function validateEncryptedTask(value: unknown): ValidationResult {
  const { fields, issues } = checkShape(value, ENCRYPTED_TASK_FIELDS);
  push(issues, 'id', isUlid(fields['id']), 'format', 'ULID');
  push(issues, 'kind', fields['kind'] === 'task', 'format', "literal 'task'");
  push(issues, 'listId', isUlid(fields['listId']), 'format', 'ULID');
  push(
    issues,
    'status',
    fields['status'] === 'open' || fields['status'] === 'done' || fields['status'] === 'archived',
    'format',
    'open|done|archived',
  );
  push(
    issues,
    'priority',
    fields['priority'] === 'P1' ||
      fields['priority'] === 'P2' ||
      fields['priority'] === 'P3' ||
      fields['priority'] === 'P4',
    'format',
    'P1|P2|P3|P4',
  );
  if (fields['dueDate'] !== undefined)
    push(
      issues,
      'dueDate',
      isLocalDateString(fields['dueDate']),
      'format',
      'YYYY-MM-DD (real calendar day)',
    );
  if (fields['reminderAt'] !== undefined) checkTimestamp(issues, fields, 'reminderAt');
  if (fields['completedAt'] !== undefined) checkTimestamp(issues, fields, 'completedAt');
  checkRecurrence(issues, fields);
  if (fields['parentTaskId'] !== undefined)
    push(issues, 'parentTaskId', isUlid(fields['parentTaskId']), 'format', 'ULID');
  push(
    issues,
    'sortOrder',
    isCanonicalOrderKey(fields['sortOrder']),
    'format',
    'canonical order key',
  );
  checkTimestamp(issues, fields, 'createdAt');
  checkTimestamp(issues, fields, 'updatedAt');
  checkTombstone(issues, fields);
  push(issues, 'deviceId', isUlid(fields['deviceId']), 'format', 'ULID');
  checkEncEnvelope(issues, fields);
  checkCiphertext(issues, fields);
  return resultOf(issues);
}

/** The encrypted `lists` at-rest shape. */
export function validateEncryptedList(value: unknown): ValidationResult {
  const { fields, issues } = checkShape(value, ENCRYPTED_LIST_FIELDS);
  push(issues, 'id', isUlid(fields['id']), 'format', 'ULID');
  push(issues, 'kind', fields['kind'] === 'list', 'format', "literal 'list'");
  push(issues, 'color', isColor(fields['color']), 'format', '#rrggbb or theme token id');
  push(
    issues,
    'sortOrder',
    isCanonicalOrderKey(fields['sortOrder']),
    'format',
    'canonical order key',
  );
  checkTimestamp(issues, fields, 'createdAt');
  checkTimestamp(issues, fields, 'updatedAt');
  checkTombstone(issues, fields);
  push(issues, 'deviceId', isUlid(fields['deviceId']), 'format', 'ULID');
  checkEncEnvelope(issues, fields);
  checkCiphertext(issues, fields);
  return resultOf(issues);
}

/* ------------------- crypto_state singleton (ADR-007 Decision 2.3/2.4) ------------------- */

const CRYPTO_STATE_FIELDS = [
  'id',
  'status',
  'enabledAt',
  'migration',
  'keys',
  'recoveryOfferedAt',
  'lockAfterMinutes',
] as const;
const KEY_ENTRY_FIELDS = ['keyId', 'slots', 'createdAt'] as const;
const KEY_SLOT_FIELDS = ['kind', 'kdf', 'wrap', 'createdAt'] as const;
const KEY_WRAP_FIELDS = ['iv', 'ct'] as const;
const LOCK_MINUTES = [5, 15, 30, 60] as const;

function checkKeySlot(issues: ShapeIssue[], slot: unknown, path: string): void {
  if (!isRecord(slot)) {
    push(issues, path, false, 'type', 'object');
    return;
  }
  for (const key of Object.keys(slot)) {
    if (
      (FORBIDDEN_KEYS as readonly string[]).includes(key) ||
      !(KEY_SLOT_FIELDS as readonly string[]).includes(key)
    ) {
      issues.push({ path: `${path}.${key}`, kind: 'unknown', detail: 'unexpected field' });
    }
  }
  const kind = slot['kind'];
  push(
    issues,
    `${path}.kind`,
    kind === 'passphrase' || kind === 'recovery',
    'format',
    'passphrase|recovery',
  );
  const wrap = slot['wrap'];
  if (!isRecord(wrap)) {
    push(issues, `${path}.wrap`, false, 'type', 'object');
  } else {
    for (const key of Object.keys(wrap)) {
      if (
        (FORBIDDEN_KEYS as readonly string[]).includes(key) ||
        !(KEY_WRAP_FIELDS as readonly string[]).includes(key)
      ) {
        issues.push({ path: `${path}.wrap.${key}`, kind: 'unknown', detail: 'unexpected field' });
      }
    }
    push(
      issues,
      `${path}.wrap.iv`,
      typeof wrap['iv'] === 'string' && fromBase64Len(wrap['iv']) === 12,
      'format',
      'base64 of 12 bytes',
    );
    push(
      issues,
      `${path}.wrap.ct`,
      typeof wrap['ct'] === 'string' &&
        (fromBase64Len(wrap['ct']) ?? 0) >= 32 &&
        (fromBase64Len(wrap['ct']) ?? 0) <= 128,
      'format',
      'base64 wrapped key bytes',
    );
  }
  const kdf = slot['kdf'];
  if (!isRecord(kdf)) {
    push(issues, `${path}.kdf`, false, 'type', 'object');
    return;
  }
  if (kind === 'passphrase') {
    push(
      issues,
      `${path}.kdf.alg`,
      kdf['alg'] === 'PBKDF2-HMAC-SHA-256' && kdf['v'] === 1,
      'format',
      "v1 'PBKDF2-HMAC-SHA-256'",
    );
    push(
      issues,
      `${path}.kdf.iters`,
      typeof kdf['iters'] === 'number' && Number.isSafeInteger(kdf['iters']) && kdf['iters'] >= 1,
      'range',
      'safe integer >= 1',
    );
    push(
      issues,
      `${path}.kdf.salt`,
      typeof kdf['salt'] === 'string' && fromBase64Len(kdf['salt']) === 16,
      'format',
      'base64 of 16 bytes',
    );
  } else {
    push(
      issues,
      `${path}.kdf`,
      kdf['v'] === 1 && kdf['alg'] === 'HKDF-SHA-256' && kdf['info'] === 'todo-enc/1/recovery-kek',
      'format',
      "v1 'HKDF-SHA-256' with the fixed info string",
    );
  }
}

/** Singleton `crypto_state` row (ADR-007 Decision 2.3) — strict like every validator. */
export function validateCryptoState(value: unknown): ValidationResult {
  const { fields, issues } = checkShape(value, CRYPTO_STATE_FIELDS);
  push(issues, 'id', fields['id'] === 'crypto', 'format', "singleton key 'crypto'");
  push(
    issues,
    'status',
    fields['status'] === 'off' || fields['status'] === 'migrating' || fields['status'] === 'on',
    'format',
    'off|migrating|on',
  );
  checkNullableTimestamp(issues, fields, 'enabledAt');
  checkNullableTimestamp(issues, fields, 'recoveryOfferedAt');
  push(
    issues,
    'lockAfterMinutes',
    (LOCK_MINUTES as readonly number[]).includes(fields['lockAfterMinutes'] as number),
    'format',
    '5|15|30|60',
  );
  const migration = fields['migration'];
  if (migration === null || migration === undefined) {
    // null is the steady state; absent is a shape issue (the field is required).
    push(issues, 'migration', migration === null, 'type', 'null or migration progress object');
  } else if (!isRecord(migration)) {
    push(issues, 'migration', false, 'type', 'object');
  } else {
    for (const key of Object.keys(migration)) {
      if (
        (FORBIDDEN_KEYS as readonly string[]).includes(key) ||
        !['startedAt', 'done', 'total', 'direction'].includes(key)
      ) {
        issues.push({ path: `migration.${key}`, kind: 'unknown', detail: 'unexpected field' });
      }
    }
    checkTimestamp(issues, migration, 'startedAt');
    for (const key of ['done', 'total'] as const) {
      push(
        issues,
        `migration.${key}`,
        typeof migration[key] === 'number' &&
          Number.isSafeInteger(migration[key]) &&
          migration[key] >= 0,
        'range',
        'safe integer >= 0',
      );
    }
    push(
      issues,
      'migration.direction',
      migration['direction'] === 'encrypt' || migration['direction'] === 'decrypt',
      'format',
      'encrypt|decrypt',
    );
  }
  const keys = fields['keys'];
  if (!Array.isArray(keys)) {
    push(issues, 'keys', false, 'type', 'array');
  } else {
    push(issues, 'keys', keys.length <= 8, 'range', 'at most 8 ring entries');
    keys.forEach((entry, i) => {
      const path = `keys[${String(i)}]`;
      if (!isRecord(entry)) {
        push(issues, path, false, 'type', 'object');
        return;
      }
      for (const key of Object.keys(entry)) {
        if (
          (FORBIDDEN_KEYS as readonly string[]).includes(key) ||
          !(KEY_ENTRY_FIELDS as readonly string[]).includes(key)
        ) {
          issues.push({ path: `${path}.${key}`, kind: 'unknown', detail: 'unexpected field' });
        }
      }
      push(issues, `${path}.keyId`, isUlid(entry['keyId']), 'format', 'ULID');
      checkTimestamp(issues, entry, 'createdAt');
      const slots = entry['slots'];
      if (!Array.isArray(slots)) {
        push(issues, `${path}.slots`, false, 'type', 'array');
        return;
      }
      push(
        issues,
        `${path}.slots`,
        slots.length >= 1 && slots.length <= 2,
        'range',
        'exactly one passphrase slot + 0..1 recovery slot',
      );
      for (const [j, slot] of slots.entries())
        checkKeySlot(issues, slot, `${path}.slots[${String(j)}]`);
    });
  }
  return resultOf(issues);
}

/** Validate one row for its store (boot validation + import share this). */
export function validateRow(store: StoreName, value: unknown): ValidationResult {
  switch (store) {
    case 'meta':
      return validateMeta(value);
    case 'lists':
      // Self-describing rows (ADR-007 Decision 4.1): `enc` present = the
      // encrypted at-rest shape; mixed stores are legal (Decision 7.1).
      return isRecord(value) && value['enc'] !== undefined
        ? validateEncryptedList(value)
        : validateList(value);
    case 'tasks':
      return isRecord(value) && value['enc'] !== undefined
        ? validateEncryptedTask(value)
        : validateTask(value);
    case 'settings':
      return validateSettings(value);
    case 'snapshots':
      return validateSnapshot(value);
    case 'snapshot_payloads':
      return validateSnapshotPayload(value);
    case 'sync_state':
      return validateSyncState(value);
    case 'crypto_state':
      return validateCryptoState(value);
  }
}
