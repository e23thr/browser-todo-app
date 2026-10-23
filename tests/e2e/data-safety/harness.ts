/**
 * E3 data-engine browser harness (test card t_f0702c05 — ADR-004 "Testing contract").
 *
 * Bundled by `tests/e2e/data-safety/vite.config.mjs` and loaded by
 * `tests/e2e/data-safety-journey.spec.ts` into a REAL Chromium page with REAL IndexedDB:
 * this is the drill driver for the export -> wipe -> import -> restored journey and the
 * corruption/loss drills, executed offline (the spec switches the context offline before
 * any drill step runs).
 *
 * It wires the production engine exactly as the composition root will
 * (`openForTests` + `bindDataSafetyDb`) — no reimplementation of any pipeline stage.
 * Test-only seams live here, never in `src/`: deterministic record builders, DB
 * fingerprinting (ADR-004 §2.4 canonical bytes), and a fault injector that makes
 * `IDBObjectStore.put` throw (drills 11/12).
 */

import { openForTests } from '../../../src/storage/db';
import type { AppDBImpl } from '../../../src/storage/db';
import type { MigrationStep } from '../../../src/storage/migrations';
import type {
  List,
  Meta,
  Settings,
  Snapshot,
  SnapshotReason,
  Task,
} from '../../../src/storage/types';
import {
  applyImport,
  bindDataSafetyDb,
  buildBackupDocument,
  canonicalizeRecord,
  DEFAULT_SETTINGS_RECORD,
  deleteAllData,
  deleteSnapshot,
  exportBackup,
  listSnapshots,
  prepareImport,
  restoreSnapshot,
  serializeBackupDoc,
  takeSnapshot,
} from '../../../src/portability/index';
import type {
  ExportError,
  ExportReport,
  ImportError,
  ImportPlan,
  ImportReport,
} from '../../../src/portability/types';
import type { Result, StorageError } from '../../../src/storage/errors';

/* ------------------------------------------------------------------ *
 * Deterministic corpus (shapes = tests/unit/storage/fixtures.ts clones) *
 * ------------------------------------------------------------------ */

/** Fixed clock base for every generated stamp (byte-stable evidence). */
export const T0 = 1_700_000_000_000;

/** Deterministic ULID-ish ids (valid ULIDs, stable across runs). */
function fid(n: number): string {
  return `01ARZ3NDEKTSV4RRFFQ6${String(n).padStart(6, '0')}`;
}

const NIL_DEVICE_ID = fid(0);

function makeList(over: Partial<List> = {}): List {
  return {
    id: fid(10),
    name: 'Personal',
    color: '#336699',
    sortOrder: 'h',
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    deviceId: NIL_DEVICE_ID,
    ...over,
  };
}

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: fid(20),
    listId: fid(10),
    title: 'Buy milk',
    notes: null,
    status: 'open',
    priority: 0,
    tags: [],
    sortOrder: 'h',
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    deviceId: NIL_DEVICE_ID,
    ...over,
  };
}

function makeSettings(over: Partial<Settings> = {}): Settings {
  return {
    id: 'settings',
    theme: 'system',
    locale: 'en',
    weekStart: 1,
    defaultListId: null,
    notificationsEnabled: false,
    lastBackupAt: null,
    ...over,
  };
}

function makeSnapshot(id: string, over: Partial<Snapshot> = {}): Snapshot {
  return {
    id,
    takenAt: T0,
    kind: 'auto',
    reason: 'scheduled',
    sizeBytes: 10,
    schemaVersion: 1,
    payloadRef: id,
    ...over,
  };
}

/** The shared drill corpus: 2 lists (1 tombstoned), 3 tasks (1 tombstoned), 1 snapshot row. */
function corpus(): { settings: Settings; lists: List[]; tasks: Task[]; snapshots: Snapshot[] } {
  const l1 = makeList({ id: fid(10), name: 'Personal', sortOrder: 'h' });
  const l2 = makeList({ id: fid(11), name: 'Work', sortOrder: 'm', deletedAt: T0 - 5 });
  const t1 = makeTask({ id: fid(20), listId: l1.id, title: 'Buy milk', sortOrder: 'h' });
  const t2 = makeTask({
    id: fid(21),
    listId: l2.id,
    title: 'Quarterly report',
    status: 'done',
    priority: 2,
    notes: 'Numbers',
    completedAt: T0 - 2,
    sortOrder: 'h',
  });
  const t3 = makeTask({
    id: fid(22),
    listId: l1.id,
    title: 'Old task I deleted',
    deletedAt: T0 - 1,
    updatedAt: T0 - 1,
    sortOrder: 'i',
  });
  return {
    settings: makeSettings({ lastBackupAt: null }),
    lists: [l1, l2],
    tasks: [t1, t2, t3],
    snapshots: [makeSnapshot(fid(30), { takenAt: T0 - 100, kind: 'auto', reason: 'scheduled' })],
  };
}

/* ------------------------------------------------------------------ *
 * Byte-equivalence primitives (ADR-004 §2.4)                          *
 * ------------------------------------------------------------------ */

export type Fingerprint = {
  lists: string[];
  tasks: string[];
  settings: string | null;
  snapshots: string[];
  payloadIds: string[];
};

function canon(section: 'settings' | 'lists' | 'tasks' | 'snapshots', row: unknown): string {
  return JSON.stringify(canonicalizeRecord(section, row));
}

/* ------------------------------------------------------------------ *
 * Fault injection (drills 11/12)                                       *
 * ------------------------------------------------------------------ */

type PutFn = (this: IDBObjectStore, ...args: unknown[]) => unknown;
let putOriginal: PutFn | null = null;

function putSlot(): { put: PutFn } {
  return IDBObjectStore.prototype as unknown as { put: PutFn };
}

function armPutFault(storeName: string, errorName: string): void {
  const slot = putSlot();
  if (putOriginal === null) putOriginal = slot.put;
  const original = putOriginal;
  slot.put = function put(this: IDBObjectStore, ...args: unknown[]): unknown {
    if (this.name === storeName) {
      // Mirrors what a real browser does on quota exhaustion: the call fails
      // before any request is issued (classifyUnknown maps the name).
      throw new DOMException(`${errorName} injected on ${storeName}.put`, errorName);
    }
    return original.apply(this, args as never);
  };
}

function disarmPutFault(): void {
  if (putOriginal !== null) {
    putSlot().put = putOriginal;
    putOriginal = null;
  }
}

/* ------------------------------------------------------------------ *
 * Migration seam (drill 3)                                             *
 * ------------------------------------------------------------------ */

const notesBackfill: MigrationStep = {
  to: 2,
  stores: ['tasks'],
  run: async (t) => {
    const tasks = await t.getAll('tasks');
    for (const task of tasks) {
      await t.put('tasks', { ...task, notes: task.notes ?? '' });
    }
    return { ok: true, value: undefined };
  },
};

const failingStep: MigrationStep = {
  to: 2,
  stores: ['tasks'],
  run: () => ({ ok: false, error: { code: 'MIGRATION_FAILED', from: 1, to: 2 } }),
};

/* ------------------------------------------------------------------ *
 * Document builders                                                    *
 * ------------------------------------------------------------------ */

export type DocKind = 'valid' | 'v1' | 'snapshots-meta' | 'corrupt-mixed' | 'variant';

/**
 * Canonical drill documents (serialized through the production serializer).
 * - `valid`         — the corpus as a fresh export (lastBackupAt stamped = exportedAt)
 * - `v1`            — old export: schemaVersion 1, tasks WITHOUT `notes` (drill 3 input)
 * - `snapshots-meta`— valid + `data.snapshots` entries that must be ignored (drill 13)
 * - `corrupt-mixed` — 2 valid lists + 3 valid tasks + 3 quarantinable tasks (drills 5/6/8)
 */
function buildDoc(kind: DocKind, nowMs: number): string {
  const c = corpus();
  let lists: List[] = c.lists;
  let tasks: Task[] = c.tasks;
  let snapshots: Snapshot[] = c.snapshots;
  let schemaVersion = 1;

  if (kind === 'v1') {
    schemaVersion = 1;
    tasks = c.tasks.map((task) => {
      const copy: Record<string, unknown> = { ...task };
      delete copy['notes'];
      return copy as unknown as Task;
    });
  }
  if (kind === 'snapshots-meta') {
    snapshots = [
      makeSnapshot(fid(30), { takenAt: T0 - 100 }),
      makeSnapshot(fid(41), { takenAt: T0 - 90, kind: 'manual', reason: 'manual' }),
      makeSnapshot(fid(42), { takenAt: T0 - 80 }),
    ];
  }
  if (kind === 'corrupt-mixed') {
    const base = c.tasks;
    const badTitle: Record<string, unknown> = {
      ...makeTask({ id: fid(50), listId: fid(10), title: 'broken' }),
    };
    badTitle['title'] = { nested: 'not a string' };
    const dangling = makeTask({ id: fid(51), listId: fid(99), title: 'orphan' });
    // Same id as the corpus' first task (fid(20)) but sorts AFTER it: first wins (drill 8).
    const dupe = makeTask({ id: fid(20), listId: fid(10), title: 'duplicate id', sortOrder: 'z' });
    tasks = [...base, badTitle as unknown as Task, dangling, dupe];
    snapshots = c.snapshots;
  }
  if (kind === 'variant') {
    // A DIFFERENT valid corpus (import/undo drills need content to change).
    lists = [
      makeList({ id: fid(60), name: 'Trip', sortOrder: 'a' }),
      makeList({ id: fid(61), name: 'Archive', sortOrder: 'b', deletedAt: T0 - 7 }),
    ];
    tasks = [
      makeTask({ id: fid(70), listId: fid(60), title: 'Pack bags', sortOrder: 'a' }),
      makeTask({
        id: fid(71),
        listId: fid(61),
        title: 'Old plan',
        deletedAt: T0 - 3,
        sortOrder: 'b',
      }),
    ];
    snapshots = [];
  }

  const doc = buildBackupDocument({
    kind: 'export',
    exportedAt: nowMs,
    deviceId: NIL_DEVICE_ID,
    schemaVersion,
    settings: { ...c.settings, lastBackupAt: nowMs },
    lists,
    tasks,
    snapshots,
    app: { name: 'local-first-todo', version: '0.1.0' },
  });
  return serializeBackupDoc(doc);
}

/* ------------------------------------------------------------------ *
 * The harness surface (window.__e3)                                    *
 * ------------------------------------------------------------------ */

let db: AppDBImpl | null = null;

function requireDb(): AppDBImpl {
  if (db === null) throw new Error('harness: call open() first');
  return db;
}

export type E3Harness = {
  ready: boolean;
  open: (name: string) => Promise<{ ok: boolean; error?: string }>;
  seed: () => Promise<Fingerprint>;
  fingerprint: () => Promise<Fingerprint>;
  meta: () => Promise<Record<string, unknown> | null>;
  canonicalDoc: (text: string) => Fingerprint;
  defaultSettings: () => string;
  buildDoc: (kind: DocKind, nowMs: number) => string;
  exportDoc: (nowMs: number) => Promise<Result<ExportReport, ExportError>>;
  wipe: () => Promise<Result<void, StorageError>>;
  prepare: (
    text: string,
    migration?: 'none' | 'backfill' | 'failing',
  ) => Promise<Result<ImportPlan, ImportError>>;
  apply: (
    plan: ImportPlan,
    nowMs: number,
    allowWithoutSnapshot?: boolean,
  ) => Promise<Result<ImportReport, ImportError>>;
  takeSnapshot: (
    reason: string,
    nowMs: number,
  ) => Promise<Result<{ id: string; takenAt: number }, StorageError>>;
  listSnapshots: () => Promise<Result<Snapshot[], StorageError>>;
  deleteSnapshot: (id: string) => Promise<Result<void, StorageError>>;
  restoreSnapshot: (id: string, nowMs: number) => Promise<Result<ImportReport, ImportError>>;
  payloadIds: () => Promise<string[]>;
  armPutFault: (storeName: string, errorName: string) => void;
  disarmPutFault: () => void;
  prepareOversizeFile: () => Promise<Result<ImportPlan, ImportError>>;
  prepareCountBomb: () => Promise<Result<ImportPlan, ImportError>>;
  prefsKeys: () => string[];
};

async function fingerprintOf(handle: AppDBImpl): Promise<Fingerprint> {
  const lists = await handle.readUnfiltered('lists');
  const tasks = await handle.readUnfiltered('tasks');
  const snapshots = await handle.readUnfiltered('snapshots');
  const payloads = await handle.readUnfiltered('snapshot_payloads');
  const settings = await handle.readUnfiltered('settings');
  if (!lists.ok || !tasks.ok || !snapshots.ok || !payloads.ok || !settings.ok) {
    throw new Error('harness: fingerprint read failed');
  }
  return {
    lists: lists.value.map((r) => canon('lists', r)).sort(),
    tasks: tasks.value.map((r) => canon('tasks', r)).sort(),
    settings: settings.value.length > 0 ? canon('settings', settings.value[0]) : null,
    snapshots: snapshots.value.map((r) => canon('snapshots', r)).sort(),
    payloadIds: payloads.value.map((r) => r.id).sort(),
  };
}

const harness: E3Harness = {
  ready: true,

  async open(name) {
    const opened = await openForTests({ dbName: name });
    if (!opened.ok) return { ok: false, error: opened.error.code };
    db = opened.value;
    bindDataSafetyDb(db);
    // Seed the meta row the boot path would create (deviceId preserved across wipe).
    const meta: Meta = {
      schemaVersion: 1,
      deviceId: NIL_DEVICE_ID,
      createdAt: T0,
      lastOpenedAt: T0,
    };
    const written = await db.put('meta', meta);
    if (!written.ok) return { ok: false, error: written.error.code };
    return { ok: true };
  },

  async seed() {
    const handle = requireDb();
    const c = corpus();
    for (const row of c.lists) {
      const r = await handle.put('lists', row);
      if (!r.ok) throw new Error(`seed lists failed: ${r.error.code}`);
    }
    for (const row of c.tasks) {
      const r = await handle.put('tasks', row);
      if (!r.ok) throw new Error(`seed tasks failed: ${r.error.code}`);
    }
    const s = await handle.put('settings', c.settings);
    if (!s.ok) throw new Error(`seed settings failed: ${s.error.code}`);
    const seededSnapshot = c.snapshots[0];
    if (seededSnapshot === undefined) throw new Error('seed corpus lost its snapshot row');
    const snap = await handle.put('snapshots', seededSnapshot);
    if (!snap.ok) throw new Error(`seed snapshots failed: ${snap.error.code}`);
    // Two boot prefs must survive nothing but the wipe (drill 1 asserts they are cleared).
    localStorage.setItem('todo:prefs:v1:theme', 'dark');
    localStorage.setItem('todo:prefs:v1:other', 'x');
    return fingerprintOf(handle);
  },

  fingerprint() {
    return fingerprintOf(requireDb());
  },

  async meta() {
    const rows = await requireDb().readUnfiltered('meta');
    if (!rows.ok) throw new Error(`meta read failed: ${rows.error.code}`);
    return (rows.value[0] as unknown as Record<string, unknown> | undefined) ?? null;
  },

  canonicalDoc(text) {
    const parsed = JSON.parse(text) as {
      data: { settings: unknown; lists: unknown[]; tasks: unknown[]; snapshots: unknown[] };
    };
    return {
      lists: parsed.data.lists.map((r) => canon('lists', r)).sort(),
      tasks: parsed.data.tasks.map((r) => canon('tasks', r)).sort(),
      settings: canon('settings', parsed.data.settings),
      snapshots: parsed.data.snapshots.map((r) => canon('snapshots', r)).sort(),
      payloadIds: [],
    };
  },

  buildDoc(kind, nowMs) {
    return buildDoc(kind, nowMs);
  },

  defaultSettings() {
    return canon('settings', DEFAULT_SETTINGS_RECORD);
  },

  exportDoc(nowMs) {
    return exportBackup({ db: requireDb(), now: () => nowMs, download: false });
  },

  wipe() {
    return deleteAllData({ db: requireDb() });
  },

  prepare(text, migration) {
    const migrations =
      migration === 'backfill'
        ? [notesBackfill]
        : migration === 'failing'
          ? [failingStep]
          : undefined;
    return prepareImport(text, migrations === undefined ? {} : { migrations });
  },

  apply(plan, nowMs, allowWithoutSnapshot) {
    return applyImport(plan, {
      db: requireDb(),
      now: () => nowMs,
      ...(allowWithoutSnapshot === undefined ? {} : { allowWithoutSnapshot }),
    });
  },

  takeSnapshot(reason, nowMs) {
    return takeSnapshot(reason as SnapshotReason, { db: requireDb(), now: () => nowMs });
  },

  listSnapshots() {
    return listSnapshots({ db: requireDb() });
  },

  deleteSnapshot(id) {
    return deleteSnapshot(id, { db: requireDb() });
  },

  restoreSnapshot(id, nowMs) {
    return restoreSnapshot(id, { db: requireDb(), now: () => nowMs });
  },

  async payloadIds() {
    const payloads = await requireDb().readUnfiltered('snapshot_payloads');
    if (!payloads.ok) throw new Error(`payload read failed: ${payloads.error.code}`);
    return payloads.value.map((r) => r.id).sort();
  },

  armPutFault,
  disarmPutFault,

  prepareOversizeFile() {
    // A REAL File whose size exceeds the 50 MiB cap (MAX_IMPORT_BYTES + 1): the size
    // cap must fire BEFORE the file is read.
    const bytes = new Uint8Array(52_428_801);
    const file = new File([bytes], 'oversize.json', { type: 'application/json' });
    return prepareImport(file);
  },

  prepareCountBomb() {
    const doc = JSON.parse(buildDoc('valid', T0)) as Record<string, unknown>;
    const data = doc['data'] as Record<string, unknown>;
    data['tasks'] = new Array(100_001).fill(0);
    return prepareImport(JSON.stringify(doc));
  },

  prefsKeys() {
    const keys: string[] = [];
    for (let i = 0; ; i += 1) {
      const key = localStorage.key(i);
      if (key === null) break;
      if (key.startsWith('todo:prefs:v1:')) keys.push(key);
    }
    return keys.sort();
  },
};

declare global {
  interface Window {
    __e3: E3Harness;
  }
}

window.__e3 = harness;
