# Sync engine API (handoff from t_00d7f17b — contract for the sync UI card t_5f4fe7db)

Implementation of **ADR-006** (`docs/adr/ADR-006-webdav-sync.md`, BINDING — the sole protocol
decider) in `src/sync/`. This document is the normative surface for the sync UI card: consume
**only** `src/sync/index.ts` + this file. The four UI states, conflict acknowledgement and the
setup form are the whole contract — nothing else in `src/sync/` is yours to depend on.

**Hard boundaries (do not re-decide):** the conflict policy is PRE-DECIDED (PROJECT_ANALYSIS §6.2:
per-record LWW on `(updatedAt, deviceId)`; tombstone deletions; unmergeable conflicts materialize
as visible `"Conflict copy of <task>"` rows — never a silent overwrite; CRDTs out). The UI
surfaces and resolves copies — **it never re-merges**. Sync failure leaves local use completely
unaffected (error state only); sync is never required for local correctness. Credentials live in
the browser profile only (there is no account system, nowhere to send them).

## 1. The four states (ADR-006 Decision 9.2, verbatim)

```ts
type SyncState =
  | { status: 'idle'; configured: boolean; autoSync: boolean;
      lastSyncAt: number | null; lastRun: SyncRunSummary | null }
  | { status: 'syncing'; phase: 'probe'|'pull'|'merge'|'apply'|'push'|'compact'; startedAt: number }
  | { status: 'error'; error: SyncError; lastSyncAt: number | null; retryAt: number | null }
  | { status: 'conflicts-pending'; conflicts: ConflictSummary[];
      lastSyncAt: number | null; lastRun: SyncRunSummary };
```

- `idle` — resting state. `configured` gates the setup wizard vs the status surface.
- `syncing` — one run in flight; `phase` maps 1:1 onto the Decision 5 phases (show progress).
- `error` — `error.code` selects copy (table §3). `retryAt` is `null` when auto-retry is off
  (`AUTH`/`CONFIG`/`SYNC_FORMAT_NEWER`) — show "fix and retry manually", not a countdown.
- `conflicts-pending` — **sticky** after a run that created conflict copies; clears only via
  `acknowledgeConflicts()`. The copies themselves are normal tasks (no cleanup needed).

## 2. `SyncEngine` (Decision 9.2 + two additive seams, marked)

```ts
const engine = new SyncEngine({ db, fetch?, now?, newId?, errorLog?, env? });

configure({ remoteUrl, user, password, remember? }) // remember:false = memory-only password (D7)
probe()                                            // ADDITIVE: wizard connection test (OPTIONS only)
runSync(trigger: 'manual' | 'auto')                 // single-flight; overlapping triggers coalesce
state(): Signal<SyncState>                         // @preact/signals binding
listConflicts(): ConflictSummary[]
acknowledgeConflicts(): void
setAutoSync(on: boolean): void
forgetCredentials(): Promise<Result>               // clears creds + disables sync; task data untouched
dispose()                                          // teardown (schedulers/listeners)
```

- `runSync` resolves `{ ok: true, value: SyncRunSummary }` or `{ ok: false, error: SyncError }`
  (team baseline: `Result`, nothing throws). Auto triggers that skip (offline, backoff, saveData,
  autoSync off) resolve `ok` with a zeroed summary and change **no** state.
- `SyncRunSummary = { startedAt, finishedAt, trigger, pulled {snapshots,batches,records},
  pushed {batches,records}, applied, conflictsCreated, compacted, notices }` — the `notices`
  array is the ONE additive field (Decision 9.2 sketch had no transport for Decision 4.3's
  "visible sync-log notice"); everything else is verbatim ADR.
- `ConflictSummary = { recordId, title, copyId, lostTo: { updatedAt, deviceId } }`.

## 3. Error codes (Decision 6 — map 1:1 onto copy; never swallow)

| code | meaning | UI behavior |
|---|---|---|
| `CONFIG` | no/invalid remote URL (non-HTTPS), missing credentials | error state → open sync settings |
| `AUTH` | 401/403 from the server | prompt re-enter credentials; auto-retry disabled |
| `CORS` | request blocked (browser cannot distinguish CORS from DNS/TLS — `detail` says so) | setup guidance (Nextcloud `Access-Control-Allow-Origin` for the app origin) |
| `NETWORK` | offline, timeout, 5xx | `retryable` — countdown to `retryAt` |
| `REMOTE_MISSING` | base collection gone | offer "re-initialize remote" |
| `CONFLICT_WRITE` | 412 If-Match | engine re-pulls once automatically; surface only if it repeats |
| `CORRUPT_REMOTE` | unparseable/hash-mismatched artifact, mixed kinds | name the artifact (in `detail`); local untouched |
| `SYNC_FORMAT_UNKNOWN` | one artifact, unknown format | skipped + warning in the sync log |
| `SYNC_FORMAT_NEWER` | remote has `todo-sync/2+` | hard stop — "written by a newer version" |
| `REMOTE_FULL` | 507 quota on the server | suggest cleaning the remote |
| `LOCAL_STORAGE` | IDB failure (apply aborted — nothing was changed) | point at the storage dashboard |
| `LOCKED` | encryption key locked (ADR-007 seam; not produced yet) | quiet defer, NOT an error banner |
| `ABORTED` | teardown/navigation | silent; next run resumes from cursors |

Every code is also written to the local error log (ADR-002 §10.4) — no telemetry (§7.2).

**CSP precondition (ADR-006 Addendum A, 2026-10-26).** The `CORS`/`NETWORK` guidance above is
only honest if the shipped CSP lets these requests leave the browser at all. It now does:
`connect-src 'self' https: http://localhost:* http://127.0.0.1:*` — exactly the engine's own
allow-list (`assertSecureRemote`: any https host; plain-HTTP loopback, "localhost excepted" as in
the `CONFIG` row). Before this widening, `connect-src 'self'` blocked every cross-origin attempt
at the policy layer and every failure surfaced as `CORS`/`NETWORK` blaming the user's server
(defect B2). If `connect-src` is ever narrowed again, this table silently becomes misleading —
the smoke e2e pins the policy value exactly to prevent that.

## 4. What the engine does on its own (Decision 9.1 — do not duplicate in the UI)

- With `enabled && autoSync` (default **on**): every 15 min while online+visible, immediately on
  the `online` event, and on tab-visible when `lastSyncAt` is stale. Never while
  `navigator.connection.saveData`. "Sync now" always works.
- Single-flight (overlapping triggers coalesce onto one promise). Failure backoff 1m → 5m → 30m
  cap, reset on success. `AUTH`/`CONFIG`/`SYNC_FORMAT_NEWER` suspend auto-retry **until the user
  acts** (`configure` re-arms).
- One run = probe → discover → pull → merge → **one atomic apply tx** → push → compact → report.
  Phases before `apply` write nothing locally; `apply` is all-or-nothing; push/compaction failures
  after a committed merge are reported but never rolled back (the merged state is correct).

## 5. Conflict-copy surfacing (the UI's whole conflict job)

- Every `"Conflict copy of <task>"` row is a **normal task** (fresh ULID, the losing version's
  content, `deletedAt: null`, stamped with the creating device). List conflicts and displaced
  deletes surface as `SyncRunSummary.notices` (`list-conflict` / `delete-lost`) — no row copy.
- Suggested resolve actions (UI-level bookkeeping only — the engine needs no call):
  **keep both** (do nothing), **keep the copy** (delete the original task row), **discard the
  copy** (delete the copy row). Deleting is the ordinary tombstone path — it propagates.
- The engine materializes a copy exactly when a merge would displace a locally-diverged LIVE
  version (the §6.2 "never a silent overwrite" promise). The winner keeps the id and its own
  `(updatedAt, deviceId)` byte-for-byte.

## 6. Opt-in boundary & credentials

- **Nothing touches the network before `configure()`** — asserted in `engine-api.test.ts` S1
  (zero requests before setup). `probe()` is only ever called by the wizard, after the user typed
  the URL+credentials (that request IS part of setup).
- Credentials: Basic over HTTPS only (localhost excepted for dev). Stored in IDB `sync_state`
  (never localStorage, never exports/snapshots/remote — asserted E11). `remember: false` keeps the
  password in memory for the session (Decision 7's supported mode). "Forget credentials" clears
  them and disables sync without touching task data (asserted S5).
- Strings via `t()` (en+th) in the UI layer; the engine returns codes + English `message`/`detail`.

## 7. Testing seams

- `tests/unit/sync/fixtures.ts` exports `makeFakeWebDav()` (in-memory WebDAV with
  fault-injection: `reject`, `failStatus`, `failAfter`, `tornPut`, `corruptGet`, `hidePath`),
  `makeTask`/`makeList` (validator-clean rows), `bootDb()`, `stateOf()`, `runEngine()`,
  `counterIds()` (deterministic copy ids), `T0` (virtual-clock base — stamp fixture rows near it).
- `SyncEngine` takes `env: SchedulerEnv` (interval/listener/online/visible/saveData seams) and
  `now`/`newId` for determinism. See `engine-api.test.ts` for the wiring pattern.

## 8. Reviewer notes (interpretations recorded for the gate)

1. **Copy materialization** = "preserve-before-overwrite": a copy appears exactly when the merge
   would displace a locally-diverged LIVE version. Worked example 1's "B pushes the copy; A pulls
   it" + the test plan's "exactly one visible Conflict copy" both hold only under this reading
   (Decision 4.3's "the losing version is materialized" + "a tombstone is never copied into a
   visible row"). Displaced LIST rows and displaced DELETES become visible `notices` instead
   (never silent). Recorded matrix row M13 asserts the one-copy fleet-wide property.
2. **Delete-vs-edit, edit-newer case**: the edit keeps the id; the displaced delete is a
   `delete-lost` notice (a tombstone is never copied into a visible row).
3. **Cursor fields** `pushedSeq` / `remoteCoveredUpTo` are additive to Decision 3's sketch but
   required by Decision 2 ("a device knows its own next seq from its local cursor") and Decision 8
   rule 3 (purge gate); `SyncRunSummary.notices` carries Decision 4.3's mandated notices.
4. **Corrupt artifacts**: a torn/hash-mismatched BATCH fails the run (CORRUPT_REMOTE, local
   byte-identical — the acceptance evidence); a corrupt SNAPSHOT is skipped with a warning and
   the run falls back to older snapshots + batches (Decision 5's explicit wording).
5. **Purge interplay** (Decision 8): with sync enabled, auto-purge needs >90d AND pushed AND
   covered by a verified remote snapshot (`tombstonePurgeAllowed`); explicit "Clean up storage"
   stays the documented escape. Without sync, ADR-002 behaviour is unchanged.

## 9. Module map (for reviewers; not a UI dependency)

| module | ADR decision | contents |
|---|---|---|
| `src/sync/types.ts` | 2/6/9 | wire + engine API types |
| `src/sync/hash.ts` | 1/2 | WebCrypto SHA-256, stable stringify, shadow `contentHash` |
| `src/sync/batchCodec.ts` | 2 | `todo-sync/1` batch/snapshot codec + format versioning |
| `src/sync/webdav.ts` | 1 | fetch transport (PROPFIND/GET/PUT/DELETE/MKCOL), verified uploads |
| `src/sync/shadow.ts` | 4.2 | the three-way shadow test (pure) |
| `src/sync/merge.ts` | 4 | pure merge planner + conflict-copy construction |
| `src/sync/engine.ts` | 5/6 | run phases, cursors, atomic apply, push, compaction |
| `src/sync/state.ts` | 9 | `SyncEngine` + scheduling |
| `src/storage/syncState.ts` | 3 | the `sync_state` singleton row helpers |
| `src/storage/purge.ts` | 8 | tombstone purge gate (`tombstonePurgeAllowed`) |
