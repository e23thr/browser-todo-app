# Epic E2 — Core Domain: Task & List Management (MVP) — epic verification

- **Epic card:** t_9b61ecf5 (h_pm) · **Verification run:** 2026-10-25
- **Baseline:** clean clone of shared `main` at **5b1fdbb** (`chore(sw): regenerate the precache
  manifest after the M13-B1 fix`), which includes the E2-relevant fixes b32cf9a/618bbe9/3ea2175/
  1dd1ad5 (core-UI review rework), 8379767 (domain-core review rework), 6061e66/1b4bb6f/7fa2acc/
  3c9582c (M5/M6 review R1 rework) and 86709cc (M13-B1 = E2 F-1 fix).
- **Method:** first-hand re-verification on a fresh `git clone` (node_modules symlinked) of that
  exact commit — the shared workspace carries sibling cards' uncommitted edits and was never used
  for gates. Card-level evidence is cited per AC below.

## 1. Gates re-run first-hand (clean clone @ 5b1fdbb)

| Gate | Result |
|---|---|
| `npm run test` (vitest) | **846 / 846** (72 files) |
| `npm run typecheck` (`tsc -b`) | **0 errors** |
| `npm run lint` (`eslint . --max-warnings 0`) | **exit 0** |
| `npx prettier --check .` | **clean** |
| `npm run build` + `scripts/check-bundle-budget.mjs` | **PASS** (12 shipped files, no wasm, no external refs; precache manifest `[unchanged]`) |
| `npm run i18n:check` | **PASS** (en/th key + placeholder parity) |
| `npm run test:coverage` | All files 84.95 % stmts; **`src/domain` 96.91 / 85.25 / 98.85 / 98.79** (stmts/branch/funcs/lines) — ≥ 80 % gate **PASS**; `src/storage/repos` 88.46 / 74.32 / 90.76 / 95.83 |
| QA probe suites (the four untracked probe files, copied into the clone) | **44 / 44** (e2-qa-probes, e2-qa-repos-probes, e2-qa-tabsync-probes, e2-core-ui-qa) |

## 2. Real-browser probes re-run first-hand (Chromium, production build via `vite preview`)

| Probe | Result |
|---|---|
| `tests/e2e/core-ui-keyboard.spec.ts` | **2 / 2** — keyboard-only pass F1 capture → F2 edit → F3 complete → F4 delete → F6 delete list (20 steps, no pointer events) + touch sweep **11 / 11 ≥ 44×44** at 375 px (`.task-check-hit` 44×44, `.fab` 56×56, tabbar 75×56, …) |
| `tests/e2e/qa-axe-nonvacuous.spec.ts` | **1 / 1** — axe report on the real core views (onboarding pre-dismissed): **0 violations** |
| `tests/e2e/qa-f2-remeasure.spec.ts` | **1 / 1** — `.task-check-hit: 44×44` (F-2 fix holds) |
| `tests/e2e/qa-search-reorder.spec.ts` | **6 / 6** (5 pass + V1 expected-fail), measurements below |

Measured numbers from the M5/M6 probe run at 5b1fdbb (echoed by the spec as `QA[...]`):

- **M5 search @10,000 fixtures:** warm per-keystroke `domMs` 1.9 / 5.8 / 13.6 / 14.9 / 17.9 ms
  (worst 25.8 ms frame) — **< 50 ms budget**. The cold first keystroke measured 57.4 ms — the
  one-time index build (QA card t_fa0903f2 observation O1; the build itself is inside the 500 ms
  boot budget). Title + notes `<mark>` highlighting, case-insensitivity, completed-task hits and
  instant (no-Enter) filtering all verified by the same probe.
- **M6 reorder parity:** `identical=true` — keyboard (Alt+↑/↓/Home/End) and grip-handle drag
  produce byte-identical persisted orders across the three scripted moves, single record write per
  move.
- **M6 virtualization:** 1,200 rows → **23 DOM rows** initially (real `aria-setsize/posinset`,
  hidden pad rows); unthrottled scroll **60 fps median 16.7 ms, 0 dropped frames**; 4× CPU median
  33.2 ms.
- **M6 touch handles:** 44×44 at both 375 px and 320 px viewports.
- **V1 REPRODUCED (defect):** with the roving cursor pinned near the top, scrolling to the bottom
  materialises **23 → 1,200 DOM rows** (`QA[virtual-bottom] {"before":23,"after":1200,...}`),
  i.e. the probe's own gate `expect(bottom.after).toBeLessThan(200)` fails — §9.1 "virtualize
  beyond ~200 DOM rows" is **not met**. Same shape in search results (288 / 288 per QA card).

Flake note: the virtualization windowing probe flaked once in an interleaved run (focus assertion
under load — same family as the previously reported `core-ui-virtual 'End focuses the LAST row'`
load flake) and passed green on three subsequent runs (isolated + full suite). No code change.

## 3. Acceptance criteria — verdicts

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| AC1 | All M1–M6 flows work offline on desktop + mobile viewports | **MET** | Per-flow QA reports `docs/qa/e2-core-ui.md` (M1–M4: 20/20 keyboard-only,3 baselines), `docs/qa/e2-search-reorder.md` (M5/M6); first-hand re-runs above incl. 320/375 px touch viewports; offline persistence journey covered by E4 `e2e:sw` 16/16 + the offline write-survives-reload drill |
| AC2 | Optimistic interactions meet the §9.1 budgets (measured) | **NOT MET — 1 of 9 budget rows fails** | Met and measured: add→visible 1.7–3.4 ms (< 100 ms), INP-scale interactions via optimistic pipeline, search ≤ 17.9 ms warm @10k (< 50 ms), boot@10k 52.6 ms (< 500 ms), warm start < 300 ms (E4), scroll 60 fps / 0 dropped frames. **Fail: "virtualize beyond ~200 DOM rows" — defect V1, reproduced first-hand above.** → fix card (gating) |
| AC3 | Keyboard equivalence proven for every gesture (drag reorder included) | **MET** | 20/20 keyboard-only pass re-run first-hand at HEAD; reorder keyboard vs drag parity `identical=true` (scripted, byte-identical orders); row-menu Tab, roving cursor and dialog focus contracts verified by review t_3650ed00 rework + `core-ui-keyboard.spec.ts` |
| AC4 | Domain unit coverage ≥ 80 % with LWW/tombstone/reorder/concurrency behaviors tested | **MET** | First-hand coverage 96.91 / 85.25 / 98.85 / 98.79 on `src/domain`; LWW compare/merge, tombstone purge (strict 90 d boundary), single-put reorder, optimistic rollback and concurrency suites green in the 846-test run + QA probes (t_7080a238, timezone-independent) |
| AC5 | Two-tab concurrent writes refresh correctly (E5) | **MET at the E2/domain layer** | Tracked `tests/unit/app/tabSync.test.ts` (watermark discipline) + independent scripted two-tab scenarios (`e2-qa-tabsync-probes.test.ts`, green first-hand 44/44): simultaneous bidirectional edits converge, zero writes on receipt, self-origin ignored, tombstones propagate. End-to-end multi-tab UX verification remains with **Epic E5** (in flight) |

## 4. Open-defect register (E2 QA findings, status at 5b1fdbb)

| ID | Severity | Status | Routing |
|---|---|---|---|
| F-1 first capture `a11y.taskAdded` cancelled by E3 persistence notice (WCAG 4.1.3) | major | **FIXED at 86709cc** (deferred announce, `DEFERRED_ANNOUNCE_DELAY_MS`); unit + component pins land with it | Fix card t_419ace90 (running) verifies/closes; M13 gate re-run t_6bc6eda5 re-verifies the a11y gate — **not gating E2** (fixed in the tree this epic verifies) |
| F-2 checkbox effective target 24×24 | major | **FIXED** (b32cf9a `.task-check-hit` label, 44×44), re-measured first-hand | closed |
| **V1** pinned-cursor scroll materialises the whole list (§9.1 virtualize row) | **blocking for AC2** | **OPEN — reproduced first-hand at 5b1fdbb** | **fix card created by this run — parent of the epic (gating)** |
| **QA-D1** depth-2 subtask chains silently dropped from tree-grouped views (`src/domain/views.ts` treeRows; import-reachable invisible rows) | moderate (QA: "recommended fix before review gate closes") | **OPEN** — characterization probe `tests/unit/domain/e2-qa-probes.test.ts 'DEFECT D1'` still pins the buggy behavior at 5b1fdbb | **fix card created by this run — parent of the epic (gating)** |
| F-3 §14 `error.taskGone` row unreachable — concurrent delete unmounts the editor, unsaved edits vanish silently | moderate (non-blocking) | **OPEN** | fix card created by this run — **non-gating for E2**, parent of the MVP DoD gate |
| QA-D2 search CI gate wall-clock / QA-D3 `listRepo` per-file coverage 52.8 % branches | non-blocking | open (advisory) | recorded; no card (advisory nits, aggregate gates pass) |

## 5. Design open questions (docs/design/core-domain.md §15) — h_pm decisions

All four are **CONFIRMED as built** (the stated defaults are what shipped; no rework):

1. **OQ-1** — manual reorder is per-list only (aggregate views use derived order + `Move to list`);
   no schema change in MVP. V1/S8 must extend, not silently reinterpret.
2. **OQ-2** — validation limits stand: title 1–200, notes ≤ 20,000, list name 1–60 unique.
3. **OQ-3** — Completed view is global with a list filter; V1 S6 (archive/history) refines it.
4. **OQ-4** — `Alt+Home/End` accelerators stay in MVP as built; the V1 shortcut owner (S8) owns
   further extended keys.

## 6. Evidence landing (this run)

Committed to `main` by this verification (E2 QA suites + E2 QA evidence were left untracked by the
QA/test cards and must be durable for the MVP DoD gate):

- `tests/component/e2-core-ui-qa.test.tsx`, `tests/e2e/core-ui-keyboard.spec.ts`,
  `tests/e2e/qa-search-reorder.spec.ts`, `tests/e2e/qa-axe-nonvacuous.spec.ts`,
  `tests/e2e/qa-f2-remeasure.spec.ts`, `tests/unit/app/e2-qa-tabsync-probes.test.ts`,
  `tests/unit/domain/e2-qa-probes.test.ts`, `tests/unit/storage/e2-qa-repos-probes.test.ts`
  (all green first-hand; lint/prettier clean).
- `docs/qa/e2-*` evidence: this report, `e2-domain.md`, `e2-core-ui.md` (+logs),
  `e2-core-ui-review.md` (+probe), `e2-domain-core-review.md`, `e2-m5m6-review.md` (+probe),
  `e2-search-reorder.md` (+logs incl. the four raw `.log` run logs, force-added as they are
  referenced by the report) + `e2-search-reorder-logs.tar.gz`.

**Still untracked (routed, not landed here):** `docs/adr/ADR-002…007` (+ the working-tree
`docs/adr/README.md` index) and `docs/design/core-domain.md` — the accepted ADR set and the E2
design deliverable, shared with sibling epics; routed to a docs-landing card (parent of the MVP
DoD gate). ADR-003 carries three marked amendments written by fix card t_cae21e7c (D8.1 rebalance
signal, D8.2 watermark erratum, Decision 4 orphan pin) that have never been committed.
