# Keyboard-only test script — 10 core flows (M13 accessibility release gate)

**Epic E5 · PROJECT_ANALYSIS §8 ("a written keyboard-only test script (10 core flows)") · design
spec `docs/design/core-domain.md` §6 (F1–F11) · WCAG 2.2 AA (2.1.1 Keyboard, 2.4.3 Focus Order,
2.4.7 Focus Visible, 2.1.2 No Keyboard Trap).**

This script is executable by a human with **no pointing device at all**: only `Tab`, `Shift+Tab`,
`Enter`, `Space`, `Esc`, arrow keys, `Home`/`End`, `PageUp`/`PageDown`, `Alt+↑`/`Alt+↓`/`Alt+Home`/
`Alt+End` and typing. A screen reader (NVDA / VoiceOver) is optional but recommended — every
"announce" line below is what the live region must contain; without a screen reader you can verify
it visually in the live region or in the NVDA speech viewer.

## How to run

1. Build and serve the release candidate: `BASE_PATH=/browser-todo-app/ npm run build && npx
   vite preview --port 4173` → open `http://127.0.0.1:4173/browser-todo-app/`.
2. Use a **fresh browser profile** (so first-run onboarding is present). Complete onboarding from
   the keyboard alone — `Tab` to **Get started**, `Enter` — before Flow 1. This is itself a mini
   check: the CTA must be reachable by `Tab` within a few presses.
3. Create at least two lists first (Flow 5 does this) and at least three open tasks in one list,
   because Flows 3, 4, 10 and 11 operate on rows.
4. Run once in the **light** theme and once in **dark** (`#/settings` → Theme), and once per
   **locale** (`#/settings` → Language: English / ไทย) where noted. Focus visibility, order and
   announcements must be identical in all four combinations.
5. **Never use the mouse.** If you are forced to reach for the pointer anywhere, that step FAILs.

Notation: `→` means "until", `⌖` means "focus is on". Expected announcements are quoted from
`src/i18n/en.json`; the Thai column is `src/i18n/th.json` (same keys).

---

## Flow 1 — F1: Capture a task (`core-domain.md` §6 F1 · WCAG 2.1.1, 4.1.3 Status Messages)

| # | Step | Expected |
|---|---|---|
| 1.1 | `Tab` from the page start | First stop = **Skip to main content** link; `Enter` jumps focus to `<main>` |
| 1.2 | `Tab` until ⌖ composer title input (`Add task…`) | Visible §6 focus ring on every stop; input announces its label/placeholder |
| 1.3 | Type `Buy milk`, press `Enter` | Row **Buy milk** appears immediately (optimistic, before the write settles); composer is cleared **and still focused** (you can type the next task without tabbing) |
| 1.4 | Listen (or inspect the polite region) | announce: `Task added: Buy milk` |
| 1.5 | Type `Pay electricity bill`, `Enter` again | Second row appears; announce: `Task added: Pay electricity bill`; still no focus loss |
| 1.6 | Empty title: clear the field, press `Enter` | Nothing is created; error `Enter a title` is linked to the input (`aria-describedby`) and announced; **Add** stays disabled |
| 1.7 | Zero-list state (fresh profile, no lists): `Tab` to composer | Inputs disabled with `Create a list first — tasks live in lists.` and a working **New list** action (covered by Flow 5) |

Thai: 1.4 = `เพิ่มงานแล้ว: Buy milk`.

## Flow 2 — F2: Edit a task (§6 F2 · WCAG 2.1.1, 2.4.3)

| # | Step | Expected |
|---|---|---|
| 2.1 | `Tab`/arrow to a task row, press `Enter` on the row title button | Editor dialog opens **with focus on Title** (`Edit task`), values prefilled |
| 2.2 | `Tab` through Title → Notes → Due → List → Priority → **Save** → **Cancel** | All fields reachable; focus ring visible; radio group (Low/Medium/High) is arrow-key operable |
| 2.3 | Change the title, press `Enter` (or `Tab` to **Save**, `Enter`) | Dialog closes, **focus returns to the originating row button**, row shows the new title |
| 2.4 | Listen | announce: `Task saved` |
| 2.5 | Reopen with `Enter`, change a field, press `Esc` | Discard confirm (`Discard changes?` — **Discard** / **Keep editing**) traps focus; `Esc`/focus **Keep editing** + `Enter` returns to the editor with your text intact; **Discard** closes and restores focus to the row |
| 2.6 | Thai locale | announce: `บันทึกงานแล้ว` |

## Flow 3 — F3: Complete / uncomplete (§6 F3 · WCAG 2.1.1, 4.1.3, 1.4.1 Not Color Alone)

| # | Step | Expected |
|---|---|---|
| 3.1 | Arrow to a row (`↑`/`↓`), press `Space` | Row checks instantly (optimistic); page does **not** scroll |
| 3.2 | Listen at toggle time | announce: `Task completed` (Thai: `เสร็จงานแล้ว`) |
| 3.3 | Observe the row | Row stays 900 ms, then leaves the open view; completion is conveyed by checkbox state + text, never colour alone |
| 3.4 | `Tab` to **Completed** view (`#/completed`), arrow to the row, `Space` | Row unchecks and returns to its list order |
| 3.5 | Listen | announce: `Task reopened` (Thai: `เปิดงานอีกครั้ง`) |
| 3.6 | Completed row also reachable from the editor; read-only line reads `Completed on <date>` | Information available without colour |

## Flow 4 — F4: Delete a task with confirm (§6 F4 · WCAG 2.1.1, 2.1.2, 2.4.3)

| # | Step | Expected |
|---|---|---|
| 4.1 | Arrow to a row, `Tab`/`End` to its **Open menu** button, `Enter` | Menu opens with focus on the first item; arrow keys move, `Esc` closes and returns focus to the trigger |
| 4.2 | Arrow to **Delete**, `Enter` | Confirm dialog `Delete task?` with the task title in the body; **initial focus on Cancel** (non-destructive default) |
| 4.3 | `Esc` | Dialog closes, nothing deleted, focus back on the row menu button |
| 4.4 | Reopen, `Shift+Tab` to **Delete** + `Enter` | Row removed; announce: `Task deleted` (Thai: `ลบงานแล้ว`); focus moves to the next row, or the view heading when the list is now empty (never dropped to `<body>`) |
| 4.5 | Tab cycle through the open dialog (steps 4.2) | Focus is trapped inside the dialog and `Esc` always releases it (intentional trap, escapable) |

## Flow 5 — F5: List management — create and rename (§6 F5 · WCAG 2.1.1, 1.3.1)

| # | Step | Expected |
|---|---|---|
| 5.1 | Navigate to `#/lists` (link/`Tab`), `Tab` to **New list**, `Enter` | Dialog opens, focus on the name input |
| 5.2 | Type `Personal`, `Enter` | List created and visible in the list order; announce: `List created: Personal` (Thai: `สร้างรายการแล้ว: Personal`) |
| 5.3 | Repeat for `Work` | announce: `List created: Work` |
| 5.4 | On the `Personal` row, open menu → **Rename**, `Enter` | Inline input (or dialog) with the current name selected; `Enter` saves, `Esc` cancels |
| 5.5 | Rename to `Home`, `Enter` | announce: `List renamed to Home` (Thai: `เปลี่ยนชื่อรายการเป็น Home`); focus stays on that row's control |
| 5.6 | List rows are real `ul`/`li` with named controls; the list reorder commands (`Move up`/`Move down`/`Alt+↑`/`Alt+↓`) announce `List moved` | Structure and announcements present |

## Flow 6 — F6: Delete a list with task disposition (§6 F6 · WCAG 2.1.1, 2.4.3, 1.4.1)

| # | Step | Expected |
|---|---|---|
| 6.1 | On the `Home` row (≥1 task), open menu → **Delete list**, `Enter` | Dialog `Delete list?` with `"Home" has N open and M completed tasks. Choose what happens to them.`; **initial focus on Cancel** |
| 6.2 | `Tab` into the disposition radios | Required radio group: **Move tasks to another list** (default when another list exists) / **Also delete N tasks** (danger); arrow keys move, selected state announced (not colour alone) |
| 6.3 | Choose **Move tasks to another list**, `Tab` to the **Move into** select, pick `Work`, `Tab` to **Delete list**, `Enter` | ONE atomic result: list gone, its tasks now carry the `Work` badge |
| 6.4 | Listen | announce: `List "Home" deleted (N tasks)` (Thai: `ลบรายการ "Home" แล้ว (N งาน)`); focus lands on the Lists heading or next row |
| 6.5 | `Esc` at 6.1 instead | Nothing changes; focus returns to the menu button |
| 6.6 | Only one list left → **Move tasks…** option shows `Create another list to move tasks into` and is disabled | Degrades without trapping the user |

## Flow 7 — F7: Navigate views (§6 F7 · WCAG 2.1.1, 2.4.1 Bypass Blocks, 2.4.3, 4.1.3)

| # | Step | Expected |
|---|---|---|
| 7.1 | Fresh load, first `Tab` | **Skip to main content** is the first focusable element; `Enter` moves to `<main>` (bypass repeated chrome) |
| 7.2 | Activate **Today** in the nav (sidebar link or bottom tab), then **All open**, **Completed**, **Search**, **Settings** | Each route: SPA **no reload** (focus is not lost to a page navigation), focus moves to the view `<h1>` |
| 7.3 | Listen after each move | announce: `View: Today` / `View: All open` / `View: Completed` … (Thai: `มุมมอง: …`) |
| 7.4 | Landmarks | Exactly one `banner`, one primary `nav` (`Views and lists`), one `main`; exactly one `h1` per view; heading levels never skip |
| 7.5 | On a 360 px viewport, the nav lives behind **Open navigation menu**; `Enter` opens the drawer | Drawer is `role="dialog" aria-modal`, focus is trapped inside, `Esc` closes and returns focus to the burger; background is `aria-hidden` |

## Flow 8 — F8: Search (§6 F8 · WCAG 2.1.1, 4.1.3)

| # | Step | Expected |
|---|---|---|
| 8.1 | Activate the **Search** nav entry / header search icon | Search screen opens **with the field focused** (auto-focus is permitted here because navigation was explicit) |
| 8.2 | Type `milk` | Results filter per keystroke (no submit, no visible debounce lag); matches carry `<mark>` highlighting — highlight is an extra cue, the row itself is the result |
| 8.3 | Pause after typing | announce (debounced): `1 results for "milk"` (Thai: `1 ผลลัพธ์สำหรับ "milk"`) |
| 8.4 | `Esc` | Query clears (field keeps focus); second `Esc` returns focus to the search trigger / previous view |
| 8.5 | Type `zzzz` | Empty state `No tasks match "zzzz"` (no silent blank list) |
| 8.6 | `Tab` into a result row | Rows are fully operable (complete, open editor, menu, **Move to list**); reorder handles are correctly absent in results (per-list view only) |

## Flow 9 — F10: Keyboard reorder (§6 F10 · WCAG 2.1.1, 1.4.1, 4.1.3) — first-class, not a fallback

| # | Step | Expected |
|---|---|---|
| 9.1 | Open a per-list view (`#/list/:id`) with ≥3 tasks; arrow to row 2 | Row cursor visible; roving `tabindex` (exactly one tabbable row) |
| 9.2 | `Alt+↓` | Row moves down **exactly one position** (one announcement per press, no repeats); announce: `Moved to position 3 of 3 in Home` (Thai: `ย้ายไปตำแหน่ง 3 จาก 3 ใน งานบ้าน`) |
| 9.3 | `Alt+↑`, `Alt+Home`, `Alt+End` | Moves up one / jumps to first / jumps to last — each with the same announcement and **focus retained on the moved row** |
| 9.4 | `Alt+↑` on the first row | No move; announce boundary: `Already at the top` (Thai: `อยู่ที่บนสุดแล้ว`) |
| 9.5 | Row menu equivalents | **Move up**/**Move down** exist and work with `Enter`; disabled at the ends (announced as unavailable, not silently dead) |
| 9.6 | After any move, leave and return (`Tab` away and back) | New order persisted (survives reload) — exactly one record written per move |
| 9.7 | On `/all` or `/search` (not a per-list view), `Alt+↓` | announce: `Reordering is only available inside a list view. Use "Move to list" to move this task.` — the keyboard path never dead-ends silently |

## Flow 10 — F11: Move a task to another list (§6 F11 · WCAG 2.1.1, 2.1.2, 2.4.3)

| # | Step | Expected |
|---|---|---|
| 10.1 | Row menu → **Move to list…**, `Enter` | Dialog opens as a **radio list** of lists (current list marked & disabled); focus lands on the first available option |
| 10.2 | `↑`/`↓` move, `Enter` selects (or arrow to an option, `Tab` to **Move**, `Enter`) | Task leaves the current view; announce: `"Buy milk" moved to Work` (Thai: `ย้าย "Buy milk" ไป Work`) |
| 10.3 | `Esc` at 10.1 | Dialog closes; focus returns to the row menu button; nothing changed |
| 10.4 | Focus cycle inside the dialog | Focus trapped while open, always released by `Esc` (2.1.2) |

---

## Cross-flow checks (run once per theme × locale combination)

| Check | Expected |
|---|---|
| Focus visibility | Every focusable stop shows the §6 ring (`outline: 3px` + offset); no `outline: none` anywhere except the skip-link target |
| Focus never dropped | After delete/route change/dialog close, `document.activeElement` is never `<body>` |
| Live regions | Exactly **one** polite `role="status"` and **one** assertive `role="alert"` region mounted for the app's lifetime; text is swapped, nodes are never recreated |
| Assertive only for failures | `Could not save. Your change was undone.` (save failure) is the assertive path; routine results are polite |
| Language | `html lang` = `en` or `th` matching the selected locale; after switching, the announcement `Language changed to ไทย` / `Language changed to English` fires and screen-reader voice follows `lang` |
| No pointer-only gestures | Every gesture has a keyboard equivalent: drag-reorder → Flow 9; drag-to-sidebar-list → Flow 10; FAB → composer `Tab` |
| Zoom | At 200% text zoom (root 32 px) every flow above still completes with no horizontal scrolling and no clipped Thai text |

## Result template

| Flow | Light/en | Light/th | Dark/en | Dark/th | Notes |
|---|---|---|---|---|---|
| 1 F1 capture | | | | | |
| 2 F2 edit | | | | | |
| 3 F3 complete | | | | | |
| 4 F4 delete | | | | | |
| 5 F5 lists | | | | | |
| 6 F6 list disposition | | | | | |
| 7 F7 navigation | | | | | |
| 8 F8 search | | | | | |
| 9 F10 keyboard reorder | | | | | |
| 10 F11 move to list | | | | | |
| Cross-flow checks | | | | | |

**Record for each cell: PASS / FAIL + date + tester + browser + screen reader (NVDA version /
VoiceOver version) — or "scripted: <evidence file>" when the step was verified by the automated
keyboard probe rather than a human.** Thai voice availability is a known constraint
(PROJECT_ANALYSIS §8): where no Thai voice exists, record `lang="th"` correctness + English-voice
fallback instead of a Thai announcement pass.

---

### Automated evidence backing this script

| Flows | Evidence | Where verified |
|---|---|---|
| 1–4, 6 (F1/F2/F3/F4/F6) | `docs/qa/e2-core-ui.md` §9 — 20-step keyboard-only pass, real Chromium, zero pointer events | `tests/e2e/core-ui-keyboard.spec.ts` |
| 5 (F5 create/rename) | same run, steps `PASS 1`, `PASS 12`, `PASS 12b` | `tests/e2e/core-ui-keyboard.spec.ts` |
| 7 (F7 navigation) | shell suite (skip link first focusable, route-change focus + `a11y.viewChanged`) | `tests/e2e/smoke.spec.ts`, shell component suites |
| 8, 9, 10 (F8/F10/F11) | `h_junior_coder` scratch `e2-core-ui-keyboard.md` — 8/8 flows, keyboard-only component pass incl. boundary/announcement assertions | `tests/component/core-ui-keyboard.test.tsx` |

Known scripted-run finding carried into the gate: in the E2 keyboard run, `Task added: …` was
suppressed once by a first-write persistence notice overwriting the polite region (see
`docs/qa/e2-core-ui.md` F-1) — re-check Flow 1 step 1.4 before release sign-off.
