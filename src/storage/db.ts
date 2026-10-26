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
import {
  APP_SCHEMA_VERSION,
  CRYPTO_KEY,
  IDB_VERSION,
  META_KEY,
  SETTINGS_KEY,
  STORE_DEFS,
  SYNC_KEY,
  DB_NAME,
} from './schema';
import type { QuarantineApi, QuarantineEntry } from './quarantine';
import { makeQuarantineApi } from './quarantine';
import type { Row, RowMap, StoreName } from './types';
import { rowCryptoSeam } from './cryptoSeam';

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

  /**
   * App-surface transaction (ADR-007 Decision 4 seam): `tasks`/`lists` rows
   * cross the crypto read/write boundary here — reads return decrypted domain
   * views, writes land encrypted when C1 is on. Every other store is untouched.
   * Raw consumers (sync engine, migrations, snapshot restore) use `txRaw`.
   */
  tx<T>(
    stores: StoreName[],
    mode: 'readonly' | 'readwrite',
    fn: (t: Tx) => Promise<Result<T, StorageError>>,
  ): Promise<Result<T, StorageError>>;

  /**
   * AT-REST transaction (ADR-007): no row transform — bytes in, bytes out.
   * Optional on the interface (`AppDBImpl` implements it; test doubles may
   * omit it — callers fall back to `tx`, which is raw for a non-transforming
   * double). Sync engine apply, migration steps and snapshot-restore rollback
   * use this so remote rows travel and land byte-identical.
   */
  txRaw?: <T>(
    stores: StoreName[],
    mode: 'readonly' | 'readwrite',
    fn: (t: Tx) => Promise<Result<T, StorageError>>,
  ) => Promise<Result<T, StorageError>>;

  /** AT-REST reads (optional — same fallback rule as `txRaw`). */
  getAllRaw?: <K extends StoreName>(
    store: K,
    spec?: QuerySpec,
  ) => Promise<Result<Row<K>[], StorageError>>;

  /**
   * Single-key AT-REST read (ADR-007 Decision 4.6 follow-up, t_a155ebf2): ONE
   * read hands back the decrypted domain view AND the exact at-rest row it was
   * decrypted from — the raw base and the merged base MUST come from a single
   * read, because a `get` + separate raw read pair could straddle a concurrent
   * write and recreate the lost update through the back door. This pair is the
   * CAS base for single-row read-modify-writes (`repos/support.ts`
   * `rmwSealed`). Optional on the interface (same fallback rule as `txRaw`).
   */
  getWithRaw?: <K extends StoreName>(
    store: K,
    key: string,
  ) => Promise<Result<{ row: Row<K> | undefined; raw: Row<K> | undefined }, StorageError>>;

  /**
   * Stage ONE domain row to its at-rest form WITHOUT any transaction open
   * (ADR-007 Decision 4.6). Optional on the interface (`AppDBImpl` implements
   * it; test doubles may omit it — callers treat the seal as identity, which is
   * correct for a non-transforming double). Repo write paths stage with this
   * and write the result verbatim in one `txRaw`.
   */
  sealForWrite?: <K extends StoreName>(
    store: K,
    row: Row<K>,
  ) => Promise<Result<Row<K>, StorageError>>;

  get<K extends StoreName>(
    store: K,
    key: string,
  ): Promise<Result<Row<K> | undefined, StorageError>>;
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
  if (lower !== undefined && upper !== undefined)
    return IDBKeyRange.bound(lower, upper, lowerOpen, upperOpen);
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
    return typeof row === 'object' && row !== null && (row as { id?: unknown }).id === SETTINGS_KEY;
  }
  if (store === 'sync_state') {
    return typeof row === 'object' && row !== null && (row as { id?: unknown }).id === SYNC_KEY;
  }
  if (store === 'crypto_state') {
    return typeof row === 'object' && row !== null && (row as { id?: unknown }).id === CRYPTO_KEY;
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

  /**
   * @internal Runtime quarantine (ADR-007 Decision 9): rows that fail decrypt
   * under a successfully unlocked key are excluded from reads, kept verbatim,
   * downloadable via the same recovery file, and deleted only by explicit purge.
   * Non-destructive — never crashed on, never silently dropped.
   */
  addQuarantine(entry: QuarantineEntry): void {
    this.#quarantineEntries = [...this.#quarantineEntries, entry];
    this.#denied.add(denyKey(entry.store, entry.key));
  }

  /** @internal Drop runtime decrypt-quarantine entries (ring grew — rows may heal). */
  clearDecryptQuarantine(): void {
    this.#quarantineEntries = this.#quarantineEntries.filter(
      (e) => !e.issues.some((i) => i.startsWith('decrypt')),
    );
    this.#denied = new Set(this.#quarantineEntries.map((e) => denyKey(e.store, e.key)));
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

  /**
   * App-surface transaction: `tasks`/`lists` rows cross the ADR-007 Decision 4
   * seam inside `TxImpl` (decrypt on read, encrypt on write).
   */
  async tx<T>(
    stores: StoreName[],
    mode: 'readonly' | 'readwrite',
    fn: (t: Tx) => Promise<Result<T, StorageError>>,
  ): Promise<Result<T, StorageError>> {
    return this.#txWith(stores, mode, fn, true);
  }

  /**
   * AT-REST transaction (ADR-007): no row transform — the bytes stored are the
   * bytes handled. Sync engine apply, migration steps and snapshot-restore
   * rollback use this (their rows must stay verbatim / byte-identical).
   */
  async txRaw<T>(
    stores: StoreName[],
    mode: 'readonly' | 'readwrite',
    fn: (t: Tx) => Promise<Result<T, StorageError>>,
  ): Promise<Result<T, StorageError>> {
    return this.#txWith(stores, mode, fn, false);
  }

  async #txWith<T>(
    stores: StoreName[],
    mode: 'readonly' | 'readwrite',
    fn: (t: Tx) => Promise<Result<T, StorageError>>,
    transform: boolean,
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
    const wrapped = new TxImpl(rawTx, this.#denied, transform, this);
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
      return err(e instanceof SeamFailure ? e.storageError : classifyUnknown(e));
    }
  }

  async get<K extends StoreName>(
    store: K,
    key: string,
  ): Promise<Result<Row<K> | undefined, StorageError>> {
    const paired = await this.getWithRaw(store, key);
    return paired.ok ? ok(paired.value.row) : err(paired.error);
  }

  /**
   * ONE read → domain view + the exact at-rest row it came from (the D4.6 CAS
   * base for `rmwSealed`). `get` delegates here so the pair can never straddle
   * a concurrent write. Quarantine/denylist rules are identical to `get`.
   */
  async getWithRaw<K extends StoreName>(
    store: K,
    key: string,
  ): Promise<Result<{ row: Row<K> | undefined; raw: Row<K> | undefined }, StorageError>> {
    if (this.#closed) return err(unknownError(new Error('AppDB is closed')));
    const k = store === 'meta' ? META_KEY : key;
    if (this.#denied.has(denyKey(store, k))) return ok({ row: undefined, raw: undefined });
    try {
      const value = (await this.#db.get(store, k)) as Row<K> | undefined;
      if (value === undefined) return ok({ row: undefined, raw: undefined });
      const seam = store === 'tasks' || store === 'lists' ? rowCryptoSeam() : null;
      if (seam === null) return ok({ row: value, raw: value });
      const read = await seam.readRow(store as 'tasks' | 'lists', value);
      if (!read.ok) return err(read.error);
      if (read.value === undefined) {
        this.addQuarantine({
          store,
          key: k,
          record: value,
          issues: ['decrypt failed under the current key — quarantined (ADR-007 Decision 9)'],
        });
        return ok({ row: undefined, raw: undefined });
      }
      return ok({ row: read.value as Row<K>, raw: value });
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

  /**
   * AT-REST rows (ADR-007): the sync engine pushes/pulls these verbatim and the
   * backup/snapshot substrate serializes them without decrypting.
   */
  async getAllRaw<K extends StoreName>(
    store: K,
    spec?: QuerySpec,
  ): Promise<Result<Row<K>[], StorageError>> {
    return this.queryWith(store, spec ?? {}, false);
  }

  async query<K extends StoreName>(
    store: K,
    spec: QuerySpec,
  ): Promise<Result<Row<K>[], StorageError>> {
    return this.queryWith(store, spec, true);
  }

  async queryWith<K extends StoreName>(
    store: K,
    spec: QuerySpec,
    transform: boolean,
  ): Promise<Result<Row<K>[], StorageError>> {
    if (this.#closed) return err(unknownError(new Error('AppDB is closed')));
    try {
      const base = this.#db.transaction([store], 'readonly') as unknown as RawTx;
      const src: RawSource =
        spec.index === undefined ? rawStore(base, store) : rawStore(base, store).index(spec.index);
      const rows = (await collect(src, spec)) as Row<K>[];
      await base.done;
      const alive = rows.filter((r) => !this.#denied.has(denyKey(store, rowKey(store, r))));
      const seam = transform && (store === 'tasks' || store === 'lists') ? rowCryptoSeam() : null;
      if (seam === null) return ok(alive);
      const out: Row<K>[] = [];
      for (const row of alive) {
        const read = await seam.readRow(store as 'tasks' | 'lists', row);
        if (!read.ok) return err(read.error);
        if (read.value === undefined) {
          this.addQuarantine({
            store,
            key: rowKey(store, row),
            record: row,
            issues: ['decrypt failed under the current key — quarantined (ADR-007 Decision 9)'],
          });
          continue;
        }
        out.push(read.value as Row<K>);
      }
      return ok(out);
    } catch (e) {
      return err(classifyUnknown(e));
    }
  }

  async put<K extends StoreName>(store: K, row: Row<K>): Promise<Result<void, StorageError>> {
    return this.putWith(store, row, true);
  }

  /** AT-REST write (ADR-007): verbatim bytes — sync apply / rollback paths. */
  async putRaw<K extends StoreName>(store: K, row: Row<K>): Promise<Result<void, StorageError>> {
    return this.putWith(store, row, false);
  }

  /**
   * Stage ONE domain row to its at-rest form WITHOUT any transaction open
   * (ADR-007 Decision 4.6 / E10-Q6): the row seam's WebCrypto is real async
   * work, and a transaction that awaits it deactivates on firefox/webkit —
   * the continuation lands after the auto-commit window, so the remaining
   * writes are refused or silently dropped. Multi-row seamed applies (import /
   * snapshot restore) stage EVERY row with this first, then write the results
   * VERBATIM in one `txRaw` — ADR-004 Decision 5's ONE-transaction atomicity
   * is unchanged, because staging is pure (no side effects, nothing to roll
   * back) and the tx still covers deletes + puts together.
   */
  async sealForWrite<K extends StoreName>(
    store: K,
    row: Row<K>,
  ): Promise<Result<Row<K>, StorageError>> {
    if (!primaryKeyOk(store, row)) {
      return err(invalidRecord(store, ['missing or malformed primary key'], rowKey(store, row)));
    }
    const seam = store === 'tasks' || store === 'lists' ? rowCryptoSeam() : null;
    if (seam === null) return ok(row);
    const sealed = await seam.writeRow(store as 'tasks' | 'lists', row);
    if (!sealed.ok) return err(sealed.error);
    return ok(sealed.value as Row<K>);
  }

  async putWith<K extends StoreName>(
    store: K,
    row: Row<K>,
    transform: boolean,
  ): Promise<Result<void, StorageError>> {
    if (this.#closed) return err(unknownError(new Error('AppDB is closed')));
    if (this.#writeGuard !== null) return err(this.#writeGuard);
    let staged: Result<Row<K>, StorageError>;
    if (transform) {
      staged = await this.sealForWrite(store, row);
    } else if (primaryKeyOk(store, row)) {
      staged = ok(row);
    } else {
      staged = err(invalidRecord(store, ['missing or malformed primary key'], rowKey(store, row)));
    }
    if (!staged.ok) return err(staged.error);
    const toWrite: Row<K> = staged.value;
    try {
      if (store === 'meta') {
        await this.#db.put(store, toWrite, META_KEY);
      } else {
        await this.#db.put(store, toWrite);
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
  readonly #transform: boolean;
  readonly #owner: AppDBImpl;

  constructor(tx: RawTx, denied: Set<string>, transform: boolean, owner: AppDBImpl) {
    this.#tx = tx;
    this.#denied = denied;
    this.#transform = transform;
    this.#owner = owner;
  }

  // E10-Q6 hazard (ADR-007 Decision 4.6): every seam call below is real async
  // work awaited INSIDE a live transaction. firefox/webkit deactivate the tx
  // across such an await (the continuation lands after the auto-commit window),
  // so seamed reads/writes through `Tx` are only reliable on engines that
  // resolve WebCrypto in a microtask (chromium). As of t_a155ebf2 NO production
  // carrier awaits seam work through `Tx` anymore: the repo surface stages
  // outside (`sealForWrite`) and commits verbatim via `txRaw` (single-row RMW
  // is CAS-guarded over the at-rest base bytes via `repos/support.ts`
  // `rmwSealed`), `purge.ts` and the migration steps run over `txRaw`, and
  // `settings`/`meta`/… are unseamed stores. The seamed `Tx` surface stays for
  // the app's own single-store reads and as the non-transforming-double
  // fallback — never again a load-bearing path for `tasks`/`lists` writes.

  async get<K extends StoreName>(store: K, key: string): Promise<Row<K> | undefined> {
    const k = store === 'meta' ? META_KEY : key;
    // ADR-002 Decision 8 step 4: the denylist applies to EVERY app read —
    // single-row Tx reads included (readUnfiltered is the only unfiltered read).
    if (this.#denied.has(denyKey(store, k))) return undefined;
    const value = (await rawStore(this.#tx, store).get(k)) as Row<K> | undefined;
    if (value === undefined) return undefined;
    const seam =
      this.#transform && (store === 'tasks' || store === 'lists') ? rowCryptoSeam() : null;
    if (seam === null) return value;
    const read = await seam.readRow(store as 'tasks' | 'lists', value);
    if (!read.ok) throw new SeamFailure(read.error);
    if (read.value === undefined) {
      this.#owner.addQuarantine({
        store,
        key: k,
        record: value,
        issues: ['decrypt failed under the current key — quarantined (ADR-007 Decision 9)'],
      });
      return undefined;
    }
    return read.value as Row<K>;
  }

  async getAll<K extends StoreName>(store: K, spec?: QuerySpec): Promise<Row<K>[]> {
    const src: RawSource =
      spec?.index === undefined
        ? rawStore(this.#tx, store)
        : rawStore(this.#tx, store).index(spec.index);
    const rows = (await collect(src, spec)) as Row<K>[];
    const alive = rows.filter((r) => !this.#denied.has(denyKey(store, rowKey(store, r))));
    const seam =
      this.#transform && (store === 'tasks' || store === 'lists') ? rowCryptoSeam() : null;
    if (seam === null) return alive;
    const out: Row<K>[] = [];
    for (const row of alive) {
      const read = await seam.readRow(store as 'tasks' | 'lists', row);
      if (!read.ok) throw new SeamFailure(read.error);
      if (read.value === undefined) {
        this.#owner.addQuarantine({
          store,
          key: rowKey(store, row),
          record: row,
          issues: ['decrypt failed under the current key — quarantined (ADR-007 Decision 9)'],
        });
        continue;
      }
      out.push(read.value as Row<K>);
    }
    return out;
  }

  async put<K extends StoreName>(store: K, row: Row<K>): Promise<void> {
    let toWrite: Row<K> = row;
    const seam =
      this.#transform && (store === 'tasks' || store === 'lists') ? rowCryptoSeam() : null;
    if (seam !== null) {
      const sealed = await seam.writeRow(store as 'tasks' | 'lists', row);
      if (!sealed.ok) throw new SeamFailure(sealed.error);
      toWrite = sealed.value as Row<K>;
    }
    if (store === 'meta') {
      await rawStore(this.#tx, store).put(toWrite, META_KEY);
    } else {
      await rawStore(this.#tx, store).put(toWrite);
    }
  }

  async delete(store: StoreName, key: string): Promise<void> {
    await rawStore(this.#tx, store).delete(store === 'meta' ? META_KEY : key);
  }
}

/**
 * Seam failures surface through the transaction's `catch` → `classifyUnknown`.
 * Wrapping keeps the typed StorageError intact (a locked write refuses as
 * `BLOCKED`, never a silent plaintext store — ADR-007 Decision 4).
 */
class SeamFailure extends Error {
  readonly storageError: StorageError;
  constructor(e: StorageError) {
    super(`row seam refused: ${e.code}`);
    this.storageError = e;
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
export async function openRawAppDB(
  options: OpenOptions = {},
): Promise<Result<RawDB, StorageError>> {
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
    upgrade(db, _oldVersion, _newVersion, versionTx) {
      for (const def of STORE_DEFS) {
        const created = !db.objectStoreNames.contains(def.name);
        const store = created
          ? def.keyPath === null
            ? db.createObjectStore(def.name)
            : db.createObjectStore(def.name, { keyPath: def.keyPath })
          : versionTx.objectStore(def.name);
        for (const idx of def.indexes) {
          // Indexes are additive too: a version bump may add an index to an
          // EXISTING store — an already-present name is skipped, a missing one
          // is created (the old `continue` above the index loop silently
          // dropped such additions).
          if (!created && store.indexNames.contains(idx.name)) continue;
          store.createIndex(idx.name, idx.keyPath, {
            unique: idx.unique ?? false,
            multiEntry: idx.multiEntry ?? false,
          });
        }
      }
    },
    blocked() {
      resolveBlocked(blocked(`database "${name}" is held open by another tab at an older version`));
    },
  });

  const raced = await Promise.race([
    openPromise.then((db): { db: RawDB } | { blocked: StorageError } => ({
      db: db as unknown as RawDB,
    })),
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
export async function openForTests(
  options: OpenOptions = {},
): Promise<Result<AppDBImpl, StorageError>> {
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
  return ok(
    new AppDBImpl(
      opened.value,
      {
        schemaVersion: APP_SCHEMA_VERSION,
        deviceId: '0'.repeat(26),
        createdAt: 0,
        lastOpenedAt: 0,
      },
      report,
    ),
  );
}
