# E2 Core UI (M1–M4) — review evidence (t_3650ed00)

- Reviewer: `h_reviewer` · round 1 · reviewed_at 2026-10-25T00:40:00Z
- Scope: core-UI implementation commits `3866cd8`, `63ba421`, `e4b5601`, `b8fcba1`, `15defe6`
  (task editor, composer, task rows/list, five views, lists management, confirm dialogs, toasts,
  `src/styles/tasks.css`, component suites).
- Baseline: detached clean worktree at `15defe6`
  (`~/.hermes/profiles/h_reviewer/cache/scratch/e2rev-1792861753`) — the shared workspace carries
  uncommitted E3 data-safety edits, so every gate below was re-run at HEAD, not on the dirty tree.
- Contracts: `docs/design/core-domain.md` (§5, §6 F1–F7, §7 S2/S3/S4/S6/S7, §9, §13, §14, §16),
  `PROJECT_ANALYSIS.md` §4 M1–M4, §8, §9.1, ADR-003 / `docs/dev/domain-api.md`.

## Verdict

**REQUEST CHANGES — 4 blocking, 9 non-blocking.** Everything else in the checklist passes.

---

## 1. Automated gates (clean worktree @ `15defe6`)

| Gate | Command | Result |
|---|---|---|
| typecheck | `npm run typecheck` (`tsc -b`) | PASS, 0 errors |
| lint | `npm run lint` (`eslint . --max-warnings 0`) | PASS, exit 0 |
| format | `npm run format:check` (prettier) | PASS, exit 0 |
| i18n | `npm run i18n:check` | PASS — en/th key sets, values and placeholders consistent; every literal `t()` resolves (4 informational non-literal call sites, all fed by constant key maps) |
| unit + component | `npm test` | PASS — **675/675 (61 files)**, incl. the 59 core-UI component tests |
| build | `npm run build` (tsc + vite + precache + sw) | PASS |
| bundle budget | `npm run budget` | PASS (initial JS gzip 36.41 KB ≤ 100 KB; no external refs; no wasm; locales lazy) |
| audit | `npm run audit:gate` (`npm audit --omit=dev --audit-level=high`) | PASS — 0 vulnerabilities |
| coverage | `npm run test:coverage` | all files 80.01 % stmts / 75.62 % branches / 78.86 % funcs / 81.96 % lines; `src/domain` 96.77 %; **`src/features/tasks` 74.00 % / 67.04 %**; `src/features/lists` 83.56 % / 75 % |
| e2e axe (shipped) | `E2E_PORT=4187 npx playwright test tests/e2e/a11y.spec.ts` | 6 passed (chromium, chromium-th, firefox × light/dark); webkit ×2 = **environment only** (`Host system is missing dependencies… libevent-2.1-7t64`), not an app defect |
| e2e core journey | `E2E_PORT=4187 npx playwright test tests/e2e/offline-data-journey.spec.ts --project=chromium` | **1 failed** (`offline data journey: an offline write survives an offline reload` — settings radio unreachable), **1 skipped** (`offline task journey: add → complete → reload (E2 core UI)` — `composer.count() === 0`) — see §5 |

## 2. axe-core over POPULATED core-UI surfaces (reviewer probe)

The shipped `tests/e2e/a11y.spec.ts` runs on a fresh profile; on a fresh profile `App.tsx:206`
returns `<Onboarding/>` **before** the route view renders, so its eight "core route" scans all hit
the E3 first-run screen (verified: the Playwright error snapshot for `#/today` is
`heading "Your data lives in this browser"`). Its PASS therefore does not cover a single task row,
menu, editor or confirm dialog.

The review probe (`docs/qa/e2-core-ui-review-probe.spec.ts`, run with
`--project=chromium --workers=1`, `E2E_PORT=4187`) dismisses onboarding, creates a list, adds three
tasks through the real composer, then scans with
`wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa`:

| Surface | axe result |
|---|---|
| All open, 3 rows | **2 serious** (below) |
| Row menu open | **2 serious** (same two) |
| Task editor dialog | **2 serious** (same two) |
| Delete-task confirm (S7.1) | **2 serious** (same two) |
| Lists manage screen (S6) | clean |
| Delete-list disposition (S7.2) | clean |
| List create dialog | clean |

**Violation A — `list` (serious)**

```
node: <ul class="task-list" aria-label="All open">
Fix all of the following:
  List element has direct children that are not allowed: [role=presentation]
```

DOM dump of the same `ul`: `LI.group-row[role=presentation]`, `LI.task-row`, `LI.task-row`,
`LI.task-row` — so the only offender is the group header `<li role="presentation">`
(`src/features/tasks/TaskList.tsx:176`). WCAG 2.2 AA is a release gate (PROJECT_ANALYSIS §8 M13).

**Violation B — `target-size` (serious, SC 2.5.8)**

```
node: <input type="checkbox" class="task-check" aria-label="Mark "Review alpha task" as complete">
data: [{"messageKey":"partiallyObscured","minSize":24,"width":22,"height":24},
       {"closestOffset":22,"minOffset":24}]
Fix any of the following:
  Target has insufficient size because it is partially obscured
    (smallest space is 22px by 24px, should be at least 24px by 24px)
  Target has insufficient space to its closest neighbors.
    Safe clickable space has a diameter of 22px instead of at least 24px.
```

Cause: `src/styles/tasks.css:468-477` — `width/height: 24px; padding: 10px; box-sizing: content-box;
margin: -10px`. The negative margin pulls the 44 px box over the row border / title button, so ~2 px
of the "44 px hit area" is covered by a sibling and the click there goes to that sibling (the title
button opens the editor). The design's intent (24 px visual, 44 px hit area, §5.1) is right; the
technique is what fails.

## 3. Keyboard / focus-model facts (reviewer probe, Chromium)

| Fact | Observed | Contract |
|---|---|---|
| Roving cursor | 3 rows, **1** tabbable `li`, inner controls of the current row tabbable only | §9.1 PASS |
| `Escape` from a row's title button | focus → `li.task-row` | §9.1 PASS |
| Editor initial focus | `input[type=text]` (title) | S4 / §16-18 PASS |
| Focus after editor close | the originating title button | §5.2 / §16-18 PASS |
| Delete-confirm initial focus | `Cancel` | S7 / §16 PASS |
| **`Tab` from inside the row menu** | **`document.body`** | §9.2 "Tab closes and moves to the next control after the trigger" **FAIL** |

The `Tab` failure is structural, not timing: `RowMenu.focusAfterTrigger`
(`src/features/tasks/RowMenu.tsx:75-87`) takes `scope = trigger.closest('li, section, div')` → the
`div.row-menu` wrapper, then `candidates = focusablesIn(scope.parentElement)` = every focusable in
`div.row-main` **including the open menu's own items**, and focuses `candidates[at + 1]` where `at`
is the **trigger's** index — i.e. the first menu item. `setOpen(false)` then unmounts that item in
the same tick, so focus falls to `document.body` and the next `Tab` restarts from the top of the
page. Same code path is used by the list rows in `ListsManageView`.

## 4. Checklist vs §16 (design handoff contract)

| §16 item | Verdict | Note |
|---|---|---|
| 1–5 shell/nav | n/a (E5 owns S1) | this card only added the `#/lists` nav links (`Shell.tsx`) |
| 6 grouping | PASS | `selectView` drives all five views; golden tests green |
| **7 row states** | **FAIL** | `default`, `focus`, `completed`, retention, 3 s fallback present; **no `hover` and no `pressed` rule for `.task-row` or `.list-row` anywhere in `src/styles/`** (the only `:hover` rules are buttons, nav links, tabs, FAB, `.menu-item`). §7 S2/S6 and §10's 7-state contract enumerate them |
| 8 due badge | PASS | `task.due.overdue/.today/.tomorrow` + `!` marker (non-colour) |
| 9 priority | PASS | high/medium only, distinct sprite shapes, `role=img` + `aria-label` |
| 10 list badge | PASS | `showListBadge = view.kind !== 'list'` |
| 11 row menu order | PARTIAL | `Edit`, `Delete` (danger) present in order; `Move to list… / Move up / Move down` are **M6** (`PROJECT_ANALYSIS` M6 = "move up/down/into") — not in this card's baseline; the M6 review card must verify them |
| 12 D9 rollover | PASS | `visibilitychange` + midnight timer, pinned by `core-ui-views.test.tsx` |
| 13–17 composer | PASS / 2 nits | see N1, N2 |
| 18–21 editor | PASS / 1 nit | see N3 (two-write save) |
| 22–24 complete | PASS | native checkbox + `a11y.toggleTask`, 900 ms retention with anchor, optimistic toggle, `sortOrder`/`completedAt` handled by the domain |
| 28–30 lists | PASS | D10 validation, 8 radio swatches with text labels, S7.2 exactly (counts, required disposition, A disabled + `noTarget`, one transaction, `a11y.listDeleted {count}`), `Alt+↑/↓` + `a11y.listMoved` + boundary announcement + `aria-disabled` menu equivalents |
| 37 i18n | PASS | zero hardcoded JSX text (regex scan of `src/**/*.tsx` = 0 hits), all keys in both catalogs |
| 38 WCAG | **FAIL** | A + B above (serious axe); reduced-motion, focus ring (3 px/2 px) and token usage are fine |
| 39 gesture parity | PASS | add/complete/delete/edit/list CRUD each have pointer + keyboard paths |
| 40 optimistic protocol | PASS / 1 nit | every mutation through `guard()` → pipeline; 3 s slow-write → assertive `a11y.saveFailed` + Retry; rollback covered by suites. See N3 for the one dishonest message |
| 41 state matrix | PASS / 1 nit | skeleton (`aria-busy` + `a11y.loading`), per-view empty titles + action, boot error with Retry — but the **lists screen's** error panel has no action (N5) |
| 42 keyboard script | PARTIAL | F1/F2/F3/F4/F6 proven 5/5 by the card; F8/F10/F11 need the M5/M6 UI, which does not exist in this baseline — epic-level item |

## 5. Cross-card observations (not this card's code, but they blind the gates)

1. **`tests/e2e/a11y.spec.ts` is currently vacuous on a fresh profile** — `App.tsx:206` renders the
   E3 onboarding gate before any route view, so all eight "core views" scans hit the onboarding
   screen. Dismiss it (click `Get started`) or seed `todo:prefs:v1:onboardingStep = 'done'` in the
   spec, otherwise no future axe regression on real views can fail CI.
2. **`offline-data-journey.spec.ts` at HEAD**: the E2 core-UI journey **self-skips**
   (`composer.count() === 0` behind the same gate) and the settings offline-write test **fails**.
   Coordinate with E3 / the E2 test card (`t_8227547d`); the E2 e2e journey evidence is not green.

## 6. Boundary, security, i18n spot-checks

- **Domain boundary**: no component imports IndexedDB or repositories; the only exception is
  `TaskScreen.tsx:43 → resetBootSingleton` (N4). `store.ts` is the documented composition root.
- **Injection / XSS**: no `innerHTML`, `insertAdjacentHTML`, `eval`, `new Function` or
  `dangerouslySetInnerHTML` anywhere in `src/`; titles and notes render as text nodes; `t()` keys are
  never built from user input. One raw-id selector (N6).
- **Secrets**: none in the diff. **Dependencies**: `npm audit --omit=dev --audit-level-high` = 0.
- **Copy**: `grep '>[A-Za-z]…<'` over `src/**/*.tsx` → 0 hardcoded text nodes; `i18n:check` green;
  Thai parity verified.

## 7. Findings

### BLOCKING

- **B1 — `list` axe violation (serious, WCAG 2.2 AA).** `TaskList.tsx:176` group headers render
  `<li class="group-row" role="presentation">`; axe: *"List element has direct children that are not
  allowed: [role=presentation]"* on `ul.task-list`. Expected: zero serious/critical violations on a
  populated view. Fix by dropping `role="presentation"` (or hoisting group headers out of the `ul`).
- **B2 — `target-size` axe violation (serious, SC 2.5.8).** `tasks.css:468-477` `.task-check` —
  axe measures a safe clickable space of **22 × 24 px** (< 24 px) because `margin: -10px` lets the row
  border / title button cover part of the 44 px box; a click in that overlap opens the editor instead
  of toggling. Fix the hit-area technique so it does not overlap siblings (wrapper/label padding, or
  an absolutely positioned hit area).
- **B3 — row-menu `Tab` drops focus to `document.body`** (`RowMenu.tsx:75-87`), task rows and list
  rows. Observed in Chromium with the probe; §9.2 requires *Tab closes and moves to the next control
  after the trigger*. Fix: skip candidates inside `.row-menu` (compute the next tabbable after the
  whole `.row-menu` container), and add a keyboard test for the `Tab` path (only `Escape` is pinned
  today).
- **B4 — row hover and pressed states missing** (§16 item 7, §7 S2/S6, §10 7-state contract): no
  `.task-row:hover`, `.task-row:active`, `.list-row:hover`/`:active` rule exists in any stylesheet.
  Expected: hover background `color.bg.raised`-equivalent and a press state, with hover never being
  the only affordance.

### NON-BLOCKING (fix before merge, no re-review)

- **N1** Composer default list falls back to the **first** live list; F1.4/§16-14 says `defaultListId`
  else **last-used list** (`Composer.tsx:64-72`).
- **N2** Composer dirty-close uses `confirm.discard.*`; the register's draft variant
  `confirm.discard.discardDraft` is never used — §16-17 asks for the draft variant. Also `dirty`
  ignores a list-only change (`Composer.tsx:74`).
- **N3** `saveTask` (`store.ts:347-375`) issues `patchTask` then `moveTask` as two guarded writes, so
  S4's "one transaction" is not met; when the patch lands and the move fails, the assertive
  `a11y.saveFailed` ("Could not save. Your change was undone.") is **false** — the field edits
  persisted. Either add a combined domain op, roll the patch back, or make the announcement
  per-operation accurate.
- **N4** `TaskScreen.tsx:43` imports `resetBootSingleton` from `src/storage/boot` and closes live
  IDB connections from a UI component — the UI must reach storage only through the store. Expose
  `retryBoot()` from `store.ts`.
- **N5** Lists screen boot-error panel (`ListsManageView.tsx:126-136`) has no Retry/action, unlike
  `TaskScreen`'s (`§14` error rows carry `common.retry`).
- **N6** `ListsManageView.tsx:95,195` builds `querySelector('[data-list-id="${id}"]')` from a raw id;
  imported ids are not guaranteed to be ULIDs. Use `CSS.escape` or a `dataset` scan like
  `TaskList.rowElement`.
- **N7** Toast action / close buttons are `min-height/min-width: 36px`
  (`tasks.css:726,732`) — §5.1 and §16-5 require ≥ 44 × 44 (they still pass WCAG 2.5.8's 24 px).
- **N8** `src/features/tasks` coverage 74 % stmts / 67 % branches (repo-wide 80.01 / 75.62). The
  ≥ 80 % gate in PROJECT_ANALYSIS §9.5 binds domain modules (96.77 % ✓), so this is advisory — but
  the untested surface is mostly error/rollback branches.
- **N9** List-row menu accessible name reuses `task.rowMenu` ("Actions for …"); a `list.rowMenu` key
  would read correctly for Thai.

## 8. What passed (no action needed)

Domain/repository boundary everywhere else · optimistic pipeline + rollback + 3 s slow-write report ·
900 ms completion retention with anchor re-insertion · D9 day rollover (midnight + visibilitychange)
· S7.1/S7.2/S7.3 confirm semantics incl. initial focus on Cancel and required disposition ·
D10 list-name validation and the 8 labelled colour radios · §9.1 roving row cursor (1 tabbable row,
arrows/Home/End/PageUp/PageDown/Space/Enter/Delete, Escape back to row) · §9.2 menu key map ·
dialog focus trap, topmost-only Escape, focus return to the exact trigger · §14 skeleton/empty/error
matrix and the unknown-list deep-link redirect · §5.5 announcements (taskAdded/Completed/Reopened/
Saved/Deleted, listCreated/Renamed/Moved/Deleted, reorderBoundary, saveFailed) · i18n discipline ·
WCAG-correct reduced-motion, focus rings and token usage · gates in §1.
