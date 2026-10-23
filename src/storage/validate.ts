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
const MAX_TAG_LEN = 64;
const MAX_TAGS = 50;
const MAX_LOCALE = 16;
const MIN_EPOCH_MS = 0;
// Year 9999 in epoch ms — anything beyond is a corrupt timestamp.
const MAX_EPOCH_MS = 253_402_300_799_999;

function isEpochMs(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= MIN_EPOCH_MS && v <= MAX_EPOCH_MS;
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
  return /^#[0-9a-fA-F]{6}$/u.test(v) || /^[a-z][a-z0-9-]{0,63}$/iu.test(v);
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
  const allowed = ['freq', 'interval', 'until', 'count'];
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
  if (rec['count'] !== undefined)
    push(
      issues,
      'recurrence.count',
      typeof rec['count'] === 'number' && Number.isInteger(rec['count']) && rec['count'] >= 1,
      'range',
      'integer >= 1',
    );
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
    fields['priority'] === 0 || fields['priority'] === 1 || fields['priority'] === 2,
    'format',
    '0|1|2',
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
      fields['locale'].length >= 2 &&
      fields['locale'].length <= MAX_LOCALE &&
      /^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/u.test(fields['locale']),
    'format',
    'BCP-47-ish primary language',
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

/** Validate one row for its store (boot validation + import share this). */
export function validateRow(store: StoreName, value: unknown): ValidationResult {
  switch (store) {
    case 'meta':
      return validateMeta(value);
    case 'lists':
      return validateList(value);
    case 'tasks':
      return validateTask(value);
    case 'settings':
      return validateSettings(value);
    case 'snapshots':
      return validateSnapshot(value);
    case 'snapshot_payloads':
      return validateSnapshotPayload(value);
  }
}
