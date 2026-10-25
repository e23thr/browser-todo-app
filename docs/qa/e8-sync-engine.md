# Epic E8 (V1) — WebDAV sync: merge, LWW & failure-injection QA

**Card:** t_beed2e01 · **Run:** h_reviewer · **Date:** 2026-10-26 · **Scope:** `src/sync/`,
`src/storage/syncState.ts`, the `sync_state` migration/validation seams, and the recorded test
matrices of the impl card (t_00d7f17b, commit `fed96f5`).

**Verdict:** **The merge/failure guarantees hold in every scenario the engine's own matrix
scripts — and FAIL in the one delivery order that matrix does not script. 1 blocking defect
(E8-D1): in the reverse order (loser pushes before pulling) a concurrent edit is discarded with
no "Conflict copy" and no notice — silent data loss against PROJECT_ANALYSIS §6.2.** A second
blocking item is integration-level (E8-D2): `format:check` still fails **at HEAD** on two files
whose Prettier drift was introduced by `fed96f5` — `npm run ci`'s first gate, so no push until
it is greened (the test/typecheck redness measured at `fed96f5` was resolved by E7's `6370493`,
re-measured below). Everything else — LWW fidelity, conflict-copy
shape, tombstone propagation + 90-day purge gate, byte-identical failure injection, opt-in
boundary, ≥80% merge/conflict coverage — verified first-hand and green.

Method: every claim below re-verified **first-hand**, not re-read from the handoff — a new
independent probe suite (`tests/unit/sync/e8-qa-probes.test.ts`, 14 tests: 12 green + 2
`it.fails` defect repros), an **independent byte-identity oracle** (`node:crypto` over a
self-written canonical dump — deliberately not `src/sync/hash`), the in-memory fake WebDAV
server (no real network, no third-party service), and a **clean clone of `fed96f5`** for
committed-state gates. Evidence: `docs/qa/e8-sync-engine-logs/`.

---

## 1. Recorded merge matrix (spec → observed)

Oracle for "expected": PROJECT_ANALYSIS §6.2 (binding, pre-decided) + ADR-006 §4.2/§4.3 table.
E = impl's recorded matrix/engine tests, Q = this card's independent probes.

| # | Scenario (both delivery orders where it matters) | Expected per §6.2 / ADR-006 | Observed | Source | Verdict |
|---|---|---|---|---|---|
| 1 | Concurrent edit, **A pushes first** (E3, worked example 1) | LWW winner keeps id + stamps byte-for-byte; loser becomes exactly one visible `Conflict copy of <task>` carrying the loser's content | Winner keeps id/stamps; B's `notes: soy` preserved in `Conflict copy of Buy milk`; identical copy id on both devices; winner side creates nothing | E3 + Q1 setup | **PASS** |
| 2 | Concurrent edit, **B pushes first** (reverse order) | Same as row 1 — delivery order must not change the outcome | **Zero** conflict copies fleet-wide; A's rename wins on both devices; B's `notes: soy` is gone from every device's row set (only the already-consumed remote batch `changes/<B>/0000000002.json` still contains it) | **Q1** (`it.fails`), trace `d1-reverse-order-trace.log` | **FAIL → E8-D1** |
| 3 | LWW tie-break: equal `updatedAt` → greater `deviceId` | Comparator decides; deterministic on both devices without talking | `compareLww` verified antisymmetric/total (M2); end-to-end both devices converge on the `deviceId`-winning row with byte-equal state (digest check) | M2 + Q2 | **PASS (convergence)** |
| 4 | Tie-break **copy**: the losing device materializes its version | Loser's row survives as one visible copy | Reverse-order run: **no copy on either device** — same root cause as row 2 (both devices had pushed their tie-stamped edit) | **Q2** (`it.fails`) | **FAIL → E8-D1** |
| 5 | Delete vs edit, edit wins the id (worked example 3b) | Edit keeps the id; the displaced **delete** surfaces as a visible `delete-lost` notice — never a row copy, never silent | A-first order: notice emitted (M5) — PASS. Reverse order (delete pushed first): **no notice anywhere**; the deleted task silently reappears with the edit | M5 vs trace scenario 2 (`d1-reverse-order-trace.log`) | **FAIL (reverse) → E8-D1** |
| 6 | Delete vs edit, tombstone wins the id | Tombstone wins the id; the edit survives as a live copy with `deletedAt: null` | Copy created, `deletedAt: null`, notes preserved (M4 + E4 end-to-end) | M4, E4 | **PASS** |
| 7 | Delete vs delete | Newer tombstone wins; nothing diverged → no copy, no notice | Exactly that (M6) | M6 | **PASS** |
| 8 | Identical content under different stamps | "Same change" demotion → no copy | No copy/notice (M7 + Q3 case 7) | M7, Q3 | **PASS** |
| 9 | Missing shadow + differing versions | Conservative → visible copy (safe direction) | One copy (M8 + Q3 case 10) | M8, Q3 | **PASS** |
| 10 | Stale local echo (local older than shadow, content differs) | LWW already decided; ADR/shadow.ts documents "stale echo" | No copy, `only-remote-changed` applied — matches the documented rule (see O2) | Q3 case 11 | **PASS (documented)** |
| 11 | List conflict | LWW + **visible notice**, never a row copy (membership safety) | Winner applied, `list-conflict` notice with the loser's title, 0 copies | M9, Q3 | **PASS** |
| 12 | Only-local / only-remote / nothing changed | Fold keeps the right side; push later; no copy | `puts`/`copies` exactly as specified (M10–M12 + Q3 cases 2, 8, 9) | M10–M12, Q3 | **PASS** |
| 13 | **"Never a silent overwrite" invariant** (this card's own formulation) | whenever a locally-held live version is displaced and it is not the shared base → a visible copy **or** notice must exist | Holds for all 11 hand-enumerated divergence cases (incl. missing-shadow and delete pairs), **except** the shadow-advanced-by-own-push case of row 2 (not expressible planner-level) | Q3 | **PASS (matrix) / FAIL (engine, row 2)** |
| 14 | Conflict copies are ordinary rows | Fresh ULID, loser content minus the LWW key, validates and syncs out | Copy row id ≠ original, `updatedAt = now`, `deviceId` = copying device, `validateRow` clean; copies propagate to the peer as plain creates (E3 fleet assertion, Q1 digest convergence) | M14, E3 | **PASS** |
| 15 | Order-insensitivity / idempotence of the planner | Delivery order, duplication, gaps do not change the plan; repeated merges are idempotent | Seeded property run (P1: 3 devices × random op rounds converge; P2: commutative/associative/idempotent) green | P1, P2 | **PASS** |
| 16 | Repeated sync rounds after convergence | No churn, no duplicate copies | Two extra full rounds per device leave the byte digest unchanged with exactly one copy (Q1, stable half) | Q1 | **PASS** |

**Tombstone propagation + 90-day purge interplay** (ADR-006 Decision 8), verified green:

- Delete propagates to the peer as a row-level tombstone (`deletedAt` set) in **both** delivery
  orders, converges byte-for-byte after one more round, and is never materialized as a visible
  row (Q6, two tests).
- Rule 1: an **unpushed** tombstone is never auto-purged; rule 2: a pushed tombstone still needs
  verified remote **snapshot** coverage before auto-purge; rule 3: explicit "clean up storage"
  remains the documented escape — all asserted (`tombstone-purge.test.ts`, 6 tests green),
  including the end-to-end propagation + snapshot-retention case.
- Compaction prunes only batches the verified snapshot covers and the snapshot retains every
  local tombstone (E7 green).

## 2. Failure injection — byte-identity evidence

Oracle: SHA-256 (`node:crypto`) over a **self-written** canonical dump (sorted keys) of
`lists` + `tasks` (tombstones included), rows sorted by id, taken before/after each run — plus
an explicit `toEqual` on both row sets, plus cursor-consistency assertions
(`pushedSeq`/`pushedUpTo`/`snapshotKey`/`remoteCoveredUpTo` unchanged, no `pull[d]` advanced
past pre-run values, `lastError` recorded).

| Case | Injection | Error surfaced | User rows | Cursors | Source |
|---|---|---|---|---|---|
| Unreachable server | `fetch` rejects | `CORS`/`NETWORK`, retryable | byte-identical | unmoved | Q5 (independent digest) |
| Timeout / abort | `AbortError` | `NETWORK`, retryable | byte-identical | unmoved | Q5 |
| 401 wrong credentials | status 401 | `AUTH`, **not** retryable | byte-identical | unmoved | Q5 |
| **Quota on the remote** | status 507 | `REMOTE_FULL` | byte-identical | unmoved | Q5 |
| 500 mid-run | fails after 4 requests | `NETWORK` | byte-identical | unmoved | Q5 |
| Partial upload (torn PUT of our own push, nothing merged) | half-stores every PUT | `NETWORK` (read-back mismatch, retried once first) | byte-identical | unmoved | Q5 |
| Corrupt remote batch (`recordsHash` tampered) | forged batch | `CORRUPT_REMOTE`, not retryable | byte-identical | unmoved | Q5 |
| Hash-valid but semantically invalid remote record (`status: 'nope'`) | valid hash, invalid row | `CORRUPT_REMOTE` **before** the tx opens | byte-identical | unmoved | **Q4 (new)** |
| Torn/partial batch on the server, corrupt snapshot, `todo-sync/2`, `SYNC_FORMAT_NEWER`, 500 mid-run, fault-injected real apply-tx abort, push-after-committed-merge | F5/F7/F9/F10/F11… | per Decision 6 | byte-identical (F11: *exactly the merged plan*, documented exemption) | F10/F11 as specified | `failure-injection.test.ts` F1–F11, re-run green |

Notes recorded from the runs (non-blocking):

- A run that reaches phase 6 with an **empty** plan still persists cursor bookkeeping
  (`pull[own] = pushedSeq = 0`); nothing advances past unapplied work. The byte-identity
  guarantee covers user data (`lists` + `tasks`), which held in every case.
- Corrupt **snapshot** → skipped with a visible notice, run continues (F7); corrupt **batch** →
  run refuses (`CORRUPT_REMOTE`) before apply (F5/F6/Q5) — matches ADR-006 Decision 6 verbatim.
- Zero network happens before `configure` (engine-api S1/P1) — opt-in boundary green.

## 3. Coverage figure (acceptance: ≥80% on merge/conflict modules)

Sync-scoped coverage run, 2026-10-26 03:53 (`coverage-sync-scope.log`; `src/sync` thresholds
reported **0 errors** — the domain/storage/portability errors in that log are artifacts of
scoping the run to the sync tests):

| Module | Stmts | Branch | Funcs | Lines | Gate |
|---|---|---|---|---|---|
| `src/sync/merge.ts` | 98.41 | 95.34 | 100 | 98.24 | ≥80 strict ✓ |
| `src/sync/shadow.ts` | 100 (18/18) | 100 (34/34) | 100 (3/3) | 100 | ≥80 strict ✓ |
| `src/sync/batchCodec.ts` | 82.60 | 82.81 | 90.90 | 87.93 | ≥80 strict ✓ |
| `src/sync/engine.ts` | 84.16 | 63.79 | 100 | 89.85 | aggregate floor ✓ (see O1) |
| `src/sync/state.ts` | 84.23 | 72.46 | 70.58 | 85.34 | ✓ |
| `src/sync/webdav.ts` | 89.09 | 82.66 | 85.71 | 92.39 | ✓ |
| `src/sync/hash.ts` | 95.83 | 80.00 | 100 | 100 | ✓ |
| **`src/sync` aggregate** | **86.97** | **77.50** | **88.33** | **90.04** | 80/70/80/80 ✓ |

Cross-check on the whole tree (2026-10-26 03:24, `full-suite-minus-stale-storage.log`): full
suite minus the three stale storage files — **105 files / 1141 tests passed, exit 0**, i.e.
every configured coverage threshold (domain, storage, portability, sync) passed on a real full
run; `src/sync` aggregate there: 86.70 / 76.66 / 88.33 / 89.73.

## 4. First-hand gate runs

| Run | Result |
|---|---|
| Sync scope: `vitest run tests/unit/sync tests/unit/storage/sync-state.test.ts` (03:59) | **10 files, 99 passed + 2 expected-fail** (the E8-D1 repros), exit 0 — 87 impl tests (81 `src/sync` + 6 `sync_state`) + 12 green probes |
| New probe suite alone | 14 tests: 12 pass, 2 `it.fails` (D1), eslint `--max-warnings 0` clean, `tsc -b` clean, prettier clean |
| Full suite (workspace, 03:24) minus the 3 stale storage files | 1141/1141 pass, coverage thresholds green (exit 0) |
| **Clean clone of `fed96f5`** (04:00, `clean-clone-fed96f5-gates.log`) | `npm test` **RED** — 68 failures / 14 files · `npm run lint` **exit 0** · `npm run typecheck` **RED** — 70 errors · `npm run format:check` **RED** — 3 files |
| **Clean clone of HEAD `3261721`** (04:08, `head-gates.log`) | `npm test` **exit 0** — 106 files / **1166 passed + 2 expected-fail** · `lint` **exit 0** · `typecheck` **exit 0** · **`format:check` exit 1** — `src/domain/model.ts` + `vite.config.ts` (the only gate still red at HEAD, see E8-D2) |
| Workspace gates while siblings run (03:54–04:08) | moving target by design: `tsc -b` 0 → 21 errors and `eslint .` 0 → 57 errors depending on which sibling WIP is on disk (sync-UI card in flight); committed-state numbers above are the authoritative ones |

## 5. Defects

### E8-D1 — BLOCKING — reverse delivery order silently drops the losing version (§6.2 "never a silent overwrite")

**Impact:** data loss. In the natural "loser syncs first" order a concurrent edit disappears
from every device with no conflict copy and no notice; a delete that lost to a newer edit is
undone with no `delete-lost` notice.

**Repro (edit-vs-edit, both devices offline from the common ancestor):**

1. A creates the task + list → sync A → sync B (ancestor shared).
2. A renames to `Buy oat milk` @`T0+2000`; B adds `notes: soy` @`T0+1900` (LWW loser).
3. **Sync B first** (its edit is pushed), then sync A, then sync B again.
4. Observed: `runB-push conflicts:[]`, `runA2 conflicts:[] notices:[]`, `runB2 conflicts:[]
   notices:[] applied:1`; final rows on **both** devices = `Buy oat milk / notes:null`.
   B's `soy` exists only in `changes/<B>/0000000002.json`, whose seq both devices have already
   consumed (A pulled it, B skips its own) — it will never be merged again and is prunable by
   Decision 8 compaction. Trace: `e8-sync-engine-logs/d1-reverse-order-trace.log`.
5. Second manifestation (same root cause): B **deletes** @`T0+2500` and pushes first, A edits
   @`T0+2600` → both devices end with the live edited row, **zero** notices (`DEL runB2 …
   n:[]`), i.e. the delete resurrects silently.

**Root cause (two halves that only both matter in this order):**

- ADR-006 Decision 5 step 8 advances the **shadow for records the run merely pushed**. After
  B's push run, `shadow[TASK] = B's own edit`, so on the next pull `local == shadow` → the
  three-way test classifies `only-remote-changed` → the newer remote version is applied with no
  copy and no notice (`merge.ts` copy block is guarded by `localLoses`, which cannot fire).
- On the winner side the copy block is likewise skipped: A pulled B's edit while holding the
  LWW winner, so `localLoses === false` and the displaced **remote** loser is discarded.
  ADR-006 §4.2's own row says *concurrent edit → loser materialized as `Conflict copy`* — the
  loser here is the remote version.

**Why the existing 87 tests miss it:** `merge-matrix.test.ts` M13 proves "both orders" at the
**planner** level with a fixed base shadow (it never models a push run mutating the shadow),
and `engine.test.ts` E3/E4 script only the A-first order, where the loser always *pulls before
pushing*. The scripted flows are correct; the matrix is incomplete.

**Required outcome:** delivery order must not change the guarantee — after both devices
converge, the loser's edit is visible exactly once (copy) or the delete loss is announced
(notice), with the ADR-006 constraints preserved: exactly one visible copy fleet-wide, winner
stamps byte-for-byte, a tombstone never copied into a visible row, list conflicts still
notice-only. Fix belongs to the implementation (h_senior_coder); if the resolution needs
ADR-006 Decision 5 step 8 / §4.2 wording to change, the ADR decider signs off — R3 forbids
re-deciding the §6.2 policy itself.

**Repro probes committed:** `tests/unit/sync/e8-qa-probes.test.ts` → `Q1` and `Q2` are
`it.fails` **while the defect is open** (they assert the spec outcome and therefore fail).
They flip to RED the moment the conflict copy comes back — replace `it.fails` with `it` and
keep the body as the regression test.

### E8-D2 — BLOCKING for push — `format:check` is red at HEAD (integration)

Measured on clean clones (both logs in §7):

- **At `fed96f5` (04:00, `clean-clone-fed96f5-gates.log`)** — four gates red/green:
  `npm test` **RED** (68 failures / 14 files: stale schema-version expectations
  `boot.test.ts`/`drills-qa.test.ts` vs `APP_SCHEMA_VERSION = 3`, plus the portability/tabSync/
  repos/validate updates that rode uncommitted), `npm run typecheck` **RED** (70 errors:
  `fed96f5` landed `Priority = 'P1'|'P2'|'P3'|'P4'` while the numeric-priority UI updates stayed
  uncommitted), `npm run lint` exit 0, `npm run format:check` **RED** (3 files).
- **At HEAD `3261721` (04:08, `head-gates.log`)** — after E7's `6370493`:
  `npm test` **exit 0** (106 files, 1166 passed + my 2 expected-fail), `lint` **exit 0**,
  `typecheck` **exit 0** → the test/typecheck half of E8-D2 is **resolved**.
  **`format:check` is still exit 1** on `src/domain/model.ts` and `vite.config.ts`.
- **Provenance of the format drift:** both files were Prettier-clean at `fed96f5^` and dirty at
  `fed96f5` (checked per commit with `prettier --check --stdin-filepath`), i.e. the drift is
  `fed96f5`'s own landed content (shared co-edit files), not sibling WIP. `npm run ci` runs
  `format:check` first, so **CI goes red on the first push** while these two stay dirty.

**Required:** `npx prettier --write src/domain/model.ts vite.config.ts` (sanity: `git diff -w`
must show no logical change), then the full `npm run ci` green at the push commit. Owner: the
next writer of those shared files (E8/E7 co-edit, disclosed in `fed96f5`'s message) — this card
does not edit src (review/QA role). Additionally, the sync-UI card's uncommitted WIP
(`src/features/sync/*`, `tests/component/sync-*`, 5 files) must be Prettier-cleaned by that card
before it commits.

**Not pushed for this reason:** this report's commit (`3261721`) sits on top of `fed96f5` +
`6370493` locally; pushing while `format:check` is red would redden `origin/main`. Push stays
serialized per the impl card's disclosure.

### Observations (non-blocking)

- **O1** `engine.ts` sits at 63.79% branch coverage; the configured `./src/sync/**/*.ts`
  floor (70% branches) is evaluated as a **glob aggregate** (77.50%) so it passes. Per-file
  it would not. Consider a per-file gate for the run engine — it is the module with the most
  failure paths.
- **O2** A local row whose content differs from the shadow but whose `updatedAt` is *older*
  than the shadow is dropped as a "stale echo" (`shadow.ts` documents it). Such a row can only
  arise from a restore/import with older stamps or a backwards clock. LWW makes it a loser, so
  §6.2 is arguably satisfied — but the ADR's §4.2 table has no row for it; worth one sentence in
  the ADR.
- **O3** Torn-PUT read-back mismatch is classified `NETWORK` (retryable) rather than a
  write-specific code; acceptable (the transport retries once and the run reports an error
  state), recorded for the error-taxonomy table.
- **O4** `shadow.ts` rows can be absent from the text coverage table in some runs while lcov
  reports full data (18/18 lines, 34/34 branches); read the lcov artifact for that file.

## 6. Not covered by this card (residual)

- **Two-browser-context E2E** (ADR-006 test plan's Playwright item: real contexts, offline
  loop) — belongs to the sync-UI/e2e cards; not executed here.
- **Real WebDAV server** (Nextcloud/`mod_dav`) — deliberately excluded (no third-party service
  in tests); the in-memory fake implements GET/PUT/DELETE/PROPFIND/MKCOL/MOVE + 207 + fault
  hooks. A manual smoke against a real server is the remaining external risk.
- **Encrypted-record envelope (ADR-007 Decision 10)** — stretch, not yet implemented; merge
  metadata/copy semantics re-verified only for the plaintext `todo-sync/1` shape.
- Snapshot/compaction pressure at scale (COMPACT_BATCH_THRESHOLD = 30) exercised only by the
  impl's E7 test, not re-derived here.

## 7. Evidence

`docs/qa/e8-sync-engine-logs/` (committed with `-f`, house convention for `*.log` evidence):

| File | What it shows |
|---|---|
| `probes-sync-scope.log` | 10 files, 99 passed + 2 expected-fail (the two D1 repros), exit 0 |
| `coverage-sync-scope.log` | full coverage table incl. the §3 numbers; 0 `src/sync` threshold errors |
| `full-suite-minus-stale-storage.log` | whole-tree run, 1141/1141 green, all coverage gates exit 0 |
| `clean-clone-fed96f5-gates.log` | the four gates on a clean clone of `fed96f5` (E8-D2 first measurement) |
| `head-gates.log` | the four gates on a clean clone of HEAD `3261721` — test/lint/typecheck green, `format:check` red (E8-D2 today) |
| `d1-reverse-order-trace.log` | raw per-run trace of both D1 scenarios (conflicts/notices/rows/server files) |

Probe suite: `tests/unit/sync/e8-qa-probes.test.ts` (Q1–Q6). Spec refs: PROJECT_ANALYSIS §6.2,
§9.3, §11 R3; `docs/adr/ADR-006-webdav-sync.md` §4.2/§4.3/Decision 5/Decision 8/test plan;
`docs/dev/sync-engine-api.md` §8 (impl's recorded decisions).
