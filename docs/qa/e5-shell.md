# E5 QA — App shell, theme & settings

Task: t_46150118 (Test, child of impl t_afe9bb56) · Reviewer: h_reviewer · Date: 2026-10-23
Scope: responsive shell (M8), no-flash theme boot (M7), minimal settings (M14)
Specs: PROJECT_ANALYSIS §4 (M7/M8/M14), §8, §10 · docs/design/ux-foundation.md §3.6, §4, §5, §6.9, §10, §11, §12.2 · docs/adr/ADR-002 (Decision 3.4, Decision 7)

## Verdict

PASS with 4 minor defects and 3 info findings (none blocking). The headline requirement —
**theme boot is genuinely flash-free** — is verified: see the explicit statement in §1 below.

Evidence: `docs/qa/e5-shell-logs/` (raw probe JSON, screenshots, and the probe scripts
themselves under `e5-shell-logs/probes/` for re-runs).

### Test target and method

Tested from a clean scratch copy of the shared workspace tree at HEAD `9d161e6` (the impl
card's final commit) plus the untracked i18n runtime it re-exports (sibling card t_5696ea45,
in flight — without those files the tree does not build). All findings below are attributed
to the shell card unless marked otherwise. Automated gates ran first, then independent
browser probes (Playwright + CDP, scripts preserved in the logs dir) — the probes were
written from the spec, not from the card's own e2e tests, so they are an independent check.

## 0. Automated gates (scratch copy of the tree)

| Gate | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` (max-warnings 0) | PASS |
| `prettier --check` on all shell-card files (src/app, src/features, src/styles, index.html) | PASS |
| `vitest run` — shell suites (theme, settings, announce, media, shell-seams, router, app, settings view) | 78/78 PASS |
| `vitest run` — whole tree | 266/270; the 4 failures are in `tests/unit/storage/zz-probes.test.ts`, an untracked in-flight storage-card probe file (out of scope — see §8) |
| `npm run build` + `npm run budget` | PASS — initial JS 24.2/100 KB, CSS 3.4/20 KB, app-shell 33.0/200 KB, locales 5.6/20 KB (both packs lazy), no-external-refs 0 hits, no wasm |
| `playwright test --project=chromium` (e2e) | 14/14 PASS (smoke + CSP, axe in both themes across all destinations, 5 theme-boot checks) |
| `npm run audit:gate` | 0 vulnerabilities |

Coverage on shell-card suites (from impl handoff, spot-verified): App 89.5/72.7, Shell
82.9/82.6, settings store 96/100, theme 92.9/96.4 (stmts/branches).

## 1. Theme boot — no flash (M7) — PASS

**Explicit statement: the theme boot is genuinely flash-free.** An independent probe wrapped
`Element.prototype.setAttribute` before any page script ran, timestamping the exact synchronous
moment the inline `#theme-boot` snippet writes `<html data-theme>`, and compared it against
first-contentful-paint (buffered PerformanceObserver).

- 7 scenarios × 2 conditions (unthrottled, 6× CPU throttled) × 3 loads = **42 loads, 42/42
  flash-free, 0 violations**.
- Scenarios: explicit light (OS dark), explicit dark (OS light), system (OS dark), system
  (OS light), absent preference (both OS), invalid stored value (`banana`, OS dark).
- Margin (FCP − data-theme write): **min 33.3 ms, max 150.1 ms** — the theme was applied
  before first paint on every single load, including under 6× CPU throttling (the card's own
  e2e has no throttled run; this closes that gap).
- `style.colorScheme` set alongside `data-theme` on every load; final resolved theme matched
  expectation in 42/42.
- Failure semantics present: the inline snippet is try-guarded; CSS `prefers-color-scheme`
  fallback exists in tokens.css (light + dark declared twice: explicit attribute + media
  query).
- Raw data: `e5-shell-logs/theme-boot-results.json` (42 run records).

## 2. localStorage = boot-prefs only (ADR-002 Decision 7) — PASS

Inspected `localStorage` after boot, after settings changes, and after reloads (probe:
`e5-shell-logs/settings-probe-results.json`).

- Only key ever seen: `todo:prefs:v1:theme`. At boot with a clean store: **empty** (the
  mirror is written only when the durable record disagrees). After changes: `{"todo:prefs:v1:theme":"dark"}`.
- Total: **25 bytes ≤ 4 KiB budget**. No task/list/snapshot/settings-record data anywhere.
- The boot snippet reads exactly this key; invalid values behave as `system` in both the
  snippet and `readThemePref()` (consistent).

## 3. Settings persistence (M14 / ADR-002) — PASS

Durable source of truth is the ADR-002 `settings` singleton in IndexedDB
(`local-first-todo` / `settings`), reached through the injectable port + the real
`createIdbSettingsPersistence()` adapter (registered in `src/app/main.tsx:14`).

- UI changes (theme → Dark, week start → Monday) persist through reload; the raw IndexedDB
  record was read directly and matches ADR-002 §3.4 shape exactly:
  `{id:'settings', theme, locale:'en', weekStart, defaultListId, notificationsEnabled, lastBackupAt}`.
- **ADR-002 §3.4 theme duplication rule verified in the browser**: mirror poisoned to
  `light` while the record says `dark` → after reload the app paints `dark` (record wins) and
  the mirror is rewritten to `dark`. Verified twice more at the store level.
- `system` preference tracks `prefers-color-scheme` live without reload (emulated OS switch
  flipped `data-theme` light→dark→light).
- Theme change announces politely ("Dark theme applied") per design §11.2.
- **`defaultListId`**: the select is present but disabled ("No lists yet") because list
  options arrive via the documented `setListOptions()` mount point (domain card, in flight).
  Persistence semantics were verified through the real IDB adapter with valid ULIDs
  (`e5-shell-logs/probes/zz-qa-adapter-probe.test.ts`, 3/3 passing against fake-indexeddb):
  save/restore of all three fields, and merge-without-clobber of foreign fields
  (`locale`, `notificationsEnabled`, `lastBackupAt` preserved).
- Note (defect D4): validation rejects a non-ULID `defaultListId` — correct per ADR-002 —
  but the failure is only `console.warn`ed (see defect list).

## 4. Responsive behaviour + touch targets (M8) — PASS (1 minor)

Measured at the design-spec breakpoints, both core routes (`/#/today`, `/#/settings`);
screenshots in `e5-shell-logs/shots/` (`base-320-*.png`, `md-768-*.png`, `lg-1024-*.png`,
`xl-1440-*.png`). Raw: `e5-shell-logs/responsive-results.json`.

| Breakpoint | Pattern | Chrome measured |
|---|---|---|
| 320 | compact | app bar 56 px, tab bar 56 px (+1 px border), FAB 56×56 @ 16 px inset, drawer button 44×44 |
| 768 | compact | same chrome; settings grid 2 columns ("348px 348px") |
| 1024 | wide | sidebar 256 px, no tab bar/FAB, content column 720 px max |
| 1440 | wide | sidebar 256 px, content column 720 px, shell max 1440 px |

- Settings sections: 1 column at 320 ("288px"), 2 columns ≥ 768 — matches §4.9.
- Touch targets: every visible interactive element ≥ 44×44 CSS px at all four breakpoints
  (smallest measured: icon buttons and segments exactly 44 px tall; segments enforce
  `min-height: var(--touch-min)`). **Exception: the skip link measures 180.9 × 43.6 px when
  focused — 0.4 px under the 44 px bar → defect D1.**
- Thai label rendering spot-check: the `ไทย` segment renders complete and unclipped
  (`scrollWidth == clientWidth`, Noto Sans Thai in the stack; `thai-segment-zoom.png`) — an
  initial screenshot reading suggesting clipped Thai was a vision-model artifact of small
  glyphs, disproven by zoom capture and DOM measurement.

## 5. Keyboard, structure, dialog (§4.1/§6.9/§11.1) — PASS (2 minor notes)

Raw: `e5-shell-logs/keyboard-probe2-results.json`.

- Tab order (compact): skip link → menu button → search → Add task → 4 tab links → More →
  FAB; no keyboard trap; wrap-around behaves.
- Skip link: **first focusable**, Enter moves focus to `main#main` (the router deliberately
  treats `#main` as an in-page anchor, `src/app/router.ts:53`). Label/target deviate from
  the spec text → defect D2.
- Landmarks per route (all 8 destinations incl. not-found): exactly one banner, one `main`,
  labelled navs; one `h1` per view with `tabindex="-1"`; heading hierarchy h1→h2 with no
  skipped levels (verified per route).
- Drawer (compact): `role="dialog"` + `aria-modal="true"` + aria-label, background
  `aria-hidden="true"` while open, scrim present. Focus moves into the drawer on open.
  Focus trap: 14 Tabs + 6 Shift+Tabs all stayed inside. Esc closes and returns focus to the
  opener — verified for BOTH openers (app-bar menu button and the More tab). Scrim tap closes
  (at ≥ 400 px width; at 320 px the drawer's spec'd max-width 320 px covers the full width,
  so the close button / Esc are the paths there — by design).
- Visible focus: every keyboard stop showed `outline: rgb(46,79,196) solid 3px` (the
  `--color-focus` ring); `#main:focus` ringless by design (it is a region, not a control).
- SPA route change: focus moves to the view `h1`, polite region announces "View: All open" /
  "View: Settings" (also after lazy-chunk route), `aria-current="page"` on the active nav
  item. Announcement wording deviates from the §11.2 pattern → info I2.

## 6. prefers-reduced-motion (§10.3) — PASS with defect D3

Under `prefers-reduced-motion: reduce` (probe output in
`e5-shell-logs/motion-contrast-results.json`, screenshots `reduced-motion-*-drawer.png`):

- All measured transition/animation durations collapse to **0.001 s (1 ms)** on FAB, drawer,
  buttons; `scroll-behavior: auto` on `html` and `body`. Baseline (no reduce) is the 120 ms
  token. This matches the normative snippet in §10.3.
- **However**, transform-based motion is only sped up, not removed: the drawer still animates
  `translateX(-100%) → 0` via `@keyframes drawer-in` (`src/styles/shell.css:262-281`) and the
  FAB press still applies `transform: scale(0.96)` (`src/styles/shell.css:227-228`), where
  §10.3 requires no transform-based motion (FAB press → fill change; drawer appears without
  slide). At 1 ms the practical impact is ~zero, hence minor → defect D3.

## 7. Contrast spot checks, light AND dark (§8, §12.2) — PASS

All 13 token pairs from §12.2 recomputed from the shipped tokens.css values in BOTH themes
(26 measurements): every pair **matches the spec's measured ratio within 0.15 and meets its
bar** (4.5:1 text, 3:1 UI). Representative: light text/surface 16.51 (spec 16.5),
on-accent/accent 6.93 (6.9), border-control/surface 3.68 (3.7), danger-text/tint 6.59 (6.6);
dark text/surface 14.6 (14.6), on-accent/accent 5.1 (5.1), focus/surface 7.57 (7.6),
warning-text/tint 8.0 (8.0). Rendered elements (h1, h2, field labels, segments, primary
button, FAB, app bar) resolve to those tokens — e.g. FAB label 6.93:1 light / 5.1:1 dark
(dark uses ink-on-fill per §3.3). Full table: `e5-shell-logs/motion-contrast-results.json`;
visual: `contrast-light-settings.png`, `contrast-dark-settings.png` (dark desktop layout
reviewed: sidebar + 2-column settings, selected/unselected states legible, no overlaps).

## 8. Defect list

| # | Sev | Finding | Location | Expected vs actual |
|---|---|---|---|---|
| D1 | Minor | Skip-link hit area 180.9 × **43.6** px when focused | `src/styles/global.css:117-133` (.skip-link) | ≥ 44×44 px per M8 / §11.1; 0.4 px short. Fix: `min-height: var(--touch-min)` (or +1 px vertical padding) |
| D2 | Minor | Skip-link label/target deviate from design §4.1 | `src/app/Shell.tsx:182` | Spec: "Skip to tasks" → jumps to the task list. Actual: "Skip to main content" → `#main`. Pattern (first focusable, moves focus) is correct; align wording/target or amend the spec |
| D3 | Minor | Reduced motion keeps transform-based motion | `src/styles/shell.css:227-228` (FAB `scale(0.96)` on `:active`), `src/styles/shell.css:262-281` (drawer `translateX` slide) | §10.3: no transform-based motion — FAB press becomes a fill change, drawer appears without slide. Durations do collapse to 1 ms, so impact is negligible; still a letter-violation of a normative section |
| D4 | Minor | Settings save failures are silent | `src/app/settings.ts:82-90` (`persist()`) | §11.2 requires the assertive live-region announcement "Couldn't save changes. Your input is kept." on write failure; actual is `console.warn` only, so a failed save (quota/IDB error, or a non-ULID `defaultListId` rejected by `validateSettings`) leaves in-memory state silently diverging from the durable record until reload. Trigger is narrow today; E3 says "never silent loss" |
| I1 | Info | Default-list select disabled until the domain card wires `setListOptions()` | `src/features/settings/SettingsView.tsx:154` | Documented mount point, not a defect; `defaultListId` persistence verified at the adapter level instead (§3) |
| I2 | Info | Route-change announcement is "View: {name}" | `src/app/App.tsx:137` (`a11y.viewChanged`) | §11.2 pattern is "{View}, {n} open tasks". The count suffix needs domain data (no tasks exist yet); revisit when the task list lands |
| I3 | Info | Spec/ADR key-name drift: design §4.9/§5.1 says `localStorage['app.theme']`, ADR-002 Decision 7 mandates `todo:prefs:v1:theme` | `docs/design/ux-foundation.md:375,405` | Implementation correctly follows ADR-002 (the storage authority); the design spec text is stale and should be reconciled by h_designer/h_pm |

Out-of-scope observations (NOT shell defects; flagged for the epic/owners):

- `tests/unit/storage/zz-probes.test.ts` (untracked, in-flight storage card) — 4 failing tests
  in the full-tree run.
- `src/storage/*` + `tests/unit/storage/*` (storage card) — 11 files fail `prettier --check`,
  which breaks the `npm run ci` gate (format:check) if landed as-is. All shell-card files are
  prettier-clean.
- Tree state caveat: the shared workspace contains in-flight untracked i18n runtime files
  (t_5696ea45) that the shell's `src/app/i18n.ts` re-exports; HEAD alone does not build.

## 9. Flash-free statement (acceptance criterion)

**Yes — theme boot is genuinely flash-free in all three modes (light / dark / system),
including for absent and invalid stored preferences, in both OS colour schemes, and under
6× CPU throttling: 42/42 instrumented loads applied `data-theme` 33–150 ms before first
contentful paint, with zero flashes of the wrong theme.** (§1; raw runs in
`e5-shell-logs/theme-boot-results.json`.)
