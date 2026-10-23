/**
 * Shared fixtures for storage-framework tests (ADR-002 shapes, always VALID rows
 * unless a test deliberately corrupts one).
 */
import 'fake-indexeddb/auto';

import { AppDBImpl, openRawAppDB } from '../../../src/storage/db';
import type { BootReport } from '../../../src/storage/db';
import { newUlid } from '../../../src/storage/id';
import type { List, Meta, Settings, Snapshot, Task } from '../../../src/storage/types';

export const T0 = 1_700_000_000_000;
export const fixedNow = (): number => T0;

let dbCounter = 0;

export function uniqueDbName(prefix = 'test'): string {
  dbCounter += 1;
  return `${prefix}-${String(dbCounter)}-${String(Date.now())}`;
}

export function makeMeta(over: Partial<Meta> = {}): Meta {
  return {
    schemaVersion: 1,
    deviceId: newUlid(T0),
    createdAt: T0,
    lastOpenedAt: T0,
    ...over,
  };
}

export function makeList(over: Partial<List> = {}): List {
  return {
    id: newUlid(T0),
    name: 'Inbox',
    color: '#336699',
    sortOrder: 'h',
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    deviceId: newUlid(T0),
    ...over,
  };
}

export function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: newUlid(T0),
    listId: newUlid(T0),
    title: 'Write tests',
    notes: null,
    status: 'open',
    priority: 0,
    tags: [],
    sortOrder: 'h',
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    deviceId: newUlid(T0),
    ...over,
  };
}

export function makeSettings(over: Partial<Settings> = {}): Settings {
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

export function makeSnapshot(id: string, over: Partial<Snapshot> = {}): Snapshot {
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

const emptyReport = (): BootReport => ({
  schemaVersion: 1,
  migrated: null,
  preMigrationSnapshotId: null,
  quarantined: 0,
  purgedTombstones: 0,
  newerSchema: null,
  bootWarnings: [],
});

/**
 * Open a wrapped DB without boot steps (raw fixture surface for unit tests).
 * Meta is READ-AND-KEPT (QA defect D5): an existing row — including a
 * deliberately corrupt one — is never overwritten by an inspection open, so
 * reopening can no longer mask meta-level corruption or rotate deviceId.
 * A fresh `meta` is written only on the first open (or when explicitly given).
 */
export async function openFixtureDb(dbName: string, meta?: Meta): Promise<AppDBImpl> {
  const opened = await openRawAppDB({ dbName });
  if (!opened.ok) throw new Error(`fixture open failed: ${opened.error.code}`);
  if (meta !== undefined) {
    const db = new AppDBImpl(opened.value, meta, emptyReport());
    await db.put('meta', meta);
    return db;
  }
  const existing = (await opened.value.get('meta', 'meta')) as Meta | undefined;
  const effective = existing ?? makeMeta();
  const db = new AppDBImpl(opened.value, effective, emptyReport());
  if (existing === undefined) await db.put('meta', effective);
  return db;
}

export type SeedInput = {
  meta?: Meta;
  lists?: List[];
  tasks?: Task[];
  settings?: Settings[];
  snapshots?: Snapshot[];
  payloads?: { id: string; payload: string }[];
};

/** Seed a database with raw rows and close it — the "fixture DB at version N". */
export async function seedDb(dbName: string, input: SeedInput): Promise<void> {
  const db = await openFixtureDb(dbName, input.meta);
  if (input.settings !== undefined) {
    for (const row of input.settings) await db.put('settings', row);
  }
  for (const row of input.lists ?? []) await db.put('lists', row);
  for (const row of input.tasks ?? []) await db.put('tasks', row);
  for (const row of input.snapshots ?? []) await db.put('snapshots', row);
  for (const row of input.payloads ?? []) await db.put('snapshot_payloads', row);
  db.close();
}

/** Deterministic PRNG for property tests (reproducible failures). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A QuotaExceededError-shaped DOMException (jsdom provides DOMException). */
export function quotaError(): DOMException {
  return new DOMException('quota exceeded (fault-injected)', 'QuotaExceededError');
}

/**
 * Fault-inject quota exhaustion on IDB writes until the returned restore fn is
 * called. Covers `put` request paths end-to-end (idb -> raw object store).
 */
export function injectQuotaOnPuts(): () => void {
  const proto = IDBObjectStore.prototype as unknown as { put: (...args: unknown[]) => unknown };
  const original = proto.put;
  proto.put = function put() {
    throw quotaError();
  };
  return () => {
    proto.put = original;
  };
}

/**
 * Fault-inject quota exhaustion on IDB reads until the returned restore fn is
 * called. Covers `get` request paths (boot's meta read catch block).
 */
export function injectQuotaOnGets(): () => void {
  const proto = IDBObjectStore.prototype as unknown as { get: (...args: unknown[]) => unknown };
  const original = proto.get;
  proto.get = function get() {
    throw quotaError();
  };
  return () => {
    proto.get = original;
  };
}
