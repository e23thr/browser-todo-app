# E7 Organization — Test Report (tags, subtasks, priority, migration)

- **Test card:** `t_ed1fa949` (h_reviewer) — child of epic `t_eb2174d7`, implemented at commit `6370493`.
- **Verdict: SUITE GREEN / 3 NEW DEFECTS FOUND (E7-D1, E7-D2, E7-D3)** — the 38-test
  acceptance battery and the whole regression suite pass, but first-hand probes found
  three user-reachable defects the existing tests do not cover (see §4).
- Every number below is first-hand. Gates were run in an **isolated worktree pinned to
  `6370493`** (`git worktree add /tmp/e7-check-6370493 6370493`, symlinked `node_modules`),
  because the shared tree is concurrently edited by in-flight sibling cards (crypto/recurrence
  work) — shared-tree runs are labelled separately.

## 0. Gates

| Check | Pinned worktree @ 6370493 | Shared tree (in-flight) |
| --- | --- | --- |
| `npx vitest run` (full suite) | **1162/1162 green, 107 files** (1154 baseline + 8 new E7 QA regression probes) | n/a — siblings' uncommitted edits make it non-representative |
| E7 acceptance battery (4 files) | **38/38 green** (`migration-v3`, `repos-e7`, unit + component `e7-org`) | green |
| `npx tsc -b` | **clean (exit 0)** | red on siblings' in-flight `crypto_state`/recurrence work — **not E7** |
| `npx eslint . --max-warnings 0` | **clean (exit 0)**; new files lint-clean | new files lint-clean |
| `npx prettier --check .` | **RED on 2 files — NOT E7's**: `src/domain/model.ts`, `vite.config.ts` | same |
| `npm run i18n:check` | PASS (en/th keys consistent; E7 added tag/subtask/priority keys) | PASS |
| `npm run audit:gate` | 0 vulnerabilities (E7 changes no dependencies) | — |

**format:check attribution (pre-existing):** both files fail at `6370493~1` (`fed96f5`, the
sync commit) and E7's diff does not touch either file — verified file-by-file. The offending
lines are the sync `StoreName` union entry and the sync coverage block. Pre-push fix owned by
the sync card; already disclosed in `cbf779c` and in the sibling review `docs/qa/e7-review.md`.

## 1. Migration test matrix (§5.4 M12)

| # | Scenario | Vehicle | Result |
| --- | --- | --- | --- |
| M1 | v1 DB (numeric priority, no `tags` field) → current schema through REAL `boot()` + **production registry** | `tests/unit/storage/e7-qa-boot-probe.test.ts` (new) | PASS — `migrated {from:1, to: APP_SCHEMA_VERSION}`, snapshot taken, `quarantined: 0` |
| M1a | Priority meaning-preserving map: `2/High→P1, 1/Medium→P2, 0/Low→P3, unset→P4, garbage→P4` | same probe + `migration-v3.test.ts` | PASS (first-hand, incl. garbage value kept as row, mapped P4) |
| M1b | **Tombstoned** rows remapped too (`deletedAt` preserved) | same probe | PASS |
| M1c | LWW stamps (`updatedAt`/`deviceId`/`tags`) untouched by migration | same probe | PASS |
| M1d | Reboot idempotent — no second migration, no second snapshot | same probe | PASS |
| M1e | Real Chromium page: literal v1 DB → real `boot()` | `tests/e2e/e7-organization-probe.spec.ts` (new) | PASS — **7.2 ms** @6370493; 29.7 ms in shared tree (schema v4 chain) |
| M2 | Hand-rolled literal **v1 export JSON** (not produced by current code) → upgraded on import, no quarantine | boot probe | PASS — `upgradedTo: APP_SCHEMA_VERSION`, priorities + recurrence remapped, stamps preserved |
| M2a | `schemaVersion: 99` file → `NEWER_SCHEMA` rejection, nothing partially imported | boot probe | PASS |
| M2b | Import cycle rejection (`markCycles`) unchanged | existing `import.test.ts` | PASS (suite green) |
| M3 | Rollback: pre-migration snapshot exists; `restoreSnapshot` path covered by `migration-v3.test.ts` rollback drill | existing suite, re-run first-hand | PASS |
| M4 | Domain regression green post-migration (views, kernel, LWW, tombstones, sync) | full suite 1162/1162 | PASS |

Priority-mapping deviation (spec row `0→P1, 1→P2, 2→P3` vs implemented `2→P1 … 0→P3`) was
**adjudicated and RATIFIED** by the sibling review card in `docs/qa/e7-review.md` §1 — MVP
encoding is `2`=High, so the implementation is the meaning-preserving one; the binding row in
the decomposition was itself wrong. Re-tested here independently: the map is correct.

## 2. Timing evidence at 10k tasks (S1 rename propagation)

| Substrate | Scale | Duration | Notes |
| --- | --- | --- | --- |
| **Real Chromium + real IndexedDB** (new e2e) | **10,000 tasks**, `sweepTag` one-transaction rename | **511.7 ms** (quiet tree) / **1339.8 ms** (shared tree under concurrent load) | `written: 10000, allRenamed: true` — **within the 2 s budget on real storage** |
| Real Chromium + real IndexedDB (new e2e) | full v1→v3 migration on real storage | **7.2 ms** | boot path incl. snapshot |
| fake-indexeddb (jsdom, first-hand re-run) | 10,000 tasks | **29.7 ms** | same code path, emulated storage |
| fake-indexeddb (existing test) | 2,000 tasks | ~7.9 s | **substrate artifact** — `fake-indexeddb`'s `update()` is quadratic; impl disclosed this |

Conclusion: the AC "rename propagation timed at 10,000 tasks" passes on real storage with ~4×
headroom under load. The quadratic numbers only appear on the emulated substrate and must not
be read as a product regression.

## 3. Depth-guard evidence ("no grandchildren possible — prove the guard")

| Path | Vehicle | Result |
| --- | --- | --- |
| **Create** under a depth-1 parent → `PARENT_DEPTH_EXCEEDED`, optimistic layer rejects before port write | existing `repos-e7.test.ts` + `e7-org` suites (re-run) | PASS |
| **Move** a task into a subtask group (repo, real chain) — new probe | `tests/unit/storage/e7-qa-depth-probe.test.ts` | PASS — rejected with `PARENT_DEPTH_EXCEEDED`, DB unchanged |
| **Move** path in the pipeline optimistic layer (no port write on violation) | same probe | PASS |
| UI: subtask editor exposes no nested "Add subtask" | existing `e7-org` component suite | PASS |
| Import: depth-2 chains from old files render flattened at depth 1 (never dropped) | existing `e2-qa-d1-fix` tests | PASS (suite green) |
| **EDGE (E7-D4, low)**: `parentTaskId === selfId` slips the repo guard | same probe (documents it) | repo accepts a self-parent when called directly — `#checkParent` early-returns when `parentTaskId === selfId`, and `validate.ts` only checks ULID format. **Not UI-reachable**: every UI call site passes `parentTaskId: null` (grep-verified), and views render a self-parent as root. Defensive-fix candidate, not a live defect. |

## 4. Defects (also in completion metadata)

### E7-D1 — HIGH — Reordering a subtask **silently unparents** it

- **Repro (real chain, first-hand):** `docs/qa/e7-qa-reorder-real-probe.test.ts` — 2/2 reproduce.
  Log: `[qa-e7-d1] move ok = true | DB parentTaskId = undefined` (both "Move down" and
  "Move up / first" variants; move **reports success** while the structural link is destroyed).
- **Root cause:** `moveTaskTo` (src/features/tasks/store.ts) always moves with
  `group: { listId, parentTaskId: null }`; real `TaskRepo.move` applies `#withGroup`, which
  **deletes `parentTaskId`** for a top-level group (taskRepo.ts), and the pipeline's optimistic
  layer does the same (pipeline.ts `moveTask`). Pre-existing code (`6370493~1` identical), but
  **E7 S2 made it user-reachable**: subtask rows now render full reorder affordances —
  `reorderable={view.kind === 'list' && sortMode !== 'priority'}` is not depth-gated
  (TaskScreen.tsx:434), so keyboard Alt+↑/↓, drag handle, and Move up/Down menu items on a
  depth-1 row all reach it.
- **Why tests missed it:** the component fixture port's `move()` spreads `current` and keeps
  `parentTaskId`, masking the defect in jsdom; no existing test covered subtask reorder at all.
- **Suggested fix direction (impl's call):** either move within the parent's sibling group
  (pass `parentTaskId` through), or withhold reorder affordances for depth-1 rows.

### E7-D2 — MEDIUM — "Move down" on a parent whose next row is its own subtask errors out

- **Repro:** `docs/qa/e7-qa-reorder-probe.test.tsx` — log:
  `[qa-e7-d2] parent move-down failure toast: Couldn't saveTry again`.
- Flat-row anchor computation produces `{ afterId: <subtask> }`; real `TaskRepo.move` rejects it
  (`REORDER_TARGET_NOT_IN_GROUP` — a subtask is not in the top-level sibling group), and the
  store surfaces a save-failure toast for a gesture that looks perfectly legal to the user.
- Same pre-existing root cause family as D1 (flat position model vs tree group).

### E7-D3 — MEDIUM — Active tag filter goes stale on rename/delete of that tag

- **Repro:** `docs/qa/e7-qa-tagfilter-probe.test.tsx` — 2/2 reproduce.
- `tagFilter` (store signal) is never reconciled by `renameTag`/`deleteTag`
  (TagsManageDialog → store). Renaming or deleting the tag the view is currently filtered by
  leaves `tagFilter` pointing at the old name → `filterByTag` matches nothing → **the list
  silently empties** while the tag-filter `<select>` (options = live task tags) no longer
  contains that value, so the select visually shows "no filter" while the view stays filtered
  to nothing. S1 says "rename propagation" — propagation to rows works (tested), propagation to
  the *filter* does not.
- **Suggested fix:** follow the rename in `tagFilter` (`work→office`), clear it on delete.

### E7-D4 — LOW (not UI-reachable) — self-parent edge in the repo guard

See §3. Evidence: `e7-qa-depth-probe.test.ts` (documents the behavior; views already render a
self-parent as root, so no visible corruption).

### INFO (not defects)

- **No existing test covered** subtask reorder or move-into-subtask depth guard before these
  probes (grep of `PARENT_DEPTH_EXCEEDED` coverage); both are now pinned by new probes.
- **format:check red** on `src/domain/model.ts` + `vite.config.ts` — pre-existing from
  `fed96f5`, not introduced by `6370493` (see §0). Cross-card (sync), pre-push fix.
- The sibling review card (`t_d45b8cf7`, `docs/qa/e7-review.md`) approved PASS; it did not
  exercise reorder gestures or the manage-tags interaction, which is where D1–D3 live — these
  findings are complementary, not a contradiction.

## 5. New artifacts (this card)

| File | Kind | Tests |
| --- | --- | --- |
| `tests/unit/storage/e7-qa-boot-probe.test.ts` | **regression** (stays in suite) | 4 PASS — real `boot()` + production registry, hand-rolled v1 export, NEWER_SCHEMA |
| `tests/unit/storage/e7-qa-depth-probe.test.ts` | **regression** (stays in suite) | 4 PASS — move-path depth guard repo+pipeline, self-parent edge documented |
| `docs/qa/e7-qa-reorder-real-probe.test.ts` | evidence, `it.fails` convention | 2 — **D1** (REAL chain) |
| `docs/qa/e7-qa-reorder-probe.test.tsx` | evidence, `it.fails` convention | 1 — **D2** |
| `docs/qa/e7-qa-tagfilter-probe.test.tsx` | evidence, `it.fails` convention | 2 — **D3** |
| `tests/e2e/e7-organization-probe.spec.ts` + `tests/e2e/e7-organization/{harness.ts,vite.config.mjs,index.html}` | **regression** (real Chromium) | 2 PASS — real-IDB migration + 10k sweep timing |
| `playwright.e7.config.ts` | focused e2e config (per-worker fixture build; never the shared `dist/`) | — |
| `tsconfig.e2e.json` | +1 line: include `playwright.e7.config.ts` | — |
| `docs/qa/e7-organization-logs/probe-run.txt` | raw probe + e2e run log | — |

`it.fails` polarity per the E8/E9 probe convention: each evidence test asserts the **desired**
behaviour and passes only because the defect reproduces — when the fix lands the test reddens
and must be flipped to `it()`.

Run instructions are in each probe's header comment (evidence probes live in `docs/qa/`,
outside every tsconfig by convention, and are copied into `tests/` to execute).

## 6. Evidence index

- Raw log: `docs/qa/e7-organization-logs/probe-run.txt` (vitest verbose + playwright output,
  including the D1 `parentTaskId = undefined`, D2 toast text, D3 empty-list states, e2e
  migration/sweep JSON).
- Pinned worktree: `/tmp/e7-check-6370493` @ `6370493`; parent-check worktree
  `/tmp/e7-parent-check` @ `6370493~1` (format baseline).
- Sibling review: `docs/qa/e7-review.md` (PASS, priority-mapping adjudication).
