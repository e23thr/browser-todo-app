/**
 * Typed IndexedDB wrapper (ADR-002 Decision 10) — the ONLY module allowed to
 * touch `idb` or `IDBDatabase`. Every public entry point returns
 * `Promise<Result<T, StorageError>>`; nothing throws across this boundary.
 *
 * `put` is deliberately RAW (Decision 5/10): no timestamp stamping, no semantic
 * validation beyond "primary key present and well-formed". Stamping lives in
 * repos; semantic validation lives in `validate.ts`.
 */

import { openDB, type IDBPDatabase, type IDBPTransaction } from 'idb';

import {
  blocked,
  classifyUnknown,
  err,
  invalidRecord,
  ok,
  unavailable,
  unknownError,
} from './errors';
import type { Result, StorageError } from './errors';
import { isUlid } from './id';
import { APP_SCHEMA_VERSION, IDB_VERSION, META_KEY, SETTINGS_KEY, STORE_DEFS, DB_NAME } from './schema';
import type { QuarantineApi, QuarantineEntry } from './quarantine';
import { makeQuarantineApi } from './quarantine';
import type { Row, RowMap, StoreName } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */
// `idb`'s dynamic-store generics cannot be expressed without `any` at exactly
// one seam (the raw handle cast below); every public signature is fully typed.
type RawDB = IDBPDatabase<any>;
type RawTx = IDBPTransaction<any, any, any>;
type RawStore = {
  get(key: string): Promise<unknown>;
  getAll(): Promise<unknown[]>;
  put(value: unknown, key?: string): Promise<string>;
  delete(key: string): Promise<void>;
  index(name: string): RawSource;
  openCursor(range?: IDBKeyRange | null, direction?: IDBCursorDirection): Promise<RawCursor | null>;
};
type RawSource = {
  openCursor(range?: IDBKeyRange | null, direction?: IDBCursorDirection): Promise<RawCursor | null>;
};
type RawCursor = { value: unknown; continue(): Promise<RawCursor | null> };
/* eslint-enable @typescript-eslint/no-explicit-any */

function rawStore(tx: RawTx, store: StoreName): RawStore {
  return tx.objectStore(store) as unknown as RawStore;
}

export type QuerySpec = {
  index?: string;
  range?:
    | { eq?: IDBValidKey }
    | {
        lower?: IDBValidKey;
        lowerOpen?: boolean;
        upper?: IDBValidKey;
        upperOpen?: boolean;
      };
  direction?: 'next' | 'prev';
  limit?: number;
};

/** Narrow view handed to `tx()` callbacks and migration steps (ADR-002 §10.2). */
export interface Tx {
  get<K extends StoreName>(store: K, key: string): Promise<Row<K> | undefined>;
  getAll<K extends StoreName>(store: K, spec?: QuerySpec): Promise<Row<K>[]>;
  put<K extends StoreName>(store: K, row: Row<K>): Promise<void>;
  delete(store: StoreName, key: string): Promise<void>;
}

export type BootReport = {
  schemaVersion: number;
  migrated: { from: number; to: number } | null;
  preMigrationSnapshotId: string | null;
  quarantined: number;
  purgedTombstones: number;
  /** Set when meta.schemaVersion is newer than this build: all writes refuse. */
  newerSchema: { found: number; supported: number } | null;
  /** Non-fatal step-5 failures (lastOpenedAt bump, purge) — surfaced, never silent. */
  bootWarnings: { step: string; error: StorageError }[];
};

export interface AppDB {
  readonly deviceId: string;
  readonly schemaVersion: number;
  readonly bootReport: BootReport;
  readonly quarantine: QuarantineApi;

  tx<T>(
    stores: StoreName[],
    mode: 'readonly' | 'readwrite',
    fn: (t: Tx) => Promise<Result<T, StorageError>>,
  ): Promise<Result<T, StorageError>>;

  get<K extends StoreName>(store: K, key: string): Promise<Result<Row<K> | undefined, StorageError>>;
  getAll<K extends StoreName>(store: K, spec?: QuerySpec): Promise<Result<Row<K>[], StorageError>>;
  put<K extends StoreName>(store: K, row: Row<K>): Promise<Result<void, StorageError>>;
  query<K extends StoreName>(store: K, spec: QuerySpec): Promise<Result<Row<K>[], StorageError>>;
  delete(store: StoreName, key: string): Promise<Result<void, StorageError>>;

  close(): void;
}

function buildRange(spec: QuerySpec['range']): IDBKeyRange | null {
  if (spec === undefined) return null;
  if ('eq' in spec) return IDBKeyRange.only(spec.eq);
  // The ADR-002 §10.2 union cannot narrow cleanly past an optional `eq`; one
  // seam-local view of the bound fields keeps call sites type-safe.
  const bounds = spec as unknown as {
    lower?: IDBValidKey;
    lowerOpen?: boolean;
    upper?: IDBValidKey;
    upperOpen?: boolean;
  };
  const lowerOpen = bounds.lowerOpen ?? false;
  const upperOpen = bounds.upperOpen ?? false;
  const { lower, upper } = bounds;
  if (lower !== undefined && upper !== undefined) return IDBKeyRange.bound(lower, upper, lowerOpen, upperOpen);
  if (lower !== undefined) return IDBKeyRange.lowerBound(lower, lowerOpen);
  if (upper !== undefined) return IDBKeyRange.upperBound(upper, upperOpen);
  return null;
}

async function collect(source: RawSource, spec: QuerySpec | undefined): Promise<unknown[]> {
  const range = buildRange(spec?.range);
  const direction: IDBCursorDirection = spec?.direction ?? 'next';
  const limit = spec?.limit;
  const out: unknown[] = [];
  let cursor = await source.openCursor(range, direction);
  while (cursor !== null) {
    out.push(cursor.value);
    if (limit !== undefined && out.length >= limit) break;
    cursor = await cursor.continue();
  }
  return out;
}

function primaryKeyOk(store: StoreName, row: unknown): boolean {
  if (store === 'meta') return typeof row === 'object' && row !== null;
  if (store === 'settings') {
    return (
      typeof row === 'object' &&
      row !== null &&
      (row as { id?: unknown }).id === SETTINGS_KEY
    );
  }
  return isUlid((row as { id?: unknown } | null)?.id);
}

function rowKey(store: StoreName, row: unknown): string {
  if (store === 'meta') return META_KEY;
  return String((row as { id?: unknown } | null)?.id);
}

function denyKey(store: StoreName, key: string): string {
  return `${store}\u0000${key}`;
}

export class AppDBImpl implements AppDB {
  readonly #db: RawDB;
  #deviceId: string;
  #schemaVersion: number;
  #writeGuard: StorageError | null = null;
  #denied = new Set<string>();
  #quarantineEntries: QuarantineEntry[] = [];
  #report: BootReport;
  #closed = false;

  constructor(db: RawDB, meta: RowMap['meta'], report: BootReport) {
    this.#db = db;
    this.#deviceId = meta.deviceId;
    this.#schemaVersion = meta.schemaVersion;
    this.#report = report;
    this.quarantine = makeQuarantineApi(this);
  }

  readonly quarantine: QuarantineApi;

  get deviceId(): string {
    return this.#deviceId;
  }

  get schemaVersion(): number {
    return this.#schemaVersion;
  }

  get bootReport(): BootReport {
    return this.#report;
  }

  /* ---- internal seams used by boot/migrations/quarantine (not public API) ---- */

  /** @internal */
  get raw(): RawDB {
    return this.#db;
  }

  /** @internal */
  setSchemaVersion(v: number): void {
    this.#schemaVersion = v;
  }

  /** @internal */
  setWriteGuard(e: StorageError | null): void {
    this.#writeGuard = e;
  }

  /** @internal */
  setQuarantine(entries: QuarantineEntry[]): void {
    this.#quarantineEntries = entries;
    this.#denied = new Set(entries.map((e) => denyKey(e.store, e.key)));
  }

  /** @internal */
  get quarantineEntries(): readonly QuarantineEntry[] {
    return this.#quarantineEntries;
  }

  /**
   * @internal Unfiltered read used by the snapshot/backup path only: backups
   * must never lose rows, so the quarantine denylist does not apply here.
   */
  async readUnfiltered<K extends StoreName>(store: K): Promise<Result<Row<K>[], StorageError>> {
    try {
      const base = this.#db.transaction([store], 'readonly') as unknown as RawTx;
      const rows = (await collect(rawStore(base, store), undefined)) as Row<K>[];
      await base.done;
      return ok(rows);
    } catch (e) {
      return err(classifyUnknown(e));
    }
  }

  /** @internal */
  updateReport(patch: Partial<BootReport>): void {
    this.#report = { ...this.#report, ...patch };
  }

  /* ------------------------------ public API ------------------------------ */

  async tx<T>(
    stores: StoreName[],
    mode: 'readonly' | 'readwrite',
    fn: (t: Tx) => Promise<Result<T, StorageError>>,
  ): Promise<Result<T, StorageError>> {
    if (this.#closed) return err(unknownError(new Error('AppDB is closed')));
    if (stores.length === 0) return err(unknownError(new Error('tx: at least one store required')));
    if (mode === 'readwrite' && this.#writeGuard !== null) return err(this.#writeGuard);
    let rawTx: RawTx;
    try {
      rawTx = this.#db.transaction(stores, mode);
    } catch (e) {
      return err(classifyUnknown(e));
    }
    const wrapped = new TxImpl(rawTx, this.#denied);
    try {
      const result = await fn(wrapped);
      if (!result.ok) {
        try {
          rawTx.abort();
        } catch {
          // already aborted/committed — the error result is still authoritative
        }
        // Abort rejects `tx.done` by design; swallow it here so the returned
        // Result is the single channel (nothing throws across the boundary).
        void rawTx.done.catch(() => undefined);
        return result;
      }
      await rawTx.done;
      return ok(result.value);
    } catch (e) {
      try {
        rawTx.abort();
      } catch {
        // fall through to classification
      }
      void rawTx.done.catch(() => undefined);
      return err(classifyUnknown(e));
    }
  }

  async get<K extends StoreName>(
    store: K,
    key: string,
  ): Promise<Result<Row<K> | undefined, StorageError>> {
    if (this.#closed) return err(unknownError(new Error('AppDB is closed')));
    if (this.#denied.has(denyKey(store, key))) return ok(undefined);
    try {
      const key2 = store === 'meta' ? META_KEY : key;
      const value = (await this.#db.get(store, key2)) as Row<K> | undefined;
      return ok(value);
    } catch (e) {
      return err(classifyUnknown(e));
    }
  }

  async getAll<K extends StoreName>(
    store: K,
    spec?: QuerySpec,
  ): Promise<Result<Row<K>[], StorageError>> {
    return this.query(store, spec ?? {});
  }

  async query<K extends StoreName>(
    store: K,
    spec: QuerySpec,
  ): Promise<Result<Row<K>[], StorageError>> {
    if (this.#closed) return err(unknownError(new Error('AppDB is closed')));
    try {
      const base = this.#db.transaction([store], 'readonly') as unknown as RawTx;
      const src: RawSource =
        spec.index === undefined
          ? rawStore(base, store)
          : rawStore(base, store).index(spec.index);
      const rows = (await collect(src, spec)) as Row<K>[];
      await base.done;
      return ok(rows.filter((r) => !this.#denied.has(denyKey(store, rowKey(store, r)))));
    } catch (e) {
      return err(classifyUnknown(e));
    }
  }

  async put<K extends StoreName>(store: K, row: Row<K>): Promise<Result<void, StorageError>> {
    if (this.#closed) return err(unknownError(new Error('AppDB is closed')));
    if (this.#writeGuard !== null) return err(this.#writeGuard);
    if (!primaryKeyOk(store, row)) {
      return err(invalidRecord(store, ['missing or malformed primary key'], rowKey(store, row)));
    }
    try {
      if (store === 'meta') {
        await this.#db.put(store, row, META_KEY);
      } else {
        await this.#db.put(store, row);
      }
      return ok(undefined);
    } catch (e) {
      return err(classifyUnknown(e));
    }
  }

  async delete(store: StoreName, key: string): Promise<Result<void, StorageError>> {
    if (this.#closed) return err(unknownError(new Error('AppDB is closed')));
    if (this.#writeGuard !== null) return err(this.#writeGuard);
    try {
      await this.#db.delete(store, store === 'meta' ? META_KEY : key);
      return ok(undefined);
    } catch (e) {
      return err(classifyUnknown(e));
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}

class TxImpl implements Tx {
  readonly #tx: RawTx;
  readonly #denied: Set<string>;

  constructor(tx: RawTx, denied: Set<string>) {
    this.#tx = tx;
    this.#denied = denied;
  }

  async get<K extends StoreName>(store: K, key: string): Promise<Row<K> | undefined> {
    const k = store === 'meta' ? META_KEY : key;
    return (await rawStore(this.#tx, store).get(k)) as Row<K> | undefined;
  }

  async getAll<K extends StoreName>(store: K, spec?: QuerySpec): Promise<Row<K>[]> {
    const src: RawSource =
      spec?.index === undefined
        ? rawStore(this.#tx, store)
        : rawStore(this.#tx, store).index(spec.index);
    const rows = (await collect(src, spec)) as Row<K>[];
    return rows.filter((r) => !this.#denied.has(denyKey(store, rowKey(store, r))));
  }

  async put<K extends StoreName>(store: K, row: Row<K>): Promise<void> {
    if (store === 'meta') {
      await rawStore(this.#tx, store).put(row, META_KEY);
    } else {
      await rawStore(this.#tx, store).put(row);
    }
  }

  async delete(store: StoreName, key: string): Promise<void> {
    await rawStore(this.#tx, store).delete(store === 'meta' ? META_KEY : key);
  }
}

export type OpenOptions = {
  dbName?: string;
  /** Test-only: force a structural upgrade to trigger `blocked` paths. */
  idbVersion?: number;
};

/**
 * Open the raw DB (Decision 8 step 1: structural changes run in `onupgradeneeded`,
 * one atomic `versionchange` transaction, purely additive). Does NOT seed meta,
 * migrate, or validate — that is `boot()`'s job.
 */
export async function openRawAppDB(options: OpenOptions = {}): Promise<Result<RawDB, StorageError>> {
  const name = options.dbName ?? DB_NAME;
  const version = options.idbVersion ?? IDB_VERSION;
  const factory = globalThis.indexedDB as IDBFactory | undefined;
  if (factory === undefined) {
    return err(unavailable(new Error('indexedDB is not available')));
  }

  let resolveBlocked!: (e: StorageError) => void;
  const blockedSignal = new Promise<StorageError>((resolve) => {
    resolveBlocked = resolve;
  });

  const openPromise = openDB(name, version, {
    upgrade(db) {
      for (const def of STORE_DEFS) {
        if (db.objectStoreNames.contains(def.name)) continue;
        const store =
          def.keyPath === null
            ? db.createObjectStore(def.name)
            : db.createObjectStore(def.name, { keyPath: def.keyPath });
        for (const idx of def.indexes) {
          store.createIndex(idx.name, idx.keyPath);
        }
      }
    },
    blocked() {
      resolveBlocked(
        blocked(`database "${name}" is held open by another tab at an older version`),
      );
    },
  });

  const raced = await Promise.race([
    openPromise.then((db): { db: RawDB } | { blocked: StorageError } => ({ db: db as unknown as RawDB })),
    blockedSignal.then((e): { db: RawDB } | { blocked: StorageError } => ({ blocked: e })),
  ]);

  if ('blocked' in raced) {
    // The open may still complete later; close it so we do not leak a connection.
    void openPromise
      .then((db) => {
        db.close();
      })
      .catch(() => undefined);
    return err(raced.blocked);
  }
  return ok(raced.db);
}

/** Convenience used by tests and boot: open + wrap without boot steps. */
export async function openForTests(options: OpenOptions = {}): Promise<Result<AppDBImpl, StorageError>> {
  const opened = await openRawAppDB(options);
  if (!opened.ok) return err(opened.error);
  const report: BootReport = {
    schemaVersion: APP_SCHEMA_VERSION,
    migrated: null,
    preMigrationSnapshotId: null,
    quarantined: 0,
    purgedTombstones: 0,
    newerSchema: null,
    bootWarnings: [],
  };
  return ok(new AppDBImpl(opened.value, {
    schemaVersion: APP_SCHEMA_VERSION,
    deviceId: '0'.repeat(26),
    createdAt: 0,
    lastOpenedAt: 0,
  }, report));
}
