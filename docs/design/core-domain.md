# Design Spec — Core Domain: Task & List Interaction (M1–M6)

- **Epic**: E2 Core Domain — Task & List Management
- **Task**: t_a236d6ea (Design: Task & list interaction spec), created by decomposition card t_1b9ee0e6
- **Author**: h_designer (product design)
- **Date**: 2026-10-23
- **Status**: READY FOR IMPLEMENTATION HANDOFF
- **Deliverable**: `docs/design/core-domain.md` (this file)
- **Constraints source of truth**: `PROJECT_ANALYSIS.md` (§3 P1 JTBDs, §4 M1–M6, §5 data model, §8 accessibility) — PO-validated 2026-10-23.

How to read this document:

- Every screen specifies layout, components **with all states**, content (as **i18n string keys** — never
  hardcoded copy), interactions, accessibility, responsive deltas, and edge cases.
- §8 is the reorder system (drag **and** keyboard) and is deliberately first-class.
- §9 is the complete keyboard interaction map.
- §16 "Handoff checklist" is the contract impl cards are built and reviewed against.

---

## 1. Feature context (from h_pm)

**Goal.** Interaction + layout spec for the MVP core loop: task editor (title, notes, due date, list,
priority high/med/low), list management incl. delete-with-task-disposition choice, views (Today,
Next 7 days, All open, per-list, Completed), complete/uncomplete with optimistic UI (destructive
actions CONFIRM in MVP; undo toast is V1 S7 — **out of scope here**), search (title + notes, instant
client-side filter), and manual reorder with drag AND a keyboard equivalent (move up/down/into).

**Binding decisions (do NOT re-decide — honored verbatim in this spec):**

1. Single-user. No sharing, no accounts (§2/§12 Q1).
2. Flat tasks + lists. **No subtasks in MVP** (§12 Q4).
3. **Plain-text notes only** (§12 Q13) — rendered as text, never as HTML/markdown.
4. `dueDate` is an **all-day local date** (`YYYY-MM-DD`) (§5.2, §12 E6).
5. Mobile-first; touch targets **≥ 44×44 CSS px** (§8).
6. **Every gesture needs a button/keyboard equivalent** (§8).
7. **WCAG 2.2 AA is a release gate** (§8, M13); light AND dark both compliant.
8. UI strings come from the i18n layer (en + th, M15) — **spec string keys, not hardcoded copy**.

**Acceptance criteria for this card:**

- AC-1: This document covers every M1–M6 flow at wireframe-description level: layout (mobile +
  desktop), empty/loading/error states, confirm dialogs, and a keyboard interaction map.
- AC-2: Keyboard reorder is specified as a first-class interaction, not an afterthought (§8.2).
- AC-3: The document ends with a handoff section listing the exact UI states/behaviors impl cards
  must build (§16).

**Refs:** PROJECT_ANALYSIS.md §3 (P1 JTBDs), §4 (M1–M6), §8 (accessibility), plus §5.2/§5.3 (data
model: per-list fractional `sortOrder`, `priority: 0|1|2`, `dueDate` local-date string) and §9.1
(perf budgets) where they constrain interaction design.

---

## 2. Scope map — M1–M6 → flows → screens

| Feature | Flows (§6) | Screens (§7) | Components (§10) |
|---|---|---|---|
| M1 Task CRUD | F1 capture, F2 edit, F4 delete | S3 composer, S4 task editor, S7 confirm | Composer, TaskEditor, ConfirmDialog, TaskRow |
| M2 Lists (create/rename/reorder/delete + disposition) | F5 list manage, F6 delete-with-disposition | S6 lists, S7 confirm | ListManager, ListDialog, ConfirmDialog |
| M3 Views | F7 view navigation | S2 task list views | ViewHeader, GroupHeader, TaskList |
| M4 Complete/uncomplete (optimistic) | F3 complete, rollback rules (§5.6) | S2, S8 toasts | TaskCheckbox, Toast, LiveRegion |
| M5 Search | F8 search | S5 search | SearchField, TaskList |
| M6 Manual reorder (drag + keyboard) | F9 drag reorder, F10 keyboard reorder, F11 move-to-list | S2 (per-list), S8 toasts | ReorderHandle, RowActionsMenu, MoveToListDialog |

Explicitly out of scope for this spec (owned elsewhere): theme/mode switch & no-flash boot (Epic E5,
M7), app shell chrome details and token VALUES (Epic E5 spec), service worker / update toast (Epic
E4, M9), export/import & quota panel (Epic E3, M11/M12/M14), settings (Epic E5), undo toast (V1 S7),
global keyboard shortcuts & command palette (V1 S8 — see D7), subtasks/tags/recurrence (V1).

---

## 3. Design decisions owned by this spec

These are interaction-design decisions within h_designer's remit. Rationale is given so h_pm can
override with a scope change; nothing here contradicts a binding decision or PROJECT_ANALYSIS.

| # | Decision | Rationale |
|---|---|---|
| D1 | **Manual reorder exists only in per-list views.** Aggregate views (Today, Next 7 days, All open, Completed, Search results) use derived ordering and show no drag handle; keyboard move up/down is disabled there with an announcement. | Ordering is a per-list property (`sortOrder` per list, §5.2). Cross-list manual order has no representation in the data model; inventing one would contradict the storage schema owned by the Arch ADR. |
| D2 | **"Move into" (§8 "indent-style into-list") is realized as "Move to list"** — a list-picker dialog, plus (desktop) drag-and-drop of a row onto a sidebar list. | Tasks are flat (Q4); there is no nesting to indent into. Changing `listId` is the only "move into" semantics that exists. |
| D3 | **View grouping model**: Today = `Overdue` + `Today`; Next 7 days = `Overdue` + one group per day (today…+6); All open = `Overdue` + `Next 7 days` + `Later` + `No due date`; Completed = `Today` / `Yesterday` / `Earlier` by completion day; per-list = one flat manual-order list of open tasks. | JTBD "see what today owes me" and "trust that overdue items are accurate" (§3 P1) require overdue visibility in both date views; grouping gives scannable structure without a sort UI. |
| D4 | **Priority mapping** `0=low, 1=medium, 2=high` (model §5.3), **default = low** on create. Rows show a priority icon for high and medium only (low = no icon) to control visual noise; the editor always shows the current value as a 3-option radio group. Priority is never color-only (distinct icon shapes + text labels). | The model has exactly three levels (no "none"); defaulting to the least emphatic level keeps list noise low. |
| D5 | **Search covers all non-deleted tasks (open + completed)**, case-insensitive substring match on `title` then `notes` (Unicode NFKC-normalized); results ordered: title matches before notes matches, then `dueDate` asc (undated last), then `updatedAt` desc. Matched substrings highlighted with `<mark>`. | M5 says "title + notes" without scoping status; users searching for a finished item is a real need. Highlighting aids scanning but is never the only signal (row checkbox state shows open/done). |
| D6 | **Composer Enter = save and stay ready** (input clears, focus stays, `Task added` announced) so back-to-back capture hits the "< 5 s" JTBD (§3 P1). `Shift+Enter` in the expanded composer saves and closes. | Capture speed is the primary JTBD. |
| D7 | **No letter-key global shortcuts in MVP.** Keyboard equivalence is delivered through standard widget semantics (Space/Enter/Delete/arrows on focused widgets) plus the reorder keys `Alt+↑ / Alt+↓`. | The shortcut layer + command palette is explicitly V1 (S8). The M6 requirement is satisfied by native semantics + the two reorder keys + menu items. |
| D8 | **Completed view is global**, grouped by completion day, with a single "list filter" select ("All lists" default). Per-list completed tasks are reached by filtering there. | Avoids building per-view completed sections; one predictable home for finished work (retention: keep until user deletes, Q14). |
| D9 | **Day rollover while the app is open**: date-derived grouping and due badges recompute on `visibilitychange` and on a local-midnight timer. No reload. | `dueDate` is an all-day local date; "Today" must stay truthful across midnight (E6). |
| D10 | **List names**: trimmed, 1–60 chars, unique case-insensitively. **Task titles**: trimmed, 1–200 chars. **Notes**: plain text, ≤ 20,000 chars (`maxlength` on the textarea). | Concrete validation rules impl needs; keeps layout stable (row title clamps at 2 lines). |
| D11 | **Optimistic-then-rollback protocol** for every write (§5.6): UI applies instantly, persistence is async; failure reverts the exact prior visual state and surfaces `role="alert"` feedback with a Retry where the action is retryable. | M4 requires optimistic UI; §9.1 requires add→visible < 100 ms perceived and INP < 200 ms. |
| D12 | **Mobile navigation = 5 bottom tabs** (Today, Next 7 days, All open, Completed, Lists) + header Search icon + floating Add button. Desktop = persistent sidebar (views + lists) + composer at top of the main pane. Breakpoint at 768 px. | Six destinations cannot fit 4 tabs; search is a mode, not a destination; add must be reachable in one tap from every view. |

Not decided here (deliberately): final token VALUES (Epic E5 design spec owns the palette; §11 gives
AA-provisional values so impl is unblocked), exact icon set (§12 names required glyphs), undo (S7),
recurrence/tags/subtasks (V1), keyboard shortcut help overlay (S8).

---

## 4. Information architecture & navigation

### 4.1 Logical routes

| Route | View | Title key |
|---|---|---|
| `#/today` | Today | `view.today` |
| `#/next7` | Next 7 days | `view.next7days` |
| `#/all` | All open | `view.allOpen` |
| `#/completed` | Completed | `view.completed` |
| `#/list/:listId` | Per-list | (list name) |
| `#/search` | Search | `view.search` |

Routing mechanism is an h_senior_coder concern; the UI contract is: back/forward must work, the
active nav item carries `aria-current="page"`, and entering a route moves focus to the view heading
(§5.4).

### 4.2 Mobile shell (320–767 px)

```
┌──────────────────────────────────────┐
│ [≡ app mark]  View title        [🔍] │  header, 56px (search icon 44px target)
├──────────────────────────────────────┤
│                                      │
│  ── Overdue (2) ───────────────────  │  group header
│  ┌────────────────────────────────┐  │
│  │ ☐  Buy milk            ⚑  ··· │  │  task row (min 56px tall)
│  │    Due 2 days ago · Personal   │  │  (metadata line)
│  └────────────────────────────────┘  │
│  ── Today (3) ────────────────────  │
│  ...                                 │
│                                      │
│                          ┌────────┐  │
│                          │  ＋   │  │  FAB 56×56, 16px above bottom nav
│  ┌────────────────────────────────┐  │
│  │ (composer when opened = sheet) │  │
│  └────────────────────────────────┘  │
├──────────────────────────────────────┤
│  Today   Next 7   All   Done   Lists │  bottom nav, 56px + safe-area inset
└──────────────────────────────────────┘
```

- Bottom nav: 5 tabs, each ≥ 44 px wide/tall, icon + 12px label, active tab marked by icon fill +
  `aria-current="page"` (never color alone).
- FAB: floating Add (56×56), sits 16 px above the bottom nav, right-aligned, 16 px from the edge.
- Header: back chevron replaces the app mark on pushed screens (per-list, search, lists editor).
- Per-list and Search are **pushed screens** (header shows Back + title); back returns to the
  previous tab with scroll position and focus restored.

### 4.3 Desktop shell (≥ 768 px)

```
┌───────────────────┬──────────────────────────────────────────────┐
│ ☰  App mark       │  Today                       [🔍 Search…  ]  │
│                   ├──────────────────────────────────────────────┤
│  Today            │  [＋ Add task — title…            (details) ]│  composer
│  Next 7 days      ├──────────────────────────────────────────────┤
│  All open         │  ── Overdue (2) ───────────────────────────  │
│  Completed        │  ☐  Buy milk             [📅] [⚑] [···] [⠿] │
│                   │      Due 2 days ago · Personal               │
│  ── Lists ──────  │  ── Today (3) ────────────────────────────  │
│  ● Personal       │  ...                                         │
│  ● Work           │                                              │
│  ● Someday        │                                              │
│  [＋ New list]     │                                              │
│  Manage lists…    │                                              │
└───────────────────┴──────────────────────────────────────────────┘
   240 px (sticky)                main pane, max-width 760 px, centered
```

- Sidebar: `nav` landmark; views group (4 links) then "Lists" group (`h2`) with one link per list
  (color dot + name + open-task count), `New list` button, `Manage lists…` button.
- Main pane: one `main` landmark, `max-width: 760px`, horizontally centered with ≥ 24 px gutters.
- Search input lives at the top-right of the main pane header (expands to a results pane — S5).
- Row hover reveals drag handle + keeps kebab menu permanently visible (never hover-only
  functionality; the menu button is always visible).

### 4.4 Breakpoints

`320` (min supported), `768` (sidebar layout begins), `1024`, `1440` (max content width). Mobile-first
CSS. Tablet 768–1023 uses the desktop layout with a collapsed 200 px sidebar. 200% zoom must reflow
to the mobile layout without horizontal scrolling (§8).

---

## 5. Global interaction conventions

### 5.1 Touch & pointer

- Minimum target 44×44 CSS px everywhere (checkbox visual 24 px with 44 px hit area; menu button 44;
  FAB 56; bottom-nav tabs 56 tall × equal width).
- Drag requires a visible grip handle (S8.1); long-press is NOT required anywhere.
- No hover-only affordances; hover may only *enhance* (e.g. reveal handle on desktop, which is also
  keyboard-reachable and permanently visible on touch).

### 5.2 Focus

- One visible focus style everywhere: 3 px solid `color.focus.ring`, 2 px offset (§11). Never
  `outline: none` without a replacement.
- Dialogs/sheets trap focus; `Escape` closes; focus returns to the exact trigger element.
- Route change moves focus to the view `h1` (`tabindex="-1"`), announced via live region (§5.5).

### 5.3 Semantics (§8, non-negotiable)

- Task lists are real lists: `ul`/`li` (with virtualization caveat in §5.7).
- Completion toggle is a **native `<input type="checkbox">`** with a visible label association to the
  task title.
- Headings form a correct hierarchy: `h1` = view title, `h2` = group headers, `h3` = sidebar
  "Lists" / dialog sections.
- Landmarks: `header`, `nav` (views/lists), `main`, `aside` avoided; dialogs use `role="dialog"`
  `aria-modal="true"` with `aria-labelledby` + `aria-describedby`.
- Status never encoded by color alone: overdue, priority, active nav, list color all carry a second
  non-color signal (text, icon shape, weight, marker).

### 5.4 Dates & due-date language

- All dates displayed via `Intl.DateTimeFormat` under the active locale; relative due language uses
  string keys `task.due.overdue` / `.today` / `.tomorrow` with `{days}`/`{date}` params.
- "Today" boundaries are **local**; recompute on `visibilitychange` + local-midnight timer (D9).
- Completed-view date groups computed from `completedAt` (epoch ms UTC → local day).

### 5.5 Live-region announcements (single polite region + one assertive region)

| Event | Region | Key |
|---|---|---|
| Task added | polite | `a11y.taskAdded` (`{title}`) |
| Task completed / reopened | polite | `a11y.taskCompleted` / `a11y.taskReopened` |
| Task deleted | polite | `a11y.taskDeleted` |
| Task saved (edits) | polite | `a11y.taskSaved` |
| Task moved to position | polite | `a11y.taskMoved` (`{position}`,`{total}`,`{list}`) |
| Task moved to list | polite | `a11y.taskMovedToList` (`{title}`,`{list}`) |
| List created / renamed / reordered / deleted | polite | `a11y.listCreated` / `listRenamed` / `listMoved` / `listDeleted` (`{list}`,`{count}`) |
| Search result count (debounced 300 ms) | polite | `a11y.searchResults` (`{count}`,`{query}`) |
| View changed | polite | `a11y.viewChanged` (`{view}`) |
| Reorder not available in this view | polite | `a11y.reorderUnavailable` |
| Reorder at boundary | polite | `a11y.reorderBoundary` (`{edge}`) |
| Validation error | assertive (field-linked) | `form.error.*` |
| Write failed (rolled back) | assertive | `a11y.saveFailed` |
| Loading | polite (status) | `a11y.loading` |

Toasts (S8) render visually AND map to these announcements; announcements without toast are still
delivered by the single always-mounted region (`aria-live="polite"`, visually hidden).

Delivery contract (`src/app/announce.ts`): each region carries one message at a time — inside a
region's 60 ms announce window the newest message supersedes the pending one — and the two regions
never cancel each other (WCAG 2.2 SC 4.1.3). A background notice fired while a user-facing message
is on the way (E3's first-write persistence notice vs. `a11y.taskAdded` / `a11y.taskSaved`) is
announced `{ deferred: true }`: it holds ~500 ms and then **queues behind** whatever the region
still has in flight — including a message still inside its landing window — instead of cancelling
it, so both messages reach the user, in order (`t_bb9053ec`). Once in flight it is never silently
dropped either: a newer message re-queues it behind itself instead of cancelling its landing, so
the notice reaches the user even when several user actions follow it closely.

### 5.6 Optimistic write protocol (D11 — applies to every mutating action)

```
user action
  → 1. apply to UI store immediately (< 16 ms)            [optimistic]
  → 2. persist via one IDB transaction                    [async]
       on success  → nothing visible (no success toasts)
       on failure  → 3. revert to the captured prior state
                     4. toast role="alert": error.save.title (+ Retry action)
                        add/edit/reorder = retryable; delete failure restores the row
       on QuotaExceededError → open the blocking data-safety dialog (E3,
                        owned by Epic E3; this spec only requires it to be modal,
                        non-destructive, and reachable from the toast)
```

- No per-row spinners (perceived add latency budget < 100 ms, §9.1). A write that has not settled
  after 3 s is reported once via `a11y.saveFailed` (assertive) with Retry.
- Undo is V1 (S7): destructive actions instead use **confirmation dialogs** (S7 of this spec).

### 5.7 Virtualization & performance contracts (§9.1)

- Lists virtualize beyond ~200 rows; the keyboard model (§9) must work across virtualization
  (roving focus scrolls rows into view; focused row must be materialized before it can hold focus).
- Search filters synchronously on `input` (budget < 50 ms over 10,000 tasks).
- Reorder writes exactly one record (fractional order key, §5.2) — never a renumbering transaction.

### 5.8 i18n conventions

- String key format `domain.element[.state]`; English source strings live ONLY in the i18n catalog
  (register in §13). Components never hardcode copy.
- Every string is treated as variable-length (Thai may run ±40% vs English); buttons must not clip —
  allow wrap on secondary/confirm dialogs, keep one-line with ellipsis only on row titles.
- `document.documentElement.lang` follows the active locale (M15); dates via `Intl`.
- Thai text renders on the system font stack (no webfonts, §9.2); line-height ≥ 1.5 for body text to
  keep diacritic/vowel stacking unclipped at 200% zoom (§8).

### 5.9 Motion

- Durations: `motion.fast` 120 ms (state changes), `motion.base` 200 ms (sheets/dialogs). Easing
  `cubic-bezier(0.2, 0, 0, 1)`. `prefers-reduced-motion: reduce` → all durations 0 ms, no
  positional animation; the "moved" highlight (S8.2) becomes a static border change.

---

## 6. User flows

### F1 — Capture a task (M1; JTBD "under 5 seconds")

1. From any view: tap/click FAB (mobile) or the composer input (desktop). → S3 opens focused on
   title.
2. Type title. `Enter` (or `Add` button) saves. Task appears **at the top of its list's manual
   order** in per-list view; in aggregate views it appears in its derived group immediately.
3. Composer stays open, cleared and focused (`a11y.taskAdded` announced). Repeat for the next task.
4. Optional fields (notes, due date, list, priority): expand composer (`details` chevron) or use
   "Edit" on the saved row (F2). Defaults: list = `defaultListId` (M14) else last-used list; due =
   none; priority = low.
5. Empty/whitespace title → `Add` disabled + `form.error.titleRequired` on attempted submit
   (`aria-describedby`).

### F2 — Edit a task (M1)

1. Row menu → `task.action.edit` (or `Enter` on the row/title button). → S4 editor (mobile: full
   screen sheet; desktop: modal dialog) with fields prefilled.
2. Change any of: title, notes, due date (date input + Today/Tomorrow/Clear chips), list (select +
   "New list…"), priority (radio group).
3. `Save` persists all changes in one transaction, closes, focus returns to the originating row,
   `a11y.taskSaved` announced. `Cancel`/`Escape` with unsaved changes → discard-confirm (S7.3).
4. Editor on a **completed** task shows the same fields plus read-only completion info
   (`task.completedOn` with date); saving is allowed.

### F3 — Complete / uncomplete (M4)

1. Tap the checkbox (or `Space` on a focused row). Checkbox checks immediately (optimistic).
2. In open-task views the row **stays visible for 900 ms** (so the user sees which task they
   checked), then collapses out of the view; `a11y.taskCompleted` announced at toggle time.
3. Uncomplete: toggle the checked checkbox in the Completed view (or editor) → task returns to its
   list's manual order (preserved while completed) and `a11y.taskReopened` announced.
4. `completedAt` set on complete; cleared on uncomplete. Failure → rollback (§5.6) with the row back
   to its prior state.

### F4 — Delete a task (M1; destructive → CONFIRM)

1. Row menu → `task.action.delete`. → Confirm dialog S7.1 (`confirm.deleteTask.title`, body names
   the task title).
2. Confirm → optimistic removal, `a11y.taskDeleted`, focus moves to the next row (or the view
   heading if none). Cancel/Escape → nothing changes, focus returns to the menu button.
3. Deleting a **completed** task uses the same dialog.

### F5 — List management: create, rename, reorder (M2)

1. **Create**: mobile Lists tab → `list.action.new` (or sidebar `New list`); ListDialog S6.3 with
   name + color swatches. Save → list appears at the end of the list order, navigable immediately.
2. **Rename**: list row menu → `list.action.rename` → inline input in place (mobile) / ListDialog
   (desktop). Enter saves, Escape cancels, blur saves.
3. **Reorder lists**: drag handle (pointer) or `Alt+↑/↓` when the list row is focused; announce
   `a11y.listMoved`. Same first-class keyboard treatment as task reorder (§8.2).
4. **Open a list**: tap its name → `#/list/:id` (per-list view).

### F6 — Delete a list with task disposition (M2; destructive → CONFIRM)

1. List row menu → `list.action.delete`. → Confirm dialog S7.2 showing counts
   (`confirm.deleteList.body` with `{list}`, `{openCount}`, `{doneCount}`).
2. **Disposition radio group (required choice, default = option A when another list exists):**
   - **A. Move tasks to another list** — nested `ListSelect` (all lists except the one being
     deleted). If no other list exists, this option is disabled with
     `confirm.deleteList.noTarget`.
   - **B. Delete the list and its tasks** — danger-styled; body restates the total count.
3. Confirm executes ONE transaction (list tombstone + task updates/deletes). Result announced
   (`a11y.listDeleted` with `{count}`), focus moves to the Lists screen heading or next list row.
4. Cancel/Escape → nothing changes; focus returns to the trigger.

### F7 — Navigate views (M3)

Bottom tab / sidebar link → route change, focus to `h1`, `a11y.viewChanged` announced, scroll
position remembered per route (session-scoped). Per-list is reached from the Lists tab (mobile) or
sidebar (desktop); Back restores the previous tab.

### F8 — Search (M5)

1. Header search icon (mobile → pushed search screen, input auto-focused) / search field (desktop).
2. Filtering is instant per keystroke (no submit, no debounce on filtering). Results = TaskRow list
   with `<mark>` highlights and list badge (D5).
3. Result count announced debounced (§5.5). `Escape` clears the query; `Escape` again closes the
   search screen (mobile) / returns focus to the trigger (desktop).
4. Empty query → hint empty state (`search.hint`). No matches → `search.empty.title` + query echo.
5. Rows in results are fully interactive (complete, open editor, menu); **no reorder in results**
   (D1); `Move to list` is available.

### F9 — Drag reorder (M6, pointer)

See §8.1. Per-list view only. Also: dropping a row onto a sidebar list (desktop) = move-to-list (F11
via pointer).

### F10 — Keyboard reorder (M6, first-class)

See §8.2. Full sequence: focus row → `Alt+↑`/`Alt+↓` repeatedly → `Enter` to inspect/edit.

### F11 — Move a task to another list ("move into", D2)

1. Row menu → `task.action.moveToList` (or desktop drag onto a sidebar list). → MoveToListDialog
   (list of lists, current list marked and disabled).
2. Choose + `Move` → task removed from the current view (it left the list), `a11y.taskMovedToList`
   announced. Dialog is radio-list semantics (arrow keys, `Enter` selects).

---

## 7. Screen specs

### S1 — App shell & navigation (`#/`)

- **Purpose**: stable frame for all M1–M6 flows; owns focus/route behavior.
- **Layout**: mobile (§4.2) / desktop (§4.3).
- **Components**: AppHeader, BottomNav (mobile), Sidebar (desktop), FAB (mobile), AddComposer
  (desktop), LiveRegion host, Toast host.
- **Content**: nav labels `nav.today`, `nav.next7days`, `nav.allOpen`, `nav.completed`, `nav.lists`;
  FAB aria-label `task.action.add`.
- **Interactions**: see §4; FAB opens S3 as a bottom sheet (mobile).
- **Accessibility**: `nav` labelled `a11y.navLabel`; active item `aria-current="page"`; bottom-nav
  order = visual order; FAB is the last tab stop before the bottom nav.
- **Responsive**: 768 px switches to sidebar layout; at 200% zoom the layout collapses to mobile.
- **Edge cases**: zero lists (sidebar Lists group shows `list.empty.title` + `New list`), one list
  (delete flow disables disposition option A).

### S2 — Task list views (`#/today`, `#/next7`, `#/all`, `#/completed`, `#/list/:id`)

- **Purpose**: the read surface of the core loop (M3) and the row interaction host (M1/M4/M6).
- **Layout**: ViewHeader → (desktop) Composer → grouped `ul` of TaskRow; mobile adds FAB.
- **Wireframe (rows, per-list view — mobile & desktop share the row anatomy):**

```
── Overdue (2) ───────────────────────────────────────────  h2 group header
┌───────────────────────────────────────────────────────────┐
│ ☐  Buy milk                                       ⚑  ⋮  ⠿│  checkbox | title | badges | menu | handle
│    Overdue · 21 Oct · Personal                           │  metadata line (mobile) / inline (desktop)
└───────────────────────────────────────────────────────────┘
── Today (3) ─────────────────────────────────────────────
┌───────────────────────────────────────────────────────────┐
│ ☑  Reply to Ana        [check = done state: title strike] │
└───────────────────────────────────────────────────────────┘
```

- **Per-view behavior matrix:**

| View | Groups (in order) | Membership | Order within group | Reorder |
|---|---|---|---|---|
| Today | Overdue, Today | open + `dueDate ≤ today` | dueDate asc, priority desc, list order, task order | no (D1) |
| Next 7 days | Overdue, then today…+6 | open + `dueDate` in window | dueDate asc, priority desc, list order | no |
| All open | Overdue, Next 7 days, Later, No due date | all open | dueDate asc, priority desc, list order | no |
| Completed | Today, Yesterday, Earlier | done, by `completedAt` day | `completedAt` desc | no |
| Per-list | (none) | one list, open only | **manual `sortOrder`** | **yes** |

- **Components**: ViewHeader (`h1` + count `view.count` `{count}`), GroupHeader (`h2` + count),
  TaskList, TaskRow, DueBadge, PriorityIcon, ListBadge (aggregate views only), RowActionsMenu,
  ReorderHandle (per-list only).
- **TaskRow anatomy & states**: `default` / `hover` (background `surface.raised`, handle visible on
  pointer devices) / `focus` (row-level focus ring; see §9.1 focus model) / `active (press)` /
  `disabled` (n/a) / `pending-write` (no visible state per §5.6; 3 s fallback only) /
  `error` (row restored after rollback + assertive announcement) / `completed` (checked checkbox,
  title `text-decoration: line-through` + `text.secondary`).
- **Row actions menu items** (in order): `task.action.edit`, `task.action.moveToList`,
  `task.action.moveUp` / `task.action.moveDown` (per-list only; `aria-disabled` at boundaries),
  `task.action.delete` (danger tone).
- **DueBadge copy**: `task.due.overdue` (`{date}`), `task.due.today`, `task.due.tomorrow`, else
  Intl medium date. Overdue badge = danger tone + `!` marker icon (not color alone).
- **Content rules**: title clamps to 2 lines (`text-overflow` handled via line clamp; full title in
  `title` attr and editor); notes presence shown as a notes glyph with `a11y.hasNotes` label; list
  badge shows the list name (color dot decorative).
- **Interactions**: click checkbox = complete; click title = open editor; menu button = actions
  menu; drag handle = reorder (per-list). Row click elsewhere = open editor (convenience; the title
  button remains the labelled control).
- **Accessibility**: `ul role="list"`; each row an `li` with roving focus (§9.1); checkbox labelled
  by the task title (visually hidden full label `a11y.toggleTask` `{title}`); badges carry
  `aria-label` text; group headers real `h2`.
- **Responsive**: metadata line (mobile) collapses to inline badges + tooltip-ish `title` on desktop;
  handle always visible on touch, hover/focus-revealed on desktop; row min-height 56 px mobile /
  44 px desktop.
- **Edge cases**: group with 0 tasks after filtering → group hidden; list with 0 open tasks →
  `list.empty.tasks` empty state + `task.action.add`; Completed empty → `completed.empty.title`;
  row's list deleted concurrently (other tab, E5) → row disappears on BroadcastChannel refresh with
  polite announcement.

### S3 — Quick-add composer (M1)

- **Purpose**: capture in < 5 s (F1) from every task view.
- **Layout**: mobile = bottom sheet (max-height 90vh, sticky title row + `Add`); desktop = inline
  block at the top of the main pane (single row collapsed).
- **Wireframe:**

```
collapsed:   [ ＋ ]  [ Add task — title………… ]        [ ⌄ details ]  [ Add ]
expanded:    [ ＋ ]  [ title……………………………………… ]
             [ notes (textarea, 3 rows)…………………… ]
             [ 📅 due date (input+chips) ] [ list ▾ ] [ priority: ○low ●med ○high ]
                                                  [ ⌃ hide ] [ Add ]
```

- **Components**: Composer, DateField, ListSelect, PriorityField.
- **States**: `collapsed` / `expanded` / `focused` (ring) / `submitting` (≤ 3 s invisible per §5.6) /
  `error` (`form.error.titleRequired` under the title input, `role="alert"`) / `disabled` (zero
  lists exist: inputs disabled, `composer.needsList` hint + `list.action.new` button).
- **Content**: placeholder `composer.placeholder`, button `composer.add`, expander labels
  `composer.details` / `composer.hideDetails`.
- **Interactions**: `Enter` saves + stays (D6); `Shift+Enter` (expanded) saves + collapses; `Escape`
  collapses/clears; expander toggles inline fields. Chips: `date.chip.today`, `date.chip.tomorrow`,
  `date.chip.clear`.
- **Accessibility**: labelled inputs (`composer.label.title` etc.), `aria-expanded` on the expander,
  save confirmation via `a11y.taskAdded`; error linked with `aria-describedby`.
- **Responsive**: as above; sheet on mobile traps focus and closes on `Escape`/scrim tap (with no
  dirty-guard needed — content is preserved in draft state while the sheet is open only; closing
  with text present asks `confirm.discardDraft` — see S7.3).
- **Edge cases**: very long titles (input scrolls, row clamps), notes with newlines (preserved
  literally, rendered as text), zero lists (disabled state), rapid repeated `Enter` (each keystroke
  of Enter creates exactly one task; input cleared synchronously).

### S4 — Task editor (M1)

- **Purpose**: full field editing (create with all fields / edit existing).
- **Layout**: mobile = full-screen sheet (header: `Cancel` / `editor.title.edit|create` / `Save`;
  scrollable body; fields stacked). Desktop = centered modal dialog `max-width 560 px`.
- **Wireframe:**

```
┌──────────────────────────────────────────────┐
│ Cancel        Edit task                Save  │
├──────────────────────────────────────────────┤
│ Title *                                      │
│ [ Buy milk for the week…………………………………… ]     │
│ Notes (plain text)                           │
│ [ ………………………………………………………………………………… ] (textarea)  │
│ Due date        [ 2026-10-25 ] [Today][Tomorrow][Clear] │
│ List            [ Personal ▾ ]  (+ New list…) │
│ Priority        ( ◉ Low  ○ Medium  ○ High )  │
│                                              │
│ [ Delete task ]          (edit mode only)    │
└──────────────────────────────────────────────┘
```

- **Components**: TaskEditor (form), DateField, ListSelect, PriorityField (radiogroup), ConfirmDialog
  (delete + discard).
- **States**: `pristine` / `dirty` (Save enabled) / `invalid` (`form.error.titleRequired` inline,
  Save disabled) / `saving` (Save shows `editor.saving`, inputs stay enabled for < 3 s) / `error`
  (rollback not applicable — dialog stays open, assertive `error.save.title` + Retry keeps the
  user's text) / `completed-task` (shows `task.completedOn` `{date}`).
- **Content**: keys `editor.title.create`, `editor.title.edit`, `editor.label.*`, `editor.save`,
  `editor.cancel`, `editor.delete`, `editor.saving`.
- **Validation (D10)**: title 1–200 chars (`form.error.titleRequired`, `form.error.titleTooLong`),
  notes ≤ 20,000 (`maxlength` + `form.error.notesTooLong`), list must exist (preselected).
- **Interactions**: `Save` persists one transaction → close → focus to originating row (or to the
  new row) → `a11y.taskSaved`. `Cancel`/`Escape` + dirty → discard-confirm (S7.3). `Delete` →
  confirm (S7.1). Date chips set/clear the date input; the native `input[type="date"]` keeps
  keyboard + locale behavior.
- **Accessibility**: dialog semantics (`aria-modal`, labelled by the title heading), focus starts on
  the title field, focus trap, `Escape` = Cancel path, radio group uses `role="radiogroup"` with
  roving arrow keys, all errors `role="alert"` + `aria-describedby`.
- **Responsive**: as above; on mobile the Save is in the sticky header (44 px target) and the
  keyboard must not cover focused fields (scroll-margin on inputs).
- **Edge cases**: editing a task deleted in another tab (E5) → editor shows `error.taskGone` and
  disables Save; date input on browsers without `input[type=date]` (below floor — not supported,
  §9.4); extremely long notes (textarea scrolls internally).

### S5 — Search (M5)

- **Purpose**: instant find across title + notes (F8).
- **Layout**: mobile = pushed screen (sticky SearchField at top, results below). Desktop =
  SearchField in the view header; typing transforms the main pane into results (view header shows
  `search.results.count` `{count}`).
- **States**: `idle` (empty query → `search.hint`), `searching` (instant; no spinner needed —
  filter is synchronous; `aria-busy` only while > 100 ms), `results`, `no-results`
  (`search.empty.title` `{query}`), `error` (search index failure → fall back to plain filtering and
  log locally; identical UI).
- **Content**: placeholder `search.placeholder`, clear button `search.clear`, count
  `search.results.count`.
- **Interactions**: filtering per keystroke (D5); `<mark>` highlight; `Escape` ×2 (see F8); result
  rows fully interactive; `Enter` on the field does nothing destructive (no navigation).
- **Accessibility**: field is `type="search"` with a real label (`search.label`), results in `ul`,
  count announced debounced (§5.5), highlighted text keeps sufficient contrast in both themes.
- **Responsive**: as above; at ≥ 768 px the sidebar stays visible so users can narrow by opening a
  list first (search remains global — scope is global in MVP).
- **Edge cases**: 10,000+ matches (virtualized results), Thai query text (NFKC match, D5), query
  that matches only notes (notes excerpt shown with highlight, clamped 2 lines).

### S6 — Lists management (M2)

- **Purpose**: create/rename/reorder/delete lists and open per-list views.
- **Layout**: mobile = the `Lists` tab (pushed list of list-rows + `list.action.new` at top).
  Desktop = sidebar section (interactive rows) + `Manage lists…` opening the same list as a dialog
  for bulk tidy-up.
- **Wireframe (Lists tab):**

```
┌──────────────────────────────────────────────┐
│ ＋ New list                                   │
│ ┌──────────────────────────────────────────┐ │
│ │ ● Personal (12)                    ⋮  ⠿ │ │
│ │ ● Work (5)                         ⋮  ⠿ │ │
│ │ ● Someday (0)                      ⋮  ⠿ │ │
│ └──────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

- **Components**: ListManager, ListRow, ListDialog (create/rename: name + color swatches),
  RowActionsMenu, ReorderHandle.
- **ListRow states**: `default` / `hover` / `focus` / `renaming` (inline input, Enter/blur save,
  Escape cancel) / `invalid-name` (inline `list.error.nameRequired` / `list.error.nameTooLong` /
  `list.error.duplicateName`) / `deleting` (confirm dialog flow).
- **ListDialog**: name input (D10 rules), color radiogroup of 8 preset swatches (`list.color.*`
  keys, decorative), `list.dialog.save` / `list.dialog.cancel`.
- **Row menu items**: `list.action.rename`, `list.action.moveUp`, `list.action.moveDown`
  (aria-disabled at ends), `list.action.delete` (danger).
- **Accessibility**: lists are `ul/li`; color swatches are radios with text labels (never color
  alone); task counts in labels `list.item.count` `{count}`; delete flow per S7.2.
- **Responsive**: sidebar rows (desktop) show the menu button on hover/focus but it remains a real,
  reachable button; mobile rows show it always.
- **Edge cases**: zero lists (empty state `list.empty.title` + `list.empty.body` + `New list`),
  deleting the last list (disposition A unavailable), duplicate name attempt (inline error, value
  preserved), renaming to whitespace (trimmed → `list.error.nameRequired`).

### S7 — Confirm dialogs (destructive = CONFIRM in MVP)

Shared shell: `role="dialog" aria-modal="true"`, title `h2`, body `aria-describedby`, actions right-
aligned (stacked full-width on mobile), **initial focus on Cancel**, `Escape`/scrim = Cancel, focus
trap, focus returns to the trigger on close. Confirm buttons use the danger tone and always carry a
verb label (never a bare "OK").

- **S7.1 Delete task** — `confirm.deleteTask.title`; body `confirm.deleteTask.body` `{title}`;
  actions `confirm.deleteTask.confirm` (danger) / `common.cancel`.
- **S7.2 Delete list + disposition** — `confirm.deleteList.title`; body `confirm.deleteList.body`
  `{list}`, `{openCount}`, `{doneCount}`; disposition radio group (S6/F6): option A
  `confirm.deleteList.moveTasks` + nested ListSelect (`confirm.deleteList.moveTarget`), option B
  `confirm.deleteList.deleteTasks` `{count}`; actions `confirm.deleteList.confirm` / `common.cancel`.
  Confirm is disabled until the disposition is valid (A needs a target ≠ deleted list).
- **S7.3 Discard unsaved changes / draft** — `confirm.discard.title`; body `confirm.discard.body`;
  actions `confirm.discard.confirm` (danger) / `confirm.discard.keepEditing`. Used by S3
  (`confirm.discardDraft` variant) and S4.

### S8 — Toasts & feedback (M4/M6 support surface)

- **Layout**: bottom-center, above the bottom nav (mobile, `bottom: calc(56px + 16px)`) / bottom-left
  of the viewport (desktop); max-width 360 px; 1–2 lines.
- **States**: `info` (brief confirmations are NOT used — see §5.6; reserved for neutral notices) /
  `error` (role `alert`, persists until dismissed or 8 s, carries optional `Retry` action) /
  `success` (used only where an action's result is not visible in place, e.g. move-to-list).
- **Content keys**: `error.save.title` + `common.retry`, `a11y.*` strings (§5.5) double as the
  announcement text.
- **Accessibility**: container hosts both live regions; toasts are focusable only via their action
  buttons; never the only channel for information (announcements carry the same content).

---

## 8. Reorder system (M6) — first-class specification

Scope: **task reorder within a per-list view (D1)** and **list reorder (S6)** use the exact same
model below; "target" = a row in an ordered list. "Move into" = move-to-list (D2, F11).

### 8.1 Drag-and-drop (pointer: mouse, pen, touch)

- **Handle**: `ReorderHandle` grip button (24 px glyph, 44 px hit area) at the row's trailing edge.
  Visible on hover/focus on pointer devices; **always visible on touch**. Accessible name
  `reorder.handle` `{title}`. Dragging starts from the handle only (so row clicks keep opening the
  editor).
- **During drag**: the source row becomes a floating ghost (50% opacity, follows pointer); a 3 px
  insertion line marks the drop point (`surface.accent`); rows auto-scroll within 48 px of the
  viewport edge (max ~800 px/s); the drop target row highlights.
- **Drop**: optimistic reorder (single order-key write, §5.7); `a11y.taskMoved` `{position}`,
  `{total}`, `{list}` announced; moved row gets a 600 ms "moved" highlight (skipped under
  `prefers-reduced-motion`).
- **Cancel**: `Escape` during drag, or drop outside any target → row returns to its original
  position; polite `a11y.reorderCancelled`.
- **Desktop extra**: dragging a row over a **sidebar list item** highlights it as a move-to-list drop
  target (D2); dropping executes F11 semantics (announced `a11y.taskMovedToList`).
- **Touch**: drag from the handle works via pointer events; no long-press needed anywhere; page
  scrolling must not fight the drag (touch-action rules on the handle only).
- **Not draggable**: completed rows (Completed view has no handle), rows in aggregate/search views
  (no handle — instead the menu offers `Move to list` and keyboard users hear
  `a11y.reorderUnavailable` if they try the keys).

### 8.2 Keyboard reorder (equally first-class — this is the WCAG path)

**Entry**: the target row is focused (row-level roving focus, §9.1) — or the ReorderHandle is
focused (it is part of the row's tab sequence and performs the identical commands).

| Key | Action | Notes |
|---|---|---|
| `Alt+↑` | Move the focused task one position **up** | Per-list view only |
| `Alt+↓` | Move the focused task one position **down** | Per-list view only |
| `Alt+Home` | Move to the **top** of the list | Optional accelerator |
| `Alt+End` | Move to the **bottom** of the list | Optional accelerator |
| `Escape` | (during drag) cancel | Pointer path only |

- **Behavior**: each press moves exactly one position (or to the edge for Home/End); **focus stays
  on the moved row** and the row scrolls into view; every move is announced: `a11y.taskMoved`
  `{position}` `{total}` `{list}` (e.g. "Moved to position 3 of 12 in Personal"). Persistence is
  optimistic per §5.6 (one order-key write per press).
- **Boundary**: at the first/last position the key is a no-op + `a11y.reorderBoundary` (`{edge}` =
  `common.top` / `common.bottom`). The row menu's `Move up`/`Move down` items show
  `aria-disabled="true"` at the same boundaries (button equivalent always present).
- **In aggregate/search views**: `Alt+↑/↓` announces `a11y.reorderUnavailable` and does nothing
  (D1) — the visible alternative there is `Move to list`.
- **Lists manager**: identical keys on focused list rows; announcements `a11y.listMoved`.
- **Mobile / touch keyboards**: `Alt+↑/↓` works with external keyboards; without one, the row
  menu's `Move up` / `Move down` buttons (44 px targets) are the equivalent — this satisfies
  "every gesture needs a button/keyboard equivalent" (binding #6).
- **Why `Alt+↑/↓`**: matches the "move line" convention from code editors; not a browser default on
  the supported desktop browsers (§9.4); never fires while a text field has focus. (A shortcut help
  overlay is V1 S8 — the discoverable MVP path is the always-visible row menu.)

### 8.3 Failure & concurrency

- Write failure → row returns to its pre-move index + assertive `a11y.saveFailed` toast with Retry.
- Another tab reorders concurrently (E5) → BroadcastChannel refresh re-sorts the view; a focused row
  keeps focus by task id, position re-announced only if it changed under the user.

---

## 9. Keyboard interaction map

### 9.1 Task list focus model (composite list)

The task list is one composite widget with **row-level roving tabindex**: exactly one row in the
list is tabbable (`tabindex="0"`), all others `tabindex="-1"`. This keeps Tab bounded regardless of
list length and works with virtualization (§5.7).

- `Tab` enters the list at the current row. From the row: `Tab` → row checkbox → title button →
  (badges, non-focusable) → menu button → ReorderHandle (per-list only) → `Tab` exits the list
  (bottom-nav / next landmark). Non-current rows' inner controls are `tabindex="-1"` and are reached
  by first moving the row cursor to them.
- `Escape` from any inner control returns focus to the row container.

| Key (row focused) | Action |
|---|---|
| `↑` / `↓` | Move row cursor (scrolls into view) |
| `Home` / `End` | First / last row |
| `PageUp` / `PageDown` | Jump ~10 rows |
| `Space` | Toggle complete (M4; prevents page scroll) |
| `Enter` | Open task editor (S4) |
| `Delete` | Delete task → confirm (S7.1) |
| `Alt+↑` / `Alt+↓` | Move up / down (§8.2) |
| `Alt+Home` / `Alt+End` | Move to top / bottom (§8.2) |

| Key (inner control focused) | Action |
|---|---|
| Checkbox: `Space`/`Enter` | Toggle complete (native) |
| Title button: `Enter`/`Space` | Open editor |
| Menu button: `Enter`/`Space`/`↓` | Open row actions menu |
| Handle: `Alt+↑`/`Alt+↓` | Move up/down (same as row) |
| `Escape` | Back to row focus |

### 9.2 Row actions menu / any menu

`Enter`/`Space`/`↓` opens (focus first item); `↑`/`↓` cycle; `Home`/`End` jump; `Enter` activates;
`Escape` closes + focus back to the trigger; `Tab` closes + moves to the next control after the
trigger. Disabled items (`aria-disabled`) are focusable and announce their disabled state.

### 9.3 Global / navigation

| Key | Action |
|---|---|
| `Tab` / `Shift+Tab` | Move through the focus order (header → main → FAB/composer → bottom nav) |
| `Enter` on nav item / `Space` on tab | Switch view (S1) |
| `F6`-free browsers: `Tab` cycles landmarks in DOM order | (no custom landmark keys in MVP) |
| `Escape` | Close topmost dialog/sheet/menu; else clear search query |

### 9.4 Composer (S3)

| Key | Action |
|---|---|
| `Enter` | Save + stay (D6) |
| `Shift+Enter` | Save + collapse (expanded state) |
| `Escape` | Collapse / clear (dirty → S7.3) |
| `Tab` | title → notes → due date → chips → list → priority → expander → Add |

### 9.5 Task editor dialog (S4)

| Key | Action |
|---|---|
| `Tab` / `Shift+Tab` | Cycle inside the trap |
| `Enter` (in inputs) | Save (single-line inputs only; `Ctrl/Cmd+Enter` in the notes textarea) |
| `Escape` | Cancel (dirty → S7.3) |
| `↑`/`↓` in priority radiogroup | Move + select |
| `DateField`: native date-picker keys (`↑`/`↓` on segments) | Adjust date; chips are tabbable buttons |

### 9.6 Confirm dialog (S7) & Move-to-list dialog

| Key | Action |
|---|---|
| `Tab` / `Shift+Tab` | Cycle inside the trap (initial focus = Cancel / first list option) |
| `Escape` | Cancel |
| `Enter` | Activate focused button; in the move dialog's listbox: select focused option |
| `↑`/`↓` (listbox / radiogroup) | Move selection (type-ahead not required) |

### 9.7 Search (S5)

| Key | Action |
|---|---|
| `↑`/`↓` (from the field) | Move into the results list (row cursor) |
| `Escape` | Clear query; second `Escape` closes search (mobile) / returns focus to trigger (desktop) |
| `Enter` | (in field) no-op; (on row) opens editor |

---

## 10. Component API (for coders)

TypeScript-first; props mirror HTML semantics. All components are locale-agnostic (take strings via
the i18n layer, never embed copy). Suggested module homes are indicative only (h_senior_coder owns
final architecture).

```ts
// ---- domain view-models (shape follows §5.3) ----
type Priority = 0 | 1 | 2;                 // 0 low, 1 medium, 2 high (D4)
interface TaskView {
  id: string; listId: string; title: string; notes: string | null;
  status: 'open' | 'done'; priority: Priority; dueDate: string | null; // 'YYYY-MM-DD'
  sortOrder: string; completedAt: number | null;
}
interface ListView { id: string; name: string; color: string; sortOrder: string; openCount: number; doneCount: number; }

// ---- TaskList (virtualized composite; §9.1 focus model) ----
interface TaskListProps {
  rows: TaskView[]; groups: { key: string; titleKey: string; params?: Record<string, string | number> }[];
  reorderable: boolean;                    // true only in per-list view (D1)
  currentRowId: string | null;             // roving focus
  onRowFocus(id: string): void;
  onToggle(id: string, done: boolean): void;
  onOpenEditor(id: string): void;
  onMove(id: string, delta: -1 | 1 | 'top' | 'bottom'): void;   // keyboard/menu reorder
  onMoveToList(id: string): void;
  onDelete(id: string): void;
  'aria-label': string;
}

// ---- TaskRow ----
interface TaskRowProps {
  task: TaskView; showListBadge: boolean; reorderable: boolean;
  highlight?: { text: string };            // search <mark>
  states: { completed: boolean; focused: boolean; moved: boolean; error: boolean };
}

// ---- Composer (S3) ----
interface ComposerProps {
  lists: ListView[]; defaultListId: string | null;
  disabledReason: 'no-lists' | null;
  onAdd(input: { title: string; notes: string | null; dueDate: string | null; listId: string; priority: Priority }): void;
}
type ComposerState = 'collapsed' | 'expanded' | 'error' | 'disabled';

// ---- TaskEditor (S4) ----
interface TaskEditorProps {
  mode: 'create' | 'edit';
  initial?: TaskView; lists: ListView[];
  onSave(task: Omit<TaskView, 'id' | 'sortOrder' | 'completedAt'> & { id?: string }): Promise<void>;
  onDelete(): void; onClose(reason: 'save' | 'cancel' | 'escape'): void;
}
type TaskEditorState = 'pristine' | 'dirty' | 'invalid' | 'saving' | 'error' | 'completed-task';

// ---- ConfirmDialog (S7.1 / S7.3; S7.2 composes it with a disposition field) ----
interface ConfirmDialogProps {
  titleKey: string; bodyKey: string; params?: Record<string, string | number>;
  confirmKey: string; cancelKey: string; tone: 'danger' | 'neutral';
  initialFocus: 'cancel' | 'confirm';       // destructive => 'cancel'
  extra?: 'delete-list-disposition';        // renders radio group + ListSelect (S7.2)
  onConfirm(value?: { mode: 'move' | 'delete'; targetListId?: string }): void;
  onCancel(): void;
}

// ---- ListManager / ListDialog (S6) ----
interface ListManagerProps {
  lists: ListView[]; onRename(id: string, name: string): void;
  onMove(id: string, delta: -1 | 1): void;
  onDelete(id: string): void; onCreate(name: string, color: string): void;
  onOpen(id: string): void;
}
interface ListDialogProps { mode: 'create' | 'rename'; initial?: { name: string; color: string };
  validate(name: string): string | null;    // returns error KEY or null (D10 rules)
  onSave(v: { name: string; color: string }): void; onCancel(): void; }

// ---- MoveToListDialog (F11) ----
interface MoveToListDialogProps { task: TaskView; lists: ListView[];
  onMove(targetListId: string): void; onCancel(): void; }

// ---- SearchField / SearchResults (S5) ----
interface SearchFieldProps { value: string; onInput(v: string): void; onClear(): void; onEscape(): void; }

// ---- ReorderHandle (§8) ----
interface ReorderHandleProps { labelKey: 'reorder.handle'; params: { title: string };
  onMove(delta: -1 | 1): void;             // keyboard path (Alt+↑/↓ handled at row level too)
  dragEnabled: boolean; }

// ---- Toast host + LiveRegion (S8 / §5.5) ----
interface Toast { id: string; tone: 'info' | 'error' | 'success'; messageKey: string;
  params?: Record<string, string | number>; action?: { key: string; run(): void }; }
interface LiveRegionProps { /* single polite + single assertive region, mounted once in S1 */ }
```

Every interactive component implements the 7 states: `default, hover, focus, active, disabled,
loading (saving), error` — enumerated per component in §7 and asserted in the §16 checklist.

---

## 11. Design tokens used (provisional values — Epic E5 owns the final palette)

Names below are the contract; values are AA-provisional so impl is unblocked, and must be replaced
by the UX Foundation token file when it lands. Contrast ratios are targets to be verified by the
axe/CI a11y gate (§8 of PROJECT_ANALYSIS) in both themes.

| Token | Light (provisional) | Dark (provisional) | Use |
|---|---|---|---|
| `color.bg.canvas` | `#F6F7F9` | `#101214` | page background |
| `color.bg.surface` | `#FFFFFF` | `#1B1E22` | rows, dialogs, sheets |
| `color.bg.raised` | `#FFFFFF` | `#22262B` | hover row, menus |
| `color.text.primary` | `#16191D` | `#E7EAEE` | titles (≥ 4.5:1) |
| `color.text.secondary` | `#4B535C` | `#A6AEB8` | metadata (≥ 4.5:1) |
| `color.accent.fg` | `#1D4ED8` | `#8FB4FF` | links, focus, active nav (≥ 4.5:1 on bg) |
| `color.accent.bg` | `#1D4ED8` | `#2E5BFF` | primary buttons (text `#FFFFFF`/`#0B1220`) |
| `color.danger.fg` | `#B42318` | `#FF9C90` | destructive text, overdue (≥ 4.5:1) |
| `color.danger.bg` | `#B42318` | `#C63A2E` | destructive buttons (white text) |
| `color.success.fg` | `#067647` | `#6FD79E` | success toast (≥ 4.5:1) |
| `color.border.default` | `#D7DBE0` | `#333941` | row/field borders (≥ 3:1 vs surface) |
| `color.focus.ring` | `#2563EB` | `#8AB4FF` | 3 px ring, 2 px offset (≥ 3:1) |
| `color.mark.bg` | `#FFF3BF` | `#5C4A12` | search `<mark>` (text stays `text.primary`) |

| Scale | Values (px) |
|---|---|
| `space.*` | 4, 8, 12, 16, 20, 24, 32, 40, 48 |
| `radius.*` | sm 6, md 10, lg 14, pill 999 |
| `type.*` | 12 (nav label), 14 (metadata), 16 (body/row title), 18 (section), 22 (view `h1`), 28 (empty-state head) |
| `line-height` | 1.5 body (Thai-safe), 1.25 headings |
| `shadow.*` | sm `0 1px 2px rgb(0 0 0 / .12)`, md `0 8px 24px rgb(0 0 0 / .18)` (dialogs/menus) |
| `motion.fast / base` | 120 ms / 200 ms, `cubic-bezier(0.2, 0, 0, 1)`; reduced-motion → 0 |
| min touch target | 44×44; row height 56 (mobile) / 44 (desktop); FAB 56 |

---

## 12. Assets

- **Icons** (inline SVG, `currentColor`, 20 px in rows / 24 px in nav; stroke 1.75; NO remote icon
  requests per §7.2): `plus`, `search`, `check`, `calendar`, `flag-high`, `flag-medium`,
  `notes`, `list`, `more-vert` (kebab), `grip` (drag handle), `chevron-down`, `chevron-left`
  (back), `close`, `trash`, `pencil`, `move-to-list`, `warning`, `inbox` (empty-state).
- Priority icons must differ **by shape**, not only color (D4): `flag-high` = filled flag,
  `flag-medium` = half-filled flag; low = no icon.
- **Illustrations**: none required (bundle budget §9.2). Empty states use a single 48 px icon +
  text; no stock imagery, no emoji as UI icons.
- **Fonts**: system font stack only (§7.2, §9.2) — `-apple-system, "Segoe UI", Roboto,
  "Noto Sans Thai", sans-serif` (Thai fallbacks included; no webfont bytes).

---

## 13. i18n string key register (English source; Thai = PO-validated translation)

`{param}` marks interpolation. No copy may be hardcoded in components (binding #8).

| Key | English source |
|---|---|
| `nav.today` / `nav.next7days` / `nav.allOpen` / `nav.completed` / `nav.lists` | Today / Next 7 days / All open / Completed / Lists |
| `view.today` / `view.next7days` / `view.allOpen` / `view.completed` / `view.search` | (same as nav) / Search |
| `view.count` | `{count} tasks` |
| `group.overdue` / `group.today` / `group.tomorrow` / `group.later` / `group.noDueDate` | Overdue / Today / Tomorrow / Later / No due date |
| `group.earlier` / `group.yesterday` | Earlier / Yesterday |
| `task.action.add` | Add task |
| `task.action.edit` / `.moveToList` / `.moveUp` / `.moveDown` / `.delete` | Edit / Move to list… / Move up / Move down / Delete |
| `task.due.overdue` | Overdue · {date} |
| `task.due.today` / `task.due.tomorrow` | Due today / Due tomorrow |
| `task.completedOn` | Completed on {date} |
| `a11y.toggleTask` | Mark "{title}" as complete |
| `a11y.hasNotes` | Has notes |
| `a11y.taskAdded` | Task added: {title} |
| `a11y.taskCompleted` / `a11y.taskReopened` | Task completed / Task reopened |
| `a11y.taskSaved` / `a11y.taskDeleted` | Task saved / Task deleted |
| `a11y.taskMoved` | Moved to position {position} of {total} in {list} |
| `a11y.taskMovedToList` | "{title}" moved to {list} |
| `a11y.listCreated` / `a11y.listRenamed` / `a11y.listMoved` / `a11y.listDeleted` | List created: {list} / List renamed to {list} / List moved / List "{list}" deleted ({count} tasks) |
| `a11y.searchResults` | {count} results for "{query}" |
| `a11y.viewChanged` | View: {view} |
| `a11y.reorderUnavailable` | Reordering is only available inside a list view. Use "Move to list" to move this task. |
| `a11y.reorderBoundary` | Already at the {edge} |
| `a11y.reorderCancelled` | Move cancelled |
| `a11y.saveFailed` | Could not save. Your change was undone. |
| `a11y.loading` | Loading tasks… |
| `a11y.navLabel` | Views and lists |
| `reorder.handle` | Reorder "{title}" |
| `composer.placeholder` | Add task… |
| `composer.add` | Add |
| `composer.details` / `composer.hideDetails` | Details / Hide details |
| `composer.label.title` / `.notes` / `.due` / `.list` / `.priority` | Title / Notes / Due date / List / Priority |
| `composer.needsList` | Create a list first — tasks live in lists. |
| `editor.title.create` / `editor.title.edit` | New task / Edit task |
| `editor.save` / `editor.cancel` / `editor.delete` / `editor.saving` | Save / Cancel / Delete task / Saving… |
| `date.chip.today` / `date.chip.tomorrow` / `date.chip.clear` | Today / Tomorrow / Clear |
| `priority.low` / `priority.medium` / `priority.high` | Low / Medium / High |
| `search.label` / `search.placeholder` | Search tasks / Search titles and notes… |
| `search.hint` | Type to search your tasks (titles and notes). |
| `search.empty.title` | No tasks match "{query}" |
| `search.results.count` | {count} results |
| `search.clear` | Clear search |
| `list.action.new` / `.rename` / `.moveUp` / `.moveDown` / `.delete` | New list / Rename / Move up / Move down / Delete list |
| `list.dialog.save` / `list.dialog.cancel` / `list.manage` | Save / Cancel / Manage lists |
| `list.dialog.name` / `list.dialog.color` | List name / Color |
| `list.item.count` | {count} tasks |
| `list.empty.title` / `list.empty.body` | No lists yet / Tasks live in lists. Create your first list to start. |
| `list.empty.tasks` | Nothing in this list yet. |
| `list.error.nameRequired` / `list.error.nameTooLong` / `list.error.duplicateName` | Enter a list name / Use 60 characters or fewer / A list with this name already exists |
| `list.color.red` … (8 keys) | Red / Orange / Yellow / Green / Blue / Purple / Gray / Teal |
| `confirm.deleteTask.title` / `.body` / `.confirm` | Delete task? / "{title}" will be deleted. This can't be undone. / Delete |
| `confirm.deleteList.title` | Delete list? |
| `confirm.deleteList.body` | "{list}" has {openCount} open and {doneCount} completed tasks. Choose what happens to them. |
| `confirm.deleteList.moveTasks` / `.moveTarget` / `.deleteTasks` / `.noTarget` | Move tasks to another list / Move into / Also delete {count} tasks / Create another list to move tasks into |
| `confirm.deleteList.confirm` | Delete list |
| `confirm.discard.title` / `.body` / `.confirm` / `.keepEditing` / `.discardDraft` | Discard changes? / You have unsaved changes. / Discard / Keep editing / Discard draft? |
| `form.error.titleRequired` / `form.error.titleTooLong` / `form.error.notesTooLong` | Enter a title / Use 200 characters or fewer / Notes are limited to 20,000 characters |
| `error.save.title` / `error.boot.title` / `error.boot.body` / `error.taskGone` | Couldn't save / Couldn't load your tasks / Your data is still on this device. Try loading again, or restore from a snapshot. / This task no longer exists |
| `common.retry` / `common.cancel` / `common.top` / `common.bottom` | Try again / Cancel / top / bottom |
| `completed.empty.title` | Nothing completed yet |
| `today.empty.title` / `next7.empty.title` / `all.empty.title` | Nothing due today / Nothing due in the next 7 days / No open tasks |

---

## 14. State matrix — empty / loading / error (AC-1)

| Screen | Empty | Loading | Error |
|---|---|---|---|
| S1 shell | Lists group: `list.empty.title` + `New list` | n/a (chrome paints instantly) | Boot failure → S2 error panel replaces `main` |
| S2 Today / Next 7 / All | Per-view empty titles (§13) + `task.action.add` | SkeletonList: 3 shimmer rows (`aria-busy`, `a11y.loading` in a status region), shown only while first paint of data is pending (budget ≤ 500 ms, §9.1) | `error.boot.title`/`body` + actions: `common.retry`, "Export recovery file", "Restore snapshot" (Epic E3 flows), Reload |
| S2 Completed | `completed.empty.title` | same skeleton | same as above |
| S2 per-list | `list.empty.tasks` + `task.action.add` | same skeleton | same + `error.taskGone` if the list id is unknown (deep link) → redirect to Today with a polite announcement |
| S3 composer | `composer.needsList` (zero lists) | invisible (≤ 3 s, §5.6) | inline `form.error.titleRequired`; write failure → toast + entered text preserved |
| S4 editor | n/a (always has values) | `editor.saving` label on Save | dialog stays open; assertive `error.save.title` + Retry; `error.taskGone` disables Save |
| S5 search | `search.hint` (idle) / `search.empty.title` (no match) | `aria-busy` only if filtering > 100 ms | filter fallback (D5) — UI unchanged |
| S6 lists | `list.empty.title` / `list.empty.body` | n/a | rename/delete failures → toast + inline rollback |
| S7 confirms | n/a | `confirm` button disabled + `editor.saving` during transaction | failure → dialog closes, assertive toast, state rolled back |
| S8 toasts | hidden | n/a | role `alert` + Retry |
| Global (E3/E5/E10 cross-epic) | — | — | QuotaExceeded dialog (modal, non-destructive) — Epic E3 owns content; quarantine banner ("{count} tasks set aside for recovery") — Epic E3 |

---

## 15. Open questions for h_pm (non-blocking; defaults applied above)

Nothing blocks implementation — the items below are confirm-or-override; the stated default is what
impl will build if no answer arrives.

- [x] **OQ-1 (D1 confirm):** manual reorder restricted to per-list views (aggregate views use
  derived order + `Move to list`). Cross-list manual ordering would require a schema change (per
  §5.2 `sortOrder` is per list) — confirm the restriction or schedule a schema ADR amendment.
  Resolved 2026-10-25 — h_pm, epic t_9b61ecf5 (see docs/qa/e2-epic-verification.md §5): confirmed as built.
- [x] **OQ-2 (D10 confirm):** validation limits (title 1–200, notes ≤ 20,000, list name 1–60 unique)
  were chosen by design; override if product wants different bounds.
  Resolved 2026-10-25 — h_pm, epic t_9b61ecf5 (see docs/qa/e2-epic-verification.md §5): confirmed as built.
- [x] **OQ-3 (D8 confirm):** Completed view is global with a list filter (no per-list completed
  section). V1 S6 (archive/history) will refine this.
  Resolved 2026-10-25 — h_pm, epic t_9b61ecf5 (see docs/qa/e2-epic-verification.md §5): confirmed as built.
- [x] **OQ-4 (nice-to-have):** `Alt+Home/End` (move to top/bottom) is included as an optional
  accelerator; drop it if the V1 shortcut owner (S8) prefers to own all extended keys.
  Resolved 2026-10-25 — h_pm, epic t_9b61ecf5 (see docs/qa/e2-epic-verification.md §5): confirmed as built.

---

## 16. Handoff checklist — exact UI states/behaviors impl cards must build

This is the review contract (AC-3). Each item is verifiable in a component test or keyboard-only
pass. **h_reviewer: anything unchecked here is a spec deviation.**

**A. Shell & navigation (S1)**
1. Mobile 5-tab bottom nav + header search icon + FAB; desktop sidebar + composer; switch at 768 px.
2. Active nav marked with `aria-current="page"` AND a non-color indicator.
3. Route change moves focus to the view `h1` and announces `a11y.viewChanged`.
4. Per-list & search are pushed screens on mobile with working Back (scroll + focus restored).
5. All touch targets ≥ 44×44 px (FAB 56); no hover-only controls anywhere.

**B. Task rows & views (S2)**
6. Grouping exactly per the D3 matrix (Today / Next 7 / All open / Completed / per-list).
7. Row states built: default, hover, row-focus, pressed, completed (strike-through + secondary
   text), moved (600 ms highlight), error (rollback), and the 3 s write fallback behavior.
8. DueBadge copy rules (`overdue/today/tomorrow/Intl date`); overdue carries a non-color marker.
9. Priority: icon for high/medium only; distinct shapes; `aria-label` text (D4).
10. ListBadge on aggregate views + search results only.
11. Row menu contains: Edit, Move to list…, Move up, Move down (per-list; `aria-disabled` at ends),
    Delete — in that order; Delete in danger tone.
12. Day rollover recompute (D9) on `visibilitychange` + midnight timer.

**C. Composer (S3)**
13. Collapsed/expanded states; `Enter` saves and stays focused + cleared; `Shift+Enter` saves and
    collapses (D6).
14. Fields: title (1–200), notes (≤ 20,000, plain text), due date (native date + Today/Tomorrow/
    Clear chips), list select (defaults per D6/F1; "New list…" option opens ListDialog and selects
    the result), priority radiogroup (default low).
15. Invalid title → `form.error.titleRequired` inline, Save disabled, `aria-describedby` linked.
16. Zero lists → disabled composer with `composer.needsList` + `list.action.new`.
17. Dirty-close asks `confirm.discardDraft` (S7.3).

**D. Task editor (S4)**
18. Mobile full-screen sheet / desktop 560 px dialog; focus starts on title; trap + Escape + focus
    return all implemented.
19. Save = one transaction (all fields); on close focus returns to the originating/new row.
20. Dirty Cancel/Escape → S7.3; Delete → S7.1; completed tasks show `task.completedOn` and stay
    editable.
21. `editor.saving` label; failure keeps the dialog open with assertive error + Retry.

**E. Complete/uncomplete (M4)**
22. Checkbox is a native input labelled by the task title (`a11y.toggleTask`).
23. Optimistic toggle; row visible 900 ms before leaving the view (F3); `a11y.taskCompleted` /
    `a11y.taskReopened` announced at toggle time.
24. Uncomplete restores `sortOrder` position; `completedAt` cleared.

**F. Search (S5)**
25. Synchronous title+notes filter (NFKC, case-insensitive), `<mark>` highlight, ordering per D5.
26. Debounced (300 ms) `a11y.searchResults` announcement; `Escape` ×2 behavior (F8).
27. Idle hint and no-results states; results rows fully interactive; no reorder handles (D1/D5).

**G. Lists (S2/S6/M2)**
28. Create/rename/reorder/delete flows with inline validation (D10) and the 8 color swatches
    (radiogroup, decorative).
29. Delete-list dialog = S7.2 exactly: counts shown, required disposition (A: move + target select,
    disabled without a target; B: delete tasks), single transaction, announcement `a11y.listDeleted`.
30. List keyboard reorder = same keys + announcements as tasks (§8.2).

**H. Reorder (M6) — must pass the keyboard-only script first (AC-2)**
31. Per-list drag from the visible handle: ghost, insertion line, edge auto-scroll, Escape cancel,
    `a11y.taskMoved` on drop (§8.1).
32. `Alt+↑/↓` (+ `Alt+Home/End`) move one position/to edge; **focus stays on the moved row**;
    announce `a11y.taskMoved` every press; boundary no-op + `a11y.reorderBoundary` (§8.2).
33. Aggregate/search views: no handles; keys announce `a11y.reorderUnavailable`; `Move to list`
    remains available (D1/D2).
34. Desktop drag onto a sidebar list = move-to-list (§8.1) with `a11y.taskMovedToList`.
35. Move-to-list dialog = radio-list semantics (arrows + Enter), current list disabled/marked.
36. One order-key write per move; failure rolls back position + assertive toast (§8.3).

**I. Cross-cutting (binding decisions)**
37. All copy via i18n keys from §13 (en + th); zero hardcoded strings; `html[lang]` follows locale.
38. WCAG 2.2 AA: real list/checkbox semantics, heading order, landmarks, focus visibility,
    4.5:1/3:1 in BOTH themes, `prefers-reduced-motion` honored, 200% zoom reflow (§8 of
    PROJECT_ANALYSIS).
39. Every gesture in this spec has both a pointer path and a keyboard path (binding #6) — verified
    against §9.
40. Optimistic-write protocol (§5.6) on every mutation, including rollback + `a11y.saveFailed`.
41. Skeleton/empty/error states per §14 built for every screen.
42. Keyboard-only test script passes for: F1 capture, F2 edit, F3 complete, F4 delete (confirm),
    F6 delete list (disposition), F8 search, F10 keyboard reorder, F11 move to list.

---

_Sibling ownership: Epic E5 (UX Foundation) owns shell chrome, theme and final token values; Epic
E3 (Data Safety) owns the recovery/quota dialogs referenced in §14. String keys §13 and token names
§11 are the only copy/value sources; hardcoded strings are a review failure._


