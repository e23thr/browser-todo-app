/**
 * Public storage-framework surface (ADR-002). Downstream cards (domain repos,
 * data-safety/export-import) import from HERE — never from `idb`, never from
 * raw `IDBDatabase`.
 */

export type {
  List,
  Meta,
  Priority,
  Recurrence,
  Row,
  RowMap,
  Settings,
  Snapshot,
  SnapshotKind,
  SnapshotPayload,
  SnapshotReason,
  StoreName,
  StoreRows,
  Task,
  TaskStatus,
} from './types';
export { DATA_STORES, STORE_NAMES } from './types';

export type { Result, StorageError } from './errors';
export { classifyUnknown, err, ok } from './errors';

export { ULID_RE, isUlid, newUlid } from './id';

export {
  ORDER_KEY_ALPHABET,
  ORDER_KEY_MAX,
  OrderKeyError,
  isCanonicalOrderKey,
  orderKeyAfter,
  orderKeyBefore,
  orderKeyBetween,
  orderKeyFirst,
} from './orderKey';

export {
  APP_SCHEMA_VERSION,
  DB_NAME,
  IDB_VERSION,
  META_KEY,
  SETTINGS_KEY,
  STORE_DEFS,
} from './schema';

export type {
  AppDB,
  BootReport,
  OpenOptions,
  QuerySpec,
  Tx,
} from './db';
export { AppDBImpl, openRawAppDB } from './db';

export type { MigrationRegistry, MigrationStep, MigrateOutcome, MigrateRowsOutcome, RunMigrationsOptions } from './migrations';
export { MemoryTx, migrateRows, productionMigrations, runMigrations, targetVersionOf } from './migrations';

export type { QuarantineApi, QuarantineEntry, RecoveryFile } from './quarantine';
export { buildRecoveryFile, runBootValidation } from './quarantine';

export type { SnapshotCodec, SnapshotSource, TakeSnapshotOptions } from './snapshots';
export {
  AUTO_RETENTION,
  deleteSnapshot,
  fallbackRawCodec,
  getSnapshotPayload,
  listSnapshots,
  readSnapshotSource,
  restoreSnapshot,
  takeSnapshot,
} from './snapshots';

export { PURGE_INTERVAL_MS, TOMBSTONE_TTL_MS, purgeTombstones } from './purge';

export type { ValidationResult } from './validate';
export {
  isLocalDateString,
  validateList,
  validateMeta,
  validateRow,
  validateSettings,
  validateSnapshot,
  validateSnapshotPayload,
  validateTask,
} from './validate';

export type { BootOptions } from './boot';
export { boot, resetBootSingleton } from './boot';
