# Storage framework API summary (handoff from t_eba4b531)

Implementation of **ADR-002** (`docs/adr/ADR-002-storage-schema.md`, BINDING). Public surface:
`src/storage/index.ts`. **Import from `src/storage` (or `src/storage/<module>`) — never from `idb`,
never from raw `IDBDatabase`.** Tooling: `idb` is the only runtime dep (contained in `db.ts`).

Modules: `types` (ADR-002 §3 records) · `errors` (Result + StorageError) · `id` (ULID) ·
`orderKey` (base-36 fractional keys) · `validate` (validators) · `schema` (store/index inventory) ·
`db` (AppDB wrapper) · `migrations` (schemaVersion chain) · `snapshots` (snapshot mechanics + codec
hook) · `quarantine` (boot validation + recovery file) · `purge` (tombstone purge) · `boot`
(Decision 8 sequence).

## Error contract (normative, ADR-002 §10.4)

```ts
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
// EVERY public entry point returns Promise<Result<T, StorageError>>. Nothing throws
// across the boundary. Internal programmer errors (non-canonical order key, bad
// QuerySpec) throw at their module seam and are test-enforced.

type StorageError =
  | { code: 'UNAVAILABLE'; cause?: unknown }      // no IDB / private mode
  | { code: 'BLOCKED'; message: string }          // other tab holds older version open
  | { code: 'QUOTA_EXCEEDED'; cause?: unknown }   // §5.5 dialog: export/cleanup, NEVER silent
  | { code: 'INVALID_RECORD'; store: StoreName; id?: string; issues: string[] }
  | { code: 'NOT_FOUND'; store: StoreName; key: string }
  | { code: 'MIGRATION_FAILED'; from: number; to: number; cause?: unknown }
  | { code: 'NEWER_SCHEMA'; found: number; supported: number }
  | { code: 'TX_ABORTED'; cause?: unknown }
  | { code: 'UNKNOWN'; cause?: unknown };
```

`classifyUnknown(e)` maps DOMExceptions (`QuotaExceededError` name or legacy code 22 →
`QUOTA_EXCEEDED`, `AbortError` → `TX_ABORTED`, `SecurityError`/`InvalidStateError` → `UNAVAILABLE`,
`VersionError` → `NEWER_SCHEMA`, `ConstraintError`/`DataError`/`DataCloneError` → `INVALID_RECORD`)
and preserves the cause. **No caller may swallow `QUOTA_EXCEEDED`** — the §5.5 blocking
export/cleanup dialog hangs off it.

## Wrapper (`db.ts`) — Decision 10 surface, exactly as the ADR

```ts
type QuerySpec = {
  index?: string;
  range?: { eq?: IDBValidKey } | { lower?: IDBValidKey; lowerOpen?: boolean;
                                  upper?: IDBValidKey; upperOpen?: boolean };
  direction?: 'next' | 'prev';   // default 'next'
  limit?: number;                // applied at the cursor, not post-filter
};

interface Tx {   // narrow view for tx() callbacks and migration steps
  get<K extends StoreName>(store: K, key: string): Promise<Row<K> | undefined>;
  getAll<K extends StoreName>(store: K, spec?: QuerySpec): Promise<Row<K>[]>;
  put<K extends StoreName>(store: K, row: Row<K>): Promise<void>;
  delete(store: StoreName, key: string): Promise<void>;
}

interface AppDB {
  readonly deviceId: string;              // meta.deviceId (ULID, stable per profile)
  readonly schemaVersion: number;
  readonly bootReport: BootReport;        // see below
  readonly quarantine: QuarantineApi;     // see below

  tx<T>(stores: StoreName[], mode: 'readonly' | 'readwrite',
        fn: (t: Tx) => Promise<Result<T, StorageError>>): Promise<Result<T, StorageError>>;
  get<K>(store: K, key: string): Promise<Result<Row<K> | undefined, StorageError>>;
  getAll<K>(store: K, spec?: QuerySpec): Promise<Result<Row<K>[], StorageError>>;
  put<K>(store: K, row: Row<K>): Promise<Result<void, StorageError>>;   // RAW upsert
  query<K>(store: K, spec: QuerySpec): Promise<Result<Row<K>[], StorageError>>;
  delete(store: StoreName, key: string): Promise<Result<void, StorageError>>; // HARD delete
  close(): void;
}

boot(options?): Promise<Result<AppDB, StorageError>>   // Decision 8 sequence, singleton per DB
```

Semantics that matter to callers:

- `tx`: `fn` resolving `ok` commits; `fn` resolving `err` **or throwing** aborts the IDB
  transaction and `tx` resolves the inner error (or classified `TX_ABORTED`). Multi-record
  atomicity == one `tx` call. Migration steps run this way, with `meta.schemaVersion` bumped
  INSIDE the same transaction.
- `get` absence is `ok(undefined)` — NOT an error. `NOT_FOUND` exists for repo-level
  "must exist" paths.
- `put` is **RAW**: no stamping, no semantic validation (only primary-key present + well-formed;
  `meta`/`settings` use their fixed keys). Stamping (`updatedAt`, `deviceId`, `createdAt`,
  `completedAt`, `deletedAt`) is the **repo layer's** job (ADR-002 Decision 5) — E2 owns it.
- `delete` is hard. App-level deletes are `deletedAt` tombstones via repos.
- Read filtering: `get/getAll/query` and `Tx.get/getAll` exclude quarantine-denylisted rows
  (invalid rows are invisible to app reads). `AppDBImpl.readUnfiltered(store)` is the ONLY
  unfiltered read — reserved for snapshot/backup paths so backups never lose rows.
- `NEWER_SCHEMA` state (meta ahead of the build): reads work, every write returns the typed
  error (`bootReport.newerSchema` is set). Never mutates newer data.

## Boot sequence (`boot.ts`) — Decision 8 normative order

open (structural, additive `onupgradeneeded`) → read/seed `meta` (fresh ULID `deviceId`) →
if `meta.schemaVersion < target`: **pre-migration snapshot → migration steps** → boot validation
(quarantine) → `meta.lastOpenedAt` bump → throttled tombstone purge.

```ts
type BootReport = {
  schemaVersion: number;
  migrated: { from: number; to: number } | null;
  preMigrationSnapshotId: string | null;
  quarantined: number;
  purgedTombstones: number;
  newerSchema: { found: number; supported: number } | null;
  bootWarnings: { step: string; error: StorageError }[];  // step-5 bookkeeping failures
};
```

Failure semantics: migration failure → `boot()` resolves `err(MIGRATION_FAILED)` **after rolling
back** (DB restored from the pre-migration snapshot, connection closed). Step-5 failures
(lastOpenedAt/purge) are non-fatal but recorded in `bootWarnings` (never silent). Meta read/seed
failures are **classified** (`classifyUnknown`): a first-run `QuotaExceededError` surfaces as
`QUOTA_EXCEEDED` (the §5.5 dialog hangs off it), never as `UNKNOWN`. A corrupt
`meta.schemaVersion` (not an integer ≥ 1) is **not a version**: no migration chain runs, no
pre-migration snapshot is taken, `bootReport.migrated` stays `null`, the NEWER_SCHEMA comparison
is skipped, and the row is quarantined by step 4 like any invalid record (heal via snapshot
restore/import — the in-memory `schemaVersion` falls back to the build target).

## Migration chain (`migrations.ts`) — Decision 8

```ts
type MigrationStep = {
  to: number;                 // version this step upgrades TO
  stores: StoreName[];        // stores the step's one atomic readwrite tx covers ('meta' added automatically)
  run: (t: Tx) => Promise<Result<void, StorageError>> | Result<void, StorageError>;
};
type MigrationRegistry = readonly MigrationStep[];
const productionMigrations: MigrationRegistry = [];   // empty at schemaVersion 1 — future steps append

runMigrations(db, { registry, codec?, now? }): Promise<Result<MigrateOutcome, StorageError>>
// MigrateOutcome = { from, to, preMigrationSnapshotId }
// forward-only; exactly one contiguous step per version; snapshot FIRST (snapshot failure
// aborts with data untouched); mid-chain step failure → restoreSnapshot(rollback) →
// err MIGRATION_FAILED; meta.schemaVersion > target → NEWER_SCHEMA write guard.

migrateRows(registry, rows: StoreRows, from, to): Promise<Result<MigrateRowsOutcome, StorageError>>
// E3 HOOK: upgrades export/snapshot ROWS (not files) through the SAME registry in memory
// (MemoryTx implements Tx). "Old exports upgrade through the chain" = serialize file ⇄
// StoreRows (ADR-004 format is yours), then migrateRows.
```

## Snapshots (`snapshots.ts`) — Decision 9 + ADR-004 format hook

```ts
type SnapshotSource = { schemaVersion: number; stores: StoreRows };  // StoreRows = per-store row arrays
type SnapshotCodec = {
  readonly name: string;
  serialize(source: SnapshotSource): string;
  deserialize(payload: string): Result<SnapshotSource, StorageError>;
};
// E3 HOOK: plug ADR-004's serializer here (boot({ codec }) / takeSnapshot({ codec }) /
// restoreSnapshot(db, id, codec)). `fallbackRawCodec` is a FRAMEWORK PLACEHOLDER so
// migration rollback is self-contained — it is NOT the export file format (ADR-004 owns that).

takeSnapshot(db, { kind: 'auto' | 'manual', reason, codec?, now? }): Promise<Result<Snapshot, StorageError>>
// serialize → put payload → put metadata → prune retention in ONE readwrite tx.
// Retention: rolling last-3 'auto' + all 'manual' (AUTO_RETENTION = 3).
listSnapshots(db) / getSnapshotPayload(db, id) / deleteSnapshot(db, id)
restoreSnapshot(db, id, codec?): Promise<Result<void, StorageError>>
// Replace lists/tasks/settings + reset meta.schemaVersion to the payload's, ONE tx.
// meta.deviceId is never restored (device identity stays with the profile).
// Migration rollback and E3's "restore snapshot" both ride this.
readSnapshotSource(db): unfiltered payload source (backup path — quarantine-safe)
```

## Quarantine (`quarantine.ts`) — Decision 8 step 4 / §5.4 / E4

```ts
type QuarantineEntry = { store: StoreName; key: string; record: unknown; issues: string[] };
type QuarantineApi = {
  list(): QuarantineEntry[];                       // invalid rows excluded from app reads
  recoveryFile(): { filename: string; json: string }; // downloadable recovery JSON
  purge(): Promise<Result<number, StorageError>>;  // explicit user action ONLY; never the singletons
};
runBootValidation(db): Promise<Result<QuarantineEntry[], StorageError>>  // also E3's import pre-check shape
```

Non-destructive contract: invalid rows are **never deleted** by the framework — they stay in the
DB (visible via `readUnfiltered`), hidden from app reads, exported verbatim in the recovery file,
and hard-deleted only by `quarantine.purge()`. **Purge never destroys the `meta`/`settings`
singletons**: a quarantined `meta` carries the device identity and deleting it would silently
re-seed a NEW `deviceId` on the next boot (ADR-002 Decision 3.1) — so singleton entries are
skipped by `purge()` and stay in the DB **and** in the recovery file (downloadable). They are
healed by snapshot restore/import, never by purge; `purge()` returns the count of rows actually
hard-deleted. A mid-pass delete failure keeps the remaining rows quarantined (state stays
truthful) and propagates the typed error.

Recovery file (binding): `recoveryFile()` emits **ADR-004 Decision 7.1's** recovery document —
one format, one writer: `serializeRecoveryDoc(entries, source, meta)` in
`src/portability/recovery-document.ts` (ADR-004 contract 5, the only implementation);
`quarantine.ts`'s same-named export is a thin delegate to it, so boot-validation quarantine and
E3's import quarantine emit byte-identical documents:

```json
{
  "format": "local-first-todo-recovery",
  "formatVersion": 1,
  "schemaVersion": 1,
  "createdAt": 1792755100000,
  "deviceId": "01J8Q4M6ZK7YV3N2R5T8W1X9AB",
  "source": { "kind": "boot-validation", "fileName": null, "fileSchemaVersion": 1 },
  "entries": [{ "store": "tasks", "id": "01J8Q6P8BN9AX5Q4T7V0Z3A1CD", "issues": ["title: ..."], "raw": { "...": "the DB row exactly as read" } }]
}
```

`entries[].id` is the record's `id` when present and parseable (a ULID), else `null`. The
`local-first-todo-recovery` format token marks the file as deliberately **not importable**
(`NOT_A_BACKUP` on attempt). Filename `local-first-todo-recovery-YYYY-MM-DDTHHmmssZ.json`
(ADR-004 Decision 9 timestamp convention).

## Validation (`validate.ts`) — Decision 11 (boot + import share it)

`validateRow(store, value): { ok: true } | { ok: false; issues: string[] }` plus per-type
validators. Strict: unknown fields are issues; `__proto__`/`constructor`/`prototype` keys are
forbidden (prototype-pollution defense for E8); real-calendar `YYYY-MM-DD`; string caps
(name 200 / title 1000 / notes 20k / tag 64 × 50); ULID + canonical order-key format checks.

## Tombstone purge (`purge.ts`) — Decision 6

`purgeTombstones(db, { now, mode: 'auto' | 'explicit' })` → `Result<number, StorageError>`.
Auto: `deletedAt < now - 90d`, throttled via `meta.lastPurgeAt` (≥24h apart); Explicit: all
tombstones, any age ("Clean up storage"). Boot runs the auto pass. The whole pass is **one
readwrite transaction** (`lists`+`tasks`, plus `meta` for the auto throttle stamp): deletions and
stamp commit or roll back together, so a stamp failure (quota) purges nothing and the returned
count is always truthful (ADR-002 Decision 6 amended 2026-10-23, QA defect D6).

## Pure helpers (E2 domain builds on these)

- `newUlid(now?)` / `isUlid(v)` — ULID, monotonic per ms (id.ts).
- `orderKeyFirst() === 'h'`, `orderKeyBetween(a, b)`, `orderKeyAfter(a)`, `orderKeyBefore(b)`,
  `isCanonicalOrderKey(k)` — canonical base-36 fractional keys, 32-char cap, ordinal compare,
  tie-break by id (orderKey.ts). `OrderKeyError.code === 'EXHAUSTED'` is the rebalance hatch.
- `TOMBSTONE_TTL_MS`, `PURGE_INTERVAL_MS` (purge.ts); `STORE_DEFS`, `DB_NAME`, `IDB_VERSION`,
  `APP_SCHEMA_VERSION`, `META_KEY`, `SETTINGS_KEY` (schema.ts).

## Test evidence (t_eba4b531)

`tests/unit/storage/` — 87 tests, all green (`npx vitest run tests/unit/storage`). Coverage on
`src/storage/**` (v8, per-file gate ≥80 lines/branches/functions/statements passes):
db.ts 88.95/89.47, migrations.ts 96.15/84.14, snapshots.ts 90.36/82.45, boot.ts 90.66/83.72,
quarantine.ts 94.11/80.0, validate.ts 96.95/95.52, orderKey.ts 94.44/95.0, id.ts 90.56/84.61,
purge.ts 91.42/86.36 (statements/branches). Acceptance drills covered explicitly:
v1→v2 migration roundtrip (boot + registry level), mid-chain interruption rollback via
pre-migration snapshot (byte-equivalent restore), corrupt-record quarantine producing a loadable
recovery file (never crash, never silent drop), QuotaExceededError propagation (put/tx/snapshot/
purge/boot surfaces, fault-injected `IDBObjectStore.put`).

## Test evidence (t_dbe04ac6, QA corruption-drill fixes D1–D6)

`tests/unit/storage/` — 114 tests, all green. The contract-deviation probes
(docs/qa/e1-storage-logs/probe-contract-deviations.txt P1–P4) are pinned as green regression
drills in `tests/unit/storage/drills-qa.test.ts`: Tx.get denylist end-to-end (D1), purge +
reboot with a quarantined `meta` keeping `deviceId` (D2), boot meta read/seed quota classified
`QUOTA_EXCEEDED` (D3), corrupt `meta.schemaVersion` yielding `migrated: null` with no spurious
snapshot on every boot (D4). Plus: `purgeTombstones` atomic-pass rollback (D6) in
`purge.test.ts`, and fixture meta read-and-keep + raw-read rollback assertion (D5) in
`tests/unit/storage/fixtures.ts` / `boot.test.ts`.
