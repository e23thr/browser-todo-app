# ADR-006: WebDAV sync protocol & merge engine (V1)

**Status**: Accepted
**Date**: 2026-10-23
**Author**: h_senior_coder (sole decider per task t_6e4bb440 — single-decider rule; the ONLY card that may design sync)
**Scope**: Local-First Todo Web App (GitHub Pages static PWA). Epic E8 (V1) WebDAV Sync; this is the protocol ADR (docs only).
**Refs**: PROJECT_ANALYSIS.md §6.2 (sync requirements + BINDING conflict policy), §5.2 (storage strategy),
§11 R3 (sync scope-creep risk), §2/WON'T (never a server we operate), §12 Q1/Q2 (PO decisions),
ADR-002 (storage schema — this ADR consumes its contracts), ADR-001 (UI stack).

---

## Context

V1 adds **opt-in WebDAV sync to USER-PROVIDED storage** (Nextcloud or any RFC 4918 WebDAV server)
— per PO Q2 DECIDED: never a server we operate, no accounts, no API of our own. MVP remains
manual export/import; sync is never required for local correctness (§6.2).

§6.2 pre-decides the conflict policy (recorded verbatim below — this ADR does NOT re-design it),
and the brief pre-decides the failure semantics (sync failure leaves local data untouched and
shows a visible error state). What remained to design — and what this ADR settles as the single
source of truth — is everything else:

1. **Remote file layout** on a dumb WebDAV file store (snapshot + change manifest).
2. **Pull/push flow** and **scheduling** (user-triggered or periodic-when-online).
3. **Client-side merge engine**: exact LWW comparison, what "unmergeable" means, conflict-copy
   creation, delete-vs-edit handling.
4. **Tombstone propagation and its interplay with the 90-day purge** (ADR-002 Decision 6).
5. **Auth handling** (user credentials, stored locally only).
6. **Failure semantics and the error-state contract** the sync UI consumes.
7. **Encryption interop**: how a record whose payload is encrypted merges under this protocol
   without breaking LWW (ADR-007 is a child decision of this one and must stay consistent).

The data model is already sync-ready (ADR-002): ULID ids, `updatedAt`, `deviceId` on every
sync-relevant record, `deletedAt` tombstones — so V1 sync is **metadata + transport + merge**,
not a data-model change (one additive migration only, see Decision 2).

Design pressure (R3): sync scope creep explodes schedules. Everything below is deliberately
boring: append-only files, full-record state versions, per-record deterministic merge, one atomic
local apply transaction. No CRDTs (C8, R&D only), no server logic, no real-time.

---

## Binding conflict policy — restated verbatim (PROJECT_ANALYSIS §6.2, pre-decided; DO NOT change)

> - **Conflict policy (pre-decided so no task has to invent one):** per-record **last-write-wins**
>   keyed on `(updatedAt, deviceId)`; deletions propagate via tombstones; an unmergeable conflict is
>   materialized as a visible "Conflict copy of <task>" — never a silent overwrite. CRDTs are
>   explicitly out (C8, R&D only).
> - **Guarantees:** sync is never required for correctness of local operation; sync failure leaves
>   local data untouched and shows an error state; sync is user-triggered or periodic-when-online.

This ADR's only freedom is defining the exact mechanics ("what counts as unmergeable", "how a
conflict copy is created", "how tombstones flow") — the policy itself is recorded, not redesigned.

### Worked example (same policy, concretely)

Task `01T…` "Buy milk" exists on device A (`deviceId 01JAAA…`) and device B (`01JZZZ…`); both
devices' last-synced **shadow** version is `updatedAt: 1000, deviceId: 01JAAA…` (the version both
have seen).

1. **Concurrent edit (edit vs edit).** A renames to "Buy oat milk" at `updatedAt 2000`
   (`01JAAA`). B, offline, adds notes at `updatedAt 1900` (`01JZZZ`). B later pulls A's version:
   `L (1900, 01JZZZ)`, `R (2000, 01JAAA)`, shadow `(1000, 01JAAA)` — both sides changed since the
   shadow and differ from each other → **unmergeable**. LWW winner is R (`2000 > 1900`): the
   record `01T…` becomes "Buy oat milk" with A's `(updatedAt, deviceId)` preserved byte-for-byte.
   The loser (B's edited version) is materialized as a new task **"Conflict copy of Buy milk"**
   carrying B's notes. B pushes the copy; A pulls it. Nothing was silently overwritten — both
   edits are visible.

2. **LWW tie-break.** Same scenario, but both edits land at `updatedAt 2000`. Then
   `deviceId` decides lexicographically: `01JZZZ… > 01JAAA…`, so **B's** version wins the id and
   A's edit becomes the "Conflict copy of …" row. Deterministic on both devices without talking.

3. **Delete vs edit.** A deletes the task at `updatedAt 2500` (tombstone `deletedAt 2500`); B
   edited it at `updatedAt 2400`. The id follows LWW → the tombstone wins and the task disappears
   from lists; but delete-vs-edit is unmergeable, so B's edit survives as **"Conflict copy of Buy
   oat milk"** (live row, `deletedAt: null`). Deletion propagates via tombstone; the concurrent
   work is never destroyed.

4. **Delete vs delete.** Both tombstone the task (2500 / 2600): the newer tombstone wins by LWW,
   no conflict copy — nothing diverged.

---

## Decision summary (the short version)

| Question | Decision |
|---|---|
| Transport | WebDAV (RFC 4918) via `fetch`: PROPFIND/GET/PUT/DELETE/MKCOL/MOVE + DOMParser; **zero new dependencies** |
| Remote layout | `todo-sync/v1/` with two artifact kinds (§6.2): `snapshots/<takenAt>-<deviceId>.json` + `changes/<deviceId>/<seq>.json` |
| Shared mutable files | **NONE.** Every remote file is written by exactly one device; append-only/immutable → no lost-update races, If-Match is an optimization not a correctness requirement |
| Wire unit | Full-record **state versions** (not field diffs): each op carries the whole record incl. `updatedAt`/`deviceId`/`deletedAt` → merge is order-insensitive and idempotent |
| Integrity | Payload collections transported as JSON **strings** + SHA-256 (WebCrypto `subtle.digest`); torn/corrupt artifacts detectable and skipped |
| Merge | Per-record LWW on `(updatedAt, deviceId)` — greater `updatedAt` wins; tie → greater `deviceId` lexicographically. Deterministic on both sides |
| Unmergeable = | Three-way divergence against a local **sync shadow** (last-synced version per record): both sides changed the record since their common version → LWW winner keeps the id, loser materialized as `Conflict copy of <task>`. Delete-vs-edit = unmergeable → edited version becomes the conflict copy |
| Conflict copies | Tasks only (verbatim §6.2 scope: "<task>"). List conflicts resolve by LWW + a visible sync-log notice (never silent) — lists carry membership (`listId`) and duplicating them scatters tasks |
| Tombstones | Merge like any version (LWW); purge interplay rule: local purge only when >90d **and** pushed-and-snapshotted remotely; stale-device resurrection is a documented accepted residual |
| Scheduling | "Sync now" (always) + periodic-when-online (opt-out toggle; 15 min + `online` event + tab-visible-if-stale), single-flight, exponential backoff |
| Auth | HTTPS-only Basic auth to the user's own server; username + **app password** stored ONLY in local IDB `sync_state` (never exported, never synced, never localStorage); "Forget credentials" action |
| Apply atomicity | Remote data is staged and validated, then applied in ONE IDB `readwrite` tx. Any failure before commit → local byte-identical |
| Encrypted records (stretch) | Plaintext **merge envelope** (`id`, `kind`, `updatedAt`, `deviceId`, `deletedAt`, `payloadHash`) + ciphertext payload; LWW/tombstones run without keys; content merge/conflict copies require the key unlocked (sync defers when locked) |
| Format versioning | `format: "todo-sync/1"`; a client seeing `2+` refuses to touch the remote (protects data written by newer clients) |

---

## Decision 1 — Transport: hand-rolled WebDAV client on `fetch`

`src/sync/webdav.ts` speaks WebDAV over `fetch` — **zero new dependencies** (§7.2: minimal deps;
this also keeps the sync route lazily loaded within §9.2's budget):

- **Methods used**: `OPTIONS` (capability probe), `PROPFIND` (discovery, `Depth: 1`),
  `GET`, `PUT`, `DELETE`, `MKCOL`, `MOVE`. Multi-status `207` responses parsed with the browser's
  own `DOMParser` (no XML dependency).
- **Auth**: `Authorization: Basic base64(user:appPassword)` set per request from in-memory config.
- **HTTPS only.** `http://` remotes are rejected except `localhost`/`127.0.0.1` for development.
  (Secure context is guaranteed by GitHub Pages hosting per §9.5; credentials must never traverse
  plaintext.)
- **Conditional writes**: where the server returns a **strong stable ETag**, `If-Match` /
  `If-None-Match: *` is used as an *optimization*. Correctness never depends on it (Decision 3's
  per-device file ownership removes the shared-file race entirely). If-Match failure (`412`) is
  handled as "re-pull and retry once", then error.
- **Upload verification**: every PUT is followed by read-back verification (GET + byte/hash
  compare) or, where `MOVE` is supported, `PUT <name>.part` → verify → `MOVE` into place.
  Verification failure = the artifact is treated as not-written and retried.
- **CORS (honest constraint)**: a browser-origin client can only reach a WebDAV server that
  allows CORS from the app origin (Nextcloud needs an explicit `Access-Control-Allow-Origin`
  config for the app's origin; `OPTIONS` preflight must pass). This is a *deployment requirement
  on the user's server*, surfaced as error code `CORS` with actionable copy — not something we can
  fix client-side. Recorded as a known adoption friction (Consequences).

*Alternative considered: the `webdav` npm package.* Rejected: hundreds of KB of unneeded surface
(PROPFIND/MKCOL/etc. is ~200 lines for our needs), a dependency to audit for §7.2, and it hides
the exact wire behavior we need to test. Boring hand-rolled client wins.

---

## Decision 2 — Remote file layout (the "snapshot + change manifest" of §6.2)

A **user-configured base collection** (e.g. Nextcloud `/Files/TodoSync/`) — we never assume a
path, and we never own a server. Under it, one directory tree:

```
<base>/todo-sync/v1/
  snapshots/
    1792758000000-01JABC….json      # full state snapshot (immutable, unique name)
  changes/
    01JABC…/                        # one directory per deviceId (ULID)
      0000000001.json               # change batch — immutable, zero-padded seq
      0000000002.json
    01JXYZ…/
      0000000001.json
```

Exactly **two artifact kinds** (mapping §6.2's terms):

1. **Snapshot** — `snapshots/<takenAtMs>-<deviceId>.json`. The full sync-visible state
   (every `List` and `Task` record, including tombstones within retention) as one
   LWW-merged view at `takenAt`. File name is unique per (takenAt, deviceId): never overwritten.
2. **Change manifest** — §6.2's "change manifest" is materialized as **immutable per-device
   change batches** under `changes/<deviceId>/<seq>.json`. One batch = the record versions one
   device pushed in one sync run. `seq` is a per-device monotonic integer (10-digit zero-padded so
   lexicographic order == numeric). Batches are append-only; the SAME `seq` is reused (overwritten)
   only to retry a failed/torn upload of that batch — only the owning device ever writes its own
   directory.

**Core structural property: there is no shared mutable file.** Each device writes only
`changes/<its own deviceId>/` and uniquely-named snapshots. Cross-device concurrency therefore
cannot lose updates: two devices pushing simultaneously write disjoint files. The only
cross-device mutation is compaction `DELETE` (idempotent, safe by rule — Decision 8). This is why
If-Match is an optimization, not a correctness requirement — and why the classic
"one `state.json` rewritten on every push" design was rejected (Alternatives).

**Discovery**: `PROPFIND Depth:1` on `snapshots/` and `changes/` (+ `Depth:1` per device dir).
No index file is required; a device knows its own next `seq` from its local cursor.

### 2.1 Batch format (`kind: "batch"`)

```json
{
  "format": "todo-sync/1",
  "kind": "batch",
  "deviceId": "01JABC…",
  "seq": 7,
  "createdAt": 1792758000000,
  "recordsHash": "sha256-hex",
  "records": "[…JSON string: array of record state versions…]"
}
```

`records` is a **JSON string** (not nested JSON) so `recordsHash` (SHA-256 over the exact string
bytes, WebCrypto `subtle.digest`) is unambiguous — no canonical-JSON spec needed. Each element:

```ts
type SyncRecord = {
  kind: 'list' | 'task';
  record: List | Task;     // EXACTLY the ADR-002 record shape, incl. updatedAt, deviceId, deletedAt
};
```

Full-record **state versions**, not field diffs: merge is per-record LWW over whatever versions a
device has seen, so application order, duplication, and gaps are all harmless (Decision 5).

### 2.2 Snapshot format (`kind: "snapshot"`)

```json
{
  "format": "todo-sync/1",
  "kind": "snapshot",
  "takenAt": 1792758000000,
  "byDeviceId": "01JABC…",
  "covers": { "01JABC…": 7, "01JXYZ…": 3 },
  "stateHash": "sha256-hex",
  "state": "[…JSON string: array of SyncRecord — the LWW-merged state…]"
}
```

`covers` = per-device watermark: this snapshot's `state` already includes every batch with
`seq <= covers[d]` for each device `d`. Snapshots are **bandwidth/compaction only** — correctness
is defined as "union of everything fetched, per-record LWW" (Decision 4), so any snapshot (or
none) converges to the same state.

### 2.3 Format versioning

`format: "todo-sync/1"` on every artifact. Rules: artifacts with an unknown `format` are
**ignored and reported** (`SYNC_FORMAT_UNKNOWN`); a remote containing `todo-sync/2`+ artifacts
puts the engine into error state `SYNC_FORMAT_NEWER` and it **refuses to read or write** that
remote (an old client must never mangle data a newer client understands). Local data untouched.

---

## Decision 3 — Local storage integration (consumes ADR-002)

- **Records**: `lists` + `tasks` exactly per ADR-002. The merge engine reads/writes them through
  `AppDB.tx` **raw** (`put` does no stamping — ADR-002 Decision 10), preserving remote
  `updatedAt`/`deviceId`/`deletedAt` byte-for-byte. **Merge-applied rows never go through repo
  stamping** (stamp-on-write would make every local record win LWW and silently discard remote
  edits). Repo stamping remains the rule for *user mutations* only.
- **New store `sync_state`** (singleton key `'sync'`), added by the documented migration chain
  (ADR-002 Decision 8): `idbVersion 2` / `schemaVersion 2`, one additive step, pre-migration
  snapshot as specified. Shape:

```ts
type SyncState = {
  id: 'sync';
  enabled: boolean;
  remoteUrl: string;            // https origin + base path of the user's WebDAV
  remoteUser: string;
  remotePassword: string;       // app password; Decision 7 — local-only, never exported
  autoSync: boolean;            // periodic-when-online toggle (default true)
  deviceId: string;             // mirror of meta.deviceId (convenience)
  cursor: {
    pull: Record<string, number>;  // deviceId -> highest contiguous batch seq fetched+merged
    snapshotKey: string | null;    // newest snapshot filename merged ('' = none)
    pushedUpTo: number;            // epoch ms watermark for push scans (Decision 5)
  };
  shadow: Record<string, { updatedAt: number; deviceId: string; contentHash: string }>;
                               // per-record LAST-SYNCED version — the merge base for
                               // "did both sides change?" detection (Decision 5)
  lastSyncAt: number | null;
  lastError: SyncErrorCode | null;
};
```

- `sync_state` is **local-only**, exactly like `meta`/`settings`/`snapshots` (ADR-002 Decision 5
  excludes them from sync). It is excluded from export files, snapshots, and remote payloads —
  the remote never sees our credentials or cursors.
- Shadow entries are pruned when their record is hard-purged. Shadow is metadata-only
  (`updatedAt` + `deviceId` + content hash) — bounded at ≤ one small entry per record.

---

## Decision 4 — Merge engine (client-side only)

Merge is a **pure function** over versions; side effects happen only in the single apply
transaction. `src/sync/merge.ts` is dependency-free and exhaustively unit-tested (§9.5 ≥80%).

### 4.1 LWW comparison (verbatim §6.2 rule, made total)

For two versions of one record id, `winner = maxBy(v -> (v.record.updatedAt, v.record.deviceId))`:
greater `updatedAt` wins; on **equal** `updatedAt`, greater `deviceId` wins **lexicographically**
(Crockford base32 ULIDs are ASCII-ordered). Deterministic on every device, so every device reaches
the same winner from the same set of versions. Versions that are *identical* (`updatedAt` +
`deviceId` equal) are the same version — deduped, nothing to decide.

### 4.2 What counts as "unmergeable" → conflict copy (the shadow test)

LWW alone always picks a winner — which would silently discard the loser's edits. §6.2 forbids
silent overwrite, so we need a definition of *unmergeable*. Decision: a **three-way test** against
the record's **sync shadow** (the last version both sides are known to have seen — the local
copy's last-synced state):

For record `id` with local version `L`, remote version `R` (either may be absent), shadow `S`:

| Case | Condition | Outcome |
|---|---|---|
| Only remote changed | `L == S` (or `L` absent) | Take `R` (create/update/tombstone locally) |
| Only local changed | `R == S` (or `R` absent) | Keep `L`; push it |
| Same change | `L == R` | No-op; advance shadow |
| **Concurrent edit** | `L ≠ S`, `R ≠ S`, `L ≠ R`, both live | **Unmergeable** → LWW winner keeps `id`; loser materialized as `Conflict copy of <task>` |
| **Delete vs edit** | One side tombstoned since `S`, other side edited since `S` | **Unmergeable** → tombstone outcome follows LWW on the record id, but the edited live version is materialized as `Conflict copy of <task>` so the edit is never lost |
| Delete vs delete | both tombstoned since `S` | No-op (newer tombstone wins by LWW) |

`==` on versions means equal `updatedAt` + `deviceId` (same version); `contentHash` (ADR-002
record content hash) additionally detects "both sides made the *same* content change" and demotes
that to `Same change`. Where shadow `S` is missing (first sync with a device, or pruned), the
conservative rule applies: differing `L`/`R` versions are treated as **concurrent edit** —
conflict copies are the safe direction (visible, never lost data).

### 4.3 Conflict-copy creation (verbatim policy made mechanical)

Applies to **`Task` records** (§6.2 says "Conflict copy of <task>"). `List` conflicts are resolved
by LWW with a **visible sync-log notice** ("'<name>' — your change to this list lost to a newer
edit from device <id>") — never silent, but no row copy: lists carry membership (`listId`), and a
duplicated list would be an empty shell scattering task membership. (ADR-002 Decision 5 already
scoped conflict copies to "a normal Task row".)

The **losing version** is materialized as a new Task:

- `id`: fresh ULID (conflict copies are new records; they sync out like any local create).
- `title`: `"Conflict copy of " + loser.title`, truncated to the ADR-002 1000-char cap.
- All other fields copied from the **losing version** (`listId`, `notes`, `status`, `priority`,
  `dueDate`, `tags`, `sortOrder`…), except: `createdAt`/`updatedAt` = now, `deviceId` = this
  device, `deletedAt` = null (a tombstone is never copied into a visible row).
- The winner keeps the original `id` and its own `updatedAt`/`deviceId` untouched.
- Both rows appear immediately in the UI; the run summary reports `conflictsCreated: n` and the
  engine enters `conflicts-pending` (Decision 9) until acknowledged.

Concurrent conflict-copy creation on two devices is possible (both materialize their own copies
with distinct ULIDs); the user may see two copies after both sync. Accepted, deterministic, and
visible — never data loss.

### 4.4 Apply = one transaction

The merge output is a **plan**: `[{op:'put', record}…, {op:'hard-delete'? no}]` plus shadow/cursor
updates plus conflict-copy rows, all validated through `validate.ts` (ADR-002 Decision 11) BEFORE
the transaction opens. Applying is one `AppDB.tx(['lists','tasks','sync_state'], 'readwrite', …)`:
all-or-nothing. If the tx aborts (`TX_ABORTED`, quota, crash) **nothing** changed locally and the
cursor does not advance — the next run re-fetches and re-merges (idempotent).

---

## Decision 5 — Pull/push flow (one sync run)

Single-flight (a run in flight → later triggers coalesce onto it). Phases:

1. **Preflight** — sync enabled? credentials present? `navigator.onLine`? not already running?
   → otherwise skip (auto) or error (manual).
2. **Probe & ensure layout** — `OPTIONS`/`PROPFIND` base; `MKCOL` `todo-sync/`, `v1/`,
   `snapshots/`, `changes/<our deviceId>/` as needed (idempotent).
3. **Discover** — `PROPFIND` `snapshots/` and `changes/` (Depth 1, then per-device Depth 1).
4. **Pull** — fetch the **newest snapshot not yet merged** (ignore corrupt/hash-mismatched ones,
   fall back to older + batches — see Decision 6), then every batch with `seq > cursor.pull[d]`
   per device, in seq order. Gaps are tolerated: LWW union is order-insensitive (a missing seq is
   picked up on a later run; re-fetching a merged batch is a no-op).
5. **Merge** (pure, in memory) — fold fetched versions + local state through Decision 4 using the
   shadow; produce the apply plan (winners, conflict copies) + updated shadow/cursor.
6. **Apply** — one `readwrite` tx (Decision 4.4). Local data changes HERE and only here.
7. **Push** — scan local records with `updatedAt >= cursor.pushedUpTo - OVERLAP` (OVERLAP = 5
   min; re-pushing a version is idempotent, so the overlap is a cheap guard against
   scan-commit races). Batch ≤ 500 records per file; write `changes/<deviceId>/<seq>.json` with
   read-back verification; reuse the same `seq` on retry. Advance `cursor.pushedUpTo` to
   `scanStartedAt - OVERLAP` only after the batch(es) verify. Push covers tombstones too.
8. **Update shadow** for every record this run observed/pushed.
9. **Compact** (cheap check, Decision 8) — maybe take a snapshot and prune covered batches.
10. **Report** — `SyncRunSummary` → UI state (Decision 9). Any failure in 1–5, 7, 9 leaves
    local data byte-identical (6 never ran) or exactly the merged plan (6 committed atomically);
    push/compaction failure never rolls back a successful merge — local is already correct.

**Ordering guarantee**: merge-before-push every run, so a device always pushes a state that has
absorbed what it pulled (converging rather than ping-ponging).

---

## Decision 6 — Failure semantics (normative)

**Invariant: a sync failure never damages local data.** Concretely:

- Everything before Phase 6 performs **zero local writes** (fetch/merge are read-only + pure).
- Phase 6 is one atomic tx — partial application is impossible.
- Phases 7/9 failing after a successful merge leaves the merged local state in place (it is
  correct and self-sufficient) and reports the error.
- Remote-side partial artifacts are detectable and harmless: batch/snapshot payloads are JSON
  strings with SHA-256 hashes; a torn upload fails parse or hash check and is **ignored**
  (and retried by its owner with the same `seq`/name). A corrupt remote file never reaches the DB.
- A remote artifact with `format: "todo-sync/2"+` → engine halts with `SYNC_FORMAT_NEWER`
  (Decision 2.3). Never best-effort-merge a format we don't understand.
- Sync is **never required for local correctness** (§6.2 verbatim): every local feature works with
  sync disabled, broken, or never configured. Sync status is advisory UI, never a gate.

### Error taxonomy (the UI-facing contract)

`SyncError = { code, message, retryable, detail? }` — codes (all also written to the local
error log per ADR-002 Decision 10.4; **no telemetry**, §7.2):

| Code | Meaning | UI behavior |
|---|---|---|
| `CONFIG` | no/invalid remote URL (non-HTTPS), missing credentials | Error state → open sync settings |
| `AUTH` | 401/403 from the server | Error state, prompt re-enter credentials; never blind-retry with same creds |
| `CORS` | preflight/blocked by the user's server CORS policy | Error state with setup guidance (the known adoption friction, Decision 1) |
| `NETWORK` | offline, DNS, TLS, timeout, 5xx | Error state, `retryable`, auto-retry with backoff |
| `REMOTE_MISSING` | base collection gone / PROPFIND failed | Error state; offer "re-initialize remote" |
| `CONFLICT_WRITE` | `412` If-Match failure | Auto re-pull + retry once, then error |
| `CORRUPT_REMOTE` | unparseable/hash-mismatch artifact, bad `covers` | Error state naming the artifact; local untouched |
| `SYNC_FORMAT_UNKNOWN` | one artifact, unknown format | Skip artifact + warning in sync log |
| `SYNC_FORMAT_NEWER` | remote has `todo-sync/2+` | Hard stop (Decision 2.3) |
| `REMOTE_FULL` | 507 / quota on the server | Error state; suggests cleaning remote |
| `LOCAL_STORAGE` | IDB error at apply | Error state; nothing applied (tx aborted) |
| `LOCKED` | encryption enabled but key locked (stretch) | Sync defers; not an error banner (Decision 8) |
| `ABORTED` | teardown/navigation | Silent; next run resumes from cursor |

---

## Decision 7 — Auth & credentials

- **Basic auth over HTTPS only** (Decision 1). OAuth/cloud-provider flows are the stretch epic —
  out of V1 (Q2).
- Recommended credential: a **Nextcloud app password** (revocable, scoped) rather than the
  account password — stated in the setup UI copy.
- Stored **locally only**: `sync_state.remoteUser/remotePassword` in IndexedDB. Never in
  localStorage (ADR-002 Decision 7 forbids non-pref data there), never in exports/snapshots
  (Decision 3), never sent anywhere except the user-configured remote origin.
- A **"Forget credentials"** action clears them and disables sync without touching task data.
- Known trade-off, recorded plainly: at rest the app password is **plaintext in the origin's
  IndexedDB** until the stretch encryption epic (C1/ADR-007) adds a key. The trust boundary is
  the browser profile (§7.1) — an attacker with full profile access already has the task data
  itself. If the user wants the password protected at rest today: don't store it (re-enter per
  session is a supported mode — the password can be held in memory only).

---

## Decision 8 — Tombstones: propagation and purge interplay

- Tombstones are ordinary sync records (`deletedAt` set): they **propagate like any version** and
  win/lose LWW like any version (§6.2 verbatim: "deletions propagate via tombstones").
- **Delete-vs-edit is unmergeable** (Decision 4.2): the edit becomes a `Conflict copy of <task>`;
  the id itself follows LWW (usually the tombstone). Deleting is therefore never a silent data
  destroyer of concurrent work.
- **Purge interplay** (with ADR-002 Decision 6's 90-day/explicit purge). The hazard: a tombstone
  hard-purged (locally or in a compacted remote) while some device still holds the older live
  version lets that version re-appear ("resurrection"). Rules:
  1. **Push before purge**: a local tombstone must have been **successfully pushed** before any
     local purge may touch it.
  2. **Snapshot before remote prune**: compaction may remove batches only when a verified
     snapshot covers them (Decision 9); snapshots **always retain tombstones** in `state` —
     compaction never deletes tombstone information from the remote.
  3. **Local purge** (auto 90-day or explicit "Clean up storage"): allowed only for tombstones
     that are >90d old AND covered by a remote snapshot this device has verified (or the user has
     explicitly confirmed "Clean up storage", whose confirm copy restates the risk — ADR-002
     already requires this wording).
  4. **Accepted residual**: a device that stays offline **>90 days** (or one whose user ran
     explicit cleanup) and then pushes an old live version can resurrect a deleted task. It is
     visibly a normal task again and can be re-deleted; LWW timestamps keep newer tombstones
     winning in every non-stale case. Same accepted trade-off class as ADR-002's "old import can
     resurrect rows" — documented, warned about in the cleanup copy, not silently ignored.

---

## Decision 9 — Scheduling & engine API (what the sync UI consumes)

### 9.1 Scheduling

- **"Sync now"** — always available when configured; runs the full flow (Decision 5).
- **Periodic-when-online** (§6.2 verbatim: "user-triggered or periodic-when-online"): when
  `enabled && autoSync` (default **true**; toggle in sync settings):
  - every **15 min** while `navigator.onLine` and the tab is visible;
  - immediately on the `online` event;
  - on tab becoming visible if `lastSyncAt` is older than the interval;
  - **not** when `navigator.connection?.saveData` is true (data-budget respect; manual still works).
- Single-flight: overlapping triggers coalesce. Failure backoff: 1 min → 5 min → 30 min cap,
  reset on success. `AUTH`/`CONFIG`/`SYNC_FORMAT_NEWER` errors **disable auto-retry** until the
  user acts (no credential guessing, no hammering).

### 9.2 Engine API (contract for the sync UI card)

```ts
type SyncState =
  | { status: 'idle'; configured: boolean; autoSync: boolean;
      lastSyncAt: number | null; lastRun: SyncRunSummary | null }
  | { status: 'syncing'; phase: 'probe'|'pull'|'merge'|'apply'|'push'|'compact'; startedAt: number }
  | { status: 'error'; error: SyncError; lastSyncAt: number | null; retryAt: number | null }
  | { status: 'conflicts-pending'; conflicts: ConflictSummary[];
      lastSyncAt: number | null; lastRun: SyncRunSummary };

type ConflictSummary = { recordId: string; title: string; copyId: string;
                         lostTo: { updatedAt: number; deviceId: string } };

type SyncRunSummary = {
  startedAt: number; finishedAt: number; trigger: 'manual' | 'auto';
  pulled: { snapshots: number; batches: number; records: number };
  pushed: { batches: number; records: number };
  applied: number; conflictsCreated: number; compacted: boolean;
};

interface SyncEngine {
  configure(cfg: { remoteUrl: string; user: string; password: string }): Promise<Result<void, SyncError>>;
  runSync(trigger: 'manual' | 'auto'): Promise<Result<SyncRunSummary, SyncError>>;
  state(): Signal<SyncState>;            // @preact/signals (ADR-001) for the UI binding
  listConflicts(): ConflictSummary[];
  acknowledgeConflicts(): void;          // conflicts-pending -> idle
  setAutoSync(on: boolean): void;
  forgetCredentials(): Promise<Result<void, SyncError>>;
}
```

`conflicts-pending` is sticky after a run that created conflict copies and clears on
acknowledgement (the copies themselves are normal tasks and need no cleanup). All results are
`Result` (team baseline — no throwing across boundaries).

---

## Decision 10 — Encrypted-record interop (constraint on ADR-007, the child decision)

The stretch encryption epic must merge under this protocol **without breaking LWW**. This ADR
fixes the envelope contract; ADR-007 chooses the crypto and must stay consistent with it.

**Envelope split** (applies to `Task` and `List` records when encryption is on):

```ts
type EncryptedSyncRecord = {
  kind: 'list' | 'task';
  record: {
    id: string;                      // plaintext — identity for merge
    kind: 'list' | 'task';
    updatedAt: number;               // plaintext — LWW key
    deviceId: string;                // plaintext — LWW tie-break
    deletedAt: number | null;        // plaintext — tombstone propagation
    payloadHash: string;             // plaintext — sha256 of `payload` (change detection)
    enc: { alg: 'AES-GCM'; v: 1; iv: string };   // plaintext crypto envelope
    payload: string;                 // CIPHERTEXT of everything else
  };
};
```

Rules the protocol guarantees from this split:

1. **LWW, tombstone propagation, and the shadow three-way test operate on the plaintext envelope
   only.** They never need the key. `payloadHash` replaces content comparison in the shadow test.
2. **Tombstones propagate even when locked** (they carry no payload). Deletion is never blocked by
   encryption state.
3. **Content merge and conflict-copy creation require the key unlocked.** A conflict copy of an
   encrypted task decrypts the loser, prepends `"Conflict copy of "` to the title, and re-encrypts
   into the new record (identical UX to plaintext). When locked, the engine defers with
   `LOCKED` (Decision 6) — it never fabricates a copy it cannot name, and never drops the merge.
4. **Degraded equality detection (accepted)**: identical concurrent edits cannot be detected for
   encrypted payloads (re-encryption changes bytes; `payloadHash` sees "changed"). The shadow test
   conservatively reports **concurrent edit → conflict copy**. Direction is safe: a possibly-
   redundant visible copy instead of any silent loss.
5. **Constraint on ADR-007**: either the payload must be copyable **verbatim** into a conflict
   copy (i.e. no record-id-bound AAD), or copies are re-encrypted while unlocked (3). ADR-007
   picks one and states it; it may not leave record-id-bound AAD *and* require verbatim copies.

---

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Single mutable `state.json` (full state per push) + If-Match | One file; trivial reads | Concurrent pushes clobber each other unless every server honors If-Match/ETags correctly (many WebDAV servers don't); rewrites whole dataset per push | Correctness must not depend on server ETag fidelity (Decision 2's per-device files remove the race structurally) |
| Per-record remote files (one file per task) | Fine-grained | PROPFIND/GET explosion at 10k+ tasks; most servers choke on huge collections | Batch files bound request counts (≤500 records/batch) |
| Field-level diffs (op logs: "set title=X") | Small deltas | Needs op ordering/compensation semantics; replay bugs = data corruption | Full-record state versions are idempotent, order-insensitive, trivially correct |
| CRDTs (Yjs/Automerge) | Textbook auto-merge | Explicitly out (C8); heavy deps; opaque conflict UX | §6.2 verbatim: "CRDTs are explicitly out" |
| Server-side merge | — | We operate no server (WON'T/Q2) | N/A |
| `webdav` npm client | Saves ~200 lines | Dependency surface (§7.2), bundle cost, hides wire behavior | Hand-rolled fetch client, fully testable |
| RFC 6578 `sync-collection` REPORT for discovery | Efficient incremental PROPFIND | Spotty server support; fallbacks needed anyway | Plain PROPFIND Depth:1 works everywhere; change batches already incremental |
| Shadow-free merge (pure LWW, always overwrite loser) | No shadow bookkeeping | Every concurrent edit silently discards the loser — forbidden by §6.2 | Shadow gives the three-way test that makes "unmergeable" well-defined |
| Conflict copies for `List` too | Symmetric | Duplicates empty lists, scatters `listId` membership | Tasks only (verbatim policy wording); lists get a visible sync-log notice instead |

---

## Consequences

**Positive**
- Structurally race-free remote: no shared mutable file, append-only batches → no lost updates
  between pushing devices without relying on server-specific ETag behavior.
- Convergence is provable and testable: "union of fetched versions, per-record LWW" is
  commutative/associative/idempotent; snapshots are pure optimizations.
- No silent data loss by construction: the shadow test turns every concurrent edit (and
  delete-vs-edit) into a visible conflict copy.
- One atomic apply tx gives the §6.2 guarantee for free: sync failure = local untouched.
- Zero new dependencies; the sync route can be lazy-loaded inside the §9.2 bundle budget.

**Negative / accepted costs**
- **CORS on the user's WebDAV server is a real setup requirement** (Decision 1) — adoption
  friction we can only document and surface clearly (`CORS` error with guidance). Honest cost of
  a browser-only client with no backend.
- Shadow map maintenance (one small entry per record) — bounded and prunable; simplifies away a
  class of silent-overwrite bugs.
- Conflict copies can be created twice (once per device) in a true concurrent edit — visible
  duplicates, acceptable.
- App password is plaintext at the origin at rest until C1 (Decision 7) — documented, with a
  memory-only mode for the privacy custodian.
- Batches re-pushed within the 5-min overlap are redundant bytes — bounded, idempotent, cheaper
  than correctness bookkeeping.

**Risks & mitigations**
- *Scope creep (R3)* → this ADR is the whole protocol; impl cards implement exactly it and may
  not extend the wire format without a superseding ADR.
- *Server zoo (WebDAV quirks)* → capability probe + read-back verification + hash-checked
  artifacts; failure injection tests (below) cover torn writes and corrupt files.
- *Stale-device resurrection* → Decision 8 rules + documented residual + cleanup confirm copy.

---

## Offline-first test plan (contract for impl/test cards)

**Unit (Vitest; ≥80% coverage on `merge.ts`, `shadow.ts`, batch codec — §9.5):**
1. **Merge matrix** (table-driven, recorded in the test file): two-device convergence; LWW
   tie-breaks (`updatedAt` equal → `deviceId` lexicographic); concurrent-edit conflict-copy
   creation; delete-vs-edit → conflict copy; delete-vs-delete; identical-change demotion;
   missing-shadow conservative rule; list LWW + notice (no copy).
2. **Property tests**: N devices × random op sequences, repeated "pull all → apply" in random
   orders/duplications/gaps → all devices converge to identical state; merge is commutative,
   associative, idempotent (fuzz with fast-check or hand-rolled seeded generator — zero-dep rule).
3. **Codec**: batch/snapshot round-trip; `recordsHash`/`stateHash` mismatch detection; torn-file
   fixtures (truncated JSON); unknown `format` skip; `todo-sync/2` hard stop.
4. **Tombstone/purge interplay**: push-before-purge gate; snapshot-retains-tombstones; stale-device
   resurrection scenario reproduced and asserted as documented behavior.
5. **Cursor/overlap**: scan-commit race simulation (record updated during push with older
   `updatedAt`) → picked up via OVERLAP; seq-gap tolerance; retry-reuses-seq idempotency.

**Failure injection (evidence artifact: local export before/after must be byte-identical):**
unreachable server (fetch reject + timeout), 401, 500 mid-run, torn batch upload (half-written
file on the "server"), corrupt snapshot (bad hash), `507` remote full, IDB apply failure
(fault-injected tx abort), `SYNC_FORMAT_NEWER`. Each asserts: error state surfaced, local data
byte-identical (except runs where the atomic apply legitimately committed), cursor consistency.

**Fake WebDAV server fixture** (in-memory, Vitest): GET/PUT/DELETE/PROPFIND/MKCOL/MOVE + 207
multistatus + fault-injection hooks. No real network in any test (§7.2/§6.1).

**E2E (Playwright, two browser contexts = two devices, run offline for the local loop per §9.5):**
create/edit on A → push → pull on B → visible convergence; concurrent edit → exactly one visible
"Conflict copy of …"; delete-vs-edit → edit preserved as copy; sync while offline → error state +
data intact; disable sync → all local features unaffected (§6.2 guarantee).

**Determinism**: injectable clock and deterministic ULIDs in tests (ADR-002 Decision 5).

---

## Contracts other cards must implement against (normative summary)

1. **Conflict policy is pre-decided (§6.2 verbatim above)** — implement exactly; never redesign.
   LWW on `(updatedAt, deviceId)`; tombstones propagate; unmergeable conflicts materialize as
   visible `"Conflict copy of <task>"` rows; CRDTs out.
2. **Wire format is `todo-sync/1` exactly as specified** (Decision 2) — batch/snapshot shapes,
   JSON-string payloads + SHA-256, per-device `changes/` dirs, immutable uniquely-named snapshots.
   Any change needs a superseding ADR (R3).
3. **Remote writes only touch**: `changes/<own deviceId>/`, uniquely-named `snapshots/`, and
   compaction `DELETE`s that satisfy Decision 8. Never rewrite another device's files.
4. **Merge-applied records bypass repo stamping** — preserve remote `updatedAt`/`deviceId`/
   `deletedAt` byte-for-byte (Decision 3).
5. **One atomic apply tx** over `['lists','tasks','sync_state']`; cursors advance only on commit
   (Decision 4.4). Sync failure must leave local data untouched — tested by byte-identity
   evidence (test plan).
6. **`sync_state`** arrives via the ADR-002 Decision 8 migration chain (idbVersion 2 /
   schemaVersion 2, additive, pre-migration snapshot); it is local-only and excluded from
   exports/snapshots/remote.
7. **Error contract**: `Result` + the `SyncError` codes of Decision 6, mapped 1:1 onto the four
   UI states of Decision 9 (`idle`/`syncing`/`error`/`conflicts-pending`).
8. **Encrypted-record envelope** (Decision 10) is binding on ADR-007 — plaintext merge metadata +
   `payloadHash`, lock-defer on content merge, tombstones work locked.

## Task result handoff (impl cards)

**t_00d7f17b — Impl: WebDAV sync engine & conflict copies (S9)** builds, in this order:
1. Migration: `sync_state` store (ADR-002 chain rules).
2. `src/sync/webdav.ts` (transport, Decision 1) + fake-WebDAV test fixture.
3. `src/sync/batchCodec.ts` (Decision 2 formats + hashing).
4. `src/sync/shadow.ts` + `src/sync/merge.ts` (Decision 4 — pure, merge-matrix tests first).
5. `src/sync/engine.ts` (Decision 5 flow, cursors, scheduling 9.1) + `state.ts` (Decision 9 API).
6. Failure-injection suite + byte-identity evidence (test plan).
Acceptance (from the card): ≥80% on merge/conflict modules, recorded merge test matrix
(two-device convergence, LWW tie-breaks, conflict-copy creation, tombstone propagation), failure
injection leaves local byte-identical, engine API documented for the sync UI card.

**Sync UI card (child of the engine card)** consumes ONLY Decision 9's `SyncEngine`/`SyncState`
API — the four states, conflict acknowledgement, and the setup form (remote URL, user, app
password, "forget credentials", auto-sync toggle).

**t_55accc9c — ADR-007 Encryption (stretch)** must stay consistent with Decision 10 (envelope
split, lock semantics, and the AAD-vs-verbatim-copy choice it must make explicitly).

## Testing contract (summary)
See "Offline-first test plan" above — it is normative for the impl/test cards (merge matrix,
property convergence tests, codec/torn-file fixtures, tombstone-purge interplay, failure
injection with byte-identity evidence, fake WebDAV fixture, two-device Playwright E2E).

## Links
- PROJECT_ANALYSIS.md §6.2 (binding sync/conflict policy + guarantees), §5.2 (storage strategy),
  §11 R3 (scope-creep risk), §2 + §4 WON'T (no server we operate), §12 Q1/Q2 (PO decisions),
  §7.1–7.2 (threat model, no-telemetry, dependency policy), §9.2/§9.5 (budgets, test bar)
- ADR-002 (storage schema — record shapes, tombstones, migration chain, `Result` contract),
  ADR-001 (UI stack: Preact + signals, Vitest/Playwright)
- Kanban: epic E8 decomposition t_1b9ee0e6; this card t_6e4bb440 (sole decider);
  child decisions: t_00d7f17b (engine impl), t_55accc9c (ADR-007 encryption)
