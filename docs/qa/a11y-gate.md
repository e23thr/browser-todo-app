# M13 Accessibility Release Gate — WCAG 2.2 AA + Thai-text accessibility

**Card:** t_b788bacf (Epic E5) · **Gate run:** 2026-10-25 · **Reviewer:** h_reviewer
**Re-run:** t_6bc6eda5 (after B1/B2) · **Re-run HEAD:** `5b1fdbb` · same date, same reviewer
**Verdict after re-run:** **FAIL — with-outstanding-O1 only.** B1 and B2 are **FIXED and
verified green** in the re-run (agent-side gate reads PASS-with-O1-pending); the release gate
stays FAIL until the human NVDA/VoiceOver pass (§5.2) is recorded or the PO records a waiver.
Details in §2.

| | |
|---|---|
| HEAD verified | **Re-run: `5b1fdbb`** (B2 `981c822` + B1 `86709cc` + manifest `5b1fdbb`; zero `src/` diff to current HEAD `2d86d06` — the two later commits are docs/tests only) · original run: `9689037` (product code identical to `c590ab2`) |
| Method | Real Chromium (Playwright) against the production build (`vite preview`, non-root base path `/browser-todo-app/`), axe-core `wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa`, in-page contrast math (WCAG 2.x relative luminance), scripted keyboard/announcement/zoom probes |
| Matrix | **67 axe scans clean at original HEAD** (54 desktop route/state × light/dark × en/th + 5 mobile routes @360px + onboarding + recovery ×2 themes + 4 status-rich states); **780 contrast samples, 0 below threshold**; 12 announcement scenarios; 200%/320px reflow in both locales. **Re-run at `5b1fdbb`:** 54/54 axe scans clean (0 violations of any impact) + 5/5 mobile clean + **12/12 announcements (en+th)** + 24/24 status-badge samples ≥4.5 + reflow/zoom green |
| Evidence | `docs/qa/a11y-gate-logs/` (22 JSON files + `keyboard-e2e-c590ab2.md` + re-runnable probes in `probes/`); **re-run at `5b1fdbb` refreshed** `axe-gate.json`, `announcements-gate.json`, `ci-routes-fresh-profile.json`, `axe-mobile-list.json`, `status-contrast.json`, `zoom-status-lang.json` + verbatim `*-rerun.txt` / `e2e-a11y-rerun.txt` run logs |
| Keyboard script | `docs/qa/keyboard-script.md` (10 core flows, expected announcements, en+th) |

> **The gate changed the code it is gating.** The first full matrix at `f18cc35` found
> **48 blocking violations in 28/54 scans** (`critical:label`, `serious:list`,
> `serious:target-size`) that CI never saw. They were fixed during the gate window
> (`b32cf9a` list semantics + target size, `ddd6e8f` file-input name, `2e6da03` false-wipe
> classification) and every scan was re-run clean at `c590ab2`. Archived: `axe-gate-f18cc35.json`,
> `axe-detail-f18cc35.json`, `visual-gate-f18cc35.json`.

---

## 1. Criterion-by-criterion verdict (WCAG 2.2 AA)

Originally verified at HEAD `9689037`, **both themes × both locales** unless noted; the B1/B2
rows were re-verified at `5b1fdbb` in the re-run (t_6bc6eda5) and are marked **⟳**.

| SC | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1.1.1 | Non-text content | **PASS** | axe 67 scans clean; priority/notes badges `role="img"` + `aria-label` (`TaskRow.tsx:274-287`); decorative dots/`due-marker` `aria-hidden` |
| 1.3.1 | Info and Relationships | **PASS** | axe `list` rule clean at HEAD (was `serious:list` at f18cc35 on `ul.task-list` → fixed in `b32cf9a`; group headers now plain `li`, verified `axe-mobile-list.json`); real `ul/li` + native checkboxes |
| 1.3.2 | Meaningful sequence | **PASS** | DOM order = visual order on all routes (axe + focus walk) |
| 1.4.3 | Contrast (minimum, 4.5:1) | **PASS** | 780 samples (16 route scans = 4 combos × `/`,`#/all`,`#/lists`,`#/settings` + 24 status-badge samples), **0 below 4.5** in light **and** dark, en **and** th (`visual-gate.json`, `status-contrast.json`); 1 axe-incomplete manually computed: dark row-menu text `#e9ecf2` on `#293039` ≈ **11.3:1** |
| 1.4.4 | Resize text (200%) | **PASS** | root font 32 px at 200%, **no horizontal scroll** on `/`,`#/all`,`#/lists`,`#/settings` in en and th; only "clipped" nodes are by-design: `.visually-hidden` live regions, 2-line-clamped task titles (full value in title attr + editor), tab labels <360 px (`zoom-status-lang.json`, `visual-gate.json`) |
| 1.4.10 | Reflow (320 px) | **PASS** | 320 px viewport, no zoom, both locales: `scrollWidth ≤ clientWidth` on all 4 routes (`zoom-status-lang.json`) |
| 1.4.11 | Non-text contrast (3:1) | **PASS** | axe `color-contrast` 0 violations; UI-component samples ≥3:1 in `visual-gate.json`; focus ring `#2e4fc4`/`#8ea8ff` ≥6.9:1 (design §12.2, re-sampled) |
| 1.4.12 | Text spacing | **PASS (indirect)** | all type in rem, line-height tokens 1.35–1.6 measured ≥ floor at 200% (`zoom-status-lang.json`: 0 elements below 1.35 except `view-title` exactly 1.35 = floor); dedicated 1.4.12 slider test not scripted |
| 1.4.1 | Use of color | **PASS** | overdue = **text** `Overdue · date` + `!` marker (`labels.ts:62`, `TaskRow.tsx:260-268`); priority = icon shape + `aria-label`; completed = checkbox state + `Completed on …` line (measured in th locale, `zoom-status-lang.json`) |
| 2.1.1 | Keyboard | **PASS** | keyboard script 10 flows; component keyboard suite 8/8 green in `npm run ci`; E2 real-browser pass 20/20 (`e2-core-ui.md §9`); reorder has first-class `Alt+↑/↓/Home/End` + menu equivalents |
| 2.1.2 | No keyboard trap | **PASS** | dialogs/drawer trap focus and release on `Esc` (component suites + probe focus walks on onboarding/recovery: 2-button cycle with `Esc` release) |
| 2.4.3 | Focus order | **PASS** | route change → focus `h1` (`tabindex="-1"`); confirm dialogs open focused on Cancel; focus never dropped to `body` after mutations (probe walks, `keyboard-e2e-c590ab2.md` steps 9–10) |
| 2.4.4 | Link purpose | **PASS** | nav links/tab labels all named in en+th (`axe-gate.json` link-name rules clean) |
| 2.4.7 | Focus visible | **PASS** | 3 px `:focus-visible` ring at every stop in all probe walks (`probe-onboarding-axe.json` focusWalks) |
| 2.5.1 | Pointer gestures | **PASS** | drag-reorder has keyboard (`Alt+…`) and menu (`Move up/Down`) equivalents (design §11.3, verified M6 card + component tests) |
| 2.5.7 | Dragging movements | **PASS** | same equivalents; `Esc` cancels a drag with announcement |
| 2.5.8 | Target size (min 24 px) | **PASS** | axe `target-size` 0 violations at HEAD (was `serious` at f18cc35 → fixed `b32cf9a`): effective targets measured — checkbox **44×44** via `.task-check-hit` label (`elementFromPoint` at all 4 edges hits the label), settings radios 18 px input inside **44 px-tall activating labels** (`hit-area-c590ab2.json`) |
| 3.1.1 | Language of page | **PASS** | `html lang` = `en` after English, `th` after Thai switch via Settings, both directions (`visual-gate.json` checks.lang) |
| 3.1.2 | Language of parts | **PASS (partial)** | locale-switched UI text follows `html lang`; **user-generated** task/list titles are not individually `lang`-marked (accepted: content authored in the active locale; Thai/English endonyms correct in both catalogs) |
| 4.1.2 | Name, Role, Value | **PASS** | axe `label` rule clean at HEAD (was `critical` on the hidden import picker → fixed `ddd6e8f`: `aria-label="Import…"` + `tabIndex=-1`, verified `axe-detail.json`) |
| 4.1.3 | Status Messages | **PASS ⟳ (B1 FIXED)** | re-run at `5b1fdbb`: **12/12 announcement scenarios HIT in en and th** (`announcements-gate.json` re-run, `announcements-rerun.txt`) — first task-add now lands ahead of the E3 persistence notice (`86709cc`: opt-in `{deferred:true}` announce). Was 10/12 at `9689037` (task-added MISS ×2) |

### PROJECT_ANALYSIS §8 extras (beyond WCAG)

| §8 item | Verdict | Evidence |
|---|---|---|
| axe automated checks wired **and green in CI** | **PASS ⟳ (B2 FIXED)** | re-run at `5b1fdbb`: `npm run e2e:a11y` **exit 0, 2/2 with the B2 guard enforcing real-shell scans** — the spec seeds the first-run dismissal via `seedOnboardingDone()` before navigation and asserts per route exactly one `nav[aria-label]` (+ `h1 'Today'` on Today routes), so onboarding-interception can no longer produce a vacuous green (`tests/e2e/a11y.spec.ts:30,41-46`; `e2e-a11y-rerun.txt`, fresh webServer, 0 port conflicts; axe tags + serious/critical threshold byte-identical). Fresh-profile product behavior is unchanged by design (`ci-routes-fresh-profile.json` re-run: 8/8 `onboarding=true` = correct first-run UX; CI now dismisses it before scanning). Was vacuous at `9689037` (8/8 routes scanned onboarding; consequence: 48 violations green at `f18cc35`) |
| Contrast ≥4.5/≥3 both themes | **PASS** | see 1.4.3/1.4.11 |
| Status never color-only | **PASS** | see 1.4.1 |
| `prefers-reduced-motion` | **PASS** | under `reduce`: **0** transition/animation durations >20 ms, 0 running animations (`visual-gate.json` checks.reducedMotion) |
| 200% zoom reflow incl. Thai diacritic stacking | **PASS** | see 1.4.4 + `e5-i18n.md` screenshot QA (4 shots: Thai marks stack cleanly, no clipping); line-heights ≥1.35 everywhere |
| ≥44 px touch targets (M8) | **PASS** | effective targets ≥44 px (label-based, measured); one exception: **skip link 43.59 px** (0.41 px under the 44 bar) — known defect **D1** from E5 QA, minor, passes WCAG 2.5.8 (24 px) — non-blocking |
| Live-region announcements for silent async changes | **PASS ⟳ (B1 FIXED)** | **12/12 in en and th** at `5b1fdbb` (`announcements-gate.json` re-run; per-scenario HIT list incl. both task-added sequences in `announcements-rerun.txt`). Was 10/12 at `9689037` (task-added MISS ×2) |
| `html lang` follows locale incl. SR language switching | **PASS (attr) / OUTSTANDING (SR)** | attribute switching verified both directions; actual NVDA/VoiceOver voice switching → §2 item O1 |
| Manual NVDA + VoiceOver passes (§8) | **OUTSTANDING (O1)** | not executable in this headless Linux environment (no Windows/macOS/iOS, no AT); scripted/automated equivalents done. **Requires a human pass on real platforms before release** |
| Written keyboard-only test script (10 flows) | **PASS (delivered)** | `docs/qa/keyboard-script.md` |

---

## 2. Blocking criteria (must fix before M13 can PASS)

**Re-run status (t_6bc6eda5, HEAD `5b1fdbb`): B1 ✅ FIXED · B2 ✅ FIXED · O1 ⏳ still outstanding.**

### B1 — First task-add announcement is swallowed (4.1.3 / §8 live regions) — ✅ FIXED (`86709cc`, verified in re-run)

On a fresh profile (or any first write where `persist()` was not granted), the sequence
`Enter` → `announce('Task added: …')` → persistence notice `announce('This browser did not
grant extra protection.')` cancels the pending task-add message inside the 60 ms announce
delay (`announce.ts` token supersede). The user hears the storage notice and **nothing about
their added task** — the single most common silent async change, and the literal example
PROJECT_ANALYSIS §8 uses.

- Reproduced at HEAD in **both locales**: `announcements-gate.json` (scenario `task-added`:
  MISS en + MISS th) and `task-added-followup.json` (add #1 misses, adds #2/#3 announce fine).
- E2 QA already classifies it **blocking**: `docs/qa/e2-core-ui.md` F-1 ("Major §8/M13
  announcement, Blocking: Yes"). Still open at `9689037`.
- Follow-up card: see completion `metadata.created_cards`.

**Fixed by `t_419ace90` (`86709cc`), verified in the re-run (t_6bc6eda5):**
`announce()` gained an opt-in `{deferred: true}` that holds a message past the 60 ms window —
only `noteFirstMeaningfulWrite` opts in — so on a session's first write the live region gets
`Task added: …` first and the E3 persistence notice ~500 ms later. Both land, in **both
locales**, with no change to any other caller's contract. Re-run proof: **HITS 12/12** at
`5b1fdbb` (`announcements-gate.json`, `announcements-rerun.txt` — first-add sequence:
`View: All open` → `Task added: Announce add` → `This browser did not grant extra protection.`).
Regression coverage: `tests/unit/announce.test.ts` (+2), new
`tests/unit/data-safety/persist-gate-announcements.test.ts`, `tests/component/core-ui-composer.test.tsx` (+1);
`npm run ci` exit 0 (**893/893**) in the re-run.

### B2 — CI's axe gate scans only the onboarding screen — ✅ FIXED (`981c822`, verified in re-run)

`tests/e2e/a11y.spec.ts` never dismisses E3's first-run onboarding. On a fresh CI profile,
`App.tsx` renders onboarding **instead of the shell regardless of hash route**, so all 8
`CORE_ROUTES` × 2 themes scan the same onboarding surface — which is clean, so the job is
green while providing **zero coverage of the application**.

- Proof: `ci-routes-fresh-profile.json` (8/8 routes `onboarding=true`, h1 = "Your data lives
  in this browser"); `axe-gate.json` `onboarding[*]` scans = 0 violations / 11 passes — the
  exact result CI reports.
- Consequence already demonstrated: the first matrix of this gate found **48 blocking
  violations at `f18cc35` while `npm run e2e:a11y` was green 2/2**.
- Fix (small): call `completeFirstRunOnboarding()` from `tests/e2e/sw-utils.ts` (the helper
  already exists — `1ff5744`/`9689037` applied the same fix to the SW and theme-boot specs)
  before the scan loop, then confirm the spec still passes **and** now reports the app's
  routes.

**Fixed by `t_36b4cf65` (`981c822`), verified in the re-run (t_6bc6eda5):** the spec now seeds
the first-run dismissal via the shared **`seedOnboardingDone()`** helper from
`tests/e2e/helpers.ts` (the AC-blessed mechanism used by `9689037`; implemented instead of the
proposed `sw-utils` helper — same marker, one mechanism across specs) before any navigation,
and asserts **per route** that the scan sees the real shell: exactly one `nav[aria-label]`
landmark + `h1 'Today'` on the Today routes, in both themes. axe tags and the
serious/critical threshold are byte-identical to HEAD. Re-run proof: `npm run e2e:a11y`
**exit 0, 2/2** at `5b1fdbb` with a fresh webServer and no port conflict (`e2e-a11y-rerun.txt`);
the assertions live inside the 8-route loop (`CORE_ROUTES`), so a regression to
onboarding-interception now **fails loudly instead of scanning onboarding**. Scope note: the
product behavior itself is unchanged (a genuinely fresh profile still shows first-run
onboarding — `ci-routes-fresh-profile.json` re-run: 8/8 `onboarding=true`); the fix is that CI
dismisses it before scanning.

### O1 — Manual NVDA / VoiceOver passes outstanding (release-blocking, not agent-executable)

§8 requires per-release manual passes with **NVDA (Windows)** and **VoiceOver (macOS/iOS)**.
This gate runs on headless Linux: neither AT nor the OSes are available. Everything scriptable
was scripted (axe, focus walks, keyboard flows, announcements, lang switching); the human AT
pass remains **owed before release**. Thai voice availability stays the documented known
constraint (design §11.4): where no Thai voice exists, verify `lang="th"` switching +
English-voice fallback instead. Record results (tester, platform, AT version, date) in §5.

---

## 3. Non-blocking findings

| # | Finding | Disposition |
|---|---|---|
| N1 | Skip link 180.9 × **43.59 px** — 0.41 px under the project's 44 px bar (passes WCAG 2.5.8) | Known **D1** (E5 QA `e5-shell.md`), already tracked; `min-height: var(--touch-min)` fixes it |
| N2 | `tests/e2e/core-ui-keyboard.spec.ts` (landed by `501ec64`; **not in CI**) failed 2/2 at `9689037`: (a) touch test strict-mode violation — two controls named "Add task" (empty-state CTA + FAB; not a WCAG failure, but ambiguous for voice control), (b) its `Task added` assertion = B1 | Test-maintenance; (b) should be resolved by the B1 fix (not re-run in t_6bc6eda5); fix the selector and add to CI |
| N3 | `npm run e2e:smoke` red at HEAD (6/7): fresh-profile onboarding intercepts shell assertions | **Not M13 scope** — same root cause as B2; h_pm already gates it via E1 (`t_d5ceab06` pattern) |
| N4 | Raw `<input>` boxes on Settings are 18 px; effective target = 44 px label | Informational — measurement method note for future probes |
| N5 | axe `incomplete: color-contrast(1)` on dark row-menu | Manually computed ≈11.3:1 → PASS (see 1.4.3) |
| N6 | User-generated titles not individually `lang`-marked (3.1.2 language of parts) | Accepted — authored in the active locale; revisit if cross-locale import is ever added |

## 4. What the gate verified as FIXED (re-audited at c590ab2)

| Was (f18cc35) | Now |
|---|---|
| `critical:label` — hidden import file input unnamed (4/4 settings scans) | fixed `ddd6e8f` — `aria-label` + `tabindex="-1"`; axe clean |
| `serious:list` — `ul.task-list` children with `role="presentation"` (16 scans) | fixed `b32cf9a` — group rows are plain `li`; axe clean desktop + mobile |
| `serious:target-size` — checkbox effective 22 px, overlapped by title (20 scans) | fixed `b32cf9a` — `.task-check-hit` label gives 44×44, no overlap; axe clean |
| False wipe: onboard → add nothing → reload → "We couldn't find your tasks" (blocked shell + keyboard e2e) | fixed `2e6da03` — wipe now requires evidence of prior data (`had-data` flag/backup/snapshot rows) |

## 5. Sign-off record

### 5.1 Automated (agent-executed) record — this gate run

| Field | Value |
|---|---|
| Themes scanned | light + dark (both, every scan set) |
| Locales scanned | en + th (both, every scan set; Thai switched through the real Settings UI) |
| axe tags | wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa |
| Screen readers | **NVDA / VoiceOver: NOT RUN here (O1)** — human pass pending, recorded in §5.2 below |
| Thai voice | known constraint per design §11.4 (record fallback verification when no Thai voice) |
| Re-run after fixes | `node docs/qa/a11y-gate-logs/probes/probe-axe.mjs` (+ `probe-announcements.mjs`, `probe-ci-routes.mjs`) against a fresh production build — **executed in t_6bc6eda5, results below** |

**Re-run record — t_6bc6eda5, 2026-10-25, HEAD `5b1fdbb` (real Chromium vs. production build):**

| Step | Command | Result |
|---|---|---|
| CI chain | `npm run ci` | **exit 0** — format, lint, typecheck, i18n:check, coverage (**893/893** tests), build, bundle budget all PASS |
| CI axe gate | `npm run e2e:a11y` | **exit 0, 2/2** with B2's shell-landmark guard live (`e2e-a11y-rerun.txt`; fresh webServer, 0 port conflicts) |
| Build + serve | `BASE_PATH=/browser-todo-app/ npm run build` then `BASE_PATH=/browser-todo-app/ npx vite preview --port 4188 --strictPort` | healthy preview; **BASE_PATH must be set for the preview too** (same gotcha as B1's run: without it vite mounts the artifact at `/` while index.html points at `/browser-todo-app/assets/*` → every asset 404s and probes stall in `createLists`) |
| `probe-axe.mjs` → `axe-gate.json` | 54 scans (2 onboarding + 4×13 route/state, light/dark × en/th) | **BLOCKING 0**; violations of any impact: **0**; notes: none |
| `probe-announcements.mjs` → `announcements-gate.json` | 6 scenarios × en + th (fixed matcher) | **HITS 12/12** (was 10/12) — B1 confirmed fixed |
| `probe-ci-routes.mjs` → `ci-routes-fresh-profile.json` | 8 `CORE_ROUTES` on a raw fresh profile | 8/8 `onboarding=true` — **expected per B2's scope** (B2 fixes the spec's dismissal + assertions; product first-run UX unchanged) |
| `probe-mobile-axe.mjs` → `axe-mobile-list.json` | 5 routes @360px | **all clean** (list children evidence unchanged) |
| `probe-status-contrast.mjs` → `status-contrast.json` | 24 status-badge samples + status-state axe | **0 below 4.5:1**; axe clean |
| `probe-zoom-status.mjs` → `zoom-status-lang.json` | 200% resize + 320px reflow, en + th | `hScroll=false` on all routes; clipped nodes = by-design tab labels; `view-title` line-height exactly 1.35 (= floor, unchanged) |
| Unit suite | `npm run test` | **893/893 pass** |

Commits landed during the re-run window (`501ec64` QA suites, `2d86d06` ADR docs) have a
**zero `src/` diff to `5b1fdbb`** — the gated product code equals current HEAD content.
Known workspace note: any `BASE_PATH` build rewrites `src/sw/precache-manifest.ts` with
different chunk hashes than the committed (default-base) manifest — restored to HEAD after the
re-run; the default-base build reproduces it byte-for-byte (churn is env-only, not drift).
At completion (04:57) a concurrent worker's in-flight edits (`src/features/search/SearchView.tsx`,
`tests/component/e2-core-ui-qa.test.tsx`, mtimes 04:53–04:56) make a fresh tree-wide
`format:check` warn on those two files — **not this gate's changes**; the gate's own
`npm run ci` ran **exit 0 at 04:31 on the `5b1fdbb` tree**, and lint + typecheck still pass
on the current tree (re-checked at completion).

### 5.2 Human AT pass (O1) — **EXECUTED 2026-10-25 (PARTIAL) — results recorded below**

> **Status: HUMAN PASS EXECUTED 2026-10-25 by the PO (Praphan), with a scope correction.**
> The pass ran under **Orca (Linux screen reader) in Firefox on Ubuntu 26.04** — the tester's
> available hardware — **NOT NVDA (Windows)** (tester clarification 2026-10-25; the submitted
> matrix's first column was labelled "NVDA (Win)" but was executed with Orca, and the results
> are recorded below under the correct AT identity). All 10 flows **PASS** under Orca.
> **VoiceOver (macOS) and VoiceOver (iOS): NOT EXECUTED — explicit PO waiver** (no Mac/iPhone
> available to the tester; see sign-off row). **NVDA (Windows): NOT RUN** — pending PO decision
> (waive or schedule). Tracked by card `t_2ce8fc1f`.

**Tester handoff — what to run:**

1. Build and serve the release candidate: `BASE_PATH=/browser-todo-app/ npm run build && npx
   vite preview --port 4173` → `http://127.0.0.1:4173/browser-todo-app/`, fresh browser
   profile (first-run onboarding present; complete it before Flow 1).
2. Execute `docs/qa/keyboard-script.md` in full — 10 core flows (capture, edit, complete,
   delete+confirm, lists, view navigation, search, reorder, move-to-list), keyboard only;
   every quoted "announce" line is the expected live-region content (en + th).
3. Repeat the AT matrix below on each platform: **NVDA (Windows)**, **VoiceOver (macOS)**,
   **VoiceOver (iOS)**. Run in light + dark, and in en + th where the row says so.
4. **Thai voice is a KNOWN constraint** (design §11.4): where no Thai voice exists, record
   `lang="th"` correctness + English-voice fallback instead of a Thai-voice pass.

**Result matrix — as executed 2026-10-25** (tester's submitted values preserved; first column
re-keyed from the submitted "NVDA (Win)" label to the AT actually used, per tester clarification):

| # | Surface (AT pass scope from §2-O1) | Orca (Linux / Firefox) — RUN | NVDA (Windows) | VoiceOver (macOS) | VoiceOver (iOS) |
|---|---|---|---|---|---|
| 1 | Task capture — "Task added: …" announced; composer keeps focus | PASS | NOT RUN | WAIVED (PO) | WAIVED (PO) |
| 2 | Task complete / uncomplete — state change announced | PASS | NOT RUN | WAIVED (PO) | WAIVED (PO) |
| 3 | Task delete — confirm dialog announced, result announced, focus lands sanely | PASS | NOT RUN | WAIVED (PO) | WAIVED (PO) |
| 4 | Dialogs — focus trap holds inside the dialog | PASS | NOT RUN | WAIVED (PO) | WAIVED (PO) |
| 5 | Dialogs — `Esc` closes | PASS | NOT RUN | WAIVED (PO) | WAIVED (PO) |
| 6 | Dialogs — focus returns to the trigger on close | PASS | NOT RUN | WAIVED (PO) | WAIVED (PO) |
| 7 | Search — result changes announced politely (count/updates) | PASS | NOT RUN | WAIVED (PO) | WAIVED (PO) |
| 8 | Language switch en→th — SR voice follows `html lang="th"` | PASS | NOT RUN | WAIVED (PO) | WAIVED (PO) |
| 9 | Language switch th→en — SR voice follows `html lang="en"` | PASS | NOT RUN | WAIVED (PO) | WAIVED (PO) |
| 10 | Thai-voice fallback (design §11.4) — `lang="th"` correct + English-voice fallback where no Thai voice | PASS | NOT RUN | WAIVED (PO) | WAIVED (PO) |

**Sign-off fields:**

| Field | Value |
|---|---|
| Tester | Praphan (PO) |
| Platform(s) | Ubuntu 26.04, Firefox (as submitted by tester) |
| AT version(s) | Orca (Linux screen reader; version not recorded); NVDA not run; VoiceOver not run |
| Date | 25 Oct 2026 |
| Overall result | **PARTIAL PASS** — 10/10 flows PASS under Orca (Firefox/Ubuntu); VoiceOver waived (PO); NVDA outstanding |
| Flows script | `docs/qa/keyboard-script.md` — 10/10 flows: **PASS** (Orca, Firefox) |
| Waiver (only if a part is not executed) | **PO-accepted explicit waiver, 2026-10-25 (card `t_2ce8fc1f`):** VoiceOver (macOS) and VoiceOver (iOS) not executed — no Mac/iPhone available to the tester. Thai-voice rows: §11.4 constraint handled per row 10 (`lang="th"` correctness + English-voice fallback). NVDA (Windows): **NOT waived** — pending PO decision (waive or schedule). |

**Gate verdict — original run (t_b788bacf, `9689037`):** FAIL — B1 + B2 blocking, O1 outstanding.

**Gate verdict — re-run (t_6bc6eda5, `5b1fdbb`): FAIL — with-outstanding-O1 only.**
B1 ✅ FIXED (`86709cc`) and B2 ✅ FIXED (`981c822`): every agent-executable criterion is green
— CI chain exit 0 (893/893), `e2e:a11y` 2/2 with the shell-landmark guard live, axe **0
blocking / 0 violations** across 54 + 5 scans, announcements **12/12 (en + th)**, status
contrast and 200%/320px reflow re-confirmed (§5.1 re-run record). The **agent-side gate reads
PASS-with-O1-pending**. The **release gate remains FAIL** solely because O1 — the human
NVDA/VoiceOver pass — is still PENDING in §5.2 with no PO waiver recorded. Per h_pm
(`t_2ce8fc1f`): a green re-run clears **B1 + B2 only**; M13's epic acceptance criterion may be cleared once §5.2 carries the manual-pass record or a PO-accepted waiver.

**Gate verdict — human AT pass recorded (t_2ce8fc1f, 2026-10-25): PARTIAL PASS — O1 substantially cleared.**
The human pass is now executed and recorded in §5.2: **10/10 flows PASS under Orca (Firefox / Ubuntu
26.04, PO as tester)**, plus an **explicit PO waiver for VoiceOver (macOS) and VoiceOver (iOS)**
(no Mac/iPhone available). This satisfies §5.2's "manual-pass record or a PO-accepted waiver" for
those platforms. The release gate moves from FAIL to **CONDITIONAL PASS**. One open item remains:
**NVDA (Windows) was never run** (the tester's environment is Ubuntu; the submitted matrix's
"NVDA (Win)" column was actually Orca — corrected above). M13 reaches full PASS when either an
NVDA (Windows) pass is recorded or the PO extends the waiver to NVDA explicitly. Per h_pm
(`t_2ce8fc1f`): a green re-run clears **B1 + B2 only**; M13's epic acceptance criterion may be
cleared once §5.2 carries the manual-pass record or a PO-accepted waiver.
