# Design Spec — UX Foundation & Design System (incl. Thai typography)

Status: FINAL for handoff to implementation
Author: h_designer (kanban task t_81b0df28)
Date: 2026-10-23
Deliverable of: t_81b0df28 (Epic E5 — UX Foundation, Accessibility & i18n, from decomposition card t_1b9ee0e6)

---

## 0. Feature context (from h_pm)

- Epic: E5 UX Foundation, Accessibility & i18n.
- Source of truth for scope/constraints: PROJECT_ANALYSIS.md (sections 4 M7/M8/M15, 5.5, 7.2, 8, 9.2, §12).
- Goal of this spec: the design system the whole MVP UI hangs on — responsive mobile-first app
  shell, design tokens (light + dark), component inventory with complete state coverage,
  theme system with no-flash boot (M7), and Thai typography rules (M15, §8, §9.2).

Binding constraints (NOT re-decidable here — copied verbatim in intent from the task brief):

1. WCAG 2.2 AA is a release gate (M13): text contrast ≥ 4.5:1, UI component contrast ≥ 3:1,
   status never encoded by color alone, prefers-reduced-motion respected, touch targets ≥ 44×44
   CSS px, 200% text zoom reflow without loss (§8).
2. Zero third-party requests at runtime (§7.2): no hosted fonts, no remote icons, no CDNs.
   Everything self-hosted or system-provided.
3. Bundle budgets (§9.2): CSS ≤ 20 KB gzip; locale strings en+th ≤ 24 KB gzip total
   (ratified 2026-10-26, t_3faa5d95; 20 KB at design time), lazy
   per-locale; no webfont bytes at all (Thai uses the system font stack).
4. English is the source-of-truth locale; Thai strings are PO-validated content (§12 Q9).
5. Mobile-first responsive, one codebase, touch targets ≥ 44 px (M8).
6. Theme = light / dark / system with no-flash boot — theme read from localStorage pre-paint (M7).

How to read this document: §3 tokens and §6 component specs are normative — implementation must
match them exactly (values are copy-paste ready and contrast-verified in §12.2). §4–§5 and §7 are
normative for layout and behavior. §8–§11 are normative rules with QA checklists attached.

---

## 1. Design principles

1. Calm utility. The user opens this app dozens of times a day; density is a feature, decoration
   is not. One accent color, generous hit areas, minimal chrome.
2. Every state is designed. Any element on screen is specified in all its states (default, hover,
   focus-visible, active, disabled, loading, error) — no improvised states in code.
3. Redundant status encoding. Color never carries meaning alone: every status is icon + text
   (and color is the third, redundant channel).
4. System fonts only. Zero webfont bytes. The type system must look correct on macOS, Windows,
   iOS and Android Thai fallbacks alike (§9).
5. Spec budget. CSS ≤ 20 KB gzip means the token layer + components must stay lean: custom
   properties, no CSS framework, no unused variants.

---

## 2. Information architecture & navigation model

Single-page app, view-switching navigation (no full page loads). Views (M3):

| View | Route | Content |
|---|---|---|
| Today | `/today` (default) | Open tasks due today + overdue, grouped "Overdue" / "Today" |
| Next 7 days | `/week` | Open tasks due in the next 7 days incl. today, grouped by day |
| All open | `/all` | All open tasks, grouped by list |
| List view | `/list/:id` | Open tasks of one list, flat, manual order |
| Completed | `/completed` | Done tasks, newest completed first |
| Search | `/search` | Instant filter over title + notes (M5) |
| Settings | `/settings` | Theme, language, week start, default list, storage/backup (M14) |

Navigation rendering (this is the responsive split of the whole app):

- Below 1024 px — "compact pattern": top app bar + bottom tab bar (5 tabs: Today, Next 7,
  All open, Completed, More) + drawer (per-lists, Search, Settings) + quick-add FAB.
- 1024 px and above — "wide pattern": persistent left sidebar (all views + lists + settings
  entry) + main column + task detail panel at ≥ 1280 px.

Search is a view in both patterns (not a filter popover) so behavior, focus management and
announcements are identical everywhere.

---

## 3. Design tokens (normative)

Naming: CSS custom properties on `:root`. Category prefix + role + variant.
Implementation: `src/styles/tokens.css`. These names are the contract between this spec and code.

### 3.1 Spacing (4 px base)

| Token | Value | Use |
|---|---|---|
| `--space-0` | 0 | reset |
| `--space-1` | 4 px | icon↔label gap, chip internal |
| `--space-2` | 8 px | tight stacks, chip padding-y |
| `--space-3` | 12 px | control padding-x, row gap |
| `--space-4` | 16 px | base unit: list row padding, card padding |
| `--space-5` | 20 px | section gap (mobile) |
| `--space-6` | 24 px | section gap (desktop), dialog padding |
| `--space-8` | 32 px | large section separation |
| `--space-10` | 40 px | page header margin |
| `--space-12` | 48 px | empty state vertical rhythm |
| `--space-16` | 64 px | page-level vertical rhythm |

### 3.2 Typography

Root font-size: 16 px. All sizes in rem so browser "font size" preference and 200% zoom scale
everything (§10).

| Token | Size | Line-height | Use |
|---|---|---|---|
| `--font-display` | 1.875 rem (30 px) | 1.35 | View title, wide pattern only |
| `--font-title` | 1.5 rem (24 px) | 1.35 | View title (compact pattern), dialog title |
| `--font-h2` | 1.25 rem (20 px) | 1.4 | Group headings ("Overdue", day groups), settings sections |
| `--font-h3` | 1.125 rem (18 px) | 1.45 | Sub-section headings |
| `--font-body` | 1 rem (16 px) | 1.6 | Task titles, inputs, body text |
| `--font-body-sm` | 0.875 rem (14 px) | 1.55 | Meta text, chips, buttons, nav items |
| `--font-caption` | 0.8125 rem (13 px) | 1.5 | Timestamps, helper text, counts |

- Floor: 13 px for any rendered text (Thai included). No smaller sizes in the system.
- Line-height floor: 1.35 anywhere (Thai diacritic stacking — §9). Body copy is 1.6.
- Font weights: 400 (regular), 500 (medium — nav items, buttons, chips), 650 (semibold —
  headings, view titles). Weight 700 is not used (no system font needs it).
- Letter-spacing: 0 everywhere. Never apply letter-spacing or text-transform to Thai strings
  (§9.3). The `text-transform: uppercase` treatment is allowed on Latin-only micro-labels
  (none exist in MVP — reserved).

Font stack (single stack for both locales — the CSS font fallback resolves per-glyph):

```
--font-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans Thai",
             "Leelawadee UI", Thonburi, "Angsana New", "Cordia New", Tahoma, sans-serif;
```

Rationale: `system-ui` gives the platform Latin face; the Thai fallbacks cover Windows
(Leelawadee UI), macOS/iOS (Thonburi), Android/Linux (Noto Sans Thai), legacy Windows
(Angsana New, Cordia New, Tahoma). No webfont is loaded — ever (§7.2, §9.2).

### 3.3 Color — semantic tokens

Two themes (light/dark) resolved at runtime via `[data-theme]` on `<html>` (§5).
Contrast values below are measured (WCAG 2.x relative luminance); full verification matrix in
§12.2. Every text-on-background pair used by the system is ≥ 4.5:1; every control border and
focus ring is ≥ 3:1 against every surface it may sit on.

#### Neutral surfaces & text

| Token | Light | Dark | Use |
|---|---|---|---|
| `--color-canvas` | `#FCFCFD` | `#0F1216` | App background |
| `--color-surface` | `#FFFFFF` | `#171B21` | Panels, rows, inputs, dialog |
| `--color-surface-subtle` | `#F2F4F7` | `#20262E` | Group headers, secondary panels, hover-on-table |
| `--color-surface-hover` | `#E9EDF2` | `#293039` | Row/option hover fill |
| `--color-text` | `#1B1F27` | `#E9ECF2` | Primary text (16.5:1 / 14.6:1 on surface) |
| `--color-text-secondary` | `#5A6372` | `#A9B2BF` | Meta text, placeholders (6.1:1 / 8.1:1) |
| `--color-text-tertiary` | `#626B7B` | `#949DAB` | Timestamps, counts (5.4:1 / 6.3:1) |
| `--color-border` | `#CBD2DA` | `#333B45` | Decorative separators (NOT for control outlines) |
| `--color-border-control` | `#7D8694` | `#727C8C` | Input/control outlines (≥ 3:1 on all surfaces) |
| `--color-focus` | `#2E4FC4` | `#8EA8FF` | Focus ring (6.9:1 / 7.6:1 on surface) |

#### Accent (primary action)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--color-accent` | `#2E4FC4` | `#5B7CFA` | Primary button fill, active nav indicator |
| `--color-accent-hover` | `#2540A8` | `#6D8BFF` | Primary button hover fill |
| `--color-accent-text` | `#2B4ABF` | `#8EA8FF` | Links, accent text on surfaces (7.4:1 / 7.6:1) |
| `--color-on-accent` | `#FFFFFF` | `#0F1216` | Text on accent fill (6.9:1 / 5.1:1) |

Note: in dark theme the accent fill carries near-black ink (`--color-on-accent` = `#0F1216`),
not white — white on `#5B7CFA` is only 3.7:1 and fails. Same for danger fills.

#### Status (each = fill tint + text + icon; never color alone — §8)

| Semantic | Light text on tint | Light tint | Dark text on tint | Dark tint | Icon |
|---|---|---|---|---|---|
| danger | `#A61B14` (6.6:1) | `#FDECEA` | `#FF8A82` (7.3:1) | `#2C1A18` | `alert-circle` |
| success | `#166534` (6.3:1) | `#E7F5EC` | `#5FC98A` (7.8:1) | `#15251B` | `check-circle` |
| warning | `#7A4D00` (6.5:1) | `#FBF1D9` | `#E0B25C` (8.0:1) | `#2A2213` | `alert-triangle` |
| info | `#1D4ED8` (5.8:1) | `#E8EEFB` | `#8EA8FF` (7.0:1) | `#1A2136` | `info` |

| Token | Light | Dark | Use |
|---|---|---|---|
| `--color-danger` | `#B3261E` | `#E2564D` | Destructive button fill |
| `--color-on-danger` | `#FFFFFF` | `#0F1216` | Text on danger fill (6.5:1 / 5.1:1) |

### 3.4 Radius, elevation, borders

| Token | Value | Use |
|---|---|---|
| `--radius-xs` | 4 px | chips, small badges |
| `--radius-sm` | 6 px | inputs, buttons |
| `--radius-md` | 8 px | rows-in-group, menus, banners |
| `--radius-lg` | 12 px | dialogs, sheets, panels |
| `--radius-full` | 999 px | avatars/FAB, pill chips |

| Token | Value | Use |
|---|---|---|
| `--shadow-sm` | light: `0 1px 2px rgba(16,20,28,.08)` / dark: `0 1px 2px rgba(0,0,0,.4)` | sticky bars |
| `--shadow-md` | light: `0 4px 12px rgba(16,20,28,.10)` / dark: `0 6px 16px rgba(0,0,0,.5)` | menus, FAB |
| `--shadow-lg` | light: `0 12px 32px rgba(16,20,28,.16)` / dark: `0 16px 40px rgba(0,0,0,.6)` | dialogs, sheets |

Dark theme: elevation is primarily expressed by `--color-border` hairlines + lighter surface;
shadows are deeper and softer (above). Dialogs in dark additionally get a 1 px
`--color-border` outline.

### 3.5 Motion

| Token | Value | Use |
|---|---|---|
| `--dur-fast` | 120 ms | hover/press feedback, focus ring, chips |
| `--dur-base` | 180 ms | row expand/collapse, menu open, toast in |
| `--dur-slow` | 260 ms | dialog/sheet enter/exit, drawer slide |
| `--ease-standard` | `cubic-bezier(0.2, 0, 0.2, 1)` | everything by default |
| `--ease-emphasized` | `cubic-bezier(0.2, 0, 0, 1)` | dialogs, sheets, drawer |

Reduced motion (normative): under `prefers-reduced-motion: reduce`, all durations collapse to
1 ms and all transforms/animations are disabled; only instant state changes remain. No
information may be conveyed by motion alone. (Full rules in §10.)

### 3.6 Layout & z-index

| Token | Value | Use |
|---|---|---|
| `--layout-sidebar` | 256 px | persistent sidebar width (≥ 1024) |
| `--layout-detail` | 320 px | detail panel width (≥ 1280) |
| `--layout-content-max` | 720 px | main content column max width |
| `--layout-app-max` | 1440 px | app shell max width (xl) |
| `--touch-min` | 44 px | minimum interactive target (both dimensions) |
| `--appbar-h` | 56 px | top app bar (compact pattern) |
| `--tabbar-h` | 56 px | bottom tab bar (compact pattern) |

| Token | Value | Layer |
|---|---|---|
| `--z-base` | 0 | content |
| `--z-sticky` | 100 | sticky headers, tab bar |
| `--z-drawer` | 200 | nav drawer |
| `--z-scrim` | 300 | dialog/sheet backdrop |
| `--z-dialog` | 400 | dialog, bottom sheet |
| `--z-toast` | 500 | toasts |

Breakpoints (mobile-first; min-width media queries):

| Name | Range | Pattern |
|---|---|---|
| base | 320–767 px | compact |
| md | 768–1023 px | compact (wider gutters, 2-col settings) |
| lg | 1024–1439 px | wide: sidebar + main |
| xl | ≥ 1440 px | wide + detail panel always visible; app max 1440 centered |

---

## 4. App shell & screen specs

### 4.1 Shell anatomy

Compact pattern (< 1024 px):

```
┌──────────────────────────────┐
│ Top app bar (56px, sticky)   │  [menu btn] View title        [search btn]
├──────────────────────────────┤
│                              │
│  Main (scrolls)              │  ← view content (§4.3–4.8)
│                              │
│                        (FAB) │  quick add, 56px circle, 16px inset
├──────────────────────────────┤
│ Bottom tab bar (56px, fixed) │  Today | Next 7 | All open | Completed | More
└──────────────────────────────┘
```

- "More" opens a left drawer (max-width 320 px, scrim behind): Search, Lists (per-list items +
  "New list"), Settings. Drawer traps focus, Esc closes, focus returns to the "More" button.
- FAB: `+` icon button, aria-label "Add task"; opens the task composer as a bottom sheet.
- Safe-area insets respected (`env(safe-area-inset-bottom)`) on the tab bar and FAB.

Wide pattern (≥ 1024 px):

```
┌────────────┬─────────────────────────────────────┬───────────┐
│ Sidebar    │ Main (content column, max 720px)     │ Detail    │
│ 256px      │                                     │ 320px     │
│            │  Header: title + count [+ Add task]  │ (≥1280px) │
│ Search     │  Composer (inline, collapsible)      │           │
│ Views      │  Task list (grouped)                 │           │
│  Today     │                                     │           │
│  Next 7    │                                     │           │
│  All open  │                                     │           │
│  Completed │                                     │           │
│ Lists      │                                     │           │
│  + New list│                                     │           │
│ ─────────  │                                     │           │
│ Settings   │                                     │           │
└────────────┴─────────────────────────────────────┴───────────┘
```

- Sidebar is fixed; main scrolls. Below 1280 px the detail panel opens as an overlay dialog
  (right sheet on md, centered dialog on base).
- Composer is always reachable without scrolling: it sits directly under the view header.

Landmarks (both patterns): one `<header>` (app bar or sidebar header), one `<nav>` (primary
navigation), one `<main>`, optional `<aside>` (detail panel). A skip link ("Skip to tasks") is
the first focusable element on the page and jumps to the task list.

Heading hierarchy: h1 = view title (one per screen), h2 = group headings ("Overdue", day/list
groups, settings sections), h3 = sub-groups. No skipped levels.

Focus management on view change: move focus to the view's h1 (`tabindex="-1"`), announce the
view name via the polite live region ("Today, 12 open tasks"). This is the SPA route-change
contract.

### 4.2 Global chrome states

| Chrome element | States |
|---|---|
| Sidebar nav item | default (secondary text), hover (surface-hover), focus-visible (ring), active/current page (accent-text + 3px accent left bar in sidebar / accent icon+label in tab bar; `aria-current="page"`), disabled (n/a — never disabled) |
| Tab bar item | default, hover, focus-visible, active (accent + filled icon variant + `aria-current`), pressed (120 ms fill) |
| FAB | default, hover (accent-hover fill), focus-visible, pressed (scale 0.96, 120 ms), disabled (rare: when a blocking dialog is open), loading (spinner replaces icon) |

### 4.3 Screen: Today (`/today`)

- Purpose: what today owes the user, plus anything overdue (P1 JTBD "see what today owes me").
- Layout: header (h1 "Today", meta "N open · M overdue", primary "Add task"), composer, two
  groups: **Overdue** (h2, warning icon + count) then **Today** (h2).
- Task rows: §6 TaskRow. Overdue rows show the overdue chip (icon + "Overdue" + date).
- Interactions: toggle complete (optimistic, §6 Checkbox), row title → detail panel/dialog,
  row menu → edit / move / delete / reorder (keyboard equivalents — §11.3).
- Empty state (no tasks today): illustration-free — check icon, heading "Nothing due today",
  body "Enjoy the clear space, or add something.", primary action "Add task".
- Edge cases: loading (3 skeleton rows, shimmer disabled under reduced-motion), load error
  (Banner danger + "Retry"), storage eviction warning (Banner warning — §4.9).

### 4.4 Screen: Next 7 days (`/week`)

- Header: h1 "Next 7 days", meta "N open". Group headings per day: "Today", "Tomorrow",
  then weekday + date (localized via `Intl.DateTimeFormat` with the active locale).
- Groups with zero tasks are hidden; if all empty → empty state ("Nothing in the next 7 days").
- Behaviors identical to Today.

### 4.5 Screen: All open (`/all`)

- Header: h1 "All open", meta "N open". Grouped by list (h2 = list name, count).
- List name in group header is a button navigating to the list view.
- Empty state: "No open tasks" + "Add task".

### 4.6 Screen: List view (`/list/:id`)

- Header: h1 = list name (click-to-rename via dialog — M2), meta "N open", row menu
  (Rename list / Delete list / Move list up / Move list down).
- Rows in manual order (M6): drag handle appears on hover/focus at row start in this view only.
  Drag is pointer-only enhancement; the row menu always carries "Move up" / "Move down" /
  "Move to list…" (keyboard equivalent, announced — §11.3).
- Delete list dialog: task disposition choice (radio group: "Move tasks to: [list select]" /
  "Delete tasks too") — destructive, danger button.
- Empty state: "This list is empty" + "Add task".

### 4.7 Screen: Completed (`/completed`)

- Header: h1 "Completed", meta "N tasks". Flat list sorted by completedAt desc; rows show
  completion date chip. Completed rows are dimmed but remain fully legible (text-secondary
  minimum, contrast still ≥ 4.5:1).
- Row menu: "Reopen" (primary), "Delete". No drag.
- Empty state: "Nothing completed yet".

### 4.8 Screen: Search (`/search`)

- Header: h1 "Search". Input (autofocus on view entry) with clear button; placeholder
  "Search tasks…".
- Instant filter over title + notes (M5), debounce 150 ms. Results use TaskRow under an h2
  "Results"; result count announced politely ("12 results") after each debounce.
- Empty query state: "Search your tasks" helper text. No-results state: "No matches for
  “{query}”" + "Clear search" action.
- Edge case: 10,000+ tasks — results virtualize beyond 200 rows (§9.1 budget, perf note).

### 4.9 Screen: Settings (`/settings`)

Sections (h2 each; single column on compact, two columns ≥ 768 px):

1. **Appearance** — theme radio group (Light / Dark / System) as a segmented control
   (role="radiogroup"; §6 Select/Segmented). Immediate apply, persisted to
   `localStorage['app.theme']` (§5).
2. **Language** — radio group (English / ไทย). Switching sets `document.documentElement.lang`,
   switches the screen-reader language (§9.4), lazily loads the locale (§9.2 budget).
3. **Tasks** — week start (Mon / Sun), default list (select).
4. **Storage & backup** — quota bar (§6), persistence status ("Persistent storage: granted /
   not granted"), last backup timestamp ("Last backup: …" / "Never"), buttons: Export JSON,
   Import JSON, "Delete all data" (danger, confirm dialog with typed confirmation is NOT
   required — a two-step confirm dialog suffices).
5. **About** — app version, licenses entry.

Banners (system-level, appear above main content, full content-column width):

| Banner | Severity | Trigger | Dismissal |
|---|---|---|---|
| Storage eviction warning | warning | first run after long absence / shrunken storage detected (§5.5) | dismiss persisted in localStorage (§5.2) |
| Backup nudge | info | `lastBackupAt` older than 14 days | dismiss persisted; re-arms after next nudge window |
| Quota ≥ 80% | warning | `storage.estimate()` | persistent until resolved |
| Private-browsing warning | warning | ephemeral storage detected (E10) | session-only dismiss |
| Update available | info | SW update ready (M9/E9) | action "Refresh" applies on user action; never auto-reload |
| Save/data error | danger | write failure, quarantine on boot (E3/E4) | persistent; action "Export recovery file" / "Retry" |

---

## 5. Theme system (M7)

### 5.1 Behavior

- Three settings: `light`, `dark`, `system` (default `system`).
- `system` tracks `prefers-color-scheme` live (matchMedia listener) and updates the theme without
  reload.
- Storage: `localStorage['app.theme'] ∈ 'light' | 'dark' | 'system'` (absent = `system`).
  localStorage is chosen because the read must be synchronous and pre-paint (§5.2 of the analysis:
  "Boot-critical prefs only").
- The resolved theme is expressed as `<html data-theme="light|dark">` plus
  `style.color-scheme = 'light' | 'dark'` (so native controls — scrollbars, form controls —
  follow), and `<meta name="color-scheme" content="light dark">` in the document head.

### 5.2 No-flash boot (normative)

A tiny inline script MUST run in `<head>`, after the `<meta name="color-scheme">` and before any
stylesheet paint, applying the stored theme to `<html>` before first paint. No flash of the wrong
theme is acceptable (M7). Reference implementation (allowed as the single hashed inline script
per §7.2 CSP note — hash it in the CSP meta):

```html
<script>
(function () {
  try {
    var t = localStorage.getItem('app.theme');            // 'light' | 'dark' | 'system' | null
    var dark = t === 'dark' ||
      ((t === null || t === 'system') &&
       window.matchMedia('(prefers-color-scheme: dark)').matches);
    var el = document.documentElement;
    el.setAttribute('data-theme', dark ? 'dark' : 'light');
    el.style.colorScheme = dark ? 'dark' : 'light';
  } catch (e) { /* private mode: fall back to system via CSS default */ }
})();
</script>
```

Failure semantics: if localStorage throws (private mode), the app must still paint using the
`prefers-color-scheme` CSS defaults (`:root` light + `@media (prefers-color-scheme: dark)`), and
the theme control in Settings still works for the session.

### 5.3 Theme switching (runtime)

- Changing the theme in Settings writes localStorage, updates `data-theme` + `color-scheme`
  instantly, and announces politely ("Dark theme applied") — the only audible side effect.
- No component may hard-code colors; everything reads the tokens in §3.3.

---

## 6. Component inventory (normative)

Conventions for every component:
- States listed exhaustively; a state marked n/a is documented as intentionally absent.
- Focus ring everywhere: `outline: 3px solid var(--color-focus); outline-offset: 2px;` applied
  on `:focus-visible` only (never remove it; never replace with color-only change).
- All interactive targets ≥ 44×44 CSS px (visual size may be smaller; padding provides the
  hit area).
- Icon-only controls always carry an accessible name (`aria-label`).

### 6.1 Button

Anatomy: icon slot (optional, leading) + label.
API:

```ts
interface ButtonProps {
  variant: 'primary' | 'secondary' | 'ghost' | 'danger';
  size: 'sm' | 'md';            // sm: 36px visual / 44px hit; md: 44px visual
  icon?: IconName;              // leading icon slot
  loading?: boolean;            // replaces icon with spinner, disables input, keeps width
  disabled?: boolean;
  type?: 'button' | 'submit';   // default 'button' — never implicit submit
}
```

| State | Spec |
|---|---|
| default | primary: `--color-accent` fill, `--color-on-accent` text, radius-sm; secondary: surface fill + `--color-border-control` 1px outline + text-primary; ghost: transparent + text-secondary; danger: `--color-danger` fill + `--color-on-danger` |
| hover | primary/danger → hover fill token; secondary → surface-hover fill; ghost → surface-hover + text-primary. 120 ms |
| focus-visible | ring (above), no other change |
| active | fill darkens one step (or `filter: brightness(0.95)` in dark); 120 ms |
| disabled | opacity 0.5 on fill + text-secondary text; `cursor: not-allowed`; no hover change; excluded from tab order is FORBIDDEN — keep focusable and use `disabled` attr semantics (announced) |
| loading | spinner (16px) replaces icon; label stays (layout must not shift); `aria-busy="true"`; clicks ignored |
| error | n/a at button level (errors render as Banner/Toast/dialog inline text) |

A11y: `<button>` element always (never a div). Accessible name = visible label (icon-only →
`aria-label`). Space/Enter activate. Busy state announced via `aria-busy`.

### 6.2 IconButton

API: `{ icon: IconName; label: string /* required, becomes aria-label */; size: 'sm'|'md'; variant: 'ghost'|'secondary' }`.
States as Button. Hit area ≥ 44 px via padding regardless of icon size (18/20/24 px icons).
Examples: search, menu (hamburger), row overflow (kebab), FAB (`+`), dialog close (×).

### 6.3 TextInput / Textarea

Anatomy: label (always visible — placeholders are never the only label), optional hint, optional
error message, control.

```ts
interface TextInputProps {
  label: string;
  hint?: string;
  error?: string;            // sets aria-invalid + describedby
  required?: boolean;
  multiline?: boolean;       // textarea variant: auto-grow to 6 rows, then scroll
}
```

| State | Spec |
|---|---|
| default | surface fill, 1px `--color-border-control`, radius-sm, padding 12px, font-body |
| hover | border → text-secondary |
| focus-visible | border → accent + focus ring |
| active/editing | as focus; caret accent |
| disabled | surface-subtle fill, text-secondary, border `--color-border`, no hover |
| error | border `--color-danger` 1.5px + error text below (danger-text with alert icon) |
| loading | n/a (fields never block on network); use adjacent async button instead |

A11y: `<label for>` binding; `aria-describedby` = hint + error ids; `aria-invalid="true"` when
error; error text rendered in a live region (polite) so it is announced when it appears;
`required` uses native `required` + visible "required" affordance in the label (asterisk +
screen-reader "required" text — asterisk alone is color/shape-only, so the SR text is the
accessible channel).

### 6.4 Checkbox (task completion)

Visual: 22 px box (radius-xs), check icon when checked; whole row area ≥ 44 px hit.
States: default (border-control), hover (border accent + surface-hover fill), focus-visible
(ring), checked (accent fill + white check icon), checked-hover, disabled (opacity 0.5),
indeterminate n/a, error n/a.
A11y: native `<input type="checkbox">` + `<label>`; the label is the task title ("Complete
‘Buy milk’" as the accessible name pattern: `aria-label` = "Mark ‘{title}’ complete" /
"Mark ‘{title}’ not complete" — state flips the label). Toggling announces via live region
(§11.2) and is optimistic (M4): UI flips immediately; failure reverts and shows an error Toast.

### 6.5 Segmented control / radio group (theme, language, week start)

Role: `radiogroup` with `role="radio"` items (or native radios visually restyled — native
preferred). Arrow keys move + select; Tab enters/exits the group as one stop.
States per item: default, hover, focus-visible, selected (accent-text + 2px accent underline or
fill-subtle + check icon — never color alone: selected also gets a check icon or filled
indicator), disabled.
Announcement: selection change announced politely ("Theme: Dark").

### 6.6 Select (default list, move-to-list)

Native `<select>` restyled minimally (system affordances kept — better for Thai fonts and
platform a11y). States: default, hover, focus-visible, disabled, error (same contract as
TextInput). Options show list name + open count. On iOS/Android the native picker is used.

### 6.7 TaskRow (list row)

Anatomy: `[checkbox 44] [title + meta chips] [spacer] [kebab menu 44]`, min-height 56 px,
padding 12px 16px, hairline `--color-border` separator.

```ts
interface TaskRowProps {
  task: Task;                  // title, notes?, dueDate?, priority, status, listName
  variant: 'default' | 'completed' | 'overdue';
  showListName?: boolean;      // true in Today/Week/Search/Completed groups
  dragHandle?: boolean;        // list view only
}
```

| State | Spec |
|---|---|
| default | surface; title font-body text-primary; chips font-body-sm |
| hover | surface-hover fill (120 ms) |
| focus-visible | ring on the focused child (checkbox / title button / kebab) |
| pressed/active | surface-hover (darker step) |
| completed | title text-secondary + strike-through; checkbox checked; chips muted but ≥ 4.5:1 |
| overdue | due chip becomes danger chip: alert icon + "Overdue" + date (icon+text — never color alone) |
| disabled | n/a (rows are never disabled) |
| loading | n/a (optimistic model); skeleton rows at list level instead |
| error | optimistic-failure: row reverts + danger Toast; row itself gets a danger hairline for 2 s |

Meta chips per row: due date chip (calendar icon + localized date; "Today"/"Tomorrow" wording),
priority chip (flag icon + High/Medium/Low text; Low may omit chip), list name chip
(showListName), notes indicator (file-text icon + aria-label "Has notes").

A11y: semantic `<ul>/<li>` list. Row internals are three focusable stops: checkbox, title
button (opens detail), kebab menu. Title button accessible name = task title; menu button =
"Actions for ‘{title}’". Never make the whole row a click target with nested buttons (fake
listbox semantics are forbidden — the row is a list item, not an option).

Kebab menu (role="menu"): Edit, Move to list…, Move up, Move down (list view), Delete (danger
item). Menu: focus trap within, Esc closes + returns focus to kebab, arrow-key navigation,
first item focused on open.

### 6.8 TaskComposer (quick add)

Compact: FAB opens bottom sheet with the same fields as the inline composer.
Inline (wide pattern): input "Add task…" + collapsed "details" expander (list select, due date,
priority select) + submit button (primary) + Enter-to-submit.
States: default, focus-visible (ring), submitting (button loading, input disabled ≤ 300 ms),
error (inline error text + input kept + typed text never discarded), empty-title submit (inline
error "Title required", input gets focus + `aria-invalid`).
A11y: form with real `<label>` "Task title"; on success announce "Task added: {title}" (polite)
and keep composer focused for rapid capture (P1 JTBD: capture in under 5 seconds).

### 6.9 Dialog (modal, incl. confirm)

Sizes: `sm` (400 px) for confirms; `md` (520 px) for task detail/edit; full-width bottom sheet
in compact pattern (radius-lg top corners, drag indicator is decorative only — closing is via
close button / Esc / scrim tap).

| State | Spec |
|---|---|
| default | surface, radius-lg, shadow-lg, padding 24px; scrim `rgba(15,18,22,.5)` light / `.65` dark |
| hover/active/focus | inner controls follow their own specs |
| disabled | n/a |
| loading | body replaced by skeleton; buttons disabled with loading labels ("Saving…") |
| error | inline error Banner inside the dialog (danger); dialog stays open; inputs preserved |

A11y (normative): `role="dialog"` + `aria-modal="true"` + `aria-labelledby` (title) +
`aria-describedby` (body); focus moves into the dialog on open (first focusable, or the safe
primary action for destructive confirms); focus trap (Tab cycles within); Esc closes; on close,
focus returns to the invoking control; background content `inert`/`aria-hidden`. Confirm dialogs
state the consequence in the body ("This deletes 3 tasks. This can't be undone." — MVP has no
undo; S7 adds undo).

### 6.10 Toast

Placement: bottom-center (compact) / bottom-right (wide), above tab bar/FAB, `--z-toast`.
Max 3 visible (older ones drop), width ≤ 360 px.

| State | Spec |
|---|---|
| default | surface + 1px border + shadow-md; icon + message + optional action |
| success | check-circle icon (success tint) — auto-dismiss 5 s |
| info | info icon — auto-dismiss 7 s |
| warning | alert-triangle — auto-dismiss 7 s |
| danger | alert-circle — persistent until dismissed (× button) |
| hover/focus | auto-dismiss pauses |
| loading | n/a (toasts report, they never spin) |

A11y: container is a live region: `role="status"` (polite) for success/info/warning,
`role="alert"` (assertive) for danger; message text is the announcement; action buttons are
normal buttons inside the toast (reachable by keyboard — toast container is not a focus trap;
Tab can enter it). Toasts never carry the only copy of critical information (errors also appear
inline near the failed action).

### 6.11 Banner (inline alert)

Full content-column width, radius-md, padding 16 px, icon + message + actions + dismiss (×).

Severities: info / success / warning / danger (tint background + status text + icon, per §3.3).
States: default, hover (on actions), focus-visible (on actions/dismiss), dismissed (removed;
persistence per §4.9 table), loading n/a (actions show their own loading state).
A11y: `role="status"` for info/success (polite), `role="alert"` for danger/warning when it
appears without user action; dismiss button labeled "Dismiss"; banners that are the result of a
user action use polite.

### 6.12 Chip / Badge

Radius-full (pill) or radius-xs; padding 2px 8px; font-body-sm; icon 14 px + text.
Variants: neutral (surface-subtle + text-secondary), accent, and the four status tints.
States: default, hover (interactive chips only: e.g. filter chips — none in MVP), focus-visible
(interactive chips), disabled n/a, loading n/a.
Rule: chips always include text; icons supplement but never replace text for status.

### 6.13 EmptyState

Icon (32 px, text-secondary) + heading (h2, font-h3) + body (text-secondary) + optional primary
action. Vertical rhythm `--space-12`. No illustrations (bundle budget; §1). Always inside the
content column, left-aligned on compact, centered on wide.

### 6.14 Skeleton / loading

List-level: 3 skeleton rows (mimic row layout: 44 px box + 2 bars). Static tint (surface-subtle);
a 1.2 s opacity pulse is allowed only when `prefers-reduced-motion` is not set. Skeletons are
`aria-hidden` — the live region announces "Loading tasks" instead (polite).

### 6.15 Quota bar (storage)

Track (surface-subtle, 8 px, radius-full) + fill (accent < 80% / warning 80–95% / danger > 95%)
+ always-visible numeric label ("2.1 MB of 50 MB used") — the number is the accessible value;
`role="progressbar"` with `aria-valuenow/min/max` + `aria-valuetext` ("4% of quota used").
Fill color is redundant with the numeric label (never color alone).

### 6.16 Icons

Inline SVG sprite bundled in the app shell (zero remote icons — §7.2). Stroke style, 24×24 grid,
1.75 px stroke, round caps. Set needed for MVP: menu, search, plus, check, check-circle,
alert-circle, alert-triangle, info, calendar, flag, file-text, more-vertical (kebab), x (close),
trash, edit, chevron-right, chevron-down, folder (lists), sun, moon, monitor (system theme),
download (export), upload (import), database (storage). Every icon-only use needs an
`aria-label` on the control (icons themselves `aria-hidden="true"`).

---

## 7. Task detail panel (wide ≥ 1280) / dialog (below)

Fields: title (TextInput), notes (Textarea, plain text — §12 Q13), list (Select), due date
(date input, native picker), priority (Segmented: High/Medium/Low), status toggle, meta line
("Created … · Updated …"), actions: Save (primary), Delete (danger, ghost variant), Close.
Autosave is out of scope for MVP design: explicit Save button, dirty-state guard on close
("Discard changes?" confirm if dirty). Error state: inline danger Banner + preserved input.

---

## 8. Status communication rules (never color alone)

| Meaning | Channels required (all of them) |
|---|---|
| Task completed | check icon + checkbox state + strike-through + muted text + live announcement |
| Task overdue | alert icon + text "Overdue" + date + danger tint + announcement on view entry |
| Priority level | flag icon + text High/Medium/Low + (tint for High only) |
| Form error | alert icon + error text + `aria-invalid` + border change + live announcement |
| Destructive action | danger button + consequence copy in dialog body + confirm step |
| Storage pressure | alert icon + numeric quota label + tint + banner copy |
| Current nav page | accent + `aria-current="page"` + filled icon variant (compact) / 3 px bar (sidebar) |

---

## 9. Thai typography & i18n rendering (M15, §8, §9.2)

### 9.1 Font rendering

- Thai renders through the shared `--font-sans` stack (§3.2). **No webfont bytes are ever
  downloaded** (binding: §7.2, §9.2) — Thai coverage comes from the OS.
- Platform QA targets (per §9.4 browser floor): Windows 10/11 (Leelawadee UI fallback),
  macOS (Thonburi), iOS Safari ≥ 16.4 (system Thai fallback), Android Chrome ≥ 110
  (Noto Sans Thai), Linux (Noto Sans Thai if present; otherwise the distro default — the
  layout must not depend on which Thai face renders).

### 9.2 Line-height & diacritic stacking

- Thai vowels/tone marks stack above and below base consonants (up to 2 marks). The type scale
  line-heights (§3.2) are the minimums that keep stacked marks from clipping into neighboring
  lines: body 1.6, body-sm 1.55, headings ≥ 1.35.
- **Never** set `line-height` below 1.35 in any component, and never use unitless < 1.4 for
  multi-line text. Single-line inputs still use line-height 1.5 with padding providing the
  extra room (Thai descenders/marks must not clip inside input boxes — verify in QA).
- Paragraph spacing: `--space-3` minimum between wrapped lines' blocks; notes field line-height
  1.6.
- `overflow: hidden` + line-clamp (task titles: 2 lines clamp) must reserve full line box
  height so tone marks on the clipped line never clip mid-glyph.

### 9.3 Spacing, casing, wrapping

- `letter-spacing: 0` for all text. Thai has no word spacing conventions we can assume; spaced-out
  Thai is broken Thai.
- `text-transform` never applied to localized strings (Thai has no case; it is a no-op at best).
- Long unbroken Thai strings: `overflow-wrap: break-word; word-break: break-word;` on titles,
  notes, list names, chips and buttons (labels must wrap or truncate, never overflow).
  `hyphens: none`.
- Truncation: single-line truncation uses ellipsis only where the full value is available
  elsewhere (row title → detail panel; list name in chip → list view). Chips keep text
  ("Overdue") visible always — status text must never be the truncated part.

### 9.4 Locale mechanics affecting rendering

- `document.documentElement.lang` is `en` or `th` and updates on language switch (M15) — this
  also switches screen-reader pronunciation; announce "Language changed to ไทย" after switching.
- Dates/numbers: `Intl.DateTimeFormat` / `Intl.NumberFormat` with the active locale. Thai
  Buddhist-era dates: format with `locale: 'th-TH-u-ca-buddhist'` for Thai, Gregorian for
  English (this is a formatter choice, not extra strings).
- Locale strings budget (§9.2): en + th ≤ 24 KB gzip (ratified 2026-10-26, t_3faa5d95; 20 KB at
  design time), lazy per-locale load. Layout must tolerate
  Thai strings being ~1.3–2× the English width/height without clipping (buttons: min-width not
  fixed-width; nav labels wrap to 2 lines max in sidebar).

### 9.5 Zoom & reflow (binding: 200% zoom reflow safe)

- All type in rem; no px-based text; no fixed heights on text containers (min-height only).
- QA gates: (a) browser text-size 200% (root effectively 32 px): no clipping, no overlap, no
  horizontal scrolling of the app shell; (b) 320 px viewport width with no zoom: same; (c) the
  combination at 200% on a 1280 px viewport remains operable (WCAG 1.4.4 / 1.4.10 style reflow —
  the binding bar is 200%, we test 400% reflow opportunistically).
- Fixed-format UI (tab bar, chips) may grow vertically; the tab bar labels may hide below 360 px
  width (icons keep accessible names) — the only allowed hide-label case.

---

## 10. Motion & interaction feedback rules

1. Motion is feedback, never information. Any animation that conveys state must be redundant
   with an icon/text/state change (§8).
2. Only the tokens in §3.5 are used (120/180/260 ms, the two easings). No spring/bounce.
3. `prefers-reduced-motion: reduce` (normative): `*, *::before, *::after {
   animation-duration: 1ms !important; transition-duration: 1ms !important;
   scroll-behavior: auto !important; }` plus no transform-based motion (FAB press scale becomes
   a fill change; drawer/dialog appear without slide; skeleton pulse off; smooth scrolling off).
4. Optimistic UI (M4) is instant state change + confirmation announcement, not animation.
5. Autoplaying/looping animation is forbidden (battery, attention, WCAG 2.2.2 style concerns).

---

## 11. Accessibility conformance notes (WCAG 2.2 AA — release gate)

### 11.1 Structure & keyboard

- Landmarks + heading hierarchy per §4.1; skip link first in tab order.
- Full keyboard operability of every task/list/view operation (M6, §8): the complete keyboard
  map is Tab/Shift-Tab (traverse), Enter/Space (activate), Esc (close/return), arrow keys
  (radio groups, menus), and the row-menu keyboard reorder commands (Move up / Move down /
  Move to list…). No keyboard trap anywhere except intentional dialog/menu focus traps
  (always escapable via Esc).
- Focus visibility: the §6 focus ring on every focusable control; never `outline: none`.
- Target size: every interactive control ≥ 44×44 CSS px hit area (M8) — including checkbox,
  kebab, dismiss buttons, chips-with-actions.

### 11.2 Live-region inventory (normative — where announcements fire)

| Event | Region | Politeness | Message pattern |
|---|---|---|---|
| View change (SPA route) | global polite region | polite | "Today, 12 open tasks" |
| Task created | global polite region | polite | "Task added: {title}" |
| Task completed / reopened | global polite region | polite | "Task completed" / "Task reopened" |
| Task deleted | global polite region | polite | "Task deleted: {title}" |
| Task moved to list | global polite region | polite | "Task moved to {list}" |
| Task reordered | global polite region | polite | "Moved to position {n} of {m}" |
| Save/write failure | global assertive region | assertive | "Couldn't save changes. Your input is kept." |
| Search results (debounced) | global polite region | polite | "{n} results" / "No results" |
| Theme changed | global polite region | polite | "{Dark/Light/System} theme applied" |
| Language changed | global polite region | polite | "Language changed to {language}" |
| Toast shown | toast container (role=status/alert) | per severity | toast message |
| Banner appears without user action | banner (role=alert for danger/warning) | assertive for danger/warning | banner copy |

Implementation contract: ONE persistent global polite region + ONE assertive region mounted in
the shell at all times (content swapped per announcement). Toasts are their own live regions.
Never re-render the whole region node (it must stay mounted to be announced).

### 11.3 Drag & drop (M6) — keyboard equivalence

Pointer drag is enhancement only. Required equivalents (in row menu and list header menu):
"Move up", "Move down", "Move to list…" (select). Each action announces its result ("Moved to
position 2 of 8"). Drop targets are indicated by a 2 px accent line + gap (not color alone —
the row order itself is the state).

### 11.4 Known constraints (accepted)

- Thai screen-reader voice availability varies (§8): QA validates with NVDA (Windows) and
  VoiceOver (macOS/iOS); where a Thai voice is unavailable, `lang="th"` is still set correctly
  and English UI strings remain announced in the English voice. This is a documented QA
  constraint, not a design defect.

---

## 12. Appendices

### 12.1 Tokens file contract

`src/styles/tokens.css` exposes exactly the custom properties in §3 as `:root` (light) +
`[data-theme='dark']` overrides for color tokens only. Sizes/radii/motion/z tokens are
theme-independent. Colors are the ONLY theme-varying values — no layout or type differences
between themes.

### 12.2 Contrast verification (measured 2026-10-23)

Method: WCAG 2.x relative luminance, sRGB. All 99 token background/foreground pairs exercised
by this spec were checked; representative values (ratio: 1):

Light: text/surface 16.5 · secondary/surface 6.1 · tertiary/surface 5.4 · tertiary/surface-hover 4.6 ·
accent-text/surface 7.4 · white/accent 6.9 · white/danger 6.5 · border-control/surface 3.7 ·
border-control/surface-subtle 3.3 · focus/surface 6.9 · danger-text/danger-bg 6.6 ·
success-text/success-bg 6.3 · warning-text/warning-bg 6.5 · info-text/info-bg 5.8.

Dark: text/surface 14.6 · secondary/surface 8.1 · tertiary/surface 6.3 · tertiary/surface-hover 4.9 ·
accent-text/surface 7.6 · ink/accent 5.1 · ink/danger 5.1 · border-control/surface 4.1 ·
border-control/surface-hover 3.2 · focus/surface 7.6 · danger-text/danger-bg 7.3 ·
success-text/success-bg 7.8 · warning-text/warning-bg 8.0 · info-text/info-bg 7.0.

Every pair meets its bar (4.5:1 text, 3:1 UI). Do not tweak these hex values without
re-running the check.

### 12.3 Handoff — what implementation cards must build

Constraints that apply to ALL of these cards: WCAG 2.2 AA release gate (§11), zero third-party
runtime requests (§7.2), CSS ≤ 20 KB gzip total (§9.2), locale strings ≤ 24 KB gzip (§9.2,
ratified 2026-10-26, t_3faa5d95),
no webfonts (§9.1), touch targets ≥ 44 px (§6), reduced-motion (§10).

1. **Design tokens + base styles** — `tokens.css` exactly per §3 (values are copy-paste ready),
   reset, typography base incl. Thai-safe line-heights and wrapping rules (§9.2–9.3).
   → h_junior_coder.
2. **Theme system** — no-flash boot snippet (§5.2, hashed inline script + CSP meta hash),
   `data-theme`/`color-scheme` switching, `prefers-color-scheme` live tracking, Settings
   segmented control (§4.9), theme-change announcement (§11.2). → h_junior_coder.
3. **App shell + responsive navigation** — compact pattern (<1024: app bar, tab bar, drawer,
   FAB) and wide pattern (≥1024: sidebar; ≥1280: detail panel), landmarks, skip link,
   route-change focus + announcement contract (§4.1). → h_senior_coder (router integration) +
   h_junior_coder.
4. **Core controls** — Button, IconButton, TextInput/Textarea, Checkbox, Segmented, Select,
   Chip, Menu (§6.1–6.6, 6.12) with the full state matrix and focus-ring contract.
   → h_junior_coder.
5. **Task list components** — TaskRow (3 variants), TaskComposer (inline + sheet), group
   headers, EmptyState, Skeleton rows (§6.7, 6.8, 6.13, 6.14), optimistic complete + failure
   revert. → h_junior_coder.
6. **Overlays** — Dialog (focus trap, Esc, focus return, `inert` background), Toast system with
   the two live-region containers + global announcer (§11.2), Banner with dismissal persistence
   (§4.9, 6.9–6.11). → h_junior_coder.
7. **Search + Settings screens** — §4.8, §4.9 incl. quota bar (§6.15) and the storage/backup
   panel wiring points. → h_junior_coder.
8. **i18n runtime** — `lang` switching incl. screen-reader language, per-locale lazy load
   within the §9.2 gzip budget (24 KB, ratified 2026-10-26, t_3faa5d95), `Intl` date/number formatting incl. Thai Buddhist-era dates
   (§9.4). → h_senior_coder (M15 card).
9. **A11y + Thai QA gate** — axe-core CI checks, keyboard-only test script (10 core flows),
   Thai diacritic/200%-zoom test script (§9.5), NVDA + VoiceOver manual pass checklist.
   → h_reviewer (gate) with h_junior_coder fixing findings.
10. **Icons sprite** — the §6.16 icon set as an inline SVG sprite bundled in the shell.

### 12.4 Open questions (for h_pm)

- [ ] Non-blocking: the product has no name/wordmark in PROJECT_ANALYSIS. The shell header and
  sidebar use a placeholder wordmark ("Todo") until h_pm supplies the product name; no other
  decision in this spec depends on it.
- No blocking questions — every binding decision was supplied in the task brief (WCAG bars,
  no-third-party, bundle budgets, en+th locales, theme no-flash boot) and all other design
  decisions are owned and made in this document (nav pattern split at 1024, focus-ring spec,
  dark-theme ink-on-fill, one shared font stack).
