# Accessibility Audit — WCAG 2.2 AA gate

**Card:** t_5612df50 (child of the MVP DoD release gate t_7f1e8f29) · **Reviewer:** h_reviewer
**Audit window:** 2026-10-25 23:30 → 2026-10-26 00:55 (+07)
**Release state audited:** main @ **`0a8702a`** (contains the SC 4.1.3 fix `64c0ee4`, card t_bb9053ec) —
audited as a **local `BASE_PATH=/browser-todo-app/` production build** in pinned snapshots (see §0).
**Production URL:** `https://e23thr.github.io/browser-todo-app/` — checked at audit time: still serving the
**pre-fix** build (`assets/index-CA0Rb68-.js`, `last-modified: 2026-10-25T16:30:07Z`), i.e. src-identical to
`b820ad7`. A post-fix deploy lands on the next green-main deploy job; **re-check the asset hash after it
runs** (finding F-3, non-blocking).

---

## VERDICT: PASS with explicit PO waivers

> **WCAG 2.2 AA — PASS with explicit PO waivers.**
> Screen-reader execution: **Orca/Linux executed 10/10 per `docs/qa/keyboard-script.md`** (record:
> `docs/qa/a11y-gate.md` §5.2 — tester Praphan/PO, 25 Oct 2026, Orca / Firefox / Ubuntu 26.04);
> **NVDA (Windows) + VoiceOver (macOS/iOS) waived by explicit PO acceptance, t_2ce8fc1f thread.**
> This is never a bare unqualified PASS — the waiver scope is part of the verdict.
>
> The release-blocking SC 4.1.3 deferred-announce race was **found pre-fix by this audit's baseline
> run** (at `225a1f3`/`b820ad7`, deterministic repro), **fixed in `64c0ee4`** (t_bb9053ec) during this
> audit, and **re-verified PASS at `0a8702a`** (unit repro green + keyboard F1 e2e **5/5**, was 6/8
> failing). Nothing else failed: axe 0 violations across every route × theme × locale × viewport,
> contrast 0 failures in all four UI states × both themes, keyboard/SR flows green, `npm run ci`
> exit 0 (927/927).
>
> **Open items attached to this PASS** (tracked, none release-blocking — see §8): F-1 route-change
> focus target deviates from design §5.2 (decision needed: amend impl or design); F-3 live Pages
> still pre-fix at audit time (re-verify deploy); F-2 probe-visual stage-6 matcher is stale
> (test-infra nit; authoritative announcement probe is 12/12).

---

## 0. Target selection, pins, and method (why snapshots)

The shared working tree was **mid-fix during this audit** (hotspot: three sibling cards building in
the same tree; `src/app/announce.ts` changed on disk at 23:44 while probes were running). Two pinned
snapshots were therefore used, never the live tree:

| Pin | What | Why |
|---|---|---|
| **baseline `b820ad7`** (`accessibility-logs/baseline-b820ad7/`) | committed src **as deployed to Pages** (pre-fix; local rebuild of it is byte-identical to the live `index.html`, same `index-CA0Rb68-.js` hash) | audit of production bytes + discovery of the race |
| **RC `0a8702a`** (top-level `accessibility-logs/`) | committed main incl. fix `64c0ee4` (src ≡ `64c0ee4`; `0a8702a` adds only the Lighthouse budget test) | verdict target = release state = HEAD, per h_pm steer |

Both pins: `git archive` → `BASE_PATH=/browser-todo-app/ npm run build` → `vite preview
--host 127.0.0.1 --strictPort` (private ports 4199/4200) → real Chromium (Playwright) against the
non-root Pages base path. Tools: axe-core `wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa`
(`@axe-core/playwright`), the CI spec `tests/e2e/a11y.spec.ts`, in-page WCAG 2.x relative-luminance
contrast math, scripted keyboard/live-region probes, screenshots.

**Route coverage note:** the task named `/`, `/plan`, `/completed`, `/settings`. This SPA's real
routes are hash routes; `/plan` maps to **`#/week`** (horizon) + **`#/lists`** (list management).
Coverage is a superset: desktop axe ran **all 9 routes** (`/`, `#/today`, `#/week`, `#/all`,
`#/completed`, `#/search`, `#/lists`, `#/list/<id>`, `#/settings`) + onboarding + 4 interactive
states; mobile ran `/#/all/#/completed/#/lists/#/settings` + `#/week` (added so the plan view is
covered on mobile too — `axe-mobile-week.json`).

---

## 1. Automated axe-core (requirement 1) — RC `0a8702a`

| Matrix | Result | Evidence |
|---|---|---|
| Desktop: 9 routes + onboarding + row-menu/move-dialog/delete-confirm/composer-expanded × light+dark × en+th = **54 scans** | **0 violations of any impact; 0 blocking** | `accessibility-logs/axe-gate.json`, `rc-group1.txt` |
| Mobile @360px: 5 CORE routes ×2 themes… (5 scans) + **`#/week` ×2 themes (addendum)** | **all clean (0 violations)** | `axe-mobile-list.json`, `axe-mobile-week.json` |
| CI-integrated gate `npx playwright test tests/e2e/a11y.spec.ts` (B2 shell-landmark guard live) | **2/2 passed, exit 0** | `e2e-a11y-rc-0a8702a.txt` |
| Status-state axe (badges, both themes × both locales) | clean ×4 | `status-contrast.json`, `rc-group1.txt` |

Baseline (`b820ad7`, = live src): identical result — 54/54 clean, mobile 5/5 clean
(`baseline-b820ad7/axe-gate.json`).

## 2. Manual keyboard-only navigation (requirement 2) — RC, screenshots on disk

Executed keyboard-only (Tab / Enter / arrows / Esc / Space — no pointer in the flows) in real
Chromium, desktop 1280×900 light + mobile 360×740 dark. **38 recorded steps, 0 focus-visibility
failures, 1 design-deviation finding (F-1), 0 stage errors.**
Log/JSON: `keyboard-sr-run.txt`, `keyboard-manual.json` · **19 screenshots:**
`accessibility-logs/screenshots/` (`01-onboarding-cta-focused.png` … `23-mobile-focus-after-sheet-esc.png`,
`f71-first-tab-light.png`, `f71-first-tab-dark.png`, `diag-*`).

| Step | Result |
|---|---|
| F7.1 fresh load → **first Tab = "Skip to main content"**, visible in viewport, 3 px ring (light `rgb(46,79,196)` / dark `rgb(142,168,255)`) | **PASS** (desktop + mobile; `skip-link-fresh-load.json` verdict PASS 2/2) |
| Enter on skip link → focus lands in `#main` | **PASS** (desktop + mobile) |
| First-run handshake keyboard-only: Tab → onboarding "Get started" → Enter → shell | **PASS** (screenshot 01) |
| Tab order walk, 18 stops from document top: names + **focus ring ≥3 px on every stop** (exception by design: `#main` region takes focus without ring) | **PASS** — 0 ring violations |
| Route change via nav link → SPA no reload, `View: …` announced | announced ✓; focus target = **composer input, not h1 → finding F-1** (§8) |
| Edit dialog: 12 Tabs stay inside (trap); Esc closes; focus returns to the row title button | **PASS** (screenshots 06–08) |
| Row menu: opens with focus on first menuitem; ArrowDown reaches Delete; Delete → confirm dialog focused on **Cancel**; 8 Tabs stay inside (trap) | **PASS** (screenshots 09–10) |
| Esc releases menu/dialog — focus returns into the task row, never dropped to `body` | **PASS** (screenshot 11) |
| Mobile: FAB → composer sheet opens, 8 Tabs stay inside (trap), Esc closes → focus back on FAB | **PASS** (screenshots 21–23) |
| 200 % zoom + 320 px reflow (both locales, all routes): `hScroll=false` everywhere; clipped nodes = by-design `.visually-hidden` sr-only + `<360px` tab labels; only line-height = floor is `view-title` 1.35 | **PASS** (`zoom-status-lang.json`) |

Prior human keyboard pass: 10/10 flows under Orca (§5.2 record) — see waiver note in the verdict.

## 3. Screen-reader spot check (requirement 3) — scripted equivalents + recorded human pass

**NVDA/VoiceOver are not executable on this headless Linux host.** Per the verdict: Orca/Linux was
**executed 10/10** by the PO on 2026-10-25 (matrix in `docs/qa/a11y-gate.md` §5.2; script
`docs/qa/keyboard-script.md`); **NVDA (Windows) + VoiceOver (macOS/iOS) waived by explicit PO
acceptance (t_2ce8fc1f thread)**. This audit adds the **scripted spot check of exactly what those
ATs consume** — live-region speech + focus behaviour — on the five named critical flows
(`sr-spotcheck.json`): **5/5 HIT** at RC (and 5/5 at baseline after probe fix).

| Flow | Expected speech (§5.5 / en) | Captured on RC | Focus behaviour |
|---|---|---|---|
| Capture item | `Task added: SR capture flow` | **HIT** | focus stays in composer (D6 capture-first) |
| Plan item (due=Today chip → save) | `Task saved` | **HIT** | editor opens focused on Title; after save focus returns to row; due badge renders `Due today` |
| Complete item | `Task completed` | **HIT** | checkbox toggled, focus stays on the checkbox, not dropped to `body` |
| Export (Back up now) | `Backup saved to your downloads. Keep it somewhere safe.` | **HIT** + real download started (`local-first-todo-backup-…json`) | button regains/stays focus |
| Language toggle en→th→en | th: `เปลี่ยนภาษาเป็น ไทย แล้ว` | **HIT** + `html lang` flipped `en→th→en` both directions | focus recorded, not lost |

Full announcement matrix (6 scenarios × en + th = **12/12 HIT** incl. route-change/search/list):
`announcements-gate.json` + `rc-group1.txt`.

## 4. Color contrast — all UI states × both themes (requirement 4)

**30 state samples, 0 below threshold (0 even among disabled-exempt) + 756 route samples, 0 failures
+ 24 status-badge samples, 0 below 4.5.** In-page WCAG 2.x math on real rendered pixels.

| State | Light | Dark | Verdict |
|---|---|---|---|
| **default** (nav 6.07 / view title 16.1 / task title 16.51 / primary button 6.93 / input 16.51) | ≥4.5 ✓ | ≥5.1 ✓ (nav 8.07 … input 14.6) | **PASS** |
| **hover** (nav 14.04 / primary button 8.83 / row-menu trigger 14.04; bg-or-color-changed each) | ≥4.5 ✓ | ≥6.07 ✓ | **PASS** |
| **focus** (`:focus-visible` ring vs adjacent bg: nav, task title, checkbox — 3 px solid) | **6.93:1** (≥3) ✓ | **7.57:1** (≥3) ✓ | **PASS** |
| **disabled** (chip `Clear` 14.98 / composer helper 6.07 / disabled input 5.37; SC 1.4.3-exempt but measured) | ≥4.5 ✓ | ≥4.5 ✓ (12.88 / 8.07 / 6.31) | **PASS** |
| **disabled `aria-disabled` row-menu item** (`Move up`, list boundary — addendum) | **5.37:1** | **6.31:1** | **PASS** |

Files: `state-contrast.json`, `state-contrast-aria-disabled.json`, `visual-gate.json` (756/0),
`status-contrast.json` (24/0), `rc-group1.txt`, `rc-group2.txt`.
Baseline run: byte-equivalent results (`baseline-b820ad7/state-contrast.json`).

## 5. SC 4.1.3 deferred-announce race — discovery → fix → re-verification

| Phase | What | Evidence |
|---|---|---|
| **Found (pre-fix, `225a1f3`/`b820ad7` = deployed src)** | Deterministic unit repro against the committed announcer: save issued 460 ms after the first write (inside the deferred hold's window) → **at t=530 polite region `""` — 'Task saved' never landed**; only the persistence notice speaks. Same mechanism the DoD gate caught 6/8 in e2e (`mvp-dod-logs/announce-taskSaved-race.md`). | `baseline-b820ad7/race-repro-unit-prefix-b820ad7.txt` (test fails, `atSave:""`) |
| **Fixed** | `64c0ee4 fix(a11y): deferred announce hand-over queues behind in-flight messages` (t_bb9053ec — done, 2026-10-26 00:18; deferred hand-over now waits out in-flight landing+observation windows, `deliverDeferred` in `src/app/announce.ts`) | git `64c0ee4`, ancestor of `0a8702a` |
| **Re-verified (RC `0a8702a`)** | Same deterministic unit test now **PASSES** (`at530='Task saved'` then notice, in order); **keyboard F1 e2e 5/5 isolated runs exit 0** with `--trace on` (pre-fix: 6/8 failing); announcements **12/12**; CI axe gate **2/2**; full **`npm run ci` exit 0 — 927/927 tests, 81 files**, format/lint/typecheck/i18n/coverage/build/budget all green | `race-repro-unit-rc-0a8702a.txt`, `race-e2e-rc-0a8702a.txt`, `rc-group3.txt`, `ci-rc-0a8702a.txt` |

*(First `rc-group3` unit invocation exited 1 with `No test files found` — the audit test file had not
yet been copied into the RC snapshot; annotated in `rc-group3.txt` and re-run green.)*

## 6. WCAG 2.2 AA criterion summary (full matrix: `docs/qa/a11y-gate.md` §1, re-verified here)

1.1.1 ✓ · 1.3.1 ✓ (axe `list` clean) · 1.3.2 ✓ · 1.4.1 ✓ (status never color-only) ·
1.4.3 ✓ (756 + 30 + 24 samples, 0 failures) · 1.4.4 ✓ (200 %) · 1.4.10 ✓ (320 px, both locales) ·
1.4.11 ✓ (focus rings ≥6.93, UI ≥3) · 1.4.12 ✓ (indirect — see gate note) · 2.1.1 ✓ (keyboard script
+ 38-step walk) · 2.1.2 ✓ (traps verified desktop+mobile) · 2.4.1 ✓ (skip link fresh-load 2/2) ·
2.4.3 ✓ with **F-1 deviation noted** (focus never lost/dropped; target differs from design §5.2) ·
2.4.4 ✓ · 2.4.7 ✓ (every stop ringed) · 2.5.1/2.5.7 ✓ (keyboard equivalents) · 2.5.8 ✓ (axe
`target-size` 0; known 44 px-bar notes in §7) · 3.1.1/3.1.2 ✓ (html lang flips both directions; N-note
on user content) · 4.1.2 ✓ (axe `label` clean) · **4.1.3 ✓ — fixed `64c0ee4`, re-verified at `0a8702a`
(§5)**.

## 7. Known findings carried from the prior gate (unchanged dispositions)

The visual probe reports the same **42 finding entries as the committed M13 gate** — byte-identical
shape, zero new entries (`compare-visual.mjs`): **24 touch-target** (skip link 43.59 px = known D1,
passes WCAG 2.5.8's 24 px bar; raw `task-check` 24×24 / settings inputs 18 px whose *effective*
targets are the 44 px labels — `hit-area-c590ab2.json`), **6 zoom-clip** (`.visually-hidden` sr-only
by design), **12 live-region** (stage-6 of probe-visual uses stale unformatted expectations — the
authoritative probe-announcements hits 12/12; see F-2).

## 8. Findings on this audit (none release-blocking)

| # | Severity | Finding | Disposition |
|---|---|---|---|
| **F-1** | Non-blocking — **decision needed** | **Route change focuses the composer input, not the view `h1`**, on task views (`#/all`, `#/completed`, `#/today`, …): `App.tsx:167-172` gives a non-dialog `[data-autofocus]` priority over the heading, and `Composer.tsx:224` marks its input. Design `core-domain.md` §5.2 says "Route change moves focus to the view `h1`" (no composer exception; only Search has an autofocus carve-out, ux-foundation §S5), and `keyboard-script.md` F7.2 expects the h1. Settings (no composer) focuses the h1 ✓; the view is still announced (`View: …`) ✓; WCAG 2.4.3 itself is satisfied (focus is coherent, operable, never lost). Origin: composer attr `3866cd8` (Oct 23) + route priority `85588df` (Oct 25 01:14); prior gate's claim of "h1" rested on an evidence file with only 3 steps and no h1 assertion. | Decision: either honor `[data-autofocus]` on the route reader only where design grants it (search), or amend design §5.2 / F7.2 to say "views with a capture composer focus the composer (capture-first D6); h1 announced via live region". Not fixable by re-testing — needs design/PO ruling. Evidence: `keyboard-manual.json` (step P1.6), screenshots `05-route-change-h1-focus.png`, `diag-route-change-focus.png`. |
| **F-2** | Test-infra nit | probe-visual stage 6 (announcements) still records MISS ×12 with **unformatted templates** (`'View: {view}'`) and an empty array — identical to the prior committed run; the standalone `probe-announcements.mjs` (fixed matcher) is authoritative at 12/12. | Update or delete stage 6 so the two probes can't disagree; does not affect product. |
| **F-3** | Ops re-check | Live Pages at audit time still serves the **pre-fix** build (`index-CA0Rb68-.js`, last-modified `16:30:07Z`). Verdict above is against a **local `BASE_PATH` build of `0a8702a`** (stated explicitly per steer). | After the next green-main deploy: `curl -s https://e23thr.github.io/browser-todo-app/ \| grep -o 'assets/index-[^"]*\.js'` must differ from `index-CA0Rb68-.js` (post-fix bundle); re-pin the live check in the DoD report. |

## 9. Evidence index

- **RC `0a8702a` (verdict basis, top level):** `accessibility-logs/` — `axe-gate.json`,
  `announcements-gate.json`, `axe-mobile-list.json`, `axe-mobile-week.json`, `status-contrast.json`,
  `zoom-status-lang.json`, `visual-gate.json`, `state-contrast.json`,
  `state-contrast-aria-disabled.json`, `keyboard-manual.json`, `sr-spotcheck.json`,
  `skip-link-fresh-load.json`, `race-repro-unit-rc-0a8702a.txt`, `race-e2e-rc-0a8702a.txt`,
  `e2e-a11y-rc-0a8702a.txt`, `ci-rc-0a8702a.txt`, `rc-group1.txt`, `rc-group2.txt`, `rc-group3.txt`,
  `screenshots/` (19 PNG), `probes/` (re-runnable scripts).
- **Baseline `b820ad7` (= deployed pre-fix bytes):** `accessibility-logs/baseline-b820ad7/` — same
  matrix + `race-repro-unit-prefix-b820ad7.txt` (the deterministic FAIL that led to fix `64c0ee4`).
- **Human AT pass + waivers:** `docs/qa/a11y-gate.md` §5.2 · script: `docs/qa/keyboard-script.md`.
- **Prior criterion matrix:** `docs/qa/a11y-gate.md` §1 (all rows re-verified against RC here).

## 10. Limits (honest scope)

- Audits ran in **headless Chromium on Linux** against pinned local production builds (both pins
  byte-verified where noted); Firefox/WebKit coverage comes from CI's nightly matrix, not this run.
- No live AT was driven by this audit: screen-reader rows are the recorded human Orca pass + PO
  waivers (verdict header) plus scripted live-region/focus equivalents.
- `1.4.12` text-spacing is verified indirectly (rem type + line-height measurements), as in the
  prior gate — no dedicated slider-injection script.
- The live-deploy question (F-3) was open at report time and is the one outstanding re-check.
