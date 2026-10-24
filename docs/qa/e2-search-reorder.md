# E2 QA — Search, manual reorder & virtualization (M5/M6)

**Card:** t_fa0903f2 (Test: Search, reorder & virtualization) · Epic E2 · **Tester of record:** h_reviewer
**Date:** 2026-10-25 · **Refs:** PROJECT_ANALYSIS.md §4 (M5, M6), §8 (a11y), §9.1 (budgets);
`docs/design/core-domain.md` §5.7 (virtualization), §7 S5 (search), §8 (reorder), §9.1/9.7
(keyboard maps), D5 (search scope/ordering), D1 (aggregate views), §16 items 25–36.

## 0. Verdict

**PASS with 1 defect and 2 observations.** Every M5/M6 behaviour the card asks for was verified
in a **real Chromium against the production build**, with numbers recorded rather than asserted:

| # | Finding | Severity | Blocks? |
|---|---------|----------|---------|
| **V1** | The roving-cursor **pin spans cursor→scroll**, so scrolling far from the cursor materialises the **whole list**: 1,200/1,200 DOM rows at the bottom of a 1,200-row list (288/288 in a 288-result search). §9.1 "virtualize beyond ~200 DOM rows" is violated by O(distance) rendering. `src/features/tasks/TaskList.tsx:234-251` + `src/domain/windowing.ts:64-71` (`pin` widens `start`/`end` on every frame) | **Major** (performance contract; O(n) DOM at 10k) | Yes for the §9.1 virtualization acceptance; no data/correctness impact |
| **O1** | **Cold first keystroke straddles the 50 ms search budget**: n=7 calm runs → **44.7–54.8 ms** (median 51.3, mean 50.0), i.e. it pays the one-time index build inside the first `input`. Warm keystrokes are 4–7× under (≤19.4 ms DOM) | Minor | No (report; consider building the index on search-screen open) |
| **O2** | **Timings are load-sensitive on this shared host**: at `loadavg 6–7` (parallel cards running `npm run ci`) the same cold keystroke measured **218 ms** and the 4×-throttled scroll median **83 ms**; calm → 44.7–54.8 ms / 16.7 ms | Informational | No — pin median-of-N in CI (same advice as E2 domain QA D2) |

Everything else passed: both reorder paths persist **identical** results (scripted, move-by-move),
**exactly one** task record is written per move on both paths, live-region announcements and focus
retention hold on every move, order survives a reload, windowing/aria/keyboard navigation are
correct at 1,200 rows, scroll holds **60 fps unthrottled (0 dropped frames)**, search covers
title + notes + completed tasks case-insensitively with `<mark>` highlighting and instant
filtering, and the drag handle measures **44×44 CSS px** at 375 px and 320 px.

Scope note: the parallel **review card t_64b514e2** (baseline `618bbe9`) found two *drag* defects
my scripted operations deliberately do not exercise — dropping a row **into its own slot** (B1)
and dropping a task **onto its own sidebar list** (B2). They are recorded there and routed to fix
card `t_4fbe8392`; they are not duplicated here.

## 1. Scope, environment, how to reproduce

| Item | Value |
|---|---|
| Subject under test | Impl card t_8524d4d7 at its handoff commit **`ebcaf33`** (M5 `80e65c4`, M6 `5c4d346`, seam `85588df`, card tests `ebcaf33`) |
| Tree state | **Clean `git worktree --detach` at `ebcaf33`**, `node_modules` symlinked. The shared tree `/home/ubuntu/workspace/browser-todo-app` carries uncommitted sibling edits (E2 core-UI rework `b32cf9a` etc. landed later on main), so nothing in it was measured |
| Confirmation run | Whole probe re-run at **`main c590ab2`** (2 runs) — functional results identical, V1 still reproduced; see §7 |
| Probe (added by this card) | `tests/e2e/qa-search-reorder.spec.ts` — 6 tests: search@10k, keyboard-vs-drag comparison, virtualization, V1 (expected-fail), 2 touch-target passes |
| Instrument | Production build served by `vite preview` under the non-root base path (Playwright `webServer` = `npm run build`), fresh browser profile per test, real IndexedDB |
| Seeding | Corpus written **into the app's own database** through the real schema (valid ULIDs, canonical order keys, `meta`/`settings` untouched), then reloaded — boot validation reported no quarantines (10,000/10,000 rows visible) |
| Evidence | `docs/qa/e2-search-reorder-logs/` — one JSON per measurement (`search_10k_keystrokes`, `reorder_paths`, `drag_geometry_op*`, `virtual_*`, `touch_handles_*`, `cpu_throttle_probe`) + raw run logs (`probe-run10.log`, `gates.log`, `head-probe-c590ab2*.log`) |

```bash
git worktree add --detach /tmp/e2-m56 ebcaf33 && ln -s "$PWD/node_modules" /tmp/e2-m56/node_modules
cd /tmp/e2-m56
E2E_PORT=4192 QA_EVIDENCE_DIR="$PWD/docs/qa/e2-search-reorder-logs" \
  npx playwright test --project=chromium --workers=1 tests/e2e/qa-search-reorder.spec.ts   # 6 passed (V1 = expected failure)
npx tsc -b && npx eslint . --max-warnings 0 && npx prettier --check . && npm run i18n:check
npm run test && npm run audit:gate && npm run budget
```

`V1` is marked `test.fail()`: the suite stays green while the defect is open and **flips loudly**
("expected to fail, but passed") the moment it is fixed — delete the marker with the fix.

## 2. Automated gates — PASS

| Gate | Result |
|---|---|
| `npx tsc -b` | 0 errors |
| `npx eslint . --max-warnings 0` | exit 0 (whole repo incl. the new probe) |
| `npx prettier --check .` | PASS |
| `npm run i18n:check` | PASS (327 en / 327 th) |
| `npm run test` (vitest) | **734/734, 66 files green** |
| `npm run audit:gate` | 0 vulnerabilities |
| `npm run budget` | PASS |
| probe (this card) | **6/6** — 5 pass + V1 expected-fail (`PW_EXIT=0`) |

Log: `docs/qa/e2-search-reorder-logs/gates.log`.

## 3. M5 — search @ 10,000 fixtures

Corpus: 10,000 open tasks in one list, titles `Fixture NNNNN <xNN>` (+ `apple` on every 8th),
notes `note xylophonememo N` on every 100th, one **completed** task carrying `zquestdone`.
Keystroke metric: `input` event → **first DOM mutation** (`domMs`) and → **next animation frame**
(`frameMs`), measured in-page with a MutationObserver + rAF.

### 3.1 Latency (§9.1 "Search over 10,000 tasks < 50 ms")

Canonical run 10 (`ebcaf33`):

| Keystroke | Results | frameMs | domMs | DOM rows | first row |
|---|---|---|---|---|---|
| `x` (**cold — pays index build**) | 10 000 | **53.3** | **53.2** | 21 | Fixture 10000 xpr |
| `x0` | 288 | 18.0 | 18.0 | 21 | Fixture 09108 x0z |
| `x0a` | 8 | 16.1 | 9.1 | 8 | Fixture 09083 x0a |
| `x0ab` | 0 → empty state | 7.5 | 6.4 | 0 | — |
| `apple` | 1 250 | 14.6 | 14.5 | 21 | Fixture 09993 xpk apple |
| `xylophonememo` (notes-only) | 100 | 24.8 | 17.1 | 100 | Fixture 09901 xn0 |

Repeat runs at `ebcaf33` (n=7 runs, calm host):

| Metric | min | median | max |
|---|---|---|---|
| Cold first keystroke (frameMs) | 44.7 | 51.3 | 54.8 |
| Warm keystroke DOM update (domMs), all 5×7 samples | 2.0 | — | **19.4** (per-run maxima 8.6–19.4) |
| Warm keystroke → next frame (frameMs), all 5×7 samples | 6.9 | — | **26.9** (per-run maxima 16.0–26.9) |

⇒ **warm typing is 1.7–25× inside the budget**; the *first* keystroke after opening search sits
**on/just over the line** because it builds the index (O1). At `main c590ab2` (calm-ish) cold was
61 ms; under `loadavg 6.15` with parallel CI jobs it was 218 ms (O2).

### 3.2 Coverage, instant filter, announcements (all PASS)

- **Title coverage**: `<mark>` present in rendered titles for `apple` (21 marks on screen).
- **Notes coverage**: `xylophonememo` exists only in notes → **100 results**, and the first row's
  `.row-notes-excerpt` carries `<mark>xylophonememo</mark>`.
- **D5 completed-task coverage**: `zquestdone` exists only on the one **completed** task →
  `aria-label="1 results"` + exactly one rendered row (search does cover completed tasks).
- **Case-insensitive**: `XYLOPHONEMEMO` → `100 results`.
- **Instant filter**: every keystroke above was dispatched as a bare `input` event — no Enter,
  no submit, no debounce; results landed before the next frame.
- **No-results state**: `x0ab` → `search.empty.title` state (no `ul` in the DOM).
- **Ordering (D5)**: first match for `x` is the most recent matching row (undated → `updatedAt`
  desc), consistent with D5's "title matches, then dueDate asc, then updatedAt desc".
- **§5.5 announcement**: polite region = `100 results for "xylophonememo"` after the 300 ms debounce.
- **D1**: `Alt+↓` on a result row announces `a11y.reorderUnavailable` and the DOM order is
  byte-identical before/after.

## 4. M6 — keyboard path vs. drag path (scripted comparison)

Corpus: 12 tasks `Reorder 01…12`, one list `Reorder QA`, viewport 1280×900 (no scrolling needed).
Three logical moves, executed **twice from an identical seed** — once through the keyboard
equivalent, once through a real pointer drag from the grip handle:

| Op | Logical move | Keyboard | Drag |
|---|---|---|---|
| 1 | index 4 → index 6 | `Alt+↓` ×2 | drop after row 6 (`dropY` 530, rows 62 px) |
| 2 | index 2 → index 1 | `Alt+↑` ×1 | drop before row 1 (`dropY` 158) |
| 3 | index 7 → index 0 | `Alt+Home` ×1 | drop before row 0 (`dropY` 88) |

**Scripted comparison — identical at every step and at the end:**

```
per-move persisted orders (keyboard, per op) == per-move persisted orders (drag, per drop)  ✓
final persisted order (both paths)           =
  [Reorder 08, Reorder 01, Reorder 03, Reorder 02, Reorder 04, Reorder 06,
   Reorder 07, Reorder 05, Reorder 09, Reorder 10, Reorder 11, Reorder 12]   ✓ (matches the model)
```

Per-move evidence (`reorder_paths.json`, `reorder_keyboard.json`, `reorder_drag.json`):

- **Single-record write at the UI level**: `IDBObjectStore.put/add` is instrumented in-page;
  every move (each arrow press **and** each drop) shows **exactly 1 `tasks` write and 0 `lists`
  writes**, and a before/after diff of all 12 order keys shows **exactly one changed row** —
  neighbours are byte-identical. ✓ (AC: "single-record-write behavior confirmed at the UI level")
- **Live region**: every move announces `Moved to position N of 12 in Reorder QA` (N = post-move
  position) — 4 keyboard presses + 3 drops, each observed before its write assertion. ✓
- **Focus retention**: after each keyboard press `document.activeElement` is still the moved row. ✓
- **Insertion line (§8.1)**: before release, `data-drop-before` is on the exact target row for all
  three drops; drop slots are ≥60 px from both viewport edges, so §8.1's own 48 px edge
  auto-scroll never fires mid-gesture (`drag_geometry_op*.json`).
- **Persistence across reload**: after the drag path, `page.reload()` → DOM order == persisted
  order == pre-reload order. ✓
- **Corpus reset between paths** is a re-write of the same deterministic rows + reload, so both
  paths start from byte-identical state (asserted).

## 5. Virtualization @ 1,200 rows

### 5.1 Window, ARIA, keyboard navigation — PASS

- Initial: **23 DOM rows** of 1 200 (`data-virtualized="true"`), `aria-setsize=1200`,
  `aria-posinset=1`, top pad `<li aria-hidden>` present, bottom pad present.
- Keyboard walk (focus follows, every step asserts focus is a *materialized* row with the right
  `aria-posinset`): `End` → **1200**, `ArrowUp`×12 → **1188**, `PageUp` → **1178**, `Home` → **1**,
  `ArrowDown`×30 → **31** — crossing several window boundaries; DOM rows stay at **32** afterwards.
  (`virtual_keyboard.json`)

### 5.2 Scroll frames (§9.1 "60 fps") — PASS with load caveat

| Run | frames | median | p95 | max | dropped (>33.4 ms) | distance | DOM rows during scroll |
|---|---|---|---|---|---|---|---|
| Unthrottled (`ebcaf33`/`c590ab2`) | 121–122 | **16.7 ms = 60 fps** | 16.7–16.8 | 16.8 | **0** | 4 672–4 816 px | 87–112 |
| 4× CPU throttle, calm | 81–83 | 16.7–16.8 ms | 33.4 | 33.4–50 | 7–11 of 81–83 | 3 240–3 320 px | 155–174 |
| 4× CPU throttle, `loadavg 7` | 80 | 33.2 ms (30 fps) | 33.4 | 50 | 7 | 3 200 px | 172 |
| 4× CPU throttle, CI jobs running | — | 83.4 ms | — | — | — | — | — (O2) |

Throttle honesty: `Emulation.setCPUThrottlingRate(4)` is verified with an in-page busy loop
(**28.8 → 106.1 ms = 3.6×**, `cpu_throttle_probe.json`); rAF cadence is vsync-bound, so the
dropped-frame count — not the median — is the signal under throttle.

### 5.3 DEFECT V1 — cursor pin defeats the window (FAIL, expected-fail test)

With the roving cursor on row 1 (or row 23) and the viewport scrolled to the bottom:

| Corpus | DOM rows at top | DOM rows at bottom | span |
|---|---|---|---|
| 1 200-row list | 23 | **1 200 / 1 200** | `aria-posinset` 1 → 1200 |
| 288 search results | 21 | **288 / 288** | 1 → 288 |

`computeWindow` widens the window to `[min(scrollStart, pin), max(scrollEnd, pin+1)]` on **every**
frame, so the window grows linearly with scroll distance from the cursor and collapses to the
whole list at the far end. At 10 000 rows the same path would materialise up to 10 000 rows.
Reproduced at `ebcaf33` in 7 consecutive runs (run4–run10: 1 178–1 200 rows) and at
**`main c590ab2`** in 2 runs (1 200/1 200) — `windowing.ts` and the pin call site are unchanged by
the sibling reworks.

Expectation: §9.1 "virtualize beyond ~200 DOM rows" (TaskList's own `VIRTUALIZE_ROWS = 200`).
Suggested direction (not decided here): pin only while the cursor row actually holds DOM focus,
or clamp the span to the viewport window ± a bounded overscan.

## 6. Touch targets — PASS

`.reorder-handle` measured on all 8 handles at both viewports (fresh mobile profile,
`isMobile`+`hasTouch`, so `@media (hover: none)` applies):

| Viewport | width × height | opacity | visibility | display | touch-action |
|---|---|---|---|---|---|
| 375 × 667 | **44 × 44** (8/8) | 1 | visible | grid | none |
| 320 × 640 | **44 × 44** (8/8) | 1 | visible | grid | none |

Matches `--touch-min: 44px` and M8/§8's ≥44×44 requirement; the handle is not hover-gated on touch
and `touch-action: none` is set on the handle only.

## 7. Confirmation at `main c590ab2`

The whole probe was re-run against current `main` (includes sibling reworks `b32cf9a`, `618bbe9`,
`2e6da03`, …):

- **Functional results identical**: reorder paths still produce the same persisted order
  (`identical=true`), search coverage/counts identical, touch targets identical, gates on the
  probe green (`tsc` 0, `eslint` 0).
- **V1 still reproduced**: 1 200/1 200 rows at the bottom (`virtual-bottom` evidence in
  `docs/qa/e2-search-reorder-logs/head/`).
- **Timings differ only with host load** (O2): at `loadavg ≈ 7` cold = 61 ms, throttled scroll
  median = 33.2 ms; with parallel `npm run ci` jobs (`loadavg 6.15`) cold = 218 ms and throttled
  median = 83.4 ms. Unthrottled scroll stayed at 60 fps / 0 dropped in every run.
- Raw logs: `head-probe-c590ab2.log`, `head-probe-c590ab2-loaded.log`.

## 8. Defects and observations (also in completion metadata)

**V1 — Major — virtualization pin (blocking for the §9.1 virtualization acceptance)**
`src/features/tasks/TaskList.tsx:234-251` (pin passed to `computeWindow` every frame) +
`src/domain/windowing.ts:64-71` (`start = min(start, pin)`, `end = max(end, pin+1)`).
Scrolling away from the pinned cursor renders O(distance) rows: 1 200/1 200 rows at the bottom of
a 1 200-row list, 288/288 in search results. Repro: probe test
`V1: scrolling far from the pinned cursor materialises the whole list` (expected-fail while open).

**O1 — Minor — cold search keystroke at/over the 50 ms budget**
First keystroke after opening Search pays the one-time index build inside the `input` handler:
44.7–54.8 ms (n=7 calm, median 51.3) vs the §9.1 <50 ms budget; warm keystrokes ≤19.4 ms.
Suggestion (design call, not decided here): build/refresh the index when the search screen opens
so the first character never pays for it.

**O2 — Informational — measurement sensitivity on a shared host**
Same probe: calm 44.7 ms cold / 16.7 ms throttled median → `loadavg 6–7` 218 ms / 83.4 ms.
Recommend CI pins a median-of-N (or a relaxed ceiling for the one-time build) rather than a single
wall-clock sample — same conclusion as E2 domain QA D2.

**Cross-card (not this card's defect list):**
- Review card t_64b514e2 blocks B1 (drop into own slot → false save-failure + dead Retry) and B2
  (drop on own sidebar list reorders) — my scripted ops do not cover those two gestures; routed to
  fix card `t_4fbe8392`.
- The E3 fix `2e6da03` ("call an empty store a wipe only with evidence of prior data") landed at
  `main`; on `ebcaf33` a fresh profile with an onboarding flag presents the §3.4 recovery screen —
  the probe walks it as a user would (`Start fresh`), so no measurement depends on that behaviour.

## 9. Evidence inventory

| File | Contents |
|---|---|
| `tests/e2e/qa-search-reorder.spec.ts` | The probe (6 tests, re-runnable; V1 = `test.fail()`) |
| `docs/qa/e2-search-reorder-logs/search_10k_keystrokes.json` | Per-keystroke frame/DOM latency + result counts |
| `docs/qa/e2-search-reorder-logs/search_10k_summary.json` | Cold/warm aggregate, `warmKeystrokesUnder50ms` computed |
| `docs/qa/e2-search-reorder-logs/reorder_paths.json` | Initial order + per-press keyboard orders + per-drop drag orders + `identical: true` |
| `docs/qa/e2-search-reorder-logs/drag_geometry_op{1,2,3}.json` | Drop coordinates, row rectangles, insertion-line target, viewport |
| `docs/qa/e2-search-reorder-logs/virtual_*.json` | Initial window/ARIA, keyboard walk, scroll frames (unthrottled + 4×), scroll-to-bottom defect |
| `docs/qa/e2-search-reorder-logs/cpu_throttle_probe.json` | Busy-loop proof the 4× throttle is engaged (3.6×) |
| `docs/qa/e2-search-reorder-logs/touch_handles_{375,320}.json` | Handle boxes at both viewports |
| `docs/qa/e2-search-reorder-logs/probe-run10.log`, `gates.log` | Canonical run + gate output (`ebcaf33`) |
| `docs/qa/e2-search-reorder-logs/head-probe-c590ab2*.log`, `head/` | Confirmation at `main` (calm + loaded) |
