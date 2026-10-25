/**
 * The backup document (ADR-004 Decisions 1–2): one serializer shared by export
 * files, snapshot payloads and (later) sync — "three call sites, one format".
 *
 * - `canonicalizeRecord` — whitelist rebuild in ADR-002 type-declaration order.
 *   This is what makes byte-equivalence testable AND closes the
 *   prototype-pollution vector `JSON.parse` alone does not (Decision 6.1.4).
 * - `buildBackupDocument` / `serializeBackupDoc` — deterministic output
 *   (Decision 2.4 canonical serialization + stability property).
 * - `parseBackupDocument` — Stage A of the import pipeline: everything here is
 *   whole-file REJECT with zero side effects. NEVER `eval`/`Function`; parsing
 *   is `JSON.parse` in try/catch; the structural walk is iterative and enforces
 *   depth ≤ 8 plus the forbidden-key rule.
 */

import { isUlid } from '../storage/id';
import type { List, Settings, Snapshot, Task } from '../storage/types';
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  FORBIDDEN_KEYS,
  MAX_DOC_DEPTH,
  MAX_IMPORT_BYTES,
  MAX_LISTS,
  MAX_SNAPSHOT_ROWS,
  MAX_TASKS,
  RECOVERY_FORMAT,
} from './constants';
import type { BackupDocument, BackupKind, ImportError } from './types';
import { err, ok } from '../storage/errors';
import type { Result } from '../storage/errors';

export type SectionName = 'settings' | 'lists' | 'tasks' | 'snapshots';

/* ------------------------ canonical serialization (§2.4) ------------------------ */

const LIST_KEYS = [
  'id',
  'name',
  'color',
  'sortOrder',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'deviceId',
] as const;
const TASK_KEYS = [
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
const SETTINGS_KEYS = [
  'id',
  'theme',
  'locale',
  'weekStart',
  'defaultListId',
  'notificationsEnabled',
  'lastBackupAt',
] as const;
const SNAPSHOT_KEYS = [
  'id',
  'takenAt',
  'kind',
  'reason',
  'sizeBytes',
  'schemaVersion',
  'payloadRef',
] as const;
const RECURRENCE_KEYS = ['freq', 'interval', 'until'] as const;

/** Optional fields are omitted when `undefined` (never written as `null`). */
const OPTIONAL_KEYS: readonly string[] = [
  'dueDate',
  'reminderAt',
  'recurrence',
  'parentTaskId',
  'completedAt',
];

function rebuild(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  const source = raw as Record<string, unknown>;
  for (const key of keys) {
    const value = source[key];
    if (value === undefined && OPTIONAL_KEYS.includes(key)) continue;
    out[key] = key === 'recurrence' ? rebuild(value, RECURRENCE_KEYS) : value;
  }
  return out;
}

/**
 * Whitelist-rebuild one record in ADR-002 type-declaration order (Decision 2.4).
 * `JSON.stringify(canonicalizeRecord(store, row))` is the byte-equivalence
 * primitive used by tests and by the serializer. Unknown fields are dropped —
 * validation (which rejects them) runs first on untrusted input.
 */
export function canonicalizeRecord(section: SectionName, raw: unknown): Record<string, unknown> {
  switch (section) {
    case 'settings':
      return rebuild(raw, SETTINGS_KEYS);
    case 'lists':
      return rebuild(raw, LIST_KEYS);
    case 'tasks':
      return rebuild(raw, TASK_KEYS);
    case 'snapshots':
      return rebuild(raw, SNAPSHOT_KEYS);
  }
}

/** Ordinal string comparison on keys (Decision 2.4.3) with `id` tie-break. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortLists(rows: List[]): List[] {
  return [...rows].sort((x, y) => cmp(x.sortOrder, y.sortOrder) || cmp(x.id, y.id));
}

function sortTasks(rows: Task[]): Task[] {
  return [...rows].sort(
    (x, y) => cmp(x.listId, y.listId) || cmp(x.sortOrder, y.sortOrder) || cmp(x.id, y.id),
  );
}

function sortSnapshots(rows: Snapshot[]): Snapshot[] {
  return [...rows].sort((x, y) => x.takenAt - y.takenAt || cmp(x.id, y.id));
}

export type BuildBackupInput = {
  kind: BackupKind;
  exportedAt: number;
  /** The SOURCE profile's `meta.deviceId` (provenance only — never applied on import). */
  deviceId: string;
  /** The source's `meta.schemaVersion` == `data` version. */
  schemaVersion: number;
  settings: Settings;
  lists: List[];
  tasks: Task[];
  /** Snapshot METADATA only — payloads are device-local (Decision 2.3). */
  snapshots: Snapshot[];
  app?: { name: string; version: string };
};

/** Build a deterministic backup document (fixed envelope/data key order, sorted arrays). */
export function buildBackupDocument(input: BuildBackupInput): BackupDocument {
  const lists = sortLists(input.lists);
  const tasks = sortTasks(input.tasks);
  const snapshots = sortSnapshots(input.snapshots);
  const doc = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: input.schemaVersion,
    kind: input.kind,
    exportedAt: input.exportedAt,
    deviceId: input.deviceId,
    ...(input.app === undefined
      ? {}
      : { app: { name: input.app.name, version: input.app.version } }),
    counts: { lists: lists.length, tasks: tasks.length, snapshots: snapshots.length },
    data: {
      settings: canonicalizeRecord('settings', input.settings),
      lists: lists.map((r) => canonicalizeRecord('lists', r)),
      tasks: tasks.map((r) => canonicalizeRecord('tasks', r)),
      snapshots: snapshots.map((r) => canonicalizeRecord('snapshots', r)),
    },
  };
  return doc as unknown as BackupDocument;
}

/** Pretty-printed 2-space JSON + one trailing newline (human-inspectable AND repairable). */
export function serializeBackupDoc(doc: BackupDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/* --------------------------- Stage A parse (Decision 5) --------------------------- */

/** The untrusted-but-structurally-shape-checked view Stage A hands to upgrade/Stage B. */
export type RawBackup = {
  formatVersion: number;
  schemaVersion: number;
  kind: BackupKind;
  exportedAt: number;
  deviceId: string;
  /** Per-section raw records, in source order (provenance for the recovery file). */
  settings: unknown;
  lists: unknown[];
  tasks: unknown[];
  snapshots: unknown[];
  warnings: string[];
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Iterative structural walk (Decision 6.1.3): explicit stack, depth ≤ 8, no
 * recursion. Any forbidden key anywhere rejects the whole file.
 */
function walkShape(root: unknown): Result<true, ImportError> {
  const stack: { node: unknown; depth: number }[] = [{ node: root, depth: 1 }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    const { node, depth } = frame;
    if (depth > MAX_DOC_DEPTH) {
      return err({
        code: 'MALICIOUS_SHAPE',
        message: `document nesting exceeds the depth cap of ${String(MAX_DOC_DEPTH)}`,
      });
    }
    if (Array.isArray(node)) {
      for (const item of node) stack.push({ node: item, depth: depth + 1 });
      continue;
    }
    if (isRecord(node)) {
      for (const key of Object.keys(node)) {
        if (FORBIDDEN_KEYS.includes(key)) {
          return err({
            code: 'MALICIOUS_SHAPE',
            message: `forbidden key "${key}" found in document`,
          });
        }
        stack.push({ node: node[key], depth: depth + 1 });
      }
    }
  }
  return ok(true);
}

function isSafeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/**
 * UTF-8 byte length of a string — the unit `MAX_IMPORT_BYTES` is stated in.
 * `String.length` counts UTF-16 code units, so a multi-byte payload (e.g. Thai
 * text: 1 code unit → 3 bytes) would otherwise slip under a code-unit cap.
 */
function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Stage A: parse + envelope + structural + malicious-shape validation.
 * ANY failure = whole-file reject with zero side effects (Decision 5.1).
 */
export function parseBackupDocument(
  text: string,
  opts: { targetSchemaVersion: number },
): Result<RawBackup, ImportError> {
  const bytes = utf8ByteLength(text);
  if (bytes > MAX_IMPORT_BYTES) {
    return err({ code: 'FILE_TOO_LARGE', bytes, cap: MAX_IMPORT_BYTES });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return err({ code: 'PARSE_ERROR', message: e instanceof Error ? e.message : String(e) });
  }
  if (!isRecord(parsed)) {
    return err({ code: 'PARSE_ERROR', message: 'top level of the document is not an object' });
  }

  const shape = walkShape(parsed);
  if (!shape.ok) return err(shape.error);

  const warnings: string[] = [];
  const format = parsed['format'];
  if (format === RECOVERY_FORMAT) {
    return err({
      code: 'NOT_A_BACKUP',
      message:
        'this is a recovery file, not a backup — repair the original backup file and import that (recovery files are not importable)',
    });
  }
  if (format !== BACKUP_FORMAT) {
    return err({ code: 'NOT_A_BACKUP', message: `format must be "${BACKUP_FORMAT}"` });
  }

  const formatVersion = parsed['formatVersion'];
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion) || formatVersion < 1) {
    return err({ code: 'NOT_A_BACKUP', message: 'formatVersion must be an integer >= 1' });
  }
  if (formatVersion > BACKUP_FORMAT_VERSION) {
    return err({ code: 'FORMAT_TOO_NEW', found: formatVersion, supported: BACKUP_FORMAT_VERSION });
  }

  const schemaVersion = parsed['schemaVersion'];
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    return err({ code: 'NOT_A_BACKUP', message: 'schemaVersion must be an integer >= 1' });
  }
  if (schemaVersion > opts.targetSchemaVersion) {
    return err({ code: 'NEWER_SCHEMA', found: schemaVersion, supported: opts.targetSchemaVersion });
  }

  const kind = parsed['kind'];
  if (kind !== 'export' && kind !== 'snapshot') {
    return err({ code: 'NOT_A_BACKUP', message: 'kind must be "export" or "snapshot"' });
  }

  const exportedAt = parsed['exportedAt'];
  if (!isSafeInt(exportedAt)) {
    return err({
      code: 'NOT_A_BACKUP',
      message: 'exportedAt must be a non-negative safe integer (epoch ms)',
    });
  }

  const deviceId = parsed['deviceId'];
  if (typeof deviceId !== 'string' || !isUlid(deviceId)) {
    return err({ code: 'NOT_A_BACKUP', message: 'deviceId must be a ULID (source provenance)' });
  }

  const app = parsed['app'];
  if (app === undefined) {
    warnings.push('app: provenance block absent');
  } else if (
    !isRecord(app) ||
    typeof app['name'] !== 'string' ||
    typeof app['version'] !== 'string'
  ) {
    warnings.push('app: malformed provenance block ignored');
  }

  const data = parsed['data'];
  if (!isRecord(data)) {
    return err({ code: 'NOT_A_BACKUP', message: 'data section missing or not an object' });
  }

  const settings = data['settings'];
  if (settings === undefined) {
    return err({
      code: 'NOT_A_BACKUP',
      message: 'data.settings missing (a complete backup always carries settings)',
    });
  }
  if (!isRecord(settings)) {
    return err({ code: 'NOT_A_BACKUP', message: 'data.settings must be an object' });
  }

  const lists = data['lists'];
  const tasks = data['tasks'];
  const snapshots = data['snapshots'];
  if (!Array.isArray(lists) || !Array.isArray(tasks) || !Array.isArray(snapshots)) {
    return err({
      code: 'NOT_A_BACKUP',
      message: 'data.lists/data.tasks/data.snapshots must be arrays',
    });
  }

  const limits: [string, number, number][] = [
    ['data.lists', lists.length, MAX_LISTS],
    ['data.tasks', tasks.length, MAX_TASKS],
    ['data.snapshots', snapshots.length, MAX_SNAPSHOT_ROWS],
  ];
  for (const [limit, found, cap] of limits) {
    if (found > cap) {
      return err({ code: 'LIMIT_EXCEEDED', limit, found, cap });
    }
  }

  const counts = parsed['counts'];
  if (counts === undefined) {
    warnings.push('counts: advisory integrity block absent');
  } else if (!isRecord(counts)) {
    warnings.push('counts: malformed advisory block ignored');
  } else {
    const declared: [string, number][] = [
      ['lists', lists.length],
      ['tasks', tasks.length],
      ['snapshots', snapshots.length],
    ];
    for (const [name, actual] of declared) {
      const stated = counts[name];
      if (typeof stated !== 'number') {
        warnings.push(`counts.${name}: missing or not a number`);
      } else if (stated !== actual) {
        warnings.push(
          `counts.${name} mismatch: declared ${String(stated)}, found ${String(actual)}`,
        );
      }
    }
  }

  for (const key of Object.keys(parsed)) {
    if (
      key !== 'format' &&
      key !== 'formatVersion' &&
      key !== 'schemaVersion' &&
      key !== 'kind' &&
      key !== 'exportedAt' &&
      key !== 'deviceId' &&
      key !== 'app' &&
      key !== 'counts' &&
      key !== 'data'
    ) {
      warnings.push(`envelope: unknown key "${key}" ignored`);
    }
  }

  return ok({
    formatVersion,
    schemaVersion,
    kind,
    exportedAt,
    deviceId,
    settings,
    lists: lists as unknown[],
    tasks: tasks as unknown[],
    snapshots: snapshots as unknown[],
    warnings,
  });
}

export type ParseFileInput = File | string;

/** Byte length of an import input without reading it (Decision 6.1.2). */
export function inputByteSize(input: ParseFileInput): number {
  if (typeof input === 'string') return utf8ByteLength(input);
  return input.size;
}

/** Read the input text, enforcing the size cap BEFORE the read for `File`s. */
export async function readImportText(
  input: ParseFileInput,
): Promise<Result<{ text: string; bytes: number }, ImportError>> {
  const bytes = inputByteSize(input);
  if (bytes > MAX_IMPORT_BYTES) {
    return err({ code: 'FILE_TOO_LARGE', bytes, cap: MAX_IMPORT_BYTES });
  }
  if (typeof input === 'string') return ok({ text: input, bytes });
  try {
    const text = await input.text();
    return ok({ text, bytes });
  } catch (e) {
    return err({ code: 'PARSE_ERROR', message: e instanceof Error ? e.message : String(e) });
  }
}
