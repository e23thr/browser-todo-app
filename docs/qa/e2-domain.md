# E2 QA — Domain core (LWW, tombstones, reorder, concurrency, search benchmarks)

**Card:** t_7080a238 (Test: Domain core), Epic E2 · **Reviewer of record:** h_reviewer
**Date:** 2026-10-23 · **Refs:** PROJECT_ANALYSIS.md §5.2/§5.3, §6.2, §9.1, §9.3, §9.5, §10 E5/E6/E7;
ADR-002 `docs/adr/ADR-002-storage-schema.md`, ADR-003 `docs/adr/ADR-003-domain-layer.md`
(both binding; note ADR-003 is still untracked in git — see §9 D4).

## 0. Scope, environment and how to reproduce

This card verifies the E2 domain core implemented by t_aee34500: `src/domain/**` (kernel, model,
dates, merge, ports, state, pipeline, views, search, windowing, sync), the repo adapters
`src/storage/repos/**` (patch-RMW, tombstones, single-record reorder), `src/storage/errorLog.ts`,
and the tab-sync transport `src/app/tabSync.ts`.

| Item | Value |
|---|---|
| Subject under test | commits `23f1430`, `8adc449`, `4fbab11`, `322986d` (impl card t_aee34500) + QA probes added below |
| Tree state | shared working tree `/home/ubuntu/workspace/browser-todo-app`, HEAD `154a861`; sibling cards were actively committing during this run (see §9 D5) |
| E2 scope suite | **15 files / 168 tests, all green** (143 impl + 25 QA probes added by this card). Late in the run the parallel review card t_371b966c added `tests/unit/domain/review-repro.test.ts` (8 tests, 6 failing — see D6), which lands in the same scope folder but is outside this card's measurements |
| Reproduce scope suite | `npx vitest run tests/unit/domain tests/unit/storage/repos.test.ts tests/unit/storage/errorLog.test.ts tests/unit/storage/e2-qa-repos-probes.test.ts tests/unit/app` |
| Reproduce coverage | `npx vitest run --coverage` (full suite; see §1) |
| Reproduce TZ matrix | `TZ=UTC\|Pacific/Kiritimati\|Pacific/Niue\|America/Caracas npx vitest run tests/unit/domain tests/unit/storage/e2-qa-repos-probes.test.ts tests/unit/app` |
| QA probes added by this card | `tests/unit/domain/e2-qa-probes.test.ts` (17), `tests/unit/storage/e2-qa-repos-probes.test.ts` (4), `tests/unit/app/e2-qa-tabsync-probes.test.ts` (4) — all written from the acceptance criteria, not from the impl's test narratives |
| Coverage (src/domain) | **94.79 % stmts / 83.40 % branches / 93.25 % funcs / 95.95 % lines** (gate ≥ 80 % — PASS) |

## 1. Coverage (AC: ≥ 80 % on domain modules, measured figure)

Measured with Vitest v8 over the full suite (55 files / 595 tests — the four files a sibling card had
transiently broken were excluded from THAT run only; three are green again in the final full run and
the fourth has a single out-of-scope failure, see §9 D5):

| Module | Stmts | Branches | Funcs | Lines | Gate (≥ 80 each) |
|---|---|---|---|---|---|
| **src/domain (aggregate)** | **94.79 %** | **83.40 %** | **93.25 %** | **95.95 %** | **PASS** |
| src/storage (aggregate, incl. repos) | 95.99 % | 93.44 % | 98.71 % | 97.64 % | PASS |
| src/storage/repos (sub-aggregate) | 82.89 % | 71.36 % | 90.76 % | 90.19 % | (see D3) |

Per-file rows worth noting inside src/domain: `pipeline.ts` 89.38/77.59/86.04/90.83 (the thinnest
domain file — remaining gaps are multi-op failure interleavings), `search.ts` 97.31/87.01/100/100,
`state.ts` 97.77/94.73/100/100, `sync.ts` 98.14/90.24/100/100, `views.ts` 98.52/75.86/100/98.11.
The project's own gate (`npm run test:coverage` glob thresholds) passes on this tree state.

## 2. LWW tie-breaks on (updatedAt, deviceId) — PASS

Binding policy (§6.2, pre-decided): per-record last-write-wins keyed on `(updatedAt, deviceId)`,
deletions propagate via tombstones.

- `src/domain/merge.ts:19` `compareLww` — greater `updatedAt` wins; exact tie → greater `deviceId`
  (lexicographic); identical versions → 0; antisymmetric.
- Evidence: `tests/unit/domain/merge.test.ts` (impl) + `tests/unit/domain/e2-qa-probes.test.ts`
  "QA: LWW conflict policy (§6.2)" (this card): `updatedAt` dominance over a winning `deviceId`,
  case-sensitive tie-break (`'Dev-Z' < 'dev-a'`), deterministic total sort under either input order,
  and the §6.2 "Conflict copy of …" title with the 1000-char cap.
- Traceability note (not a defect): the LWW primitives have **no production call site yet** — MVP
  import is REPLACE-only (portability Decision 11, verified in `src/portability/import.ts:17`), so
  `compareLww`/`conflictCopyTitle` are the tested contract for V1 ADR-006 sync and any future
  merge-mode import. Consistent with ADR-003 ("primitives M11 import and ADR-006 sync call").

## 3. Tombstones: soft-delete + > 90-day purge + explicit clean-up — PASS

- **Soft delete**: `TaskRepo.remove` tombstones (`deletedAt`), invisible to `loadAll`, still visible
  to `changedSince` (tab sync) and `readUnfiltered` (export/backup) — proven in this card's probe
  "tombstone visibility (reads vs export/sync paths)" and impl's `repos.test.ts`.
- **Child cascade**: direct subtasks tombstoned in ONE transaction (impl `repos.test.ts`);
  `upsertImported` never tombstones.
- **Auto purge strictly > 90 days** (`src/storage/purge.ts:59` uses `deletedAt < now - TTL`): this
  card's boundary probe pins the STRICTness — a tombstone aged **exactly** 90 days survives,
  one **millisecond older** is purged; throttle is 24 h via `meta.lastPurgeAt`.
- **Explicit "clean up storage"** purges tombstones of **every** age and hard-deletes them, never
  touching a live row (probe + impl).
- Purge is one atomic transaction: deletions + the auto throttle stamp commit or roll back together
  (the QA-D6 fix from the E1 card), so the returned count cannot lie.

## 4. Reorder = single-record write (fractional keys) — PASS

This card's probe "move() writes EXACTLY one record…" (put-counting AppDB over fake-indexeddb):
`move(b, beforeId: a)` performs **exactly 1 `put`**, neighbors `a`/`c` remain **byte-identical**
(JSON snapshot compare), exactly one row's JSON changes, and the moved key sorts strictly before the
reference key. Impl's `repos.test.ts` additionally covers top-level/afterId/beforeId/subtask-group
moves, `REORDER_TARGET_NOT_IN_GROUP`, and the 32-char key-exhaustion **rebalance hatch** (observable
in the structured error log, keys re-spaced canonical). Order lives in `(sortOrder, id)`; optimistic
moves mint a provisional key via injected `OrderKeyOps`, the repo recomputes authoritatively.

## 5. Optimistic pipeline rollback on write failure — PASS for the AC scenarios (deeper interleavings contested — see D6)

Normative order (ADR-003 Decision 3): apply → synchronous notify → serialized write → swap on ok /
rollback on fail. This card's probe ran a **3-op chain on one record** (patch, patch, setDone) and
failed the first write: state is visible before any write resolves, then on failure **all three ops
are rolled back in reverse order**, each reporting its own `write-failed`/`onError`
(`['set-done', 'patch-task', 'patch-task']` observed), state returns **exactly** to the last
committed image (deep-equal), and `pending` clears. Impl's `pipeline.test.ts` covers queued-op
cancellation scoping (only ops sharing ids), multi-record list-disposition rollback, provisional →
authoritative swap (stamps + order keys), and re-anchoring to the LAST COMMITTED image under live
later ops. NOTE: the concurrent review card's repro A/A2 (§10 D6) contest the rollback baseline
across *settled multi-record* ops — outside this AC scenario but inside the same code path.

## 6. Two-tab concurrency scenario (§10 E5) — scripted and PASSING (sweep/announce edge cases contested — see D6)

Two independent scripts, both green:

1. **Impl acceptance script** — `tests/unit/app/tabSync.test.ts`: two MutationRunners + their own
   repo instances over ONE fake IndexedDB + a fake BroadcastChannel bus. Covers A→B convergence via
   `data-changed`, self-origin ignore, **zero writes on receipt**, tombstone propagation,
   `settings: true` targeted reload, `change: 'all'` full reload, and the `by_updatedAt` watermark
   sweep converging B when EVERY broadcast is lost.
2. **This card's independent script** — `tests/unit/app/e2-qa-tabsync-probes.test.ts` ("QA: two-tab
   concurrency (§10 E5 acceptance script)"), written from §6.2/§9.3/§10 E5:
   - **Simultaneous bidirectional edits to ONE record** (A patches title while B patches notes AND
     completes the task, fired without awaiting) converge to ONE merged record in BOTH tabs —
     disjoint fields all survive (patch merges read-modify-write inside one IDB transaction),
     both tabs end byte-identical, and tab B's receipt path performed exactly its own 2 writes.
   - Each tab ignores its own broadcasts and applies the peer exactly once (no double-apply).
   - Delete propagates as tombstone eviction to the peer.
   - Watermark sweep converges the peer under total broadcast loss.

## 7. View-model correctness (Today / Next 7 / All open / per-list / Completed) — PASS (one defect, D1)

Evidence: impl `views.test.ts` + `coverage-topups.test.ts`, plus this card's boundary probes:

| Check | Evidence | Result |
|---|---|---|
| Today = Overdue + Today groups; yesterday=overdue, today member, tomorrow/no-date/done/archived absent; counts (open, overdue) | probe "Today: overdue\|due-today only…" | PASS |
| Next 7 window **inclusive on both edges** [today, today+6], empty day groups omitted, across a **year boundary** (2026-12-29 → 2027-01-04) | probe "Next 7: window is [today, today+6]…" | PASS |
| Leap-year February arithmetic (2028-02-28 + 1d = 2028-02-29; 2027-02-28 + 1d = 2027-03-01) and window span across it | probe "Next 7 across a leap-year February…" | PASS |
| All open: grouped per live list in manual (sortOrder, id) order; done/archived/**tombstoned** excluded | probe "All open: grouped per live list…" | PASS |
| Per-list: manual order + one nesting level; Completed: completedAt desc, id desc tiebreak, missing completedAt last | probe "per-list… / Completed…" | PASS |
| Uniform subtask rule (depth 1 only when parent is in the same group; else depth 0) | probe "subtask renders depth 1 only when its parent is in the SAME group" | PASS |
| Depth-2 chains (grandchild rows) | probe "DEFECT D1 (characterization)…" | **DEFECT D1** (see §9) |

## 8. All-day dueDate semantics (§5.2/§10 E6) — PASS

`dueDate` is a `YYYY-MM-DD` local calendar-day label compared lexicographically; `todayStr` builds
it from LOCAL components and never calls `toISOString()`.

- Probes: local label asserted against local components for instants straddling UTC midnight, with
  an explicit regression guard that the label **differs from the UTC/ISOString label** whenever the
  run timezone is not UTC; `todayStr(now + msUntilNextLocalMidnight) === addDays(todayStr(now), 1)`
  (day-rollover timer and label agree); overdue = open && dueDate < today (due today is NOT
  overdue; done never overdue); next-7 boundaries inclusive at today and today+6, exclusive at +7.
- **Timezone matrix** (the whole E2 suite re-run per TZ): `TZ=UTC`, `TZ=Pacific/Kiritimati` (UTC+14),
  `TZ=Pacific/Niue` (UTC-11), `TZ=America/Caracas` (UTC-4:30) — **13 files / 139 tests green in
  every timezone**. No test outcome depends on the host timezone.

## 9. Benchmarks (§9.1) — recorded numbers

Primary = calm host, single-file runs (reproduce with
`npx vitest run tests/unit/domain/e2-qa-probes.test.ts --disable-console-intercept`). "Worst
observed" = the same tests during a full parallel suite run on a loaded host — recorded for honesty;
every query stayed inside budget in every run.

| Metric (10,000 fixtures) | Calm run | Worst observed (full-suite load) | Budget | Verdict |
|---|---|---|---|---|
| Search index build | 43.6 ms (QA corpus) / 39.6 ms (impl corpus) | 166 ms | build off paint path (< 500 ms gate) | PASS |
| Cold query, 1 token | 2.56 ms | 30.4 ms | < 50 ms | PASS |
| Cold query, 2 tokens | 1.35 ms | 12.5 ms | < 50 ms | PASS |
| Keystroke-narrowed query | 3.59 ms | 20.3 ms | < 50 ms | PASS |
| Thai-script query (NFKC) | 1.34 ms | 6.0 ms | < 50 ms | PASS |
| Naive scan (documented fallback, NOT the budgeted path) | 17.9 ms | 89 ms | — | informational |
| **Domain boot @10k** (state build 2.4 ms + index 40.7 ms + first view select 9.5 ms) | **52.6 ms** | 265.6 ms | < 500 ms (boot to first data paint, §9.1) | **PASS** |
| First view select alone (allOpen @10k) | 9.5 ms | 55.9 ms | (subset of boot path) | PASS |
| today / completed / search view selects @10k | 2.6 / 0.6 / 2.8 ms | 22.9 / 5.5 / 9.5 ms | — | informational |
| **Add → visible (perceived)** | **0.44 ms** | 0.71 ms | < 100 ms perceived (§9.1) | **PASS** |

Corpus: 10,000 tasks (~50/50 with notes), mixed Latin + Thai tokens (QA corpus) — index size 10,000
entries; impl corpus adds a lorem/word mix. The CI gates inside the tests assert the §9.1 budgets
(query < 50 ms; boot-side total < 500 ms; add→visible < 100 ms).

## 10. Defect list

**D1 (domain correctness, MODERATE — recommended fix before the review gate closes):**
`src/domain/views.ts` `treeRows()` silently drops rows of depth-2 chains. A task C whose parent B is
itself a subtask of A renders nowhere in the tree-grouped views (Today / Next 7 / All open /
per-list) — `rows: ['A:0','B:1']`, C missing — while C **is** in state, survives export round-trips,
and **is** visible in the flat views (Search, Completed). Reachable via `TaskPort.upsertImported`:
`validateTask` (`src/storage/validate.ts:337`) checks `parentTaskId` is a ULID but enforces **no
depth rule**, so a crafted/hostile import file (§10 E8) or a future-version export can create such
chains; the interactive write path correctly rejects them with `RULE: PARENT_DEPTH_EXCEEDED`.
Suggested fix: in `treeRows`, render a child whose parent is itself nested at depth 1 as depth 0
(or clamp the chain), or reject depth-2 chains at `upsertImported` validation. Characterization
probe pinned in `tests/unit/domain/e2-qa-probes.test.ts` ("DEFECT D1") — flip it when fixing.
No data loss; severity driven by "task invisible in 4 of 6 views after import".

**D2 (test robustness, NON-BLOCKING):** the search perf CI gate (`tests/unit/domain/search.test.ts`
`expect(coldMs).toBeLessThan(50)` etc.) is a wall-clock assertion on a shared CI host; worst
observed cold query during a parallel full-suite run was 30.4 ms — margin is adequate but not huge.
Consider medians of N runs or a load-scaled bound if CI flakes.

**D3 (coverage observation, NON-BLOCKING):** `src/storage/repos/listRepo.ts` per-file coverage is
64.36 % stmts / 52.83 % branches (its error/disposition branches). The project gate passes
(aggregate over `src/storage`), and every behavior demanded by the AC is covered — but listRepo is
the thinnest file in the E2 repo surface. Recommend a follow-up probe card for its error paths.

**D4 (process, NON-BLOCKING — already flagged by the impl card):** `docs/adr/ADR-003-domain-layer.md`
(plus ADR-004..007) is still **untracked in git**. The binding spec for this card exists only in the
working tree. The orchestrator should get the ADR docs committed by their owning cards.

**D5 (process, informational):** shared-tree churn from concurrent cards was observed mid-run
(transient failures in `tests/unit/data-safety/classify.test.ts`, `tests/unit/i18n-document-meta.test.ts`
and `tests/component/settings.test.tsx` in earlier runs; all green by the final run). Final full-suite
state at report time: **642/643 green**, the single failure being
`tests/component/app.test.tsx > "renders exactly one h1 per screen"` — shell/UI card territory,
outside the E2 domain scope. Not attributable to the domain-core diff.

**D6 (concurrent review-card repros — NOT authored by this card; t_371b966c adjudicates):** while
this report was being written, the parallel review card added `tests/unit/domain/review-repro.test.ts`
(8 tests: 2 controls pass, **6 fail**) asserting five behavioral defects in the same domain code this
card tested. Recorded here for completeness; the review card's verdict is authoritative:

1. (repro A) A later failed write on a task moved by a *settled* `removeList(move)` rolls it back to
   its PRE-move list — i.e. the rollback baseline is not the last committed image in multi-record ops.
2. (repro A2) A failed `upsertImported` of a previously deleted task resurrects it from a stale
   committed image.
3. (repro B) Bulk ops (`removeList` disposition, `upsertImported`) announce explicit id ChangeSets,
   never `change: 'all'` (verified in `src/domain/pipeline.ts:353/469-483` — the receiver side handles
   `'all'`, but the sender never emits it; ADR-003 Decision 8.1 rule 2 is the contested contract).
4. (repro D) `pending` clears when the FIRST of several queued ops on one record settles instead of
   after the last in-flight op.
5. (repro C) The `by_updatedAt` watermark sweep can leapfrog a lost-broadcast row written before
   this tab's own commit (announce bumps the watermark past an unobserved row).

These do NOT contradict the AC-named scenarios in §2–§8 (all still green, incl. this card's
two-tab scripts), but repros 1–2 are in the §5 rollback path and 3/5 in the §6 sync path — treat
those sections as passing only their scripted scenarios. If the review card confirms these as real,
D6 items 1–4 are blocking for the E2 review gate.

## 11. Acceptance-criteria traceability

| AC (task body) | Verdict | Evidence |
|---|---|---|
| docs/qa/e2-domain.md with per-check evidence + coverage figure + search/boot benchmark numbers | MET | this document (§1, §9) |
| Two-tab concurrency scenario scripted and passing | MET (2 scripts) | §6 — impl `tabSync.test.ts` + this card's `e2-qa-tabsync-probes.test.ts` |
| Unit suite ≥ 80 % coverage on domain modules, measured figure recorded | MET | §1 — 94.79/83.40/93.25/95.95 |
| LWW tie-breaks on (updatedAt, deviceId) | MET | §2 |
| Tombstone soft-delete + > 90-day purge + explicit clean-up | MET | §3 |
| Reorder as a single-record write (fractional keys) | MET | §4 |
| Optimistic pipeline rollback on write failure | MET | §5 |
| View-model correctness incl. boundary dates + all-day dueDate semantics | MET (one defect, D1) | §7, §8 |
| Search performance over 10,000 fixtures < 50 ms, measured | MET | §9 — worst observed cold query 30.4 ms |
| Defect list in report AND completion metadata | MET | §10 (D1–D6) mirrored in the completion metadata |
