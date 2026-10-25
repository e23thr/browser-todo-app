/**
 * Shared helpers for the data-safety (ADR-004) test suites.
 *
 * Fixture drills live here as builders; the static JSON fixtures under
 * `tests/fixtures/backup/` cover the malicious-input cases that are cheap to
 * keep as files (oversize / truncated / count-limit inputs are generated).
 */
import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { List, Settings, Snapshot, Task } from '../../../src/storage/types';
import {
  buildBackupDocument,
  canonicalizeRecord,
  serializeBackupDoc,
} from '../../../src/portability/backup-document';
import type { BackupKind } from '../../../src/portability/types';
import { makeList, makeSettings, makeSnapshot, makeTask, T0 } from '../storage/fixtures';

export { T0 };
export { makeList, makeSettings, makeSnapshot, makeTask };

/** Load a drill fixture from `tests/fixtures/backup/` as raw text (hostile input stays raw). */
export function fixture(name: string): string {
  return readFileSync(resolve(process.cwd(), 'tests/fixtures/backup', name), 'utf8');
}

/** Deterministic ULID-ish ids for fixtures (valid ULIDs, stable across runs). */
export function fixtureId(n: number): string {
  return `01ARZ3NDEKTSV4RRFFQ6${String(n).padStart(6, '0')}`;
}

export type DocSections = {
  settings?: Settings | Record<string, unknown>;
  lists?: (List | Record<string, unknown>)[];
  tasks?: (Task | Record<string, unknown>)[];
  snapshots?: (Snapshot | Record<string, unknown>)[];
  kind?: BackupKind;
  exportedAt?: number;
  deviceId?: string;
  schemaVersion?: number;
  app?: { name: string; version: string } | undefined;
};

/** A structurally valid v1 backup document as a JS object (mutate for attacks). */
export function makeDocObject(sections: DocSections = {}): Record<string, unknown> {
  const doc = buildBackupDocument({
    kind: sections.kind ?? 'export',
    exportedAt: sections.exportedAt ?? T0,
    deviceId: sections.deviceId ?? fixtureId(1),
    schemaVersion: sections.schemaVersion ?? 1,
    settings: (sections.settings ?? makeSettings()) as Settings,
    lists: (sections.lists ?? []) as List[],
    tasks: (sections.tasks ?? []) as Task[],
    snapshots: (sections.snapshots ?? []) as Snapshot[],
    ...(sections.app === undefined ? {} : { app: sections.app }),
  });
  return JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
}

/** The canonical serialization of a valid document (the export byte shape). */
export function makeDocText(sections: DocSections = {}): string {
  return serializeBackupDoc(makeDocObject(sections) as never);
}

/** A small valid corpus: 2 lists (one tombstoned), 3 tasks (one tombstone), 1 snapshot row. */
export function seedCorpus(): {
  settings: Settings;
  lists: List[];
  tasks: Task[];
  snapshots: Snapshot[];
} {
  const l1 = makeList({ id: fixtureId(10), name: 'Personal', sortOrder: 'h' });
  const l2 = makeList({
    id: fixtureId(11),
    name: 'Work',
    sortOrder: 'm',
    deletedAt: T0 - 5,
  });
  const t1 = makeTask({ id: fixtureId(20), listId: l1.id, title: 'Buy milk', sortOrder: 'h' });
  const t2 = makeTask({
    id: fixtureId(21),
    listId: l2.id,
    title: 'Quarterly report',
    status: 'done',
    priority: 'P1',
    notes: 'Numbers',
    completedAt: T0 - 2,
    sortOrder: 'h',
  });
  const t3 = makeTask({
    id: fixtureId(22),
    listId: l1.id,
    title: 'Old task I deleted',
    deletedAt: T0 - 1,
    updatedAt: T0 - 1,
    sortOrder: 'i',
  });
  const s1 = makeSnapshot(fixtureId(30), { takenAt: T0 - 100, kind: 'auto', reason: 'scheduled' });
  return {
    settings: makeSettings({ lastBackupAt: null }),
    lists: [l1, l2],
    tasks: [t1, t2, t3],
    snapshots: [s1],
  };
}

/** `File`-shaped input without needing a real File (size cap is checked first). */
export function fakeFile(name: string, text: string, sizeOverride?: number): File {
  return {
    name,
    size: sizeOverride ?? new TextEncoder().encode(text).length,
    text: () => Promise.resolve(text),
    // The S12 import flow sniffs the head via `slice(0, n).text()` — the fake
    // implements the File surface it impersonates (node has no Blob subclass).
    slice: (start = 0, end?: number) => ({
      text: () => Promise.resolve(text.slice(start, end)),
    }),
  } as unknown as File;
}

/** Fault-inject writes for one object store only (e.g. snapshot writes). */
export function injectFailureOnStorePut(storeName: string, error: DOMException): () => void {
  const proto = IDBObjectStore.prototype as unknown as {
    put: (...args: unknown[]) => unknown;
    name: string;
  };
  const original = proto.put;
  proto.put = function put(this: { name: string }, ...args: unknown[]) {
    if (this.name === storeName) throw error;
    return original.apply(this, args as never);
  };
  return () => {
    proto.put = original;
  };
}

/** Byte-equivalence primitive of ADR-004 §2.4, used by the restore drill. */
export function canonicalText(
  section: 'settings' | 'lists' | 'tasks' | 'snapshots',
  row: unknown,
): string {
  return JSON.stringify(canonicalizeRecord(section, row));
}
