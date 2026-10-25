# E1 QA — Storage wrapper, migrations & boot validation (corruption drills)

**Card:** t_ae894274 (Test: Storage wrapper & corruption drills), Epic E1 · **Reviewer of record:** h_reviewer
**Date:** 2026-10-23 · **Refs:** PROJECT_ANALYSIS.md §5.4 (schema versioning/migrations), §5.5 (quota),
§9.3 (reliability), §10 E3/E4 (quota + corrupt record/failed migration failure modes)

## 0. Scope, environment and how to reproduce

This report drills the failure modes of the M12 storage framework (`src/storage`, impl card
t_eba4b531, commits `25a25d3`/`8a70fda`/`f5e7706`) and records measured unit coverage for the
wrapper and migration modules.

| Item | Value |
|---|---|
| Subject under test | `src/storage/**` at HEAD `f5e7706` in the shared working tree |
| Test suites | impl suite `tests/unit/storage/*.test.ts` (87 tests) + QA drill suite `tests/unit/storage/drills-qa.test.ts` (17 tests, added by this card) = **104 tests, all green** |
| Reproduce drills | `npx vitest run tests/unit/storage/drills-qa.test.ts` |
| Reproduce full suite | `npx vitest run tests/unit/storage` |
| Reproduce coverage | `npx vitest run tests/unit/storage --coverage --coverage.include='src/storage/**'` |
| Raw evidence | `docs/qa/e1-storage-logs/` (verbatim run logs + a real sample recovery file) |
| Known tree caveat | `tsc -b` on the shared tree currently fails only inside `src/portability/**` (sibling card's live in-progress work, not committed and not part of this subject; all storage files and test files typecheck clean) |

## 1. Coverage — measured figures (gate: ≥80% on wrapper + migration modules)

Command: `npx vitest run tests/unit/storage --coverage --coverage.include='src/storage/**'`
(log: `docs/qa/e1-storage-logs/coverage-run.txt`, 104 tests, v8 provider)

| File | % Stmts | % Branch | % Funcs | % Lines | ≥80 gate |
|---|---|---|---|---|---|
| **All src/storage** | **94.73** (791/835) | **91.58** (490/535) | **98.66** (148/150) | **97.09** (701/722) | PASS |
| db.ts (wrapper) | 92.44 | 92.63 | 95.34 | 93.83 | PASS |
| migrations.ts | 97.69 | 86.58 | 100 | 100 | PASS |
| snapshots.ts | 96.38 | 91.22 | 100 | 100 | PASS |
| boot.ts | 90.66 | 86.04 | 100 | 91.42 | PASS |
| quarantine.ts | 94.11 | 80.00 | 100 | 100 | PASS |
| validate.ts | 96.95 | 95.52 | 100 | 99.32 | PASS |
| purge.ts | 91.42 | 86.36 | 100 | 100 | PASS |
| orderKey.ts | 94.44 | 95.00 | 100 | 95.74 | PASS |
| id.ts | 90.56 | 84.61 | 100 | 92.85 | PASS |

Baseline before this card's drills (impl suite only): 93.17 stmts / 89.53 branches / 96.66 funcs /
96.12 lines. The drill suite raised statements +1.56pp and branches +2.05pp and closed the
wrapper's `blocked()` path (db.ts 436-454), the snapshots error paths and the double-failure
migration path (migrations.ts 114) that the impl suite left uncovered.

## 2. Drill results per failure mode

All drills are executable tests in `tests/unit/storage/drills-qa.test.ts` (names below are test
titles; verbatim run: `docs/qa/e1-storage-logs/drills-run.txt`, 17/17 green).

### Drill 1 — Migration interrupted mid-chain → rollback via pre-migration snapshot

Registry `v2` (tasks notes backfill) → `v3` (list rename) → `v4` (writes a row, then fails) on a
seeded v1 database (2 lists, 2 tasks, settings, meta).

| Check | Expected | Actual |
|---|---|---|
| `boot()` result | `err(MIGRATION_FAILED)` `{from: 1, to: 4}` | PASS |
| lists/tasks/settings/meta after rollback | byte-equivalent to the v1 seed (verified via non-destructive raw IDB reads; NO trace of the v2 notes backfill, the v3 rename, or the failing step's `NEVER VISIBLE` write) | PASS |
| Rollback evidence | 1 snapshot left in `snapshots`, `kind: 'auto'`, `reason: 'pre-migration'` | PASS |
| DB stays usable | second boot with the fixed chain migrates cleanly `{from: 1, to: 3}`, data transformed, `meta.schemaVersion` 3 | PASS |
| Variant: step wipes `meta` mid-step | `err(MIGRATION_FAILED)`, meta restored byte-equivalent, no crash | PASS |
| Variant: rollback itself fails (codec deserializer injected broken) | `err(MIGRATION_FAILED)` whose `cause` carries BOTH `stepError` and `rollbackError` (migrations.ts:114 path) | PASS |

Note: the byte-equivalence check had to read meta through raw IDB — the shared test fixture's
`openFixtureDb` rewrites meta on every open, which makes meta-level assertions through it
vacuous (defect **D5**; the impl suite's rollback test is affected).

### Drill 2 — Corrupt records quarantined to a downloadable, loadable recovery file

Dataset: 1 valid task + 3 invalid tasks (impossible `dueDate: '2026-02-30'`, 1001-char title,
unknown `hacked` field).

| Check | Expected | Actual |
|---|---|---|
| Boot on corrupt data | `ok`, no crash, `bootReport.quarantined === 3` | PASS |
| Silent drop | NONE: all 4 rows still in the DB (`readUnfiltered`), invalid ones only denylisted from app reads | PASS |
| Recovery file produced | `quarantine.recoveryFile()`, filename `recovery-YYYYMMDD-HHMMSS.json` | PASS |
| Recovery file **loadable** | written to disk, re-read, `JSON.parse` succeeds after a real disk round-trip | PASS |
| Records verbatim | every quarantined record deep-equals the DB row; every entry carries non-empty `issues`; `generatedAt` + `schemaVersion` present | PASS |
| Only exit is explicit purge | `quarantine.purge()` deletes exactly the 3 quarantined rows, valid row untouched, list empties, `bootReport.quarantined` back to 0 | PASS |

A real generated file is kept as evidence: `docs/qa/e1-storage-logs/sample-recovery.json`
(generated from a mixed dataset; invalid rows carry the record verbatim plus e.g.
`"dueDate: format (YYYY-MM-DD (real calendar day))"`).

### Drill 3 — QuotaExceededError propagation as a typed error

Fault-injection: `IDBObjectStore.put` throws a `QuotaExceededError`-named DOMException.

| Surface | Expected | Actual |
|---|---|---|
| `AppDB.put` | `err(QUOTA_EXCEEDED)`, `cause` preserved (DOMException) | PASS |
| `tx(..., 'readwrite', ...)` | `err(QUOTA_EXCEEDED)` | PASS |
| `takeSnapshot` | `err(QUOTA_EXCEEDED)` | PASS |
| `restoreSnapshot` | `err(QUOTA_EXCEEDED)` | PASS |
| `purgeTombstones` (auto stamp path) | `err(QUOTA_EXCEEDED)` | PASS |
| `boot()` bookkeeping (step 5) | boot stays `ok` (non-fatal by design) and `bootWarnings` carries `{step: 'lastOpenedAt'}` + `{step: 'purge'}`, both `QUOTA_EXCEEDED` — nothing swallowed | PASS |

Two contract deviations on adjacent paths (NOT swallowed, but miscoded/observability):
boot's meta read/seed wraps quota in `UNKNOWN` (**D3**), and a failed purge stamp loses the purge
count although the deletions committed (**D6**). See §5.

### Drill 4 — Boot validation on a mixed valid/invalid dataset

Dataset across stores: valid task + valid list; invalid task (`dueDate`), invalid list (bad
`color`), invalid settings (`theme: 'neon'`); one 91-day tombstone, one 1-day tombstone.

| Check | Expected | Actual |
|---|---|---|
| Boot | `ok`; `migrated: null`, `newerSchema: null`, `bootWarnings: []` | PASS |
| Quarantine count | `quarantined === 3` (task + list + settings) | PASS |
| Boot purge | `purgedTombstones === 1` (only the >90d one) | PASS |
| Valid rows | live via `getAll`/`query` across stores | PASS |
| Invalid rows | invisible to `get`/`getAll`/`query`, still present via `readUnfiltered` | PASS |
| Recovery file | accounts for exactly the 3 quarantined rows, one per store | PASS |

### Drill 5 — Tombstone purge timing (>90 days / explicit clean-up)

| Check | Expected | Actual |
|---|---|---|
| Constants | `TOMBSTONE_TTL_MS === 90d`, `PURGE_INTERVAL_MS === 24h` | PASS |
| Auto TTL boundary | purges `deletedAt` strictly older than 90d; a tombstone at EXACTLY 90d is kept (matches §5.4 "older than 90 days"); 89d kept | PASS |
| Never collateral | live rows (`deletedAt: null`) and snapshots never touched | PASS |
| Auto throttle | second auto pass within 24h returns 0 without touching rows; after `PURGE_INTERVAL_MS` the pass runs | PASS |
| Explicit "Clean up storage" | purges ALL tombstones immediately, any age (1h and 200d drilled), across `lists` and `tasks`, live rows untouched | PASS |

### Drill 6 — Snapshot restore works like a feature (take → corrupt → restore)

Flow: boot (migrated to v2) → create list/task/settings → `takeSnapshot(manual)` → corrupt
(mutate a task title, delete a list, delete settings, add a junk task) → `restoreSnapshot`.

| Check | Expected | Actual |
|---|---|---|
| Data restored | lists/tasks/settings deep-equal the pre-corruption state; junk row gone | PASS |
| Device identity | `meta.deviceId` unchanged (ADR-002 Decision 3.1) | PASS |
| Schema version | `meta.schemaVersion` reset to the payload's (2) | PASS |
| Evidence kept | the snapshot still exists in `listSnapshots` after restoring it | PASS |
| Torn write shape | snapshot metadata without payload → typed error (`UNKNOWN`, message names the id), never a crash | PASS |

### Drill 7 — Wrapper resilience (coverage-gap drills)

| Check | Expected | Actual |
|---|---|---|
| Another tab holds an older version | `openRawAppDB` resolves `err(BLOCKED)` (typed, actionable — never a hang), connection not leaked | PASS |
| Snapshot reads on a closed DB | `listSnapshots`/`getSnapshotPayload`/`restoreSnapshot` return typed errors, never throw | PASS |
| Corrupt snapshot payload | codec deserializer failure on restore → typed `UNKNOWN` error, data untouched | PASS |

## 3. Explicit attestation — invalid records never vanish silently

**Confirmed.** In every drill the framework honored the non-destructive quarantine contract:
boot validation never crashes and never deletes; invalid rows remain in the database (visible via
`readUnfiltered`), are excluded from app reads by the denylist, and are exported verbatim into a
recovery JSON file that was produced, parsed after a disk round-trip, and matched record-for-record
against the database (Drill 2). The ONLY way a quarantined record leaves the database is an
explicit `quarantine.purge()` user action — and that action has one edge hazard of its own
(defect **D2**: it can also delete the `meta`/`settings` singletons).

## 4. Contract-deviation probes

While writing the drills, four assertions encoding the DOCUMENTED contract (docs/dev/storage-api.md
+ ADR-002) were run against the implementation and failed. Verbatim output:
`docs/qa/e1-storage-logs/probe-contract-deviations.txt` (temporary probe file deleted after
capture; the committed suite stays green).

| Probe | Documented contract | Actual |
|---|---|---|
| P1 | `Tx.get/getAll` exclude quarantine-denylisted rows (storage-api.md "Read filtering") | `Tx.get` returns the quarantined row verbatim; `Tx.getAll`, `AppDB.get/getAll/query` filter correctly |
| P2 | `meta.deviceId` stays with the profile across purge + reboot (ADR-002 Decision 3.1) | deviceId re-seeded to a fresh ULID after `quarantine.purge()` + reboot |
| P3 | `QuotaExceededError` always surfaces as `QUOTA_EXCEEDED` ("no caller may swallow QUOTA_EXCEEDED") | fresh-boot meta seeding under quota exhaustion returns `UNKNOWN` |
| P4 | corrupt `meta.schemaVersion` boots without bogus migration bookkeeping | `bootReport.migrated = {from: 0.5, to: 1}` and a spurious pre-migration snapshot on every boot (no crash, no data loss) |

## 5. Defect list

| ID | Severity | Type | Summary | Evidence | Fix | Tracked by |
|---|---|---|---|---|---|---|
| D1 | MEDIUM | read-contract | `TxImpl.get` (src/storage/db.ts:371-374) does not apply the quarantine denylist — invalid rows leak to any code reading by key inside a transaction (repos, migration steps), violating the documented "Tx.get/getAll exclude denylisted rows" contract. All other read surfaces filter correctly. | `probe-contract-deviations.txt` P1 | add the same `#denied` check `AppDB.get` uses (db.ts:290) to `TxImpl.get`; add a regression drill (probe P1 can become the test) | fix card below |
| D2 | MEDIUM | data-safety | `quarantine.purge()` hard-deletes quarantined `meta`/`settings` singletons (quarantine.ts:94-105 → db.ts:348). When meta itself is corrupt and quarantined, purge + reboot silently re-seeds meta with a NEW `deviceId` — device identity reset, contradicting ADR-002 Decision 3.1 ("meta.deviceId never restored / identity stays with the profile"). | `probe-contract-deviations.txt` P2 | purge must skip the singletons (or re-seed meta preserving `deviceId`/`createdAt` from the quarantined record); add a regression drill | fix card below |
| D3 | LOW | error-contract | boot's meta read/seed catch blocks (src/storage/boot.ts:82-83, 108-109) wrap failures in `unknownError(e)` instead of `classifyUnknown(e)`, so a first-run `QuotaExceededError` surfaces as `UNKNOWN` and the §5.5 export/cleanup dialog contract (`QUOTA_EXCEEDED`) misses it. | `probe-contract-deviations.txt` P3 | classify in both catch blocks (or route through `classifyUnknown`); regression drill | fix card below |
| D4 | INFO | robustness | A corrupt non-integer `meta.schemaVersion` (e.g. 0.5) boots without crashing (good) but yields a bogus `bootReport.migrated` and takes a spurious pre-migration snapshot on EVERY boot until meta is fixed. No data loss. | `probe-contract-deviations.txt` P4 | consider validating meta before the migration comparison (fold into the D2 meta-handling fix) | fix card (optional) |
| D5 | LOW | test-infrastructure | `openFixtureDb` (tests/unit/storage/fixtures.ts:101-108) unconditionally overwrites `meta` with a fresh `makeMeta()` when called without an explicit meta — reopening a DB "for inspection" silently rewrites `deviceId`/`createdAt` and masks meta-level corruption. Consequence: the impl suite's rollback assertion (`boot.test.ts` ~163-167: `expect(meta.value?.schemaVersion).toBe(1)` after `openFixtureDb`) is vacuous — the fixture rewrites meta before the read. Data rollback is still genuinely tested. | P2 initial observation + boot.test.ts source | `openFixtureDb` should read-and-keep existing meta (or only seed when meta is absent); flip the affected assertion to raw reads as drills-qa.test.ts does | fix card (optional) |
| D6 | INFO | observability | `purgeTombstones` auto pass commits the per-store deletions BEFORE stamping `meta.lastPurgeAt` in a second transaction (purge.ts:46-70). If the stamp fails (quota), the pass returns `QUOTA_EXCEEDED` and boot reports `purgedTombstones: 0` although the rows WERE purged. No live-data loss (tombstones are deletion artifacts); only the count/throttle state is lost. | drills-qa.test.ts "boot survives quota exhaustion…" (asserts the exact semantics) | return the purged count even when stamping fails (or stamp inside the same transaction per store) | fix card (optional) |
| D7 | MEDIUM | spec-drift vs ADR-004 | The boot recovery file's shape deviates from **ADR-004 Decision 7 (binding)**: implemented `buildRecoveryFile` (src/storage/quarantine.ts:63-84) emits `{generatedAt, schemaVersion, note, quarantine:[{store, key, record, issues}]}` with filename `recovery-YYYYMMDD-HHMMSS.json`, while the ADR mandates `serializeRecoveryDoc(entries, source, meta)` producing `{"format":"local-first-todo-recovery", formatVersion, schemaVersion, createdAt, deviceId, source:{kind:"boot-validation", fileName:null, fileSchemaVersion}, entries:[{store, id\|null, issues, raw}]}` with filename `local-first-todo-recovery-<UTC>.json` — and names that function "the **only** recovery-file writer" that "E1's boot-validation quarantine calls". Unlike `fallbackRawCodec`, the placeholder status is not flagged anywhere (docs/dev/storage-api.md documents the shape as if final). Two "recovery" formats in the wild is an E1↔E3 integration hazard. | `docs/adr/ADR-004-export-import-format.md` Decision 7 vs src/storage/quarantine.ts + docs/qa/e1-storage-logs/sample-recovery.json | ADR-004 module map places the writer in `src/portability/recovery-document.ts` (E3 card): implement `serializeRecoveryDoc`, rewire `quarantine.recoveryFile()` to call it, and update Drill 2's shape-level assertions in tests/unit/storage/drills-qa.test.ts (the loadable/verbatim/no-silent-drop contract assertions carry over) | E3 card t_a7c2087f (commented) |

## 6. Verdict

**PASS with findings.** All six corruption-drill failure modes demanded by the card are exercised
by executable tests and behave to contract: mid-chain migration interruption rolls back via the
pre-migration snapshot byte-equivalent (including meta) and the DB remains migratable; corrupt
records are quarantined non-destructively and exported to a downloadable, loadable recovery file
(records verbatim, explicit purge as the only exit); QuotaExceededError surfaces as a typed
`QUOTA_EXCEEDED` on every write surface and in boot warnings; boot validation on a mixed
valid/invalid dataset quarantines exactly the invalid rows across stores while purging >90d
tombstones; tombstone purge timing honors the 90-day TTL (strict), the 24h throttle and the
explicit clean-up; snapshot restore restores the exact data while keeping device identity. Measured
coverage on wrapper + migration modules is well over the 80% gate (db.ts 92.44/92.63 stmts/branches,
migrations.ts 97.69/86.58).

Six defects are recorded (2 MEDIUM, 2 LOW, 2 INFO); none of them causes silent data loss or a
crash. D1 and D2 are contract violations that should be fixed before the E2 repo layer and the E3
data-safety features build on these paths; D3-D6 are smaller hardening/observability items.

**Seventh finding (D7, MEDIUM, spec-drift):** the boot recovery file's shape and filename deviate
from ADR-004 Decision 7 (binding `serializeRecoveryDoc` writer) without being flagged as a
placeholder — routed to the E3 card t_a7c2087f which owns `src/portability/recovery-document.ts`;
see §5.
