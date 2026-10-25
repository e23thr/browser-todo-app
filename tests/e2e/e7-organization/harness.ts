/**
 * E7 QA browser harness (test card t_ed1fa949, h_reviewer).
 *
 * Bundled by `tests/e2e/e7-organization/vite.config.mjs` and loaded into a REAL
 * Chromium page with REAL IndexedDB (same pattern as the E3 data-safety
 * harness). Two probes run here because jsdom/fake-indexeddb cannot stand in for
 * the production substrate at these sizes:
 *
 *  - `seedV1` + `bootMigration`: a literal v1 database (numeric priority, no
 *    tags field) migrated by the REAL `boot()` + production registry — the
 *    acceptance path of §5.4 in a real browser.
 *  - `seed10k` + `timeSweep`: 10,000 tagged tasks, then the REAL
 *    `TaskRepo.sweepTag` (one transaction) timed on real IndexedDB — the
 *    rename-propagation AC. fake-indexeddb's update path is quadratic (the
 *    impl disclosed 7.9 s @ 2k), so only real IDB gives a truthful number.
 *
 * Test-only seams live here; `src/` is untouched.
 */

import { openForTests, type AppDBImpl } from '../../../src/storage/db';
import { boot, resetBootSingleton } from '../../../src/storage/boot';
import { createErrorLog } from '../../../src/storage/errorLog';
import { newUlid } from '../../../src/storage/id';
import { TaskRepo } from '../../../src/storage/repos/taskRepo';
import type { List, Meta, Settings, Task } from '../../../src/storage/types';
import { DEFAULT_SETTINGS } from '../../../src/domain/model';

/** Fixed clock base for byte-stable stamps. */
export const T0 = 1_700_000_000_000;

/** Deterministic valid ULID (same shape as the E3 harness). */
function fid(n: number): string {
  return `01ARZ3NDEKTSV4RRFFQ6${String(n).padStart(6, '0')}`;
}

const DEVICE = fid(1);
const LIST_ID = fid(10);

function makeList(): List {
  return {
    id: LIST_ID,
    name: 'Personal',
    color: '#2e6fd9',
    sortOrder: 'a',
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    deviceId: DEVICE,
  };
}

function makeSettings(): Settings {
  return { ...DEFAULT_SETTINGS, id: 'settings' };
}

function makeMeta(schemaVersion: number): Meta {
  return { schemaVersion, deviceId: DEVICE, createdAt: T0, lastOpenedAt: T0 };
}

/** A literal MVP-era v1 task row: numeric priority, NO `tags` field. */
function v1Task(id: string, priority: unknown): Task {
  const row: Record<string, unknown> = {
    id,
    listId: LIST_ID,
    title: `legacy ${id}`,
    notes: null,
    status: 'open',
    sortOrder: 'h',
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    deviceId: DEVICE,
  };
  if (priority !== undefined) row['priority'] = priority;
  return row as unknown as Task;
}

function v3Task(id: string, i: number): Task {
  return {
    id,
    listId: LIST_ID,
    title: `task ${String(i)}`,
    notes: null,
    status: 'open',
    priority: 'P4',
    tags: ['work', `bucket-${String(i % 50)}`],
    sortOrder: 'h',
    createdAt: T0 + i,
    updatedAt: T0 + i,
    deletedAt: null,
    deviceId: DEVICE,
  };
}

let db: AppDBImpl | null = null;

function requireDb(): AppDBImpl {
  if (db === null) throw new Error('e7 harness: call open() first');
  return db;
}

/** Batched puts in ONE transaction — seeding must not dominate the timing. */
async function putRows(store: 'tasks' | 'lists' | 'settings', rows: unknown[]): Promise<void> {
  const handle = requireDb();
  const written = await handle.tx([store], 'readwrite', async (t) => {
    const puts = rows.map((row) => t.put(store, row as never));
    await Promise.all(puts);
    return { ok: true as const, value: undefined };
  });
  if (!written.ok) throw new Error(`e7 harness: seed ${store} failed: ${written.error.code}`);
}

export type MigrationResult = {
  ok: boolean;
  migrated: { from: number; to: number } | null;
  snapshotId: string | null;
  quarantined: number;
  schemaVersion: number;
  priorities: Record<string, unknown>;
  durationMs: number;
};

export type SweepResult = {
  ok: boolean;
  durationMs: number;
  written: number;
  allRenamed: boolean;
  sampleTag: string | undefined;
};

export type E7Harness = {
  ready: boolean;
  open: (name: string) => Promise<{ ok: boolean; error?: string }>;
  close: () => void;
  /** Seed a literal v1 DB (numeric priorities) and boot-migrate it for real. */
  seedV1AndMigrate: (dbName: string) => Promise<MigrationResult>;
  /** Seed `count` tagged tasks, then time the real one-transaction sweep. */
  seed10kAndSweep: (count: number) => Promise<SweepResult>;
};

const harness: E7Harness = {
  ready: true,

  async open(name) {
    const opened = await openForTests({ dbName: name });
    if (!opened.ok) return { ok: false, error: opened.error.code };
    db = opened.value;
    return { ok: true };
  },

  close() {
    db?.close();
    db = null;
    resetBootSingleton();
  },

  async seedV1AndMigrate(dbName) {
    // Close the inspection handle first — boot opens its own connection.
    db?.close();
    db = null;
    resetBootSingleton(dbName);

    const opened = await openForTests({ dbName: dbName });
    if (!opened.ok) return failure(`open: ${opened.error.code}`);
    db = opened.value;
    const meta = await db.put('meta', makeMeta(1));
    if (!meta.ok) return failure(`meta: ${meta.error.code}`);
    await putRows('lists', [makeList()]);
    await putRows('settings', [makeSettings()]);
    await putRows('tasks', [
      v1Task(fid(21), 2), // legacy High
      v1Task(fid(22), 1), // legacy Medium
      v1Task(fid(23), 0), // legacy Low
      v1Task(fid(24), undefined), // unset
      v1Task(fid(25), 'garbage'), // unknown → P4, never dropped
    ]);
    db.close();
    db = null;
    resetBootSingleton(dbName);

    const started = performance.now();
    const booted = await boot({ dbName: dbName, now: () => T0 });
    const durationMs = performance.now() - started;
    if (!booted.ok) return failure(`boot: ${booted.error.code}`);
    db = booted.value as AppDBImpl;

    const rows = await db.readUnfiltered('tasks');
    if (!rows.ok) return failure(`read: ${rows.error.code}`);
    const priorities: Record<string, unknown> = {};
    for (const row of rows.value) priorities[row.id] = row.priority;
    const report = db.bootReport;
    return {
      ok: true,
      migrated: report.migrated,
      snapshotId: report.preMigrationSnapshotId,
      quarantined: report.quarantined,
      schemaVersion: db.schemaVersion,
      priorities,
      durationMs,
    };
  },

  async seed10kAndSweep(count) {
    const handle = requireDb();
    await putRows('lists', [makeList()]);
    const rows: Task[] = [];
    for (let i = 0; i < count; i += 1) rows.push(v3Task(newUlid(T0 + i), i));
    await putRows('tasks', rows);

    const repo = new TaskRepo({
      db: handle,
      clock: () => Date.now(),
      ids: () => newUlid(),
      errorLog: createErrorLog(),
    });

    const started = performance.now();
    const swept = await repo.sweepTag('work', 'office');
    const durationMs = performance.now() - started;
    if (!swept.ok)
      return { ok: false, durationMs, written: 0, allRenamed: false, sampleTag: undefined };

    const read = await handle.readUnfiltered('tasks');
    if (!read.ok)
      return { ok: false, durationMs, written: 0, allRenamed: false, sampleTag: undefined };
    const allRenamed = read.value.every(
      (t) => !t.tags.includes('work') && (t.tags.includes('office') || t.deletedAt !== null),
    );
    return {
      ok: true,
      durationMs,
      written: swept.value.length,
      allRenamed,
      sampleTag: read.value[0]?.tags[1],
    };
  },
};

function failure(step: string): MigrationResult {
  return {
    ok: false,
    migrated: null,
    snapshotId: null,
    quarantined: -1,
    schemaVersion: -1,
    priorities: {},
    durationMs: 0,
    error: step,
  } as MigrationResult;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).__e7 = harness;

declare global {
  interface Window {
    __e7: E7Harness;
  }
}
