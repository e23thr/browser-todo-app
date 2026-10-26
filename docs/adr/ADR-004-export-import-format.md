# ADR-004: Export/import file format & import semantics

**Status**: Accepted
**Date**: 2026-10-23
**Author**: h_senior_coder (sole decider per task t_8c2e4e93 — single-decider rule; no other card
may design the export format or import semantics)
**Scope**: Local-First Todo Web App (GitHub Pages static PWA). Epic E3 Data Safety & Portability.
**Refs**: PROJECT_ANALYSIS.md §5.4 (versioning/migrations), §7.4 (portability/deletion),
§7.1 threat (d) (malicious imports), §10 E2/E4/E8, M11 (export/import), M12 (snapshots).
Binding input: [ADR-002](ADR-002-storage-schema.md) (storage schema — consumed verbatim, never
re-decided here).

---

## Context

MVP has no server and no sync: **manual export → transfer → import is the entire multi-device and
backup story** (§6.2, Q2 DECIDED). The file format is therefore a data-safety contract, not a
convenience: it is what stands between a user and total loss when browser storage is cleared
(E2), when a migration or record corrupts (E4), or when storage is evicted (E1/R1). The Q15 MVP
DoD explicitly requires "export/restore verified".

Binding constraints honored verbatim (recorded, not re-litigated):

- Storage schema, ids, timestamps, tombstones, snapshot storage = **ADR-002** (binding).
- **MVP import is replace-only.** No merge import. Merging arrives with V1 sync (Q2); the
  per-record LWW conflict policy is pre-decided (§6.2) and is **not** re-decided here.
- Export must be **human-inspectable JSON** (Q8: JSON only in MVP; Todo.txt/CSV = V1 importers).
- **No data leaves the browser except via user-initiated export** (§6.1/§7.2: zero network).
- Import files are **untrusted** (§7.1 threat (d)): schema validation, size caps, **never
  `eval`'d**, prototype-pollution-shaped input rejected.
- Invalid records are **quarantined to a downloadable "recovery" file** — never crashed on,
  never silently dropped (E4, ADR-002 Decision 8 step 4).

This ADR is the single source of truth for: the backup document (export file / snapshot payload)
shape; the recovery document shape; the import pipeline (validate → confirm → pre-import snapshot
→ replace apply); how old exports upgrade through the forward-only migration chain; snapshot
retention and pre-import (undo) semantics; and the exact restore path.

---

## Decision summary (the short version)

| Question | Decision |
|---|---|
| File format | One JSON document format, `"format": "local-first-todo-backup"`, pretty-printed, UTF-8, `.json` |
| One serializer | Export file, snapshot payload (ADR-002 "byte-identical to the M11 export file format"), and the record shapes shared with V1 sync (ADR-006 owns its own wire format) — one `backup-document` module |
| Envelope carries | `format`, `formatVersion`, `schemaVersion`, `kind`, `exportedAt`, `deviceId` (required); `app`, `counts` (advisory) |
| Completeness | `data` = `settings` + `lists` + `tasks` + `snapshots` (metadata only). Tombstones included. No snapshot payloads, no localStorage prefs, no `meta` internals |
| Record fidelity | Records round-trip **verbatim** (byte-equivalence): no re-stamping, no re-trimming, original `deviceId` stamps preserved; import writes via raw `put` |
| Old exports | `schemaVersion` < target → upgraded through the **same** forward-only migration registry over an **in-memory `Tx` adapter**; `schemaVersion` > target → reject (`NEWER_SCHEMA`) |
| Import semantics (MVP) | **REPLACE only**, always with explicit confirmation; one atomic `readwrite` transaction; pre-import snapshot is the undo |
| Pipeline | parse/validate (Stage A: reject whole file) → record validation (Stage B: quarantine per record) → user confirm → **pre-import snapshot** → atomic replace apply |
| Malicious input | ≤ 50 MiB cap before read; `JSON.parse` in try/catch (never `eval`/`Function`); depth cap; `__proto__`/`constructor`/`prototype` keys reject the file; records rebuilt field-by-field via whitelist |
| Quarantine | In-memory only, offered as a downloadable `local-first-todo-recovery` JSON (not importable; repair the original file). Same format for boot-validation quarantine (E1 hook) |
| Snapshots | Payload = backup document (`kind: "snapshot"`); rolling **last-3 `kind:'auto'`** (evict-then-put, one transaction) + all `manual` until user-deleted; pre-import snapshot participates; undo survives via one-click download |
| Wipe ("Delete all data") | Hard-deletes lists, tasks, snapshots + payloads; resets settings; clears `todo:prefs:v1:*`; keeps `meta` (deviceId) — a true factory reset (§7.4 "no shadow copies") |
| Merge | Not in MVP (binding). Record shapes are merge-ready (ids, `updatedAt`, `deviceId`, tombstones — identical to ADR-006's wire unit); merge algorithm = pre-decided LWW (§6.2), specified in ADR-006 (accepted) |

---

## Decision 1 — One document format (export + snapshot payload)

The **backup document** is the interchange format for:

1. **Export files** (M11) — user-initiated download, `kind: "export"`.
2. **Snapshot payloads** (M12) — `snapshot_payloads.payload`, `kind: "snapshot"` (ADR-002
   Decision 9 already fixes "byte-identical to the M11 export file format"; this ADR is that
   format). This is what makes "rollback = import the snapshot" (ADR-002 Decision 8) literally
   true: a snapshot payload is a valid import input.
3. **V1 sync (ADR-006, accepted)** — NOT a third use of this document: ADR-006 owns its own
   wire artifacts (`todo-sync/1` batches/snapshots with SHA-256 integrity). What this ADR
   guarantees for sync is narrower and deliberate: the **record shapes** carried here are exactly
   the record state versions sync merges (`id`, `updatedAt`, `deviceId`, `deletedAt` tombstones —
   ADR-006's wire unit), so manual export/import (the MVP "sync" story) and V1 WebDAV sync move
   the same underlying records. The merge algorithm itself is ADR-006's; this ADR decides
   nothing about it.

A sibling format, the **recovery document** (`"format": "local-first-todo-recovery"`), holds
quarantined records. It is deliberately **not** importable (Decision 7).

One serializer module serves all call sites (ADR-002 §3.6: "one serializer module is shared by
export, snapshot, and import — three call sites, one format"):

```
src/portability/backup-document.ts   serialize + parse + canonicalize (this ADR's format)
src/portability/recovery-document.ts serialize recovery files (Decision 7)
src/portability/export.ts            exportBackup()
src/portability/import.ts            prepareImport() / applyImport()
src/storage/snapshots.ts             takeSnapshot / listSnapshots / restoreSnapshot /
                                     deleteSnapshot / downloadSnapshot / retention (Decision 8)
```

(The exact file placement is the impl card's; the **formats and signatures below are binding**.)

---

## Decision 2 — Backup document shape

### 2.1 The document

UTF-8, no BOM, LF line endings, `.json` extension, `application/json`, **pretty-printed with
2-space indent plus one trailing newline** (human-inspectable is a binding requirement — a user
must be able to open a backup in a text editor and read/repair it).

```json
{
  "format": "local-first-todo-backup",
  "formatVersion": 1,
  "schemaVersion": 1,
  "kind": "export",
  "exportedAt": 1792755000000,
  "deviceId": "01J8Q4M6ZK7YV3N2R5T8W1X9AB",
  "app": {
    "name": "local-first-todo",
    "version": "0.1.0"
  },
  "counts": {
    "lists": 2,
    "tasks": 3,
    "snapshots": 1
  },
  "data": {
    "settings": {
      "id": "settings",
      "theme": "dark",
      "locale": "th",
      "weekStart": 1,
      "defaultListId": "01J8Q4M6ZK7YV3N2R5T8W1X9AB",
      "notificationsEnabled": false,
      "lastBackupAt": 1792755000000
    },
    "lists": [
      {
        "id": "01J8Q4M6ZK7YV3N2R5T8W1X9AB",
        "name": "Personal",
        "color": "#3b82f6",
        "sortOrder": "h",
        "createdAt": 1792700000000,
        "updatedAt": 1792700000000,
        "deletedAt": null,
        "deviceId": "01J8Q4M6ZK7YV3N2R5T8W1X9AB"
      },
      {
        "id": "01J8Q5N7AM8ZW4P3S6U9Y2Z0BC",
        "name": "Work",
        "color": "accent-red",
        "sortOrder": "m",
        "createdAt": 1792700100000,
        "updatedAt": 1792700100000,
        "deletedAt": null,
        "deviceId": "01J8Q4M6ZK7YV3N2R5T8W1X9AB"
      }
    ],
    "tasks": [
      {
        "id": "01J8Q6P8BN9AX5Q4T7V0Z3A1CD",
        "listId": "01J8Q4M6ZK7YV3N2R5T8W1X9AB",
        "title": "Buy milk",
        "notes": null,
        "status": "open",
        "priority": 1,
        "dueDate": "2026-10-24",
        "tags": ["errand"],
        "sortOrder": "h",
        "createdAt": 1792700200000,
        "updatedAt": 1792700200000,
        "deletedAt": null,
        "deviceId": "01J8Q4M6ZK7YV3N2R5T8W1X9AB"
      },
      {
        "id": "01J8Q7Q9CP0BY6R5U8W1A4B2DE",
        "listId": "01J8Q5N7AM8ZW4P3S6U9Y2Z0BC",
        "title": "Quarterly report",
        "notes": "Numbers from the finance sheet",
        "status": "done",
        "priority": 2,
        "tags": [],
        "sortOrder": "h",
        "createdAt": 1792700300000,
        "updatedAt": 1792710000000,
        "completedAt": 1792710000000,
        "deletedAt": null,
        "deviceId": "01J8Q4M6ZK7YV3N2R5T8W1X9AB"
      },
      {
        "id": "01J8Q8R0DQ1CZ7S6V9X2B5C3EF",
        "listId": "01J8Q4M6ZK7YV3N2R5T8W1X9AB",
        "title": "Old task I deleted",
        "notes": null,
        "status": "open",
        "priority": 0,
        "tags": [],
        "sortOrder": "h0",
        "createdAt": 1792700400000,
        "updatedAt": 1792700500000,
        "deletedAt": 1792700500000,
        "deviceId": "01J8Q4M6ZK7YV3N2R5T8W1X9AB"
      }
    ],
    "snapshots": [
      {
        "id": "01J8Q9S1ER2DA8T7W0Y3C6D4FG",
        "takenAt": 1792740000000,
        "kind": "auto",
        "reason": "scheduled",
        "sizeBytes": 2048,
        "schemaVersion": 1,
        "payloadRef": "01J8Q9S1ER2DA8T7W0Y3C6D4FG"
      }
    ]
  }
}
```

The example above is one list of three tasks (third is a **tombstone** — `deletedAt` set), a
settings record, and one snapshot-metadata row. Field shapes are exactly ADR-002 Decisions 3 and
5 (`Task`, `List`, `Settings`, `Snapshot` types), verbatim.

> **Erratum (2026-10-23, hardening card t_1ab8c71d).** In the example above the third task's
> `"sortOrder": "h0"` is **not** a canonical order key — `isCanonicalOrderKey` (ADR-002 Decision
> 4.2, `src/storage/orderKey.ts`) rejects the trailing-zero form. **The validator is authoritative**:
> any real row must carry a canonical key, so the example's value should read a canonical key
> (e.g. `"h"`). The example JSON is left as originally published and this note is documentation
> only — the validator is unchanged.

### 2.2 Envelope fields

| Field | Type | Required | Rules | On import |
|---|---|---|---|---|
| `format` | string | yes | must be exactly `"local-first-todo-backup"` | mismatch → reject `NOT_A_BACKUP` |
| `formatVersion` | integer ≥ 1 | yes | container version. Current: **1**. Reserved: a future encrypted export (C1) bumps this and adds a `crypto` envelope block | `> 1` → reject `FORMAT_TOO_NEW` ("made by a newer app version"); `< 1` → reject |
| `schemaVersion` | integer ≥ 1 | yes | **data** version == `meta.schemaVersion` at serialize time (ADR-002 Decision 2). Current: **1** | `> app target` → reject `NEWER_SCHEMA`; `< target` → upgrade (Decision 4); `== target` → as-is |
| `kind` | string enum | yes | `"export"` (user download) \| `"snapshot"` (snapshot payload) | informational; both are valid import inputs |
| `exportedAt` | number | yes | epoch ms UTC (ADR-002 Decision 5); for snapshots == `Snapshot.takenAt` | informational (logged, shown in summary) |
| `deviceId` | string (ULID) | yes | `meta.deviceId` of the **source profile**. Provenance of the document — **never** applied to records or to the target's `meta` | informational only |
| `app` | object `{name, version}` | no | provenance | ignored (warning if absent/malformed) |
| `counts` | object `{lists, tasks, snapshots}` | yes when produced by us | advisory integrity check | mismatch vs actual array lengths → **warning**, proceed (files are human-editable by design) |

Unknown envelope keys: **ignored with a warning** (forward tolerance for additive annotations).
Unknown keys anywhere inside `data` records: **not tolerated** — closed per-version record
schemas (Decision 6).

### 2.3 `data` sections

| Section | Content | Required | Notes |
|---|---|---|---|
| `data.settings` | the `Settings` record verbatim (singleton, `id: "settings"`) | yes | missing → reject `NOT_A_BACKUP` (a complete backup always carries settings) |
| `data.lists` | array of `List` records verbatim, tombstones included | yes (may be `[]`) | sorted canonically (below) |
| `data.tasks` | array of `Task` records verbatim, tombstones included | yes (may be `[]`) | sorted canonically (below) |
| `data.snapshots` | array of `Snapshot` **metadata** rows only | yes (may be `[]`) | payloads are NOT exported (see below) |

Deliberately **not** in the document:

- **Snapshot payloads** — they are full copies of past data; including them would triple file
  size for no portability gain. Snapshot *metadata* is included for provenance ("what recovery
  points existed when this backup was taken"), and is **informational on import** (Decision 8).
- **`meta` internals** (`createdAt`, `lastOpenedAt`, `lastPurgeAt`) — device-local bookkeeping.
  `deviceId`/`schemaVersion` ride the envelope.
- **localStorage prefs** (`todo:prefs:v1:*`) — device-local UX state (dismissed banners,
  onboarding step), never user content (ADR-002 Decision 7).
- **Tombstones are NOT excluded** — "complete" means complete (§7.4). An export older than a
  purge can resurrect deleted rows on import (accepted trade-off, already documented in ADR-002
  Decision 6; the import confirm copy names it).

### 2.4 Canonical serialization (byte-equivalence is testable because of this)

Produced by our exporter, a document is deterministic:

1. Envelope keys in the fixed order of §2.2; `data` keys in order `settings`, `lists`, `tasks`,
   `snapshots`.
2. Record keys in **ADR-002 type-declaration order** (`id`, then the type's fields exactly as
   written in ADR-002 §3). Optional fields that are `undefined` are **omitted** (never `null`):
   `dueDate`, `reminderAt`, `recurrence`, `parentTaskId`, `completedAt`. Fields typed
   `T | null` (`notes`, `deletedAt`) are always present.
3. Array order: `lists` by `(sortOrder, id)`; `tasks` by `(listId, sortOrder, id)`;
   `snapshots` by `(takenAt, id)` — all ordinal string comparison on keys (ADR-002 Decision 4),
   `id` tie-break.
4. Numbers are epoch-ms **safe integers** (or small enums) — `JSON.stringify` is value-exact for
   these; no floats exist in the schema.

**Byte-equivalence definition (used by tests):** for a record `r`,
`canonicalize(r)` (whitelist-rebuild in the key order above) → `JSON.stringify` must be
string-equal between the exported document and the row read back after export → wipe → import.

**Stability property (used by tests):** exporting twice with no data change yields identical
documents except `exportedAt` (and `settings.lastBackupAt`, which export sets to `exportedAt` —
Decision 9).

---

## Decision 3 — Record fidelity on import

Import restores records **verbatim**. In particular:

- **No re-stamping.** `createdAt`/`updatedAt`/`completedAt`/`deletedAt` are preserved exactly.
  Re-stamping `updatedAt` would corrupt future V1 LWW (§6.2) and break byte-equivalence. Import
  therefore writes via the **raw wrapper `put`** (ADR-002 Decision 10: `put` is raw), inside one
  transaction — it does **not** go through the repo stamping layer.
- **Original `deviceId` stamps are preserved** on every record (they are record provenance for
  future LWW).
- **The target profile's `meta.deviceId` is never overwritten** (device identity stays with the
  device; ADR-002 Decision 3.1: generated once per profile). `meta` is not imported at all.
- **No re-trimming/normalization.** If it passes validation as-is, it is stored as-is.
- The only writes outside the replaced stores: `meta.lastOpenedAt` bookkeeping (boot) and the
  pre-import snapshot (Decision 8).

After a successful apply: the theme mirror in localStorage is rewritten from the imported
`settings.theme` (ADR-002 Decision 3.4 mirror rule); `BroadcastChannel("local-first-todo")`
posts `{type: "data-replaced"}` so other tabs refresh (E5). Writes racing a replace in another
tab are an accepted MVP edge (Consequences).

---

## Decision 4 — Versioning: old exports upgrade through the same migration chain

Two version numbers, deliberately:

- **`formatVersion`** — the *container* (envelope shape, encoding). Bumped only for container
  changes (e.g. a future C1 encrypted export). Rare.
- **`schemaVersion`** — the *data* version, identical to `meta.schemaVersion` (ADR-002 Decision
  2) and evolved by the **same forward-only registry**:

```ts
// ADR-002 Decision 8 — the ONE registry, key = version the step upgrades TO
const migrations: Record<number, (t: Tx) => Promise<Result<void, StorageError>>>;
```

**Upgrade algorithm (normative).** Let `S = doc.schemaVersion`, `T = app target`:

1. `S > T` → reject `NEWER_SCHEMA` ("this backup was made by a newer app version"). Never
   partially read it (mirrors the boot rule).
2. `S === T` → no upgrade.
3. `S < T` → run `migrations[S+1] … migrations[T]` **in order**, each against an **in-memory `Tx`
   adapter** (a `Map`-backed implementation of ADR-002's `Tx` interface over the six store
   names). This is the same code path as DB migrations — one migration implementation, two
   substrates (IDB transaction vs in-memory document), so export-upgrades can never drift from
   DB-upgrades.
   - The adapter is seeded with `meta` = `{schemaVersion: S, deviceId: doc.deviceId, …}`;
     `meta` writes are absorbed in-memory and only the final `schemaVersion` (`T`) is written
     back to the document envelope.
   - `snapshot_payloads` is empty on the document substrate (payloads are out of document scope);
     a migration writing to it is a no-op there.
   - Any step returning `err`/throwing → reject `UPGRADE_FAILED`, **zero side effects** (the
     adapter is memory-only).
4. After upgrading (or when `S === T`), validate every record at version `T` (Decision 6) and
   proceed with the import pipeline (Decision 5).

Because the chain is empty today (only v1 exists), tests run the upgrade path with an
**injectable registry seam** (`applyImport`/`prepareImport` accept an optional `migrations`
override; production uses the app registry).

---

## Decision 5 — The import pipeline

### 5.1 Stages (normative order)

```
[0] acquire      user picks/drops a file (user-initiated; the ONLY way data enters)
[1] Stage A      parse + envelope + structural + malicious-shape validation   -- reject = zero side effects
[2] upgrade      Decision 4 (schemaVersion chain over in-memory adapter)      -- reject = zero side effects
[3] Stage B      per-record validation + referential pass -> quarantine plan  -- reject = zero side effects
[4] confirm      UX: summary ("this REPLACES all current data: N lists, M tasks") -- user may abort
[5] snapshot     automatic pre-import snapshot (kind auto, reason pre-import) -- failure = user choice
[6] apply        ONE readwrite transaction: hard-delete + verbatim put        -- atomic; failure = DB unchanged
[7] report       ImportReport (+ recovery file download if quarantined) + undo snapshot handle
```

**Reject (Stages 1–3) means literally zero side effects**: no DB writes, **no snapshot taken**,
no quota consumed. The user keeps their file and their data.

**Stage A rejects the whole file** when any of: unreadable; `File.size > 50 MiB` (checked before
reading); `JSON.parse` fails (SyntaxError/RangeError — caught, never `eval`/`Function`); top
level is not an object; envelope violations (§2.2); any `data` section missing or
wrong-typed; structural limits exceeded (§6); a `__proto__` / `constructor` / `prototype` key
found anywhere in the parsed tree (malicious shape).

**Stage B quarantines per record** (Decision 7): records failing record-level validation or the
referential pass are excluded and collected into the recovery file; all other records apply.

**`NOTHING_TO_IMPORT` special case:** if the document declares records but **every** record
quarantined (0 accepted), the import is rejected with zero side effects and the recovery file is
offered — a file whose entire payload is corrupt is a corrupt file, not an empty backup. (A
legitimate empty backup — sections present, arrays `[]` — imports fine and replaces with empty.)

**Duplicate ids** within one section: first occurrence wins, later occurrences are quarantined
with issue `"duplicate id"`.

### 5.2 `prepareImport` / `applyImport` split

Zero-side-effect stages are separated from mutating ones so the UX can show a summary and ask
before anything happens:

```ts
prepareImport(input: File | string, opts?: {migrations?: MigrationRegistry})
  : Promise<Result<ImportPlan, ImportError>>          // stages 1-3; pure w.r.t. the DB

applyImport(plan: ImportPlan, opts?: {allowWithoutSnapshot?: boolean})
  : Promise<Result<ImportReport, ImportError>>        // stages 5-6; requires a confirmed plan

type ImportPlan = {
  fileSummary: { fileName: string; fileBytes: number; formatVersion: number;
                 schemaVersion: number; upgradedTo: number; kind: 'export' | 'snapshot' };
  accepted: { lists: number; tasks: number; settings: true };
  quarantined: RecoveryEntry[];      // preview for the report
  warnings: string[];                // e.g. 'counts.tasks mismatch: declared 5, found 6'
};

type ImportReport = {
  outcome: 'applied' | 'partial';    // 'partial' = applied with quarantined.length > 0
  accepted: { lists: number; tasks: number; settings: true };
  quarantined: number;
  recoveryFileName: string | null;   // present iff quarantined > 0 (download offered)
  undoSnapshot: { id: string; takenAt: number } | null;  // the pre-import snapshot
  warnings: string[];
};
```

`restoreSnapshot(id)` (Decision 8) is `prepareImport(storedPayload) + applyImport` with the same
confirmation UX.

### 5.3 Apply (REPLACE) semantics

- **One `readwrite` transaction over `['lists', 'tasks', 'settings']`** (ADR-002 `tx`):
  hard-delete every existing row in `lists` and `tasks` (including tombstones — `delete` is the
  hard-delete op, whose sanctioned users per ADR-002 Decision 10 include "import `replace`
  mode"), then `put` every accepted record verbatim; `settings` is replaced by the imported
  record. Any failure — including `QUOTA_EXCEEDED` — **aborts the transaction**: the database is
  exactly as before (IDB atomicity), and the typed error surfaces (§5.5 dialog for
  `QUOTA_EXCEEDED`: export/cleanup, never a silent drop).
- **C1 staging (ADR-007 Decision 4.6):** when the target store is encrypted, each accepted
  record is sealed to its at-rest bytes BEFORE the transaction opens, and the transaction
  writes those bytes verbatim (the at-rest transaction, `txRaw`). The atomicity contract
  above is unchanged — staging is pure — and the at-rest format is ADR-007 Decision 4.1's.
- `snapshots`/`snapshot_payloads` are untouched by apply (the pre-import snapshot row was written
  in stage 5). Imported `data.snapshots` metadata is **not** restored — informational only
  (warning: "snapshot metadata ignored — snapshot payloads are device-local").
- On commit: theme mirror sync + `data-replaced` broadcast (Decision 3).

### 5.4 Error codes (Result-based; nothing throws across the boundary)

```ts
type ImportError =
  | { code: 'FILE_TOO_LARGE'; bytes: number; cap: number }
  | { code: 'PARSE_ERROR'; message: string }            // malformed JSON / not an object
  | { code: 'NOT_A_BACKUP'; message: string }           // wrong format token / bad envelope / incomplete sections
  | { code: 'FORMAT_TOO_NEW'; found: number; supported: number }
  | { code: 'NEWER_SCHEMA'; found: number; supported: number }
  | { code: 'UPGRADE_FAILED'; from: number; to: number; cause?: unknown }
  | { code: 'MALICIOUS_SHAPE'; message: string }        // proto-pollution keys, depth bomb
  | { code: 'LIMIT_EXCEEDED'; limit: string; found: number; cap: number }
  | { code: 'NOTHING_TO_IMPORT'; quarantined: number }
  | { code: 'SNAPSHOT_FAILED'; cause?: unknown }        // pre-import snapshot failed and user did not opt in
  | { code: 'QUOTA_EXCEEDED'; cause?: unknown }         // -> §5.5 dialog
  | { code: 'TX_ABORTED'; cause?: unknown }
  | { code: 'UNAVAILABLE'; cause?: unknown }
  | { code: 'UNKNOWN'; cause?: unknown };
```

### 5.5 Confirmation UX is part of the contract

Because apply is destructive, `applyImport` must only run **after** an explicit user confirmation
whose copy states: (a) this **replaces ALL current data** (with the file's list/task counts);
(b) an automatic pre-import snapshot is taken as the undo and where to find it; (c) importing an
old backup can bring back rows the user deleted since (tombstone resurrection, ADR-002 Decision
6). The data-safety UX card owns the wording; the three facts are required.

---

## Decision 6 — Validation rules & size caps (untrusted input)

The threat model (§7.1 (d)): a malicious or corrupt file must not crash the app, exhaust
resources, execute code, or corrupt stored data. **The file is data, never code.**

### 6.1 Hard rules

1. **Never `eval`, never `Function`, never dynamic `import`, never `new` on anything from the
   file.** Parsing is `JSON.parse` inside `try/catch` (catches `SyntaxError` and depth-bomb
   `RangeError`).
2. **Size cap before read**: `File.size > 52_428_800` bytes (50 MiB — ADR-002 Decision 11's
   binding cap) → `FILE_TOO_LARGE` without reading the file into memory.
3. **Structural walk is iterative** (explicit stack, no recursion), enforcing depth ≤ 8 and
   collecting keys. Any key in `{'__proto__', 'constructor', 'prototype'}` anywhere →
   `MALICIOUS_SHAPE` (whole file).
4. **Whitelist rebuild**: accepted records are constructed field-by-field from known fields
   (never `Object.assign`/spread of untrusted objects — that is the prototype-pollution vector
   `JSON.parse` alone does not close). Unknown record fields → record quarantined (closed
   per-version schema).
5. All validators are the **`validate.ts`** predicates from ADR-002 Decision 11 (one validator
   set, two consumers: boot validation + import). This ADR pins the caps those predicates must
   enforce (below); where ADR-002 left a cap open (tags, color tokens), this table is the rule.

### 6.2 Limits & caps

| Limit | Value | Failure |
|---|---|---|
| File bytes | ≤ 50 MiB (52_428_800) | `FILE_TOO_LARGE` (reject) |
| Parsed JSON depth | ≤ 8 | `MALICIOUS_SHAPE` (reject) |
| `data.lists` length | ≤ 1,000 | `LIMIT_EXCEEDED` (reject) |
| `data.tasks` length | ≤ 100,000 (E7 ceiling) | `LIMIT_EXCEEDED` (reject) |
| `data.snapshots` length | ≤ 1,000 | `LIMIT_EXCEEDED` (reject) |
| id fields (all) | `^[0-9A-HJKMNP-TV-Z]{26}$` (ULID, ADR-002 §4.1) | quarantine record |
| `List.name` | 1..200 chars after trim | quarantine |
| `List.color` | `#rrggbb` or theme token `^[a-z][a-z0-9-]{0,31}$` | quarantine |
| `Task.title` | 1..1,000 chars after trim | quarantine |
| `Task.notes` | `null` or ≤ 20,000 chars | quarantine |
| `Task.status` | `open` \| `done` \| `archived` | quarantine |
| `Task.priority` | `0` \| `1` \| `2` | quarantine |
| `Task.dueDate`, `Recurrence.until` | `YYYY-MM-DD` **real calendar day** (rejects `2026-02-30`) | quarantine |
| `Task.reminderAt`, all timestamps | non-negative safe integers (epoch ms UTC) | quarantine |
| `Task.tags` | ≤ 50 entries, each 1..100 chars, no empties | quarantine |
| `Task.parentTaskId` | absent or ULID; must reference an accepted task; **chains acyclic** | quarantine |
| `Task.listId` | ULID; must reference an accepted list record (tombstoned list counts as present) | quarantine |
| `Recurrence.freq` | `daily`\|`weekly`\|`monthly`\|`weekdays`; `interval` integer ≥ 1; `count` integer ≥ 1 | quarantine |
| `Settings.theme` | `light` \| `dark` \| `system` | quarantine |
| `Settings.locale` | 1..35 chars (BCP-47-ish; `en`/`th` at MVP) | quarantine |
| `Settings.weekStart` | `0` \| `1` | quarantine |
| `Settings.notificationsEnabled` | boolean | quarantine |
| `Settings.lastBackupAt`, `defaultListId` | `null` or timestamp / ULID | quarantine |
| `Snapshot` metadata fields | per ADR-002 §3.5; shallow check only (informational) | quarantine |

**Referential pass** (after per-record validation, on the accepted set): tasks whose `listId`
resolves to no accepted list record, or whose `parentTaskId` resolves to no accepted task /
closes a cycle, are quarantined too (a corrupt list record cascades to its unusable tasks —
everything lands in the recovery file, nothing is silently dropped).

---

## Decision 7 — Quarantine & the recovery document

Quarantine is **in-memory and download-only**. Quarantined records are **never persisted to the
database** and never re-applied — §7.4 forbids shadow copies of user content. (Boot-validation
quarantine is the one exception to "never persisted": ADR-002 Decision 8 step 4 keeps invalid
**existing** rows in the DB behind an in-memory denylist until the user explicitly purges them —
those rows were already stored; nothing new is written.)

### 7.1 Format

```json
{
  "format": "local-first-todo-recovery",
  "formatVersion": 1,
  "schemaVersion": 1,
  "createdAt": 1792755100000,
  "deviceId": "01J8Q4M6ZK7YV3N2R5T8W1X9AB",
  "source": {
    "kind": "import",
    "fileName": "local-first-todo-backup-2026-10-23T183700Z.json",
    "fileSchemaVersion": 1
  },
  "entries": [
    {
      "store": "tasks",
      "id": "01J8Q6P8BN9AX5Q4T7V0Z3A1CD",
      "issues": ["title: must be 1..1000 chars after trim"],
      "raw": { "...": "the record exactly as it appeared in the source" }
    },
    {
      "store": "tasks",
      "id": null,
      "issues": ["id: missing or not a ULID"],
      "raw": { "...": "..." }
    }
  ]
}
```

| Field | Rules |
|---|---|
| `format` | exactly `"local-first-todo-recovery"` — a different token from the backup format **on purpose**: recovery files are **not importable** (`NOT_A_BACKUP` on attempt). Repair the original backup file (it is human-readable JSON) and import that |
| `source.kind` | `"import"` (this Decision) \| `"boot-validation"` (E1 boot hook — same shape, `fileName: null`, `fileSchemaVersion` = DB's version) |
| `entries[].store` | `"lists"` \| `"tasks"` \| `"settings"` \| `"snapshots"` |
| `entries[].id` | the record's `id` if present and parseable, else `null` |
| `entries[].issues` | human-readable strings, `"field: reason"` — enough for a person to repair by hand |
| `entries[].raw` | the record **exactly as it appeared in the source** (in-file for import — pre-upgrade; the DB row for boot-validation) |

Filename: `local-first-todo-recovery-<UTC>.json` (same timestamp convention as Decision 9).
Produced by `serializeRecoveryDoc(entries, source, meta)` — the **only** recovery-file writer;
E1's boot-validation quarantine calls the same function (that is the "recovery file hook").

---

## Decision 8 — Snapshots: payload layout, retention, pre-import (undo) semantics

(Accepts ADR-002 Decisions 3.5, 3.6, 9 as given; this section pins the algorithm precisely
enough to implement without further decisions.)

### 8.1 Payload layout

- `snapshot_payloads` row: `{ id, payload }` where `id === Snapshot.id` (`payloadRef`),
  `payload` = **the backup document as a JSON string**, `kind: "snapshot"`, `exportedAt` =
  `Snapshot.takenAt`, `schemaVersion` = version at which the snapshot was taken. Exactly the
  serializer of Decision 2 (ADR-002 §3.6: shared, byte-identical format).
- `snapshots` row per ADR-002 §3.5 (`reason` refines `kind`: `scheduled` | `pre-migration` |
  `pre-import` | `manual`).
- Because payloads are valid import documents, **restore = import**: `restoreSnapshot(id)` runs
  the full Decision 5 pipeline on the stored payload (including its own pre-import snapshot —
  undo of undo).

### 8.2 Retention — rolling last-3 auto + all manual (normative algorithm)

After every snapshot write, **in the same `readwrite` transaction over
`['snapshots', 'snapshot_payloads']`** (atomic):

1. Compute the victim set: rows with `kind: 'auto'`, ordered by `(takenAt ASC, id ASC)`;
   with the row being written included in the ordering, keep the **newest 3 autos**; every older
   auto is a victim. `kind: 'manual'` rows are **never** victims.
2. **Evict-then-put**: delete each victim's `snapshots` row **and** its `snapshot_payloads` row
   first, then put the new payload and metadata rows. (Order matters for quota headroom: never
   hold 4 payloads transiently; atomicity is the transaction's job.)
3. Commit.

Consequences pinned: pre-import and pre-migration snapshots are `kind: 'auto'` and **participate
in the rolling-3** (binding per ADR-002 Decision 9) — so an undo snapshot can be evicted by
later autos. That is why the import report exposes `undoSnapshot` with a one-click **download**
(the document is importable later, from anywhere); the data-safety UX card must offer it.
Users may delete **any** snapshot (auto or manual) from the storage dashboard; "Delete all data"
removes everything (Decision 10).

### 8.3 Auto snapshot triggers

| Reason | When | Failure handling (binding per ADR-002 Decision 9) |
|---|---|---|
| `scheduled` | at boot, after successful migration + boot validation, at most once per 24h (compare newest snapshot `takenAt`; no change-detection gate) | warn in local error log; boot continues |
| `pre-migration` | before any migration step runs (E1's hook) | **abort the migration** (data untouched; stay on old version) |
| `pre-import` | after user confirmation, before apply (also before `restoreSnapshot` apply) | proceed **only** on explicit user confirmation (`allowWithoutSnapshot`), else abort with `SNAPSHOT_FAILED` and zero side effects |
| `manual` | user action from the storage dashboard | error surfaced; nothing else happens |

### 8.4 Pre-import snapshot semantics (the undo contract)

1. **Captures the full current state** (a `kind: "snapshot"` document of the DB as it is *before*
   the import), including tombstones — restoring it is a byte-equivalent undo (modulo envelope
   timestamps).
2. Taken **after** validation/confirmation and **before** any apply write. On a fresh/empty DB it
   is a trivial document — still taken (uniformity beats special cases).
3. It is the **only** undo mechanism for an import in MVP (undo toast = S7, V1 — ADR-002
   Decision 6). The import report names it (`undoSnapshot: {id, takenAt}`) and the UX must let
   the user download it and must tell them where it lives (Settings → Storage → Snapshots).
4. It follows rolling-3 eviction (above); downloading is the durable escape hatch.
5. Invoking the undo = `restoreSnapshot(id)` (or importing the downloaded snapshot document) —
   which is itself a full import with its own pre-import snapshot.

---

## Decision 9 — Export behavior (M11)

1. **Serialize** the current DB state (live rows **and** tombstones; `settings`, `lists`,
   `tasks`, `snapshots` metadata — Decisions 2.3/2.4) with `kind: "export"`,
   `exportedAt = Date.now()`, `deviceId = meta.deviceId`, `app.version` = build version.
2. **`settings.lastBackupAt := exportedAt`** — written both into the document (the document is
   self-consistent: its own `lastBackupAt` equals its `exportedAt`) and back to the DB (best
   effort: if that small write fails, log locally and still export — the download is the point).
   This drives the S11 backup nudge (14 days) and makes export → wipe → import round-trips
   byte-equivalent for `settings` too.
3. **Download** via `Blob([str], {type: 'application/json'})` + anchor `download` —
   **user-initiated**, local only (§6.1: nothing leaves the browser; a download is not a
   transmission).
4. Filename: `local-first-todo-backup-YYYY-MM-DDTHHmmssZ.json` (UTC, filesystem-safe, no colons
   in the time part). Snapshot download: `local-first-todo-snapshot-<stamp>.json`. Recovery:
   `local-first-todo-recovery-<stamp>.json`.

Export **always** includes tombstones and is always a full backup (no partial/scope filters in
MVP — determinism and "complete" beat convenience; a filtered export can be a V1 feature).

---

## Decision 10 — The exact restore path (the named drill)

**"Export → wipe → import → restored"** — the acceptance drill, spelled out so QA and tests can
run it verbatim:

1. **Export** — Settings → "Export backup": `local-first-todo-backup-<UTC>.json` lands on disk.
   (Checksum: record its `counts` — lists/tasks/snapshots.)
2. **Wipe** — Settings → "Delete all data" (confirmed; §7.4 "real, immediate, confirmed").
   Semantics (**pinned here because the restore path depends on them**): hard-delete every row in
   `lists`, `tasks`, `snapshots`, `snapshot_payloads`; reset `settings` to module defaults; clear
   `todo:prefs:v1:*` (theme mirror → default); keep `meta` (`deviceId`, `createdAt`;
   `schemaVersion` stays current; `lastPurgeAt` cleared). The local error log survives
   (diagnostics, not user content). Result: an effectively fresh install with the same
   `deviceId`. **No pre-wipe snapshot** — this is the explicit, confirmed, destructive control
   (and a snapshot would be exactly the "shadow copy" §7.4 forbids).
3. **Import** — Settings → "Import backup" → pick the file from step 1 → pipeline (Decision 5):
   parse + validate (50 MiB cap; envelope; records) → summary + REPLACE confirmation →
   pre-import snapshot of the empty state → atomic apply.
4. **Restored** — `counts` match step 1; every `lists`/`tasks` record and `settings` is
   byte-equivalent to the exported document (Decision 2.4); tombstones restored; app usable
   immediately; other tabs got `data-replaced`. Snapshot metadata from the file is reported as
   ignored (payloads were device-local).

Variants (same pipeline): **new device** = step 1 + step 3; **corruption (E4)** = boot quarantine
→ download recovery file → repair the source JSON by hand → import; **undo an import** =
restore the pre-import snapshot (Decision 8.4).

---

## Decision 11 — Import semantics: REPLACE only (no merge in MVP)

- **MVP apply mode is REPLACE** (binding: "MVP import is replace-only"; §7.4 recommends replace
  as the default). There is no merge/union import mode, no per-record reconciliation at import
  time, no conflict copies at import time.
- **Why the format is still merge-ready**: records carry `id`, `updatedAt`, `deviceId`,
  `deletedAt` (tombstones included) — exactly the fields the pre-decided LWW rule (§6.2: winner
  = greater `updatedAt`, tie-break greater `deviceId`; deletions propagate via tombstones;
  unmergeable conflicts become visible `"Conflict copy of <task>"` rows) needs, and exactly the
  record state versions ADR-006's sync wire unit carries. **The merge engine and sync protocol
  are ADR-006's (accepted) — this ADR decides neither**; a WebDAV sync apply is a different
  operation from an import and never routes through `applyImport`.
- Importing an older backup over newer data **replaces** it (the pre-import snapshot is the
  undo; the confirmation copy names this — Decision 5.5).

---

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Compressed export (.zip / .gz) | Smaller files | Not human-inspectable; tooling friction; binary diffs | Human-inspectable JSON is binding; compression can be a `formatVersion` bump later if size ever hurts |
| NDJSON / JSONL | Streamable | Not one readable document; harder to hand-repair | Inspectability + repairability win |
| Include snapshot payloads in export | Self-contained history | 2–4× file size; marginal value | Metadata-only provenance; payloads are device-local recovery, not portability |
| Whole-file reject on any bad record (no quarantine) | Simple | One bad row out of 10k blocks a restore — data-hostile (E4) | Per-record quarantine preserves everything (recovery file) while restoring the rest |
| Merge/union import modes in MVP | Convenient multi-device | Binding says replace-only; merge intent is ambiguous; LWW at import time is sync scope creep (R3) | Replace + pre-import snapshot is honest and loss-free; merge arrives with V1 sync |
| Separate doc-upgrade code for imports | Isolated | Two migration implementations drift; "same chain" is a stated requirement | In-memory `Tx` adapter runs the **same** registry — one implementation, two substrates |
| Restore via repo layer (with stamping) | Consistent write path | Re-stamps `updatedAt` → corrupts future LWW; breaks byte-equivalence | Raw `put`, verbatim records (ADR-002 Decision 10 sanctions `delete`/`put` for import-replace) |
| Overwrite `meta.deviceId` on import | "Clean" identity | Device identity is per-profile (ADR-002); breaks LWW tie-break semantics | Keep target `deviceId`; records keep their own stamps |
| CSV / Todo.txt / vendor importers now | Familiar | Q8: JSON only in MVP | V1 importers will reuse this pipeline's validate/quarantine stages |
| Quarantine records persisted in DB | Convenient retry | Shadow copies of user content (§7.4 forbids) | In-memory + download only |
| Accept recovery files as imports | Repair-then-import in one file | Two file semantics; ambiguous provenance | Repair the original (it's plain JSON); recovery file stays a report |
| Hash/checksum required in envelope | Tamper-evidence | Weaker threat model needs it; hand-editability is a feature | Hand-edits must keep working (counts are advisory for this reason) |

---

## Consequences

**Positive**
- One document format serves export, snapshot, and restore — one serializer, one
  validator set, one set of fixtures; "export → wipe → import" is byte-equivalent and testable.
- Replace + pre-import snapshot is a complete, honest undo story with no merge ambiguity; the
  snapshot payload being importable makes rollback after migration or import trivially uniform.
- Untrusted-input handling is pinned (caps, no-eval, whitelist rebuild, proto-key rejection) —
  E8 is a checklist item in tests, not a design question at implementation time.
- Forward-only upgrades reuse the ADR-002 registry via an in-memory adapter, so an old backup
  always upgrades exactly like an old database.

**Negative / accepted costs**
- Replace-only is blunt for multi-device users until V1 sync: accepted (binding) and mitigated
  by explicit confirmation + undo snapshot + export discipline.
- "Partial" outcomes (quarantined > 0) add UX surface: the report + mandatory recovery download
  must be handled by the data-safety UX card.
- The in-memory `Tx` adapter is a second substrate for the migration registry: accepted; it is
  small (`Map`-backed) and tested with the same migration fixtures.
- Parsing a 50 MiB document spikes memory (roughly 3–5× file size transiently): accepted within
  the cap; the cap exists precisely to bound it.
- Snapshot payloads inflate IndexedDB usage: bounded by rolling-3 + manual retention and visible
  in the quota dashboard (S11); pre-import snapshots can be evicted — the download is the durable
  undo.

**Risks & mitigations**
- *Import racing another tab's writes* → post-commit `data-replaced` broadcast + tab refresh;
  the replace transaction itself is atomic. Residual edge (a stale tab writing after replace) is
  accepted for MVP and listed in the E3 test plan as a known limitation.
- *User restores an old backup and "loses" newer work* → mandatory REPLACE confirmation naming
  counts + the undo snapshot; tombstone-resurrection caveat in the copy (ADR-002 Decision 6).
- *Quota exhaustion during apply or snapshot* → atomic abort leaves data untouched;
  `QUOTA_EXCEEDED` → §5.5 export/cleanup dialog; snapshot failure follows Decision 8.3's rules.

---

## Contracts other cards must implement against (normative summary)

1. **The document format** (Decision 2) and **canonical serialization** (Decision 2.4) — the
   only wire format for export files, snapshot payloads, and (later) sync.
2. **The import pipeline** (Decision 5): `prepareImport` (zero side effects) / `applyImport`
   (confirm → pre-import snapshot → one atomic replace tx). Replace-only in MVP.
3. **Migration reuse** (Decision 4): imports upgrade `schemaVersion < target` through the SAME
   registry over an in-memory `Tx` adapter; `schemaVersion > target` → `NEWER_SCHEMA` reject.
4. **Validation & caps** (Decision 6): `validate.ts` predicates + this ADR's caps; never `eval`;
   whitelist record rebuild; `__proto__`/`constructor`/`prototype` → `MALICIOUS_SHAPE` reject.
5. **Recovery document** (Decision 7): `serializeRecoveryDoc` is the single writer — import
   quarantine AND E1's boot-validation quarantine produce this exact shape. Recovery files are
   not importable and never persisted.
6. **Snapshot engine** (`src/storage/snapshots.ts`): `takeSnapshot(reason)`, retention
   algorithm (evict-then-put, rolling-3 autos, one tx — Decision 8.2), `restoreSnapshot(id)` =
   runImport(stored payload), `listSnapshots`, `deleteSnapshot`, `downloadSnapshot`.
   **Ownership seam**: E1 (boot/migration framework) implements `takeSnapshot('pre-migration')`
   and retention against this spec; E3 (data-safety impl) owns the module and adds
   scheduled/manual/restore/download. Same spec — no second design.
7. **Errors**: `Result<T, ImportError | StorageError>` end-to-end; nothing throws across the
   boundary; `QUOTA_EXCEEDED` always surfaces the §5.5 export/cleanup dialog.
8. **Restore path** (Decision 10) incl. the pinned "Delete all data" semantics (factory reset
   incl. snapshots; `meta.deviceId` kept).
9. **UX facts required at confirmation** (Decision 5.5): replaces-all warning with counts, undo
   snapshot pointer, tombstone-resurrection caveat.

### API surface (binding signatures)

```ts
exportBackup(): Promise<Result<ExportReport, ExportError>>
// ExportReport = { fileName, fileBytes, exportedAt, counts: {lists, tasks, snapshots} }

prepareImport(input: File | string, opts?: {migrations?: MigrationRegistry})
  : Promise<Result<ImportPlan, ImportError>>
applyImport(plan: ImportPlan, opts?: {allowWithoutSnapshot?: boolean})
  : Promise<Result<ImportReport, ImportError>>

takeSnapshot(reason: 'scheduled' | 'pre-migration' | 'pre-import' | 'manual')
  : Promise<Result<{id: string; takenAt: number}, StorageError>>
listSnapshots(): Promise<Result<Snapshot[], StorageError>>        // newest first, metadata only
restoreSnapshot(id: string): Promise<Result<ImportReport, ImportError>>
deleteSnapshot(id: string): Promise<Result<void, StorageError>>   // any kind, explicit user action
downloadSnapshot(id: string): Promise<Result<Blob, StorageError>>// kind:'snapshot' document

serializeRecoveryDoc(entries: RecoveryEntry[], source: RecoverySource, meta: RecoveryMeta): string
```

---

## Testing contract (corruption drills — impl/test cards)

Fixtures under `tests/fixtures/backup/` (each named for the drill it serves):

1. **Restore drill (acceptance)** — build a fixture DB → `exportBackup` → "Delete all data" →
   `prepareImport`+`applyImport` the file → every `lists`/`tasks` record and `settings`
   **byte-equivalent** (Decision 2.4) to the document; counts match; tombstones restored.
2. **Stability** — export twice with no data change → identical except `exportedAt` /
   `settings.lastBackupAt`.
3. **Old-export upgrade** — injectable registry seam: v1 doc + test-only v1→v2 step → import →
   upgraded records validate at v2; failing step → `UPGRADE_FAILED`, zero side effects.
4. **Malicious fixtures — each REJECTED with zero DB writes and NO snapshot taken**:
   oversize file (> 50 MiB); wrong `format` token; `formatVersion: 2`; `schemaVersion: 99`
   (`NEWER_SCHEMA`); truncated JSON; deep-nesting bomb (parse error or depth > 8);
   `__proto__` / `constructor` / `prototype` keys; wrong field types (`title: {}`);
   count-limit bomb (100,001 tasks); missing `data.settings`.
5. **Quarantine drill** — N valid + 3 corrupt records → outcome `partial`, N−3 applied,
   recovery document holds exactly the 3 with `issues` + `raw`; DB contains only valid records;
   recovery file not persisted anywhere.
6. **Referential drill** — task with dangling `listId`, `parentTaskId` cycle → quarantined
   (cascade rule of Decision 6); tombstoned list still satisfies `listId`.
7. **Nothing-to-import** — all records corrupt → `NOTHING_TO_IMPORT`, zero side effects.
8. **Duplicate-id drill** — first wins, later duplicates quarantined.
9. **Retention drill** — 5 `takeSnapshot('auto')` → exactly the newest 3 remain; evicted
   payloads gone from `snapshot_payloads`; manual snapshots never evicted; `deleteSnapshot`
   works for any kind.
10. **Undo drill** — import → `restoreSnapshot(pre-import id)` → data byte-equivalent to
    pre-import state; undo-of-undo snapshot exists.
11. **Snapshot-failure drill** — fault-injected snapshot write failure → `applyImport` aborts
    (`SNAPSHOT_FAILED`) unless `allowWithoutSnapshot` (then apply proceeds); migration
    pre-snapshot failure aborts the migration (E1's drill).
12. **Quota drill** — fault-injected `QuotaExceeded` on apply → transaction aborts, DB
    unchanged, typed `QUOTA_EXCEEDED`; same on `settings.lastBackupAt` write → export still
    succeeds (best-effort).
13. **Snapshot-metadata drill** — document with `data.snapshots` entries → accepted with
    "snapshot metadata ignored" warning; `snapshots` store unchanged except the pre-import row.
14. **Recovery-format drill** — recovery document round-trips `serializeRecoveryDoc` → is NOT
    importable (`NOT_A_BACKUP`).
15. **Manual QA drill** (no automation): run Decision 10's four steps on a real browser,
    including the iOS Safari path (E2/E1 narrative), and archive the two files with the report.

---

## Links

- Binding input: [ADR-002](ADR-002-storage-schema.md) (schema, `Tx`/`AppDB`, migration registry,
  snapshot stores, `validate.ts`, error contract)
- PROJECT_ANALYSIS.md §5.4 (migrations/exports carry `schemaVersion`), §7.4 (portability:
  validate → snapshot → replace; delete-all-data; no shadow copies), §7.1 threat (d) (malicious
  imports), §6.2 (pre-decided LWW — consumed, not re-decided), §10 E2/E3/E4/E8, M11/M12, S7/S11
- Kanban: epic E3 decomposition t_1b9ee0e6; this card t_8c2e4e93 (sole decider). Downstream:
  E1 framework card t_eba4b531 (boot hooks: pre-migration snapshot, boot-quarantine recovery
  file), E3 impl card t_a7c2087f (format + pipeline implementation, drills above)
- Note on numbering: the provisional numbering in ADR-001's completion metadata (ADR-003 =
  service worker, ADR-004 = sync, ADR-005 = encryption) is SUPERSEDED by the decomposition
  (t_1b9ee0e6). Canonical list (authority: task t_8c2e4e93 body, confirmed by h_pm 2026-10-23):
  ADR-001 UI framework & build tooling · ADR-002 storage schema & IDB wrapper · ADR-003 domain
  layer · **ADR-004 export/import file format & merge semantics (this ADR)** · ADR-005 service
  worker & update strategy · ADR-006 WebDAV sync protocol (merge semantics pre-decided by §6.2,
  consumed in Decision 11) · ADR-007 encryption at rest.
