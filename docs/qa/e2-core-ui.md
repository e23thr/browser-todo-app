# E2 QA — Core UI flows (M1–M4)

**Card:** t_8227547d (Test: Core UI flows M1–M4), Epic E2 · **Tester of record:** h_reviewer
**Date:** 2026-10-25 · **Refs:** PROJECT_ANALYSIS.md §4 (M1–M4, M8, M13, M15), §8 (accessibility),
§10 (E6 date semantics); `docs/design/core-domain.md` §5.5 (announcements), §5.6 (optimistic
writes), §6 flows F1–F7, §14 (state matrix), §16 items 6–24, 28–30, 37–42 (review contract).

## 0. Verdict

**PASS with 2 open defects** (F-1, F-3) — every M1–M4 flow works end to end against the domain
layer, the optimistic-add budget is *measured* at **1.7–3.4 ms** (budget < 100 ms), the
keyboard-only pass of the five core flows is **20/20 steps green in a real Chromium**, and the
touch-target sweep is **11/11 ≥ 44×44** after the in-run fix below. Re-verified on three
baselines as sibling cards landed (`b747c8e` → `f18cc35` → `c590ab2` → final `981c822`).

| # | Defect | Severity | Blocking? | Status at final baseline `981c822` |
|---|--------|----------|-----------|-------------------------------------|
| **F-1** | `a11y.taskAdded` never reaches the live region on the **first** capture of a session — Epic E3's persistence notice cancels it inside the 60 ms announce delay | Major (§8/M13 announcement) | **Yes** | **OPEN at HEAD** — fix **in flight** (uncommitted `M13-B1` `deferred` announce in the shared tree; verified: with those two files applied the probe records `PASS 3 … "Task added: Buy milk"`) |
| **F-2** | Task-row checkbox hit target was **24×24 CSS px** at 375 px (required ≥ 44×44, M8/§8) | Major (M8 touch target) | **Yes** | **FIXED during this run** by the core-UI review rework `b32cf9a` — effective target is now the `label.task-check-hit` wrapper, re-measured **44×44**, axe `target-size` clean |
| **F-3** | §14 `error.taskGone` row is unreachable in the composed screen: `TaskScreen` unmounts the editor on a concurrent delete, so unsaved edits vanish silently | Moderate (§14 / §16 item 41) | No (fix before release) | **OPEN at HEAD** (component characterization probe still green at `981c822`) |

Full detail, evidence and reproduction: **§13**. Out-of-scope observations (E2E **smoke** red at
HEAD, etc.): **§12**.

## 1. Scope, environment and how to reproduce

| Item | Value |
|---|---|
| Subject under test | Impl card t_a2c647e1 (`[E2] Impl: Core UI M1–M4`) — original baseline `b747c8e` (parent handoff HEAD `15defe6` + precache), **re-verified at every later HEAD as sibling cards landed**: `f18cc35`, `c590ab2`, final baseline **`981c822`** (core-UI review rework `b32cf9a`, M5/M6 R1, E3 fixes and the non-vacuous a11y gate all landed mid-run) |
| Tree state | **Clean `git worktree --detach` at each baseline**, `node_modules` symlinked to the shared repo. The shared working tree `/home/ubuntu/workspace/browser-todo-app` was continuously mid-edit by sibling cards during this run — every figure below comes from the frozen worktree(s), never the shared tree |
| Component probes (added by this card) | `tests/component/e2-core-ui-qa.test.tsx` — **19 tests**, written from the acceptance criteria, not from the impl's narratives — 19/19 at every baseline |
| Browser probes (added by this card) | `tests/e2e/core-ui-keyboard.spec.ts` — **2 tests**: keyboard-only F1/F2/F3/F4/F6 pass + 44 px touch sweep (sweep updated mid-run to measure the *effective* target `.task-check-hit` after `b32cf9a`); `tests/e2e/qa-axe-nonvacuous.spec.ts` — axe scan of the **real** core views (onboarding pre-dismissed, seeded via the real composer) |
| Impl suites re-run | every pre-existing file at each baseline — green |
| Full suite at final baseline `981c822` | **72 files / 861 tests, all green** (incl. the 19 QA probes) |
| Evidence files | `docs/qa/e2-core-ui-logs/keyboard-e2e-981c822.md` (final keyboard+touch run), `docs/qa/e2-core-ui-logs/keyboard-e2e-f18cc35.md`, `docs/qa/e2-core-ui-logs/axe-nonvacuous-f18cc35.txt` (pre-fix axe violations that `b32cf9a`/`ddd6e8f` then fixed) |

Reproduce (final baseline):

```bash
git worktree add --detach /tmp/e2-head 981c822 && ln -s "$PWD/node_modules" /tmp/e2-head/node_modules
cd /tmp/e2-head
npx vitest run tests/component/e2-core-ui-qa.test.tsx        # 19/19
npx vitest run                                               # 861/861
E2E_PORT=4191 npx playwright test --project=chromium tests/e2e/core-ui-keyboard.spec.ts tests/e2e/qa-axe-nonvacuous.spec.ts
npx eslint . --max-warnings 0 && npx tsc -b && npm run i18n:check && npm run format:check
```

## 2. Automated gates — PASS (final baseline `981c822`)

| Gate | Result |
|---|---|
| `npx vitest run` (full suite + QA probes) | **861/861, 72 files green** (also 779/779 at `f18cc35`, 802/802 ×2 at `c590ab2`) |
| `npx tsc -b` | 0 errors at every baseline |
| `npx eslint . --max-warnings 0` | exit 0 at every baseline (whole repo, incl. the three QA files) |
| `npm run i18n:check` | PASS — en/th key sets, values and placeholders consistent |
| `npm run format:check` | PASS |
| `npm run build` | PASS — ran as the Playwright `webServer` command on every E2E run (`tsc -b && vite build && precache && sw build`) |
| axe-core, **committed gate** `tests/e2e/a11y.spec.ts` (chromium, light+dark) | **2/2 PASS at `981c822`** — and no longer vacuous: `981c822` made the gate dismiss E3's first-run screen, so it now scans the real app (M13-B2). At `f18cc35` the gate still scanned the onboarding screen only — cross-check below |
| axe-core, **non-vacuous probe** `tests/e2e/qa-axe-nonvacuous.spec.ts` (real views, seeded rows, onboarding pre-dismissed) | **(zero) violations at `c590ab2`/`981c822`**. At `f18cc35` it found 3 (`docs/qa/e2-core-ui-logs/axe-nonvacuous-f18cc35.txt`): `list` serious + `target-size` serious (both review B1/B2 → fixed by `b32cf9a`) and `label` critical on the hidden import picker (→ fixed by `ddd6e8f`). All three were real, all three landed as fixes during this run |

Note: `npm run test` in the *shared* working tree can show transient failures from sibling
cards' uncommitted edits — they are green at every frozen baseline (verified here).

Known red at HEAD (out of this card's scope): `tests/e2e/smoke.spec.ts` — 6/7 fail at
`981c822`, same E3 first-run cause (§12).

## 3. M1 — task CRUD (F1 capture, F2 edit, F4 delete) — PASS

| Behaviour (spec) | Evidence | Result |
|---|---|---|
| F1.2/F1.3 `Enter` saves, field clears and stays focused, row appears in the derived group | e2e PASS 3/5: type → `Enter` → row in All open; composer cleared and ready for the next capture without leaving the field (D6) | PASS |
| F1.5 empty title → `form.error.titleRequired` linked with `aria-describedby`, Add disabled | component: composer suite + probe re-check of the zero-list/empty-title states; `Add` is `disabled` until `title.trim() !== ''` (`Composer.tsx:236`) | PASS |
| F1/§16 item 16 zero lists → `composer.needsList` + `New list` action, inputs disabled | e2e PASS 0 (zero-list state reached by Tab from a fresh profile) + component probe §14 | PASS |
| F2.1/F2.3 editor opens from the row (Enter / row menu), focus starts on Title, `Enter` saves, focus returns to the originating row button, `a11y.taskSaved` announced | e2e PASS 6; component "saves title + priority + list … restores focus" | PASS |
| F2.3 Save = all fields in one path (title + notes + due + list + priority) | component probe: title/priority/list asserted in `state` after one Save | PASS |
| F2 dirty `Escape`/`Cancel` → S7.3 discard confirm; `Enter` in a single-line field saves (§9.5) | impl suites + component re-checks (Discard / Keep editing paths) | PASS |
| F4.1/F4.2 `Delete` opens S7.1 with the task title in the body, initial focus on Cancel; Escape cancels and focus returns to the row; confirm deletes + `a11y.taskDeleted` | e2e PASS 9/10/11 (Escape path and confirm path both, keyboard only); component "Escape cancels…" + "confirm deletes…" | PASS |
| F4.3 deleting a completed task uses the same dialog | component suites (S7.1 cases) | PASS |
| §16 item 19/20 editor focus return, completed-task editing | component probes | PASS |

Optimistic add is verified twice: at component level with a never-settling write (§6) and in a
real browser against real IndexedDB (§7).

## 4. M2 — lists (F5 create/rename/reorder, F6 delete with disposition) — PASS

| Behaviour (spec) | Evidence | Result |
|---|---|---|
| F5.1 create via ListDialog with D10 validation (1–60, case-insensitive unique), list lands at the end of the order, `a11y.listCreated` | component "creates a list … desktop ListDialog" (wide path) + e2e PASS 1 (compact/composer path) and PASS 12 (lists screen) | PASS |
| F5.2 rename — desktop dialog *and* compact inline (Enter saves / Escape cancels / blur saves) | component: wide-dialog rename announced `List renamed to Groceries`; impl suites cover the inline branch (re-run green) | PASS |
| F5.3 `Alt+↑/↓` moves one position, `a11y.listMoved`; boundary no-op announces `a11y.reorderBoundary` | component "Alt+ArrowDown moves a list one position; the boundary is a no-op with its own message" (order asserted in **domain state**: `L2,L1`, then `Already at the bottom`, order unchanged) | PASS |
| F6.1 menu → `Delete list` → S7.2 shows `"X" has N open and M completed tasks…`, focus on Cancel | e2e PASS 13 (keyboard: menu open with ArrowDown, `End` jumps to the last item); component disposition tests | PASS |
| F6.2 disposition radio group: A (move + target select, default when another list exists) / B (delete tasks), confirm disabled until valid | component both branches + e2e run on the default A | PASS |
| F6.3 **one** transaction, result announced with the count, focus moves to the heading | component disposition A: list gone, **both tasks retargeted to L2 in domain state**, `List "Archive" deleted (2 tasks)`, focus on `h1[data-view-title]`; e2e PASS 14 | PASS |
| F6.4 Cancel/Escape changes nothing, focus returns to the trigger | component (delete-list cancel paths) + F4 Escape evidence for the shared Dialog shell | PASS |
| Disposition B really removes tasks (domain state, not just the DOM) | component: after confirm, zero live (`deletedAt === null`) tasks remain | PASS |

## 5. Layer boundary (ADR-003) — PASS

Spot-checked as part of this card: no core-UI component touches IndexedDB or repositories
directly. Every mutation the screens perform goes through `src/features/tasks/store.ts`
(`addTask`/`saveTask`/`deleteTask`/`setTaskDone`/list mutations → `MutationRunner` → the
`ListRepo`/`TaskRepo`/`SettingsRepo` ports bound in `startTaskStore`), and components read the
`state`/`status`/`today` signals only — `grep -rn "idb\|indexedDB" src/features src/components`
returns nothing. View membership and grouping come from the domain selector
(`selectView`, ADR-003 Decision 5) — the UI never re-derives view semantics. All user-visible
strings resolve through `t()` (the `i18n:check` gate is green), and the QA probes confirm the
en/th keys they assert are the ones rendered.

## 6. M4 — complete/uncomplete + §5.6 write protocol — PASS

| Behaviour (spec) | Evidence | Result |
|---|---|---|
| Optimistic apply happens before the write settles | component "applies completion to the UI while the write is still in flight" — a runner whose `setDone` **never** settles still yields `status: 'done'` in state, `data-done` on the row and the announcement | PASS |
| Optimistic add measured in a real browser | e2e PASS 4, measured on **every** baseline: row in the DOM **+1.7 / +2.3 / +2.6 / +2.7 / +3.4 ms** after `Enter` (`b747c8e`→`981c822` runs); IndexedDB write issued +5.0…+17.2 ms, settled +4.5…+16.8 ms — **visible strictly before settle, budget < 100 ms met** | PASS |
| F3.2 completed row stays 900 ms then collapses | e2e PASS 7 (`data-retained="true"` while held, then gone); component timed probe | PASS |
| F3.1/F3.3 `a11y.taskCompleted` / `a11y.taskReopened` at toggle time; uncomplete restores order and clears `completedAt` | component + e2e PASS 7/8; announcement sequence contains `Task completed` … `Task reopened` | PASS |
| §5.6 failure → rollback to the committed baseline + assertive `a11y.saveFailed` + Retry toast | component "rolls the row back … offers Retry": forced port failure after the optimistic apply → state back to `open`, row unchecked, assertive region `Could not save. Your change was undone.`, toast `error.save.title` with `common.retry` | PASS |
| §16 item 40 optimistic protocol on every mutation incl. rollback | above + impl suites re-run green | PASS |

## 7. M3 — the five views and E6 date boundaries — PASS

Seeded boundary set (local calendar labels, E6): `today−1`, `today`, `today+6`, `today+7`,
no date, and a completed task due today.

| View | Membership observed | Result |
|---|---|---|
| **Today** | only `today−1` (Overdue group, `!` marker + text) and `today`; `+6`, `+7`, no-date and completed excluded; count `2 tasks` | PASS |
| **Next 7 days** | `today` and `+6` only — **`+6` in, `+7` out** (inclusive window `today … today+6`), overdue not re-listed, exactly 2 day groups (empty groups omitted) | PASS |
| **All open** | all five open tasks across both lists with list groups + badges; completed excluded; count `5 tasks` | PASS |
| **Per-list** | only that list's open tasks in manual order, no group headers, no list badge, heading = list name | PASS |
| **Completed** | only the completed task, flat, `1 tasks`, `Completed on …` chip | PASS |

Also verified: unknown list deep link → redirect to Today with a polite announcement (§14), and
the D9 day-rollover test the impl added (in the green suite).

## 8. §14 empty / loading / error matrix — PASS

| State | Evidence | Result |
|---|---|---|
| Loading: skeleton with `aria-busy` + `a11y.loading` in a status region, h1 paints immediately | component probe | PASS |
| Error: `role="alert"` boot panel, `Try again`, storage link, typed error code shown | component probe (code `BLOCKED`) | PASS |
| Empty: per-view copy (`Nothing due today`, `Nothing due in the next 7 days`, `No open tasks`, `Nothing completed yet`, `Nothing in this list yet`) + `Add task` action | component probe (all four views + list empty state) | PASS |
| Zero lists: `composer.needsList` + `New list` (the composer is disabled, not dead) | component probe + e2e PASS 0 | PASS |
| Editor `error.taskGone` | **not reachable in the composed screen — defect F-3 (§13)** | FAIL |

## 9. Keyboard-only pass of the five core flows (§16 item 42) — PASS 20/20

Real Chromium (Playwright), desktop viewport, **no pointer events at all** in the flow — Tab,
typing, `Enter`, `Escape`, `Space`, `Delete`, `End`, `Alt`-free navigation only. Full step log:
`docs/qa/e2-core-ui-logs/keyboard-e2e-981c822.md` (final run; `…-f18cc35.md` is the
re-verification at the earlier baseline). Reproduced at `f18cc35`, `c590ab2` and `981c822`.

| Flow | Steps | Result |
|---|---|---|
| Setup | first-run screen (Epic E3) dismissed with Tab+Enter; zero-list composer reached with Tab | PASS |
| F1 capture | composer → type → Enter → row + `Task added` (F-1 caveat) → second capture without leaving the field | PASS |
| F2 edit | row → Enter → editor (focus on Title) → edit → Enter → saved, dialog closed, focus back on the row button, `Task saved` | PASS |
| F3 complete/uncomplete | `Space` on the focused row → check + `Task completed` → 900 ms retention → collapse; Completed view → `Space` → `Task reopened` | PASS |
| F4 delete | `Delete` → S7.1 focus on Cancel → `Escape` cancels (task intact, focus back on the row) → `Delete` again → `Shift+Tab` wraps to the confirm (§9.6 trap) → `Enter` → removed, `Task deleted` | PASS |
| F6 delete list | row menu with ArrowDown → `End` to the last item → `Enter` → S7.2 counts + focus on Cancel → `Tab` to confirm → `Enter` → list gone, task moved, count announcement, **focus on the h1** | PASS |
| Live regions | exactly one polite + one assertive region for the whole run | PASS |

## 10. Live-region announcements (design §5.5) — PASS with F-1

Recorded polite sequence from the keyboard run (in order):

```
List created: Personal | View: All open | This browser did not grant extra protection.
| Task added: Walk dog | Task saved | Task completed | View: Completed | Task reopened
| View: All open | Task deleted | View: Manage lists | List created: Work
| List "Personal" deleted (1 tasks)
```

Everything §5.5 assigns to M1–M4 is present (`taskAdded` for the *second* capture, `taskSaved`,
`taskCompleted`, `taskReopened`, `taskDeleted`, `listCreated`, `listRenamed` (component run),
`listMoved` + `reorderBoundary` (component run), `listDeleted`, `viewChanged`) — **except the
first `Task added`**, which never rendered (F-1). Assertive region: empty for the whole run
(no write failed), which is correct.

`a11y.taskMovedToList` ("… moved to <list>") is **out of this card's scope**: it belongs to
F11 / §16 items 33–35 (move-to-list), which the parent handoff assigns to the sibling M5/M6 card
(t_8524d4d7). Moving a list *inside the editor* is speced as `a11y.taskSaved` (F2.3) and is
verified as such.

## 11. Touch targets ≥ 44×44 (M8 / §8 / §16 item 5) — 11/11 PASS at `981c822` (F-2 fixed)

Measured with `getBoundingClientRect()` on a 375×667 viewport (compact pattern), final run:

| Target | Size (CSS px) | Result |
|---|---|---|
| `.fab` | 56×56 | PASS |
| `.tabbar a.tab` (nav tab) | 75×56 | PASS |
| `.tabbar button.tab` (More) | 75×56 | PASS |
| `.appbar .icon-button` | 44×44 | PASS |
| `.empty-state .button` | 91×44 | PASS |
| **`.task-check-hit` (checkbox label = effective toggle target)** | **44×44** | **PASS (F-2 fixed)** |
| `.task-title` (row title button) | 142×44 | PASS |
| `.row-menu-trigger` (row) | 44×44 | PASS |
| `.list-actions button` | 86×44 | PASS |
| `.list-row-link` | 243×44 | PASS |
| `.list-row .row-menu-trigger` | 44×44 | PASS |

**F-2 history (found → fixed within this run):** at baselines `b747c8e`/`f18cc35` the row
checkbox's *effective* target measured **24×24** (the CSS intended a 44 px hit area —
`width/height: 24px; padding: 10px; box-sizing: content-box; margin: -10px` at
`tasks.css:468` — but the browser computed `padding: 0px` on the native control, and axe
independently reported `target-size` serious with 22×24 safe space: the negative margin let
the row border/title cover part of the box, so edge clicks opened the editor instead of
toggling). The core-UI review rework **`b32cf9a`** fixed it by wrapping the input in a
`label.task-check-hit` (44×44, `--touch-min`, normal flow, no negative margins — native label
toggling). Re-measured with `tests/e2e/qa-f2-remeasure.spec.ts`: `.task-check-hit: 44×44`,
`.task-check: 24×24` (visual only, inside the label); axe `target-size` clean; the committed
sweep now measures the effective target and passes 11/11 at `c590ab2` and `981c822`.

## 12. Out-of-scope observations

1. **The E2E smoke suite is red at HEAD** (`npm run e2e:smoke`: 6/7 fail at `981c822`,
   re-run during this card). Every failure is the same cause: a fresh browser profile now shows
   Epic E3's first-run screen ("Your data lives in this browser") instead of the shell, and
   `tests/e2e/smoke.spec.ts` does not dismiss it (screenshots in `test-results/smoke-*`; the
   a11y gate had the same gap and was fixed in `981c822` / M13-B2 — smoke still needs the same
   treatment). Unrelated to M1–M4 (my specs dismiss the screen explicitly), but the ADR-001 §6
   smoke gate cannot go green — belongs to E1/E3, tracked here so it is not lost.
2. **Shared-tree churn**: the shared working tree was continuously mid-edit by sibling cards
   during this run (uncommitted M5/M6 edits at the start, then review-rework commits landing
   hourly). Any card running gates against the shared tree can see transient red — all figures
   in this report come from frozen detached worktrees. Hotspots touched during the run:
   `src/features/tasks/TaskList.tsx`, `src/app/announce.ts` + `src/features/data-safety/persistGate.ts`
   (M13-B1 F-1 fix, uncommitted at the time of writing), `tests/e2e/a11y.spec.ts` (`981c822`).
3. `a11y.taskMoved` (row reorder announcement) is also out of scope here — §16 item 31–36 (M6).
4. **Cross-check of the committed a11y gate**: at `f18cc35` `tests/e2e/a11y.spec.ts` passed 2/2
   while scanning *only E3's onboarding screen* on a fresh profile (App renders the first-run
   gate before the route view) — a vacuous pass. Confirmed with the non-vacuous probe (which
   found 3 real violations the gate missed), and the gate itself was fixed in `981c822`
   (M13-B2) to dismiss first-run before scanning. Re-run at `981c822`: 2/2 PASS **and** the
   probe reports zero — the gate now earns its pass.

## 13. Defect list

### F-1 (Major, blocking) — first capture's `a11y.taskAdded` never reaches the live region — **OPEN at `981c822`, fix in flight**

*Where:* `src/features/tasks/Composer.tsx:124` (`announce(t('a11y.taskAdded', …))`) racing
`src/features/data-safety/persistGate.ts:49` (`announce(persistence…)` after `requestPersist()`),
via the supersede rule in `src/app/announce.ts:64-72` (a newer `announce` cancels the pending
60 ms timer).

*What happens:* the first task written in a session triggers Epic E3's persistence notice
(`noteFirstMeaningfulWrite`, called from `store.ts:336` right before the composer's own
`.then`). `navigator.storage.persist()` resolves within a few milliseconds — inside the 60 ms
announce delay — so the notice cancels `Task added: <title>` before it is ever written to the
region. Subsequent captures are unaffected (the gate only runs once).

*Evidence:* the recorded announcement sequence in §10 contains `Task added: Walk dog` (second
capture) but **not** `Task added: Buy milk` (first capture); the FINDING F-1 line in the E2E
evidence file reproduced on **every** run at `b747c8e`, `f18cc35`, `c590ab2` and `981c822`.
Mechanism confirmed in source (above).

*Impact:* a screen-reader user gets no confirmation for the very first task they add — the flow
the JTBD "< 5 seconds capture" is built around. Violates design §5.5 / F1.3 and §16 item 42, and
§8's "live-region announcements for async changes" (M13 release gate).

*Status / fix in flight:* Epic M13's rework (uncommitted `src/app/announce.ts` `deferred`
option + `persistGate.ts` `{ deferred: true }` in the shared tree at the time of writing)
implements exactly the suggested sequencing. Verified by this card: copying those two files
onto `981c822` turns the probe's `FINDING F-1` into `PASS 3 … "Task added: Buy milk"`.
**Re-check after M13-B1 lands: the keyboard probe must record PASS 3, not FINDING F-1.**

### F-2 (Major, blocking) — row checkbox touch target is 24×24 instead of ≥44×44 — **FIXED by `b32cf9a` (rework landed mid-run)**

*Where (as found):* `src/styles/tasks.css:468-477` (`.task-check`), measured at 375×667.

*What happened:* the intended 44 px hit area did not materialise — computed `padding` was
`0px`, border box **24×24 CSS px**, and axe reported `target-size` serious (22×24 safe, edge
clicks opened the editor). Evidence: E2E sweep FINDING F-2 on 2 runs at `b747c8e`/`f18cc35`.

*Fix:* core-UI review rework `b32cf9a` wrapped the input in `label.task-check-hit` (44×44,
normal flow, no negative margins). **Re-verified by this card**: `qa-f2-remeasure` →
`.task-check-hit: 44×44`; axe non-vacuous probe → `target-size` clean; touch sweep → 11/11 at
`c590ab2` and `981c822`. Closure evidence: §11.

### F-3 (Moderate, non-blocking) — `error.taskGone` never renders in the composed screen — **OPEN at `981c822`**

*Where:* `src/features/tasks/TaskScreen.tsx:163-164, 269-277` vs `src/features/tasks/TaskEditor.tsx:55,148-152`.

*What happens:* `removeTask` evicts the row from state optimistically, `TaskScreen`'s
`editingTask` becomes `undefined` and the editor **unmounts** — so the §14 editor error row
(`error.taskGone`, Save disabled) can never appear in situ. The state itself works, but only
when `<TaskEditor>` is mounted standalone (which is exactly how the impl suite tests it,
`core-ui-composer.test.tsx:276`).

*Evidence:* component probe "taskGone (§14 S4): a concurrent delete closes the editor instead of
showing the row" — after a concurrent removal the dialog is gone and neither the message nor a
Save button exists.

*Impact:* a task deleted in another tab (E5 two-tab scenario) silently closes the editor; the
user's unsaved edits are lost without the documented explanation or a chance to re-enter them.
Violates §14's editor row and §16 item 41.

*Suggested fix:* keep the editor mounted while it has unsaved state (hold `editingId`, render the
editor against the last known task and flip `gone`), or prompt with the S7.3 discard confirm
instead of closing.

## 14. Acceptance criteria

| AC | Status |
|---|---|
| `docs/qa/e2-core-ui.md` with per-flow evidence **including a keyboard-only run** | ✅ this document; keyboard run §9 (20/20 steps, real browser, reproduced at 3 baselines, evidence in `docs/qa/e2-core-ui-logs/`) |
| Optimistic add → visible < 100 ms perceived, verified or measured | ✅ **measured 1.7–3.4 ms** to DOM-visible (5 runs across all baselines), strictly before the IndexedDB write settled; component-level proof with a never-settling write (§6) |
| Defect list in the report **and** completion metadata | ✅ §13 — **F-1** (open, M13-B1 fix in flight, re-verified), **F-2** (found here, fixed by `b32cf9a`, re-verified 11/11), **F-3** (open) + metadata `known_defects` |
