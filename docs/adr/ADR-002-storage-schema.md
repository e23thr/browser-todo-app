# ADR-002: Storage schema & IndexedDB wrapper design

**Status**: Accepted
**Date**: 2026-10-23
**Author**: h_senior_coder (sole decider per task t_576c2376 — single-decider rule)
**Scope**: Local-First Todo Web App (GitHub Pages static PWA). Epic E1 Infrastructure & DevOps.
**Refs**: PROJECT_ANALYSIS.md §5.1–5.5 (storage), §6.2 (sync/conflict policy), §7.1–7.2
(security/dependency policy), M10/M11/M12, S11.

---

## Context

The app is browser-only, offline-first, with no server (DECIDED constraints 1–5). All app data
lives in the browser origin. PROJECT_ANALYSIS §5.2 selects IndexedDB as the PRIMARY store and
localStorage for boot-critical prefs only; §5.3 sketches the records; §5.4 requires a
`schemaVersion` migration chain with pre-migration snapshots; §6.2 pre-decides the sync conflict
policy (LWW + tombstones + conflict copies) that the schema must be able to serve later.

This ADR is the single source of truth for:

1. The exact IndexedDB stores, key paths, and indexes.
2. The id scheme, order-key format, tombstone model, timestamp/timezone conventions.
3. The thin typed wrapper API (`open` / `tx` / `get` / `put` / `query` / `delete`) and its error
   contract.
4. The contracts downstream impl/test cards must build against: localStorage scope, the
   migration chain, snapshot storage, and validation.

Binding constraints honored verbatim (recorded, not re-litigated): per-record last-write-wins
keyed on `(updatedAt, deviceId)`; deletions propagate via tombstones (`deletedAt` soft-delete);
unmergeable conflicts materialize as visible "Conflict copy of <task>" rows (§6.2). Tags stay
denormalized `string[]` on tasks for MVP (rename = one transaction sweep).

---

## Decision summary (the short version)

| Question | Decision |
|---|---|
| Primary store | IndexedDB, via `idb` (the only storage dependency) wrapped in our own typed `AppDB` module |
| DB name / versions | `local-first-todo`; two version layers: native IDB version (structure) + `meta.schemaVersion` (data) |
| Stores (7) | `meta`, `lists`, `tasks`, `settings`, `snapshots`, `snapshot_payloads`, (+ `tags` NOT in v1) |
| Id format | **ULID** (26-char uppercase Crockford base32, monotonic within ms), generated client-side |
| Order keys | **base-36 fractional rank strings** per sibling group, ordinal string comparison |
| Deletion | soft-delete `deletedAt: number | null`; hard purge of tombstones > 90 days or on explicit "Clean up" |
| Timestamps | `createdAt/updatedAt/completedAt/deletedAt/takenAt/reminderAt` = epoch ms UTC number; `dueDate` = local-date string `YYYY-MM-DD`; `deviceId` on every sync-relevant record |
| Snapshot payloads | in the same IDB, store `snapshot_payloads` (JSON string, `payloadRef` = snapshot id). OPFS stays reserved (§5.2.3) |
| Error contract | every wrapper call returns `Promise<Result<T, StorageError>>`; typed error codes; no thrown errors across the API surface |
| localStorage | boot-critical prefs ONLY (theme, dismissed banners, onboarding step) under `todo:prefs:v1:*`; never task data |
| Migrations | forward-only, one atomic IDB transaction per step, automatic snapshot before any migration |

---

## Decision 1 — Storage technology and wrapper dependency

**IndexedDB is the sole primary store** (§5.2). The wrapper dependency is **`idb`** (Jake
Archibald; ~1.5 KB min+gz; Apache-2.0), used strictly as the low-level promise wrapper over the
raw IDB API. All app code talks to **our** typed module (`src/storage/db.ts`), never to `idb`
directly and never to raw `IDBDatabase`, so `idb` is replaceable without touching call sites.

Rationale: `idb` satisfies §7.2 (minimal dependencies, tiny, long-lived, permissive license,
bundled output). Writing our own promise layer is more code and more test surface for zero gain.
`idb` is the boring choice.

Not chosen: raw IDB (verbose, error-prone callbacks — we would immediately re-wrap it);
Dexie (rich query layer we do not need, much larger); WASM-SQLite over OPFS (already rejected
in §5.1: bundle budget, sync-handle quirks).

**Bundle impact**: +~1.5 KB gzipped. Within budget.

---

## Decision 2 — Database identity and versioning layers

- Database name: `local-first-todo`.
- **Two version layers, deliberately**:
  - **Native IDB version** (the `indexedDB.open` version parameter) governs *structure* only —
    creating stores and indexes. Structural changes run inside `onupgradeneeded`, which is one
    atomic `versionchange` transaction. Current: **idbVersion 1**.
  - **`meta.schemaVersion`** governs *data/logical* shape — field semantics, record migrations,
    export format. Current: **schemaVersion 1**. Runs as one atomic `readwrite` transaction per
    step (Decision 8).
- Mapping (kept in sync; both bump together until a reason to diverge appears):

  | idbVersion | schemaVersion | Change |
  |---|---|---|
  | 1 | 1 | Initial schema (this ADR) |

- **Forward-only.** There are no down-migrations. If a build encounters a `meta.schemaVersion`
  newer than it supports, it refuses all writes with `StorageError.NewerSchema` and tells the
  user to update the app (see §"Boot contract"). Old data opened by new code is upgraded via the
  chain; new data opened by old code is never mutated.

---

## Decision 3 — Stores, key paths, indexes

Six object stores in idbVersion 1 (plus the reserved name `tags`, see 3.7). All use **in-line key paths** (`id`) except `meta`, which is
a singleton under an out-of-line key. All keys are strings (ULIDs, except `meta` = `'meta'`).

### 3.1 `meta` — singleton app record

- Key: out-of-line, always `'meta'`. Exactly one record.

```ts
type Meta = {
  schemaVersion: number;   // integer; logical data version (Decision 2)
  deviceId: string;        // ULID; generated once per browser profile (LWW tie-breaker)
  createdAt: number;       // epoch ms UTC
  lastOpenedAt: number;    // epoch ms UTC; bumped on every boot
  lastPurgeAt?: number;    // epoch ms UTC; tombstone purge throttle (Decision 6)
};
```

No indexes. `deviceId` is generated (ULID) on first boot and never regenerated; it stamps every
sync-relevant record (Decision 5).

### 3.2 `lists` — user lists

- Key path: `'id'` (ULID).

```ts
type List = {
  id: string;              // ULID
  name: string;            // 1..200 chars after trim
  color: string;           // '#rrggbb' (validated) or a theme token id; UI decides rendering
  sortOrder: string;       // order key (Decision 4), ordered among lists
  createdAt: number;       // epoch ms UTC
  updatedAt: number;       // epoch ms UTC
  deletedAt: number | null;// tombstone (Decision 6); null = live
  deviceId: string;        // ULID (Decision 5)
};
```

Indexes: **`by_updatedAt`** (`keyPath: 'updatedAt'`) — change-manifest / sync sweep / export
diffing. Filtering live-vs-tombstoned lists is done in memory: lists are bounded (tens), and a
`deletedAt` index cannot express "is null" cleanly.

### 3.3 `tasks` — the core store

- Key path: `'id'` (ULID).

```ts
type TaskStatus = 'open' | 'done' | 'archived';
type Priority = 0 | 1 | 2;              // 0 = low (default), 1 = medium, 2 = high (M1 high/med/low)

type Recurrence = {                     // RRULE-lite subset (S4 owns semantics)
  freq: 'daily' | 'weekly' | 'monthly' | 'weekdays';
  interval: number;                     // integer >= 1
  until?: string;                       // 'YYYY-MM-DD' (optional)
  count?: number;                       // optional
};

type Task = {
  id: string;               // ULID
  listId: string;           // FK -> List.id (unenforced at IDB level; enforced by repos)
  title: string;            // 1..1000 chars after trim
  notes: string | null;     // plain text (markdown only with sanitization, C9); <= 20k chars
  status: TaskStatus;
  priority: Priority;
  dueDate?: string;         // 'YYYY-MM-DD' local-date string (Decision 5)
  reminderAt?: number;      // epoch ms UTC (S5)
  recurrence?: Recurrence;  // S4
  tags: string[];           // denormalized; MVP has no tags store (see 3.7)
  parentTaskId?: string;    // ULID of parent Task; subtasks one level deep in V1 (S2)
  sortOrder: string;        // order key (Decision 4)
  createdAt: number;        // epoch ms UTC
  updatedAt: number;        // epoch ms UTC
  completedAt?: number;     // epoch ms UTC; set when status -> 'done', cleared on uncomplete
  deletedAt: number | null; // tombstone (Decision 6)
  deviceId: string;         // ULID (Decision 5)
};
```

Indexes (the four mandated plus two additive refinements):

| Index | keyPath | Purpose |
|---|---|---|
| `by_listId` | `'listId'` | per-list views, list delete disposition |
| `by_status` | `'status'` | "All open", Completed, Archive views (M3) |
| `by_dueDate` | `'dueDate'` | Today / Next 7 days (M3). Auto-sparse: tasks without `dueDate` are absent |
| `by_updatedAt` | `'updatedAt'` | change manifest, sync sweep, "recently modified" |
| `by_list_sort` | `['listId', 'sortOrder']` | ordered per-list retrieval without an in-memory resort |
| `by_parent` | `'parentTaskId'` | subtask queries (S2, V1). Auto-sparse: top-level tasks absent |

Live-vs-tombstoned filtering is in memory at the repo layer (Decision 6 keeps tombstone count
bounded by purge). `tags`, `title`, `notes` are never indexed — search (M5) is a bounded
in-memory scan, per §5.1 ("revisit SQL only at 100k+ tasks").

### 3.4 `settings` — singleton user settings

- Key path: `'id'`; the single record has `id: 'settings'`.

```ts
type Settings = {
  id: 'settings';
  theme: 'light' | 'dark' | 'system';
  locale: string;                // 'en' | 'th' at MVP (Q9); open string for C5
  weekStart: 0 | 1;              // 0 = Sunday, 1 = Monday (matches Date#getDay)
  defaultListId: string | null;  // FK -> List.id
  notificationsEnabled: boolean;
  lastBackupAt: number | null;   // epoch ms UTC (S11 backup nudge at 14 days)
};
```

No indexes. Theme duplication rule: `settings.theme` is the durable source of truth;
localStorage mirrors it synchronously purely for pre-paint boot (Decision 7). If they disagree at
boot, `settings` wins and the mirror is rewritten.

### 3.5 `snapshots` — snapshot metadata

- Key path: `'id'` (ULID).

```ts
type Snapshot = {
  id: string;                 // ULID; ALSO the payloadRef
  takenAt: number;            // epoch ms UTC
  kind: 'auto' | 'manual';
  reason: 'scheduled' | 'pre-migration' | 'pre-import' | 'manual'; // refinement of kind
  sizeBytes: number;          // byte length of the serialized payload
  schemaVersion: number;      // logical version of the payload (required to restore safely)
  payloadRef: string;         // -> snapshot_payloads.id (== this.id by convention)
};
```

Index: **`by_takenAt`** (`keyPath: 'takenAt'`) — retention pruning (Decision 9).

### 3.6 `snapshot_payloads` — the payload bodies

- Key path: `'id'`; `id` == the owning `Snapshot.id`.

```ts
type SnapshotPayload = {
  id: string;
  payload: string;   // JSON string — byte-identical to the M11 export file format
};
```

No indexes. **Payloads live here, in this same IndexedDB database** (§5.2.3: "MVP keeps
auto-snapshot blobs in IndexedDB (simpler), migrate to OPFS only if snapshot volume demands").
OPFS stays reserved; no OPFS code in MVP. `payloadRef` is a plain string so the payload location
can move to OPFS in a later schema version without rewriting snapshot metadata.

The payload is the **same serializer as the M11 export file** (schema-versioned JSON). One
serializer module is shared by export, snapshot, and import — three call sites, one format.

### 3.7 `tags` — explicitly NOT in schema v1

PROJECT_ANALYSIS §5.2/§5.3 mention a `tags` store (V1, normalized). The binding sketch for this
task keeps **tags denormalized as `string[]` on tasks for MVP** (rename = one transaction sweep —
fine at 10k tasks). Decision: **no `tags` store at idbVersion/schemaVersion 1**. Tag metadata
(color per tag) is a V1 concern and lands via the migration chain (additive store + backfill from
task rows). The store name `tags` is reserved; no code may use it until a migration creates it.

---

## Decision 4 — Id scheme and order-key format

### 4.1 Ids: ULID

All record ids are **ULIDs**: 26-char uppercase Crockford base32
(`^[0-9A-HJKMNP-TV-Z]{26}$`), 48-bit ms timestamp + 80-bit randomness, generated client-side in
`src/storage/id.ts` (self-contained ~40 lines — zero extra dependency, §7.2).

- **Monotonic within a millisecond**: same-ms generation increments the random component, so ids
  minted in one transaction sort in creation order. This matters for stable tie-break ordering
  and change manifests.
- **Sortable**: lexicographic string order == chronological order (Crockford alphabet is
  ASCII-ordered).
- **Collision-safe across devices** (80-bit random), so ids need no coordination in any future
  sync (§5.2 "zero rework").

*Alternative considered: UUIDv7.* See table below. ULID wins on compactness (26 vs 36 chars),
trivial self-implementation, and canonical monotonicity. Ids are opaque strings to every layer
except `id.ts`, so a later switch is a per-record migration, not a rewrite.

### 4.2 Order keys: base-36 fractional rank strings

`sortOrder` on `List` and `Task` is a **fractional index string** so drag-reorder is a
single-record write (§5.2), never a renumbering transaction.

**Format** (`src/storage/orderKey.ts`, pure and dependency-free):

- Alphabet: `0123456789abcdefghijklmnopqrstuvwxyz` (36 symbols, ASCII-ordered).
- A key is a non-empty string over the alphabet, **canonical form: does not end in `'0'`**,
  hard-capped at **32 characters**.
- **Comparison: plain ordinal string comparison** (JS `<` on strings). On canonical keys this
  equals numeric comparison of the base-36 fraction `0.d1d2…dn`. Ties (equal keys) are broken by
  record `id` — every ordering query sorts by `(sortOrder, id)`.
- **Ordering scope ("sibling group")**:
  - top-level tasks: within `listId` (i.e. `parentTaskId` absent);
  - subtasks: within `parentTaskId`;
  - lists: global (one group).
- **API**:
  ```ts
  orderKeyBetween(a: string | null, b: string | null): string
  // returns canonical key m with (a ?? -inf) < m < (b ?? +inf); throws OrderKeyError only on
  // invalid input (non-canonical a/b, a >= b) — programmer error, caught in review/tests
  orderKeyFirst(): string          // == orderKeyBetween(null, null) === 'h'
  orderKeyAfter(a: string): string // == orderKeyBetween(a, null)
  orderKeyBefore(b: string): string// == orderKeyBetween(null, b)
  ```
- **Semantics (the contract tests assert these)**:
  1. Strict bounds: `a < m < b` always (given `a < b`, nulls = ∓∞).
  2. Canonicity: result never ends in `'0'`; input keys are validated.
  3. Density within the cap: between any two canonical keys there is a midpoint ≤ 32 chars.
     Midpoints are chosen as near the arithmetic middle as digit alignment allows, so key length
     grows ~log₂ of the number of *adjacent* insertions — realistically 2–4 chars at 10k tasks.
  4. **Rebalance escape hatch**: if `orderKeyBetween` cannot find a midpoint within 32 chars
     (pathological adjacency), the repo rebalances the affected sibling group in ONE `readwrite`
     transaction (fresh keys evenly spaced). This is vanishingly rare and must be observable in
     the local error log.
- Seed: the first task in an empty group gets `'h'` (middle of the alphabet — headroom both ways).

*Alternative considered: integer ranks with gaps (e.g. step 1024 + renumber).* Simpler, but
worst-case renumbering transactions are exactly what §5.2 rules out, and gap exhaustion forces
global writes. Fractional keys are the stated direction and cost one small pure module.

---

## Decision 5 — Timestamps, timezones, deviceId

| Field(s) | Format | Rule |
|---|---|---|
| `createdAt`, `updatedAt`, `completedAt`, `deletedAt`, `takenAt`, `reminderAt`, `lastOpenedAt`, `lastBackupAt`, `lastPurgeAt` | `number` | **Epoch milliseconds, UTC** (safe integer, `Date.now()` source). Never `Date` objects in the DB |
| `dueDate` | `string` | **Plain local-date string `YYYY-MM-DD`** — no timezone, no conversion. It means "the user's calendar day", validated against a real calendar (rejects `2026-02-30`), compared lexicographically. NEVER converted to a `Date`/UTC instant for all-day semantics (§5.2) |
| `reminderAt` | `number` | Epoch ms UTC — unlike `dueDate`, a reminder is a real instant (S5) |
| `deviceId` | `string` (ULID) | On **every sync-relevant record** (`List`, `Task`) for LWW tie-breaks. Not needed on `meta`/`settings`/`snapshots`/`snapshot_payloads` (local-only, never synced) |

- All writes go through a repo layer that stamps `updatedAt = clock.now()` and
  `deviceId = meta.deviceId` on **every** mutation; `createdAt` on create; `completedAt` when
  `status` becomes `'done'` (and cleared on uncomplete); `deletedAt` on tombstoning. The low-level
  wrapper `put` does NOT stamp anything (see Decision 10) — stamping is one place, one rule.
- The clock is injectable (`() => number`) so tests control time.

**LWW rule (pre-decided in §6.2, recorded here as the schema's consumer contract):** for two
versions of one record, the winner is the one with the **greater `updatedAt`; if equal, the
greater `deviceId` (lexicographic)** — fully deterministic on both sides of any future sync.
Unmergeable conflicts materialize as a visible `"Conflict copy of <title>"` record (a normal Task
row, `title` prefixed, linked by no field — plain row) — never a silent overwrite.

---

## Decision 6 — Deletion model and tombstone purge

- **Soft delete**: `deletedAt: number | null` (epoch ms UTC). Every read path in the repo layer
  filters `deletedAt === null` unless explicitly asked for tombstones (export/sync/purge).
- **No silent cascade.** Deleting a list requires an explicit task disposition (M2): move tasks
  to a target list (rewrites `listId`, stamps `updatedAt`) or tombstone them — one transaction
  either way.
- **Purge policy** (hard delete of tombstoned rows):
  1. **Automatic**: tombstones with `deletedAt < now - 90 days` are purged. The pass runs at most
     **once per 24h** (throttled via `meta.lastPurgeAt`), cheaply, one `readwrite` transaction per
     store. 90 days comfortably covers the export/backup horizon.
  2. **Explicit**: the storage dashboard "Clean up storage" action (S11) purges **all** tombstones
     immediately (confirmed UI; the confirm copy states sync-import from exports older than the
     purge can resurrect deleted rows — accepted trade-off).
- Purge never touches live rows and never touches snapshots. Undo for MVP is the pre-import
  snapshot + export discipline (undo toast = S7, V1).

> **Amendment (2026-10-23, QA fix card t_dbe04ac6).** Two clarifications after the E1
> corruption-drill QA (docs/qa/e1-storage.md §5):
>
> 1. **Purge transaction shape (finding D6):** the automatic pass now stamps `meta.lastPurgeAt`
>    in the **same** `readwrite` transaction as the tombstone deletions (one transaction
>    covering `lists`, `tasks` and `meta`) rather than one transaction per store plus a second
>    stamp transaction. With the old shape a failed stamp (quota) surfaced `QUOTA_EXCEEDED`
>    while the deletions had already committed — boot reported `purgedTombstones: 0` although
>    rows were gone. Deletions and stamp now commit or roll back together; TTL (90d) and
>    throttle (24h) are unchanged.
> 2. **Singleton safety (finding D2, reinforces Decision 3.1):** explicit `quarantine.purge()`
>    never destroys the `meta`/`settings` singletons. A quarantined `meta` carries the device
>    identity; hard-deleting it made the next boot silently re-seed a NEW `deviceId` (identity
>    reset). Singleton entries stay quarantined and downloadable in the recovery file and are
>    healed via snapshot restore/import, never via purge.

---

## Decision 7 — localStorage contract (boot-critical prefs ONLY)

- localStorage is for **synchronous, pre-paint, boot-critical preferences ONLY** (§5.2.2: theme
  must apply before first paint; async boot = FOUC).
- Allowed keys, all namespaced `todo:prefs:v1:`:
  - `todo:prefs:v1:theme` — mirror of `settings.theme` (Decision 3.4);
  - `todo:prefs:v1:dismissedBanners` — JSON string array of banner ids;
  - `todo:prefs:v1:onboardingStep` — integer/string step marker.
- **Never** task/list/snapshot/settings-record data. Budget: total ≤ 4 KiB.
- Writes are fire-and-forget with a `try` guard (Safari private mode may throw — the app must
  survive without localStorage mirrors; IDB settings remain the source of truth).
- The theme value is read by a hashed inline boot snippet before first paint (CSP exception per
  §7.2). Everything else reads localStorage only during boot.

---

## Decision 8 — schemaVersion migration chain

- **Forward-only**: `v1 → v2 → …`, never down. A build that meets a newer `meta.schemaVersion`
  than it supports stops writes with `StorageError.NewerSchema` and surfaces "update the app".
- **One atomic IDB transaction per step.** Each migration step is a single `readwrite`
  transaction over exactly the stores it touches; the `meta.schemaVersion` bump for that step is
  written **inside the same transaction** — so a step is all-or-nothing and the version can never
  run ahead of its data.
- **Automatic snapshot before any migration.** If `meta.schemaVersion` < target at boot: take a
  snapshot (`kind: 'auto'`, `reason: 'pre-migration'`) FIRST, then run steps, then prune per
  Decision 9. Rollback = import the snapshot (§5.4).
- **Boot-time sequence** (normative order):
  1. Open the DB. Structural changes (new stores/indexes) happen in `onupgradeneeded` (atomic
     `versionchange` transaction). Structural upgrades are **purely additive** in every planned
     migration so no pre-snapshot can be invalidated by them.
  2. Read `meta`; on first boot seed it (`schemaVersion: 1`, fresh `deviceId` ULID).
  3. If `meta.schemaVersion` < app target → snapshot → run migration steps (one tx each).
  4. **Boot validation** (§5.4): schema-check every record against the validators (Decision 11).
     Invalid records are handled **non-destructively**: never crashed on, never silently dropped;
     they are excluded from app reads via an in-memory denylist, surfaced in the storage dashboard
     (S11) with a downloadable "recovery" JSON file, and purged only on explicit user action.
  5. `meta.lastOpenedAt = now`; run the throttled tombstone purge (Decision 6).
- **Export/import** (M11) shares the chain: exports carry `schemaVersion`; import upgrades old
  export formats through the same step registry before merging.
- Migration registry shape (implemented by the impl card):
  ```ts
  const migrations: Record<number, (t: Tx) => Promise<Result<void, StorageError>>>;
  // key = version this step upgrades TO; each runs in one atomic readwrite tx
  ```

---

## Decision 9 — Snapshots

- **Where payloads live**: `snapshot_payloads` store in the same IndexedDB DB (Decision 3.6).
  Not OPFS (reserved, §5.2.3), not Cache API (assets only), never localStorage.
- **Format**: JSON string, byte-identical to the M11 export file (shared serializer).
- **Retention**: rolling **last-3 `kind: 'auto'`** snapshots (covers `scheduled`,
  `pre-migration`, `pre-import`) + **all `kind: 'manual'`** until the user deletes them from the
  storage dashboard (S11). Pruning runs after each snapshot write, in the same transaction.
- Taking a snapshot is: serialize (shared exporter) → `put` payload → `put` metadata → prune.
  Snapshot failure must never block a migration or an import — it degrades to a loud warning and
  the operation proceeds only if the user (for import) or policy (for migration — abort the
  migration and stay on the old version, which is safe because migrations are forward-only)
  allows it. **Normative**: a migration whose pre-snapshot fails is **aborted** (no data touched);
  an import whose pre-snapshot fails proceeds only with explicit user confirmation.

---

## Decision 10 — Wrapper API surface (`src/storage/db.ts`)

### 10.1 Types

```ts
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

type StoreName = 'meta' | 'lists' | 'tasks' | 'settings' | 'snapshots' | 'snapshot_payloads';

type StorageError =
  | { code: 'UNAVAILABLE'; cause?: unknown }        // no IDB / private mode / storage blocked
  | { code: 'BLOCKED'; message: string }            // another tab holds an older version open
  | { code: 'QUOTA_EXCEEDED'; cause?: unknown }     // -> §5.5 blocking dialog (export/cleanup)
  | { code: 'INVALID_RECORD'; store: StoreName; id?: string; issues: string[] }
  | { code: 'NOT_FOUND'; store: StoreName; key: string }
  | { code: 'MIGRATION_FAILED'; from: number; to: number; cause?: unknown }
  | { code: 'NEWER_SCHEMA'; found: number; supported: number }
  | { code: 'TX_ABORTED'; cause?: unknown }         // explicit abort or inner failure
  | { code: 'UNKNOWN'; cause?: unknown };           // cause preserved for the local error log
```

### 10.2 The surface

```ts
type QuerySpec = {
  index?: string;                 // index name on that store (e.g. 'by_listId')
  range?: { eq?: IDBValidKey } | {
    lower?: IDBValidKey; lowerOpen?: boolean;
    upper?: IDBValidKey; upperOpen?: boolean;
  };
  direction?: 'next' | 'prev';    // default 'next'
  limit?: number;                 // default: unbounded (callers at 10k scale pass limits)
};

interface Tx {                    // narrow view handed to tx() callbacks
  get<K extends StoreName>(store: K, key: string): Promise<Row<K> | undefined>;
  getAll<K extends StoreName>(store: K, spec?: QuerySpec): Promise<Row<K>[]>;
  put<K extends StoreName>(store: K, row: Row<K>): Promise<void>;
  delete(store: StoreName, key: string): Promise<void>;
}

interface AppDB {
  readonly deviceId: string;
  readonly schemaVersion: number;

  tx<T>(stores: StoreName[], mode: 'readonly' | 'readwrite',
        fn: (t: Tx) => Promise<Result<T, StorageError>>): Promise<Result<T, StorageError>>;

  get<K extends StoreName>(store: K, key: string): Promise<Result<Row<K> | undefined, StorageError>>;
  getAll<K extends StoreName>(store: K, spec?: QuerySpec): Promise<Result<Row<K>[], StorageError>>;
  put<K extends StoreName>(store: K, row: Row<K>): Promise<Result<void, StorageError>>; // upsert
  query<K extends StoreName>(store: K, spec: QuerySpec): Promise<Result<Row<K>[], StorageError>>;
  delete(store: StoreName, key: string): Promise<Result<void, StorageError>>;           // HARD delete

  close(): void;
}

boot(): Promise<Result<AppDB, StorageError>>;   // open + migrate + validate + purge throttle
```

### 10.3 Semantics (normative)

| Op | Semantics |
|---|---|
| `boot()` | Full Decision 8 sequence. Idempotent per app instance (singleton). Resolves with a ready `AppDB` or a typed error. `BLOCKED` (another tab) resolves as an actionable error state, not a hang |
| `tx(stores, mode, fn)` | Opens one IDB transaction over `stores`. If `fn` resolves `ok`, the transaction commits; if `fn` resolves `err` **or throws**, the transaction aborts and `tx` resolves with `TX_ABORTED` (or the inner error). At least one store required; `readwrite` covers everything `fn` does — multi-record atomicity is exactly this call |
| `get` | Single-row lookup by primary key. `ok.value === undefined` when absent — absence is NOT an error; `NOT_FOUND` exists for repo-level "must exist" paths only |
| `getAll` / `query` | `getAll(store)` = full scan (with `spec`). `query(store, spec)` = index/range/direction/limit retrieval via `IDBKeyRange`; sorted by the index key then primary key; `limit` applied at the cursor (not post-filter). Both filter nothing — live-vs-tombstone filtering is the repo layer's job (Decision 6) |
| `put` | Upsert by primary key. **Raw**: no timestamp stamping, no validation beyond "primary key present and well-formed" (Decision 5 puts stamping in repos; Decision 11 puts semantic validation in validators). `put` never mutates `id` |
| `delete` | **Hard** delete of one row. Only used by: tombstone purge, "delete all data", import `replace` mode, quarantine purge. App-level deletes are `deletedAt` tombstones via repos |
| `close()` | Idempotent; used on teardown / before reload |

### 10.4 Error contract

- **Every public entry point returns `Promise<Result<T, StorageError>>`. Nothing throws across
  the boundary** (team baseline: Result types, no throwing in business logic). Internal
  programmer errors (invalid `QuerySpec`, non-canonical order key) throw at the module seam and
  are eliminated by tests/review — they never cross `db.ts`.
- `QuotaExceeded` maps to the §5.5 flow: blocking-but-non-destructive dialog offering export /
  cleanup; **never silently drop a write**.
- `UNAVAILABLE` (private mode / no IDB) maps to the honest "storage unavailable" state; the app
  never pretends writes succeeded.
- All error branches write a structured local error log entry (JSON, ring buffer, downloadable);
  **no telemetry** (§7.2).
- Repositories (`src/storage/repos/`) sit above `AppDB` and are where domain rules live:
  stamping (Decision 5), tombstoning (Decision 6), list-delete disposition, conflict-copy naming.
  They also return `Result`.

---

## Decision 11 — Validation (one module, two consumers)

`src/storage/validate.ts` holds hand-rolled validators (no zod — §7.2 minimal deps; the schemas
are small and stable) for `Meta`, `List`, `Task`, `Settings`, `Snapshot`, `SnapshotPayload`:
field presence, types, ranges (`priority ∈ {0,1,2}`, `status ∈ {open,done,archived}`), formats
(ULID regex, `YYYY-MM-DD` real-calendar check, `#rrggbb`, epoch-ms safe-integer checks, string
length caps per Decision 3).

Consumers:
1. **Boot validation** (Decision 8 step 4) — quarantine flow, non-destructive.
2. **Import validation** (§7.1 threat (d): "malicious import files — schema validation, size
   caps, never eval'd"): the import path validates every record through these same validators
   with size caps (import file ≤ 50 MiB, record counts sanity-capped) before anything touches
   the DB, and imports run under the pre-import snapshot rule (Decision 9).

---

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Raw IndexedDB, no wrapper dep | Zero deps | Verbose callback API; we'd rewrite `idb` anyway | More code and test surface than `idb`; §7.2 allows small reviewed deps |
| Dexie | Rich queries, terse | ~25 KB+; a second ORM-ish layer to learn; query surface we don't need | Bundle budget + unnecessary abstraction; boring wins |
| WASM-SQLite over OPFS | Real SQL | +1–2 MB WASM; sync-handle quirks; complexity | Rejected already in §5.1 (100k+ tasks only) |
| UUIDv7 ids | RFC 9562 standard, tooling | 36 chars (with dashes 36/32), same hand-implementation effort, no canonical monotonicity in naive impls | ULID is smaller, self-contained, monotonic-per-ms by construction; ids are opaque so either could swap later |
| Integer ranks w/ gaps (×1024) | Trivial arithmetic | Renumbering transactions on gap exhaustion — exactly what §5.2 rules out | Fractional keys make reorder a single-record write |
| LexoRank-style fixed buckets | Simple | Periodic rebalance storms; coarser ordering | Fractional base-36 strings are strictly better at equal complexity |
| `tags` store in schema v1 | Normalized tag colors early | Contradicts the binding MVP sketch; adds store + backfill for a V1 feature | Denormalized `string[]` for MVP (binding); normalize at V1 via migration |
| Snapshots in OPFS | Keeps IDB small | Two storage backends in MVP; §5.2.3 explicitly reserves OPFS | Payloads in IDB now; `payloadRef` keeps the move cheap later |
| Auto-stamping in `put` | Convenient | Hidden mutations; LWW integrity depends on invisible magic | One stamping rule in repos (Decision 5), wrapper stays raw |
| zod for validation | Familiar API | ~13 KB+ for six small schemas | Hand-rolled validators; fewer deps (§7.2) |

---

## Consequences

**Positive**
- Single, typed, swappable storage seam (`AppDB`) — every feature card codes against one API with
  a uniform `Result` error contract; QuotaExceeded/unavailable paths are impossible to ignore.
- Reorder is a one-record write; per-list views ride a compound index; search stays in-memory
  until it demonstrably isn't fine.
- The schema is sync-ready (ULID ids, `deviceId`, `updatedAt`, tombstones, `(updatedAt, deviceId)`
  LWW) without implementing sync — V1 WebDAV is metadata + transport, not a data-model change.
- Migrations are boring and safe: forward-only, one tx per step, snapshot-first, export-compatible.
- Import/export/snapshot share ONE serializer and ONE validator set.

**Negative / accepted costs**
- In-memory live/tombstone filtering means repo-layer discipline is required — mitigated by
  keeping all reads behind repos and testing the filter rule.
- Base-36 fractional keys need a small hand-written module + property tests — accepted; it is
  pure and tiny, and the rebalance hatch bounds the pathological case.
- No `tags` store means tag rename is a transaction sweep over `tasks` until V1 — accepted at
  MVP scale (≤10k tasks).
- Snapshot payloads inflate IndexedDB usage — bounded by rolling-3-auto + manual retention and
  surfaced in the quota dashboard (S11).
- Two version layers (IDB + meta.schemaVersion) add a little bookkeeping — accepted for the
  snapshot-before-migration guarantee that `onupgradeneeded` alone cannot give.

**Risks & mitigations**
- *Quota pressure* → `storage.persist()` (M10), quota bar + 80% warning (S11), QuotaExceeded
  dialog (§5.5) wired to this error contract.
- *Tombstone purge resurrect-on-old-import* → documented in the "Clean up" confirm copy; 90-day
  window ≫ backup horizon.
- *`idb` abandonment risk* → contained inside `db.ts`; only `idb`'s promise thinning is used.

**Migration path**: schemaVersion 2 candidates already known — `tags` store (V1), OPFS payload
relocation (record `payloadRef` as a URI-ish string now), recurrence field extensions (S4). All
arrive as additive steps through Decision 8's chain.

---

## Contracts other cards must implement against (normative summary)

1. **localStorage** = `todo:prefs:v1:{theme,dismissedBanners,onboardingStep}` ONLY (≤4 KiB).
   Never task/list/snapshot data (Decision 7).
2. **Migration chain** = forward-only, one atomic `readwrite` tx per step, `meta.schemaVersion`
   bumped inside the step's tx, automatic `pre-migration` snapshot first (abort if the snapshot
   fails), export/import reuse the same registry (Decision 8).
3. **Pre-decided, do not change**: LWW on `(updatedAt, deviceId)` with `deviceId` lexicographic
   tie-break; deletions propagate via `deletedAt` tombstones; unmergeable conflicts materialize
   as visible `"Conflict copy of <task>"` rows (§6.2).
4. **Ordering**: always sort by `(sortOrder, id)` within the sibling group (Decision 4).
5. **Errors**: `Result` + `StorageError` codes end-to-end; `QUOTA_EXCEEDED` must surface the
   export/cleanup dialog flow; no silent write drops (§5.5).
6. **Validation**: all record-shaped input (DB writes at the repo layer, import files) passes
   `validate.ts` (Decision 11).

## Testing contract (for the impl/test cards)

- `orderKey.ts`: property tests — random `between()` sequences keep strict total order, canonicity
  (no trailing `'0'`), 32-char cap with rebalance observable; known-vector tests (seeds,
  `orderKeyFirst() === 'h'`).
- `validate.ts`: unit tests per record type incl. malicious-import fixtures (bad dates like
  `2026-02-30`, oversized strings, prototype-pollution-shaped JSON, wrong types).
- Migrations: fixture DBs at each historical `schemaVersion` → migrate → assert shape + snapshot
  existence; a failing snapshot aborts the migration with data untouched.
- Repos: stamping rules, tombstone + purge (>90d, throttle, explicit), list-delete disposition,
  live/tombstone filtering.
- Wrapper: `tx` commit/abort semantics, `Result` shapes for every `StorageError` code,
  QuotaExceeded surfacing (fault-injected IDB).

## Links

- PROJECT_ANALYSIS.md §5.2 (storage strategy), §5.3 (data model sketch), §5.4 (versioning/migrations),
  §5.5 (quota/persistence/eviction), §6.2 (sync + conflict policy), §7.1–7.2 (threat model, policies)
- Kanban: epic E1 decomposition t_1b9ee0e6; this card t_576c2376 (sole decider)
- Related: ADR-001 (stack selection — owned by a sibling card; this ADR assumes the §7.2
  dependency policy and does not restate the stack)
