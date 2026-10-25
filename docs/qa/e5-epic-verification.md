# Epic E5 — UX Foundation, Accessibility & i18n (MVP): epic verification

**Card:** t_db6845bc · **Run:** h_pm · **Date:** 2026-10-25 · **Verified HEAD:** `1006354` (shared main) · **Closed at:** `e8ee00d`
**Verdict:** **CLOSED — 5 of 5 acceptance criteria MET.** The first verification pass (2026-10-25, clean clone of `1006354`) found 4/5 MET with the M13 criterion ("the a11y gate card reports PASS") held open on O1 (human AT pass). O1 has since been executed and recorded (t_2ce8fc1f): the human pass ran 2026-10-25 (Orca / Firefox / Ubuntu, PO as tester) with **10/10 flows PASS** and explicit PO-accepted waivers for NVDA (Windows) + VoiceOver (macOS/iOS); the gate reads **FULL PASS with explicit PO waivers** (`docs/qa/a11y-gate.md` §5.2). The closing run spot re-ran the gate probes at the shipped HEAD `e8ee00d` (§7) — no a11y regression.

Method: every automatable criterion re-verified **first-hand** on a **clean git clone** of `1006354`
(symlinked `node_modules`, no sibling WIP), not re-read from upstream handoffs. Upstream evidence:
`docs/qa/e5-shell.md` (t_46150118), `docs/qa/e5-i18n.md` (t_8e3c7e08), `docs/qa/a11y-gate.md`
(t_b788bacf + re-run t_6bc6eda5 + O1 record t_2ce8fc1f), reviews t_01ee8f5a / t_8a0a176a, fixes t_419ace90 / t_36b4cf65 /
t_464575b1 / t_d5ceab06 / t_a485d24d.

---

## 1. Acceptance-criteria verdicts

| # | Acceptance criterion | Verdict | First-hand evidence at `1006354` (closing additions at `e8ee00d`) |
|---|---|---|---|
| AC1 | Theme boot flash-free in all three modes | **MET** | `npx playwright test tests/e2e/theme-boot.spec.ts` = **24 passed / 0 failed** (6 specs × chromium, firefox, webkit, chromium-th): explicit light, explicit dark, system-dark, system-light, absent preference, plus the first-run onboarding boot (t_d5ceab06). The probe asserts `data-theme` is applied **before** first contentful paint. Upstream instrumented evidence: 42/42 loads (three modes × OS schemes × absent/invalid prefs × 6× CPU throttle, `docs/qa/e5-shell-logs/theme-boot-results.json`) and the onboarding-screen first paint proof (t_464575b1 / t_d5ceab06). The theme-boot suite was red at `c590ab2` (stale first-run waits) and is green since `9689037`/`1006354` — this was test staleness, not an M7 product defect. |
| AC2 | Every UI string externalized (en+th parity, per-locale lazy-load, locale bytes ≤ 20 KB gzip measured) | **MET** | `npm run i18n:check` **PASS** (en/th key sets, values, placeholders consistent). `npm run build` + `npm run budget` **PASS**: `locales 12.7 KB / 20 KB`, `locales-lazy 0 hits` (no locale pack in the initial closure — per-locale lazy-load), `no-external-refs 0 hits`. Measured built packs myself: `locale-en` **5,895 B** + `locale-th` **7,112 B** gzip = **13,007 B** ≤ 20,480 B. Hardcoded-string sweeps clean (QA `docs/qa/e5-i18n.md` §7; the single index.html title/description exception was localized by t_a485d24d — `app.documentTitle`/`app.metaDescription` in both catalogs, live-verified en↔th, static English kept only as the documented pre-paint fallback, `docs/i18n/README.md` §4). |
| AC3 | `document.documentElement.lang` tracks locale incl. SR language switching | **MET** | `setLocale()` sets `document.documentElement.lang` (src/i18n/index.ts) — pinned by unit tests inside the 910-test green run and verified live in both directions via the real Settings UI (a11y-gate §1 SC 3.1.1 PASS, `visual-gate.json` checks.lang; i18n QA `locale_switching` incl. the `a11y.languageChanged` SR announcement). The **SR-observed** voice switch is now covered by O1's executed human AT pass (a11y-gate §5.2 rows 8–10: lang-switch both directions + Thai-voice fallback per design §11.4 all PASS under Orca). |
| AC4 | Thai renders via system fonts (zero webfont bytes) with 200%-zoom diacritic-stacking reflow verified | **MET** | Zero webfont bytes first-hand: `@font-face` / `woff` / `fonts.googleapis` / `fonts.gstatic` scan over `src/`, `index.html`, `public/` = **0 hits**; `--font-sans` is the OS stack (system-ui … 'Noto Sans Thai', 'Leelawadee UI', Thonburi, 'Angsana New', 'Cordia New', Tahoma — `src/styles/tokens.css:15-17`); build gate `no-external-refs 0 hits`. Reflow/zoom: a11y gate PASS for 1.4.4 / 1.4.10 in **both themes × both locales** (200% root 32 px + 320 px, no horizontal scroll; re-run at `5b1fdbb` and re-confirmed at `e8ee00d`, §7), i18n QA vision pass on 4 Thai screenshots (diacritics stack cleanly at 200% × 1280/320, line-heights ≥ 1.35). |
| AC5 | The a11y gate card reports **PASS** on WCAG 2.2 AA in both themes and both locales (a FAIL blocks release) | **MET** | `docs/qa/a11y-gate.md` now reads **FULL PASS with explicit PO waivers** (§5.2 verdict trail: original run FAIL on B1+B2+O1 → re-run `5b1fdbb` FAIL-with-outstanding-O1 → O1 executed and recorded → FULL PASS; the header verdict was updated in the closing run so the headline matches §5.2). All agent-side criteria green (67/67 axe scans at `9689037`, 54+5 clean at `5b1fdbb`; 780 contrast samples 0 failures; announcements **12/12** after B1 fix `86709cc`; CI axe gate non-vacuous after B2 fix `981c822`), the human AT pass is recorded (Orca 10/10 PASS, 2026-10-25, PO as tester) with explicit PO waivers for every platform not executable (NVDA Windows, VoiceOver macOS/iOS), and the closing run re-confirmed the whole gate surface at the shipped HEAD `e8ee00d` (§7). |

## 2. First-hand runs (clean clone of `1006354`, 2026-10-25)

| Gate / suite | Result |
|---|---|
| `npm run format:check` | exit 0 |
| `eslint . --max-warnings 0` | exit 0 |
| `tsc -b` | exit 0 |
| `npm run i18n:check` | PASS |
| `npx vitest run` | **910 passed (910)**, 77 files |
| `BASE_PATH=/browser-todo-app/ npm run build` + `npm run budget` | exit 0 / **RESULT: PASS** (initial-js 65.5/100 KB, css 6.7/20, app-shell 81.4/200, locales 12.7/20, locales-lazy 0, no-external-refs 0, no-wasm 0) |
| `E2E_PORT=4521 npx playwright test tests/e2e/theme-boot.spec.ts` | **24 passed / 0 failed** (6 × 4 projects) |
| `E2E_PORT=4523 npm run e2e:smoke` | **8 passed** |
| `E2E_PORT=4525 npm run e2e:a11y` | **2 passed** |
| `tests/unit/i18n-reload-qa.test.ts` (E5 QA reload drills, landed by this run) | **3 passed** + eslint/prettier/tsc clean |
| Locale pack gzip (built, measured directly) | en 5,895 B + th 7,112 B = **13,007 B** ≤ 20,480 B |
| Webfont scan (`@font-face`/`woff`/google-fonts over src + index.html + public) | **0 hits** |

## 3. Work items and follow-ups — all accounted for

| Card | Role | Status |
|---|---|---|
| t_81b0df28 | Design: UX foundation & design system (incl. Thai typography) | done |
| t_afe9bb56 | Impl: responsive shell, no-FOUC theme, settings (M7/M8/M14) | done |
| t_5696ea45 | Impl: i18n en+th (M15) | done |
| t_46150118 / t_01ee8f5a | Test / Review: shell, theme, settings | done (PASS, 4 minor defects D1–D4 below) |
| t_8e3c7e08 / t_8a0a176a | Test / Review: i18n en+th | done (PASS; defect D1 fixed by t_a485d24d) |
| t_b788bacf | M13 a11y release gate | done — verdict FAIL (B1/B2/O1), **flipped to FULL PASS with explicit PO waivers** when O1 landed (comment on the card) |
| t_419ace90 / t_36b4cf65 | Fix B1 (first task-add announce) / B2 (vacuous CI axe) | done, verified green in re-run |
| t_6bc6eda5 | M13 re-run after B1/B2 | done — FAIL-with-outstanding-O1 (agent-side green) |
| t_464575b1 / t_d5ceab06 | Theme-boot suite vs E3 first-run onboarding (M7 surface) | done (`9689037` + `1006354`, 24/24) |
| t_a485d24d | i18n D1: localize document title + meta description | done |
| t_2ce8fc1f | **O1: human AT manual pass** | **done** — executed 2026-10-25 (Orca/Firefox/Ubuntu, PO as tester) 10/10 PASS; NVDA (Windows) + VoiceOver (macOS/iOS) covered by explicit PO waivers; recorded in `docs/qa/a11y-gate.md` §5.2 |

## 4. Escalation history — M13 / O1 (RESOLVED 2026-10-25)

The first verification pass escalated O1 as the sole standing blocker (PROJECT_ANALYSIS §8 requires
per-release manual NVDA (Windows) / VoiceOver (macOS/iOS) passes; neither the ATs nor those OSes
exist in this headless environment). Resolution path, as executed:

1. PO took the tester role and received the turnkey kit (`browser-todo-app-at-pass-build.zip` + `at-pass-kit.md`, release build `818d02a`).
2. The human pass executed 2026-10-25 under **Orca (Linux screen reader) / Firefox / Ubuntu 26.04** — a scope correction recorded honestly: the submitted "NVDA (Win)" matrix column was in fact Orca, re-keyed in §5.2. **10/10 flows PASS** per `docs/qa/keyboard-script.md`.
3. NVDA (Windows) and VoiceOver (macOS/iOS) were not executable (no Windows/Mac/iPhone hardware available to the tester) — the PO recorded **explicit waivers** for all three (the NVDA waiver extended the same day).
4. `docs/qa/a11y-gate.md` §5.2 carries the full matrix + sign-off fields; the gate verdict reads **FULL PASS with explicit PO waivers**; t_b788bacf carries the flip comment. Per the gate's own sign-off condition ("manual-pass record or a PO-accepted waiver"), O1 is cleared and AC5 stands MET.

Closing-HEAD note (the re-run gated `5b1fdbb`; product code then gained the E2 fixes `924c17f`/`cec79ba`/`c652340`/`0ef2d8e`): the gate's own probe set was spot re-run at the shipped HEAD `e8ee00d` in the closing run (§7), so the PASS record points at the shipped tree.

## 5. Residual register (accepted, non-gating — PO may schedule as polish)

- **QA D1** skip-link hit area 43.6 px vs the 44 px design bar (0.4 px under; WCAG 2.5.8 passes — measured again in the M13 gate).
- **QA D2** skip-link label/target deviate from design §4.1 ('Skip to main content' → #main vs spec 'Skip to tasks').
- **QA D3** `prefers-reduced-motion` keeps transform-based motion (FAB :active scale, drawer slide) where design §10.3 requires none; durations do collapse to 1 ms (WCAG 2.3.3 is AAA).
- **QA D4** settings-save failures announce nothing (console.warn only) where design §11.2 requires an assertive notice.
- Design review t_01ee8f5a: 7 non-blocking design discrepancies (logged on that card for h_designer/PM).
- i18n QA N2: Buddhist-era date formatting (design 9.4) deferred — no date surfaces in MVP; verify when dates render.
- The "end-to-end multi-tab UX pass" noted on the MVP gate by E2's closing is **not** an E5 acceptance criterion (E5's AC list and work items don't include it) and no E5 work item covered it; the two-tab write-refresh behavior is verified at the E2/domain layer. If the PO wants a full multi-tab UX pass it should be scheduled as its own card.
- If NVDA (Windows) / VoiceOver (macOS/iOS) hardware ever becomes available, run the pass and replace the WAIVED cells in a11y-gate.md §5.2 (waiver drop condition recorded there).

## 6. Handoff — what the MVP DoD gate (t_7f1e8f29) may assume from E5

- Responsive mobile-first shell + flash-free theming (3 modes) + minimal settings: shipped and green (M7/M8/M14).
- Bilingual en+th at MVP (M15): all UI strings externalized, parity machine-checked, per-locale lazy packs, 13.0 KB gzip of 20 KB, `html lang` follows the locale (M15/Q9).
- **WCAG 2.2 AA release gate: `docs/qa/a11y-gate.md` reads FULL PASS with explicit PO waivers** (Orca 10/10 human pass + explicit PO waivers for NVDA/VoiceOver). **Q15 criterion 4 can read PASS on that record** — the waiver basis is the PO's own explicit acceptance (t_2ce8fc1f), and the DoD report should carry the same "PASS with explicit PO waivers" wording plus the waiver note, not a bare PASS.
- Scope fidelity: zero webfont bytes (Thai = OS fonts), no manifest/install surface (E4/Q12), no external refs/telemetry (budget gate + CSP).
- Evidence durability: this run landed the E5 QA evidence and the previously untracked `tests/unit/i18n-reload-qa.test.ts` (locale-reload durability drills) into git; the closing run added `docs/qa/a11y-gate-logs/closing-e8ee00d/` (gate-probe re-run evidence at the shipped HEAD). **Still untracked in the shared tree:** other epics' QA evidence (`docs/qa/e1-*`, `docs/qa/e3-epic-verification.md`, `docs/qa/e3-data-safety-ux-review.md`, `docs/qa/e4-*`, `docs/BACKLOG.md`) — per the standing rule, treat untracked QA evidence as not-done until landed; the gate should route a landing sweep or land them itself.

## 7. Closing run (h_pm, 2026-10-25, shipped HEAD `e8ee00d`)

Triggered when t_2ce8fc1f completed (the epic is dependency-linked to it). Verified first-hand on a **clean clone of `e8ee00d`** (product `src/` byte-identical to the `1006354` verification tree — commits since are tests/docs only):

| Re-check | Result at `e8ee00d` |
|---|---|
| O1 record present | `docs/qa/a11y-gate.md` §5.2 filled (Orca 10/10 PASS + explicit PO waivers, tester Praphan, 25 Oct 2026); verdict trail ends **FULL PASS with explicit PO waivers**; gate card t_b788bacf carries the flip comment |
| `probe-axe.mjs` (full matrix) | **54 scans, 0 blocking, 0 violations of any impact** — both themes × both locales |
| `probe-announcements.mjs` | **12/12 HIT (6/6 en + 6/6 th)** incl. first task-add both locales |
| `probe-zoom-status.mjs` | 200% + 320 px reflow en+th: no horizontal scroll anywhere; only by-design clipping (`tab-label` <360 px, sr-only); `view-title` line-height 1.35 (= floor) |
| `probe-status-contrast.mjs` | **24 samples, 0 below 4.5:1**; status-state axe clean |
| `E2E_PORT=4477 npm run e2e:a11y` | **2/2 passed** (B2 shell-landmark guard live) |

Evidence: `docs/qa/a11y-gate-logs/closing-e8ee00d/` (probe JSONs + run logs + `e2e-a11y-closing.txt`; the original `5b1fdbb`/`9689037` evidence was not overwritten). One environment fix during the re-run: `vite preview` must be started with `BASE_PATH=/browser-todo-app/` (a bare preview 404s the hashed assets — probe harness detail, not product drift; noted so the next re-runner doesn't debug it blind).
