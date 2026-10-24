# E2 M5/M6 — Search, reorder & virtualization — review evidence (t_64b514e2)

- Reviewer: `h_reviewer` · round 1 · reviewed_at 2026-10-25T02:30:00Z
- Scope: M5/M6 implementation commits `5c4d346` (M6 reorder), `80e65c4` (M5 search),
  `85588df` (sidebar drop seam, grip icon, search autofocus), `ebcaf33` (45 component tests),
  reviewed as landed on `main` at `618bbe9` (includes sibling rework `b32cf9a`/`618bbe9`
  and E3 merge `f18cc35` — the shared workspace's uncommitted E3/E9 edits were NOT reviewed;
  the impl's own commits were verified on a clean basis).
- Baseline: detached clean worktree at `618bbe9` (`/tmp/e2-review-wt`); all gates re-run there,
  not on the dirty shared tree.
- Contracts: `docs/design/core-domain.md` (§5.5–§5.7, §6 F8–F11, §7 S5, §8.1–§8.3,
  §9 keyboard map, §16 items 25–27/31–36/39/40/42), `PROJECT_ANALYSIS.md` §4 M5/M6, §8,
  §9.1 budgets, ADR-003 Decision 4/6 + `docs/dev/domain-api.md`.
- Probe: `docs/qa/e2-m5m6-review-probe.spec.ts` (re-runnable; `E2E_PORT=4291 npx playwright test
  docs/qa/… --project=chromium --workers=1` after moving into `tests/e2e/` or via `--config`).

## Verdict

**REQUEST CHANGES — 2 blocking, 5 non-blocking.** Everything else on the checklist passes,
including all a11y, budget and test gates.

---

## 1. Automated gates (clean worktree @ `618bbe9`)

| Gate | Command | Result |
|---|---|---|
| typecheck | `npm run typecheck` (`tsc -b`) | PASS, 0 errors |
| lint | `npm run lint` (`eslint . --max-warnings 0`) | PASS, exit 0 |
| format | `npm run format:check` (prettier) | PASS, all files |
| i18n | `npm run i18n:check` | PASS — en/th consistent, every `t()` literal resolves |
| unit + component | `npm test` | PASS — **773/773 (68 files)**; the 4 M5/M6 suites: search 15, reorder 14, virtual 8, keyboard 8 = **45/45** |
| build | `npm run build` (tsc + vite + precache + sw) | PASS |
| bundle budget | `npm run budget` | PASS (no-wasm, no external refs) |
| audit | `npm run audit:gate` (`npm audit --omit=dev --audit-level=high`) | PASS — 0 vulnerabilities |
| coverage | `npm run test:coverage` | all files **83.63 % stmts / 77.53 % branch / 82.17 % funcs / 86.05 % lines**; `features/search` 85.62 %, `domain/search` 97.31 %, `TaskList` 86.15 %, `reorderDrag` 78.02 % (see N1) |

## 2. Real-browser probe (chromium, production build)

`tests/e2e/reviewer-probe-m5m6.spec.ts` on the preview server (moved to
`docs/qa/e2-m5m6-review-probe.spec.ts`):

| Check | Result |
|---|---|
| axe `wcag2a/aa, wcag21a/aa, wcag22aa` — search results (populated, `<mark>`) | **clean, 0 serious/critical** |
| axe — per-list view with reorder handles | **clean** |
| axe — move-to-list dialog (F11) | **clean** (empty-target state; multi-list radio path pinned by the F11 component test) |
| axe — virtualized list, 210 rows, pad spacers | **clean**; pads render as `LI.task-list-pad aria-hidden=true` (no `role=presentation` — sibling rework `b32cf9a` fixed the prior review's B1 for both group rows and this card's pads) |
| Reorder handle | `44×44` `BUTTON`, accessible name `Reorder "Buy milk"` (§8.1) |
| Search `<mark>` | renders (1 hit for "milk"); `<mark>` uses design tokens (`--color-warning-tint/-text`, both themes) |
| Search results | 0 reorder handles (D1/§16-27) |
| Virtualization | 210 rows → **21–22 DOM rows** (`data-virtualized=true`); `End` on row 1 materializes + focuses row 210 (`aria-posinset=210`, `aria-setsize=210`, 22 DOM rows); mid-scroll `aria-posinset=189` — real positions, not window indices |
| Virtualization + keyboard (jsdom suites) | arrow/PageDown crossing window boundaries, pin + pendingFocus, computeWindow 0.09 ms@1k / 0.33 ms@10k — PASS (8/8) |

## 3. Blocking findings (both reproduced in a real browser AND in jsdom @ `618bbe9`)

### B1 — Drag into the row's own slot raises a false save-failure (assertive) + a Retry that can never succeed

- Where: `src/features/tasks/TaskList.tsx:138-145` (`positionForIntent`), triggered by
  `TaskList.tsx:439-443` (`onDrop` → `onMoveTo`), rejected at
  `src/domain/pipeline.ts:295-303` (`#groupRows` excludes the moved task, so a self-`afterId`
  fails `REORDER_TARGET_NOT_IN_GROUP` synchronously).
- Reaches the user via `store.ts:264-302` (`guard` → `reportFailure`): assertive
  `a11y.saveFailed` + `error.save.title` toast with a **Retry** action that re-runs the exact
  same rejected position (infinite fail loop).
- Geometry: dropping the dragged row in the gap directly below itself (its own slot's right
  boundary — the most common "picked it up, put it back" release) resolves
  `before <next row>` → `{ afterId: <dragged row itself> }` → domain rejects.
- Real-browser probe E (drag row 2 down 12 px, release):
  `toasts: ["Couldn't save + Try again", "Could not save. Your change was undone."]`,
  order unchanged `["One alpha","Two beta","Three gamma"]`.
  jsdom probe A: `moveTask` called once with `position={afterId:"T2"}`, assertive contains "undone".
- Expected (§8.1 drop semantics, §8.3 failure feedback, §5.6): a drop that resolves to the row's
  current position writes nothing (or is a valid no-op write) — NO failure feedback. The keyboard
  path already implements exactly this guard (`TaskScreen.tsx:269-276`, boundary → no write +
  polite `reorderBoundary`); the drag path must hold the same bar (checklist item 39,
  every gesture needs parity).

### B2 — Drag onto the task's OWN list in the sidebar reorders it to the bottom of that list

- Where: `src/app/Shell.tsx:78` renders `data-drop-list-id` on **every** list (no current-list
  exclusion); `src/features/tasks/TaskScreen.tsx:302-315` (`onDropOnList`) unconditionally
  executes `moveTaskTo(id, listId, 'last')`; the drop layer highlights the own list
  (`data-drop-hover=true`, probe F confirmed).
- Conflict: §8.1 says the sidebar drop "executes F11 semantics" and F11 explicitly excludes the
  task's current list as a target (`MoveToListDialog.tsx:37`, §16-35 "current list … not a target").
- Real-browser probe F (drag task 1 onto its own sidebar entry):
  order became `["Two beta","Three gamma","One alpha"]` (task teleported to the end of its own
  list) with announcement `"One alpha" moved to Probe List` — a membership-change announcement
  for a task that never changed lists.
- Expected: drop on the current list is not a move — no order change (exclude it as a target
  like F11 does, or treat the drop as `reorderCancelled` per §8.1's cancel path).

## 4. Non-blocking findings (fix before merge, no re-review)

1. **N1 coverage** — `src/features/tasks/reorderDrag.ts` sits at **78.02 % stmts / 63.82 %
   branch**: the auto-scroll timer branches (`reorderDrag.ts:141-151`), `pointercancel`
   (`:197-199`) and parts of `dispose` are uncovered. Bring the file to ≥ 80 % (unit bar).
2. **N2 keystroke work** — `searchIndexCache.ts:44-61` runs `liveTasks()` (full O(n) Map build)
   on **every** `SearchView` render before the `state.version` check, contradicting its own doc
   ("Query keystrokes never touch this module beyond `state.version` reads", `:14-16`);
   `domain/views.ts` `searchView` also rebuilds the `valid` id-Map per query. Measured in budget
   (7.03 ms median / 10.78 ms worst @ 10k vs the 50 ms §9.1 bar), so not blocking — but hoist
   both behind the version/result guards to keep the promise literal.
3. **N3 virtualization + group headers** — `TaskList.tsx:182-192` measures only
   `[data-task-id]`; `.group-row` headers are never measured and always use the
   `--row-height-task` estimate, so grouped aggregate views > 200 rows accumulate prefix-sum
   drift (cosmetic scroll imprecision; cursor row still pinned, axe still clean). Measure group
   rows keyed by `row.key` too.
4. **N4 memory** — `TaskList.tsx:175` `heights` Map never evicts entries for deleted/hidden
   tasks; unbounded within a long session (nit at 10k+ scale).
5. **N5 drop-intent coupling** — `TaskList.tsx:140` maps `after-last` to the literal position
   `'last'` (absolute end of the FULL list) while the insertion line marks the last *rendered*
   row. Today overscan (2×8) keeps the pointer above the last rendered row's midpoint, so this
   is unreachable mid-list — but the safety is implicit. Prefer
   `{ afterId: <last rendered row> }` (identical outcome when the true last row is rendered).

## 5. Informational

- The impl handoff's latency numbers (median 3.2 ms / build 30 ms) differ from the evidence file
  (median 7.03 ms / build 108 ms) — regenerated by the parallel Test card at 02:02 on a loaded
  machine. Both are far inside the < 50 ms budget; the CI gate (`search.test.ts`) pins ≤ 50 ms.
- Cross-card observation (M1–M4/E9 scope, not this card): `Composer.submit` refocuses its title
  in `addTask().then()` (`Composer.tsx:131-141`), so a late-settling add steals focus back from
  wherever the user moved during the write (observed while seeding 210 tasks in the probe).
  Route to the composer owner.
- F11 dialog probe saw 0 radios only because the fresh profile had a single list (empty-target
  state); the multi-list radio path + current-list marking are pinned by
  `core-ui-reorder.test.tsx` (F11) and the keyboard evidence.

## 6. Checklist verdicts (card body)

| Item | Verdict |
|---|---|
| Keyboard parity with drag | **PASS** — Alt+↑/↓/Home/End one-step/edge moves, focus retention + per-press `a11y.taskMoved {position}{total}{list}`, boundary no-op + `reorderBoundary`, menu Move up/down `aria-disabled` at ends, handle routes identical commands (§9.1 inner map), F11 radio dialog; 45/45 tests + keyboard evidence 8/8 (F8/F10/F11). Drag-only defects B1/B2 are the parity gaps found. |
| Search-index discipline (no per-keystroke rescan) | **PASS** — lazily built `SearchIndex` singleton, incremental diff per `state.version` only, indexed query per keystroke, 7 ms median @ 10k (< 50 ms); naive fallback documented (ADR-003 D6.3). N2 is a literal-promise nit. |
| Virtualization edge cases (dynamic row heights) | **PASS with notes** — rendered rows re-measured every layout pass (variable heights), pin materializes the cursor row across window jumps (real-browser `End` → row 210 focused with real posinset), pads are `aria-hidden` li (axe clean), rAF-coalesced scroll. N3/N4/N5 are the edge notes. |
| a11y (WCAG 2.2 AA) | **PASS** — axe serious/critical **0** on all four M5/M6 surfaces (real browser); handle 44×44 named; drag never the only path; live regions per §5.5 (polite moves/boundary/unavailable, assertive save-failure); real ul/li + native checkbox intact under virtualization; `<mark>` contrast via tokens in both themes. |
| §9.1 budgets | **PASS** — search 7.03 ms median / 10.78 ms worst @ 10k (< 50 ms, CI-pinned); virtualize > 200 rows (210 → 21 DOM rows real browser); reorder = one `moveTask` call per gesture (spy-verified) — main-thread work per interaction is sub-frame (computeWindow 0.33 ms @ 10k); true browser INP/60fps belongs to the e2e lane (impl noted honestly). |
| §16 items 25–27 (search) | **PASS** — synchronous indexed filter + `<mark>` + notes excerpt + title-before-notes rank; 300 ms debounced count + Escape ×2; idle/no-results states; interactive results, no handles; visible "N results" group header (`labels.ts:44-45`). |
| §16 items 31–36 (reorder) | **FAIL on 31/34** — B1 (item 31 drop) and B2 (item 34 sidebar drop) above; items 32/33/35/36 PASS (keyboard, aggregate-unavailable, dialog, single-write + rollback — all test-pinned). |
| ADR-003 / domain boundary | **PASS** — features import domain only; every move is one `MoveTarget` position → one record; domain validation is synchronous and typed (`RULE/REORDER_TARGET_NOT_IN_GROUP`); search runs over the maintained domain index. |
| Domain correctness (Epic ACs) | **PASS with the 2 drag defects** — measured latency recorded, both reorder paths end-to-end + persistence + single-record-write spy proof, virtualization evidence, 45 component tests. |
