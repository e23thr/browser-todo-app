# MVP Definition-of-Done release gate — PROJECT_ANALYSIS §12 Q15

**Card:** t_7f1e8f29 (h_reviewer) · **Run date:** 2026-10-25 · **Release HEAD verified:** `225a1f3`
(local first-hand battery at `e584488`; `src/` is **byte-identical** `e584488..225a1f3` — the
intervening commits touch only `docs/`, `tests/` and `playwright.config.ts`; the temporary
`ci.yml` diagnostic step added in `e387889` was removed again in `225a1f3` (net zero vs
`e584488`), and the GitHub Actions run at `225a1f3` covers the rest too).

**Verdict: 🔴 BLOCKED — release-blocking a11y finding on criterion 4 (§7).** Criteria 1, 2, 3
and 5 are green first-hand, including the previously blocked Q11/C5: CI run **40197229692** at
release HEAD `225a1f3` is **12/12 jobs green** (`bundle-budget` 65.6/100.0 KB PASS + `deploy`),
and `https://e23thr.github.io/browser-todo-app/` serves **the exact build of that commit** (§2.6,
§3). **Criterion 4 (WCAG 2.2 AA): `docs/qa/a11y-gate.md` reads FULL PASS with explicit PO
waivers — but this gate run reproduced a live SC 4.1.3 violation at release HEAD**: the
`a11y.taskSaved` status message is intermittently cancelled by the deferred-announce hand-over
(§7; evidence `docs/qa/mvp-dod-logs/announce-taskSaved-race.md`), so the keyboard core-loop e2e
spec fails **6 of 8 initial attempts** here. Per this card ("a FAIL is release-blocking and must
be escalated") the gate escalates with `kanban_block(kind=needs_input)` — options in §6. The
**"30 days of daily use" element remains PO-PENDING by design** (§2.2) and still blocks nothing.

---

## 1. First-hand verification runs (this gate, at `e584488`)

| # | Command | Result |
|---|---|---|
| 1 | `npm run ci` (format:check → lint → typecheck → i18n:check → test:coverage → build → budget) | **exit 0** — prettier clean, eslint `--max-warnings 0`, `tsc -b` clean, i18n **339 en / 339 th keys** parity PASS, **913/913 tests (78 files)**, coverage `All files 85.48/79.90/84.72/87.86`, `src/domain 97.51/87.05/99.44/99.13`, `src/storage 96.03/93.47/98.73/97.67` (≥80 % gates PASS), build OK, **budget PASS** |
| 2 | `CI=true npm run e2e:data-safety` | **16/16 passed, exit 0** — incl. drill 1 (export → wipe → import → byte-equivalent restored, offline), hostile imports, quarantine, quota atomic-abort, snapshot rotation/undo |
| 3 | `CI=true npm run e2e:sw` | **16/16 passed, exit 0** — offline boot, `add → complete → reload → data present` offline, offline-write-survives-reload, degraded network, §9.1 boot budget, **MVP install scope (PO Q12)** |
| 4 | `CI=true npm run e2e:smoke` | **8/8 passed, exit 0** — non-root base path, hash routes, CSP listener, zero third-party |
| 5 | `CI=true npm run e2e:a11y` | **2/2 passed, exit 0** — B2 shell-landmark guard live |
| 6 | `CI=true npx playwright test --project=chromium` on `core-ui-keyboard` + `qa-search-reorder` + `qa-f2-remeasure` | **9/9 passed, exit 0** — keyboard-only capture→edit→complete→delete→delete-list, **touch targets @375 px and @320 px ≥44×44**, search @10k latency, virtualization windowing, keyboard↔drag reorder byte-parity ⚠️ *run at `e584488`; **NOT reproducible at release HEAD** — `core-ui-keyboard` now fails 6/8 attempts (§7)* |
| 7 | `node docs/qa/mvp-dod-logs/probes/probe-offline-mobile.mjs` (new gate probe, see §2.1) | **PASS — 14/14 steps** across 375×667 and 320×640, **0 console errors** (`docs/qa/mvp-dod-logs/offline-mobile-probe.json`) |
| 8 | `npm run audit:gate` + `npm audit` | **0 vulnerabilities** (prod and dev) |
| 9 | default-base `npm run build` after restoring `src/sw/precache-manifest.ts` | **`[unchanged]`** (shellVersion `c6bef87e0491796c`) — ADR-005 Decision 2 freshness gate green; `git status src/` clean |
| 10 | scope-fidelity source scans (§3) | zero hits for manifest/install-prompt, attachments/OPFS, accounts/auth/cookies, telemetry/third-party requests |
| 11 | `gh run view 40197229692` (real GitHub Actions, release HEAD `225a1f3`) | `conclusion: success` — **12/12 jobs green**: lint, typecheck, unit (**914/914 tests, 79 files**, coverage gate), build, precache-freshness (`[unchanged]`, shellVersion `c6bef87e0491796c` = run 9), **bundle-budget** (`initial-js 65.6 KB / 100.0 KB PASS`, `RESULT: PASS`), audit, e2e:sw (**14 passed + 2 flaky** — E9 mid-edit-flush + stale-tab-guard retried green on the runner; first-hand locally 16/16, run 3), e2e:data-safety (**16 passed**), e2e-smoke (**8 passed**), a11y-axe (**2 passed**), **deploy** |
| 12 | `gh run list` (run history) | `40196895952` (at `e387889`) also **success 12/12** → two consecutive green runs; the two earlier reds (`40194624821` unit ENOENT, `40196421582` Playwright webServer timeout) are precisely the defects fixed by parents `t_61309e52` and `t_46622f83` — both landed, both re-verified green in CI |
| 13 | `curl -sI https://e23thr.github.io/browser-todo-app/` + local rebuild compare | **HTTP 200**, `last-modified: 2026-10-25T13:23:03Z` (= the deploy of run `40197229692`); `BASE_PATH=/browser-todo-app/ npm run build` at `225a1f3` yields a `dist/index.html` **byte-identical** to the live document (same 4 asset hashes: `index-CA0Rb68-.js`, `snapshots-api-B23rPcZQ.js`, `dbAccess-Bx1kHfMa.js`, `index-B7sWvTs_.css`) → the live site serves the exact build of release HEAD |
| 14 | Pages `deploy` job log (`--job=121180923318`) | `pages_build_version: 225a1f380879eeb4b0fc4930038d56b3e9a8dee5` — **the deployed Pages build IS release HEAD**; `Created deployment for 225a1f3…`, `Reported success!`, evaluated `url: https://e23thr.github.io/browser-todo-app/`. Only warning in the whole run: Actions warn that actions targeting Node.js 20 are forced onto Node.js 24 (runner-side deprecation notice, not a failure) |
| 15 | `npm run ci` re-run at release HEAD `225a1f3` (report finalization) | **exit 0** — format/lint/typecheck/i18n/test:coverage/build/budget, `initial-js 65.5/100.0 KB PASS`, precache `[unchanged]` (`c6bef87e0491796c`) |
| 16 | the four CI e2e suites re-run first-hand at `225a1f3` | `e2e:sw` **16/16**, `e2e:data-safety` **16/16**, `e2e:smoke` **8/8**, `e2e:a11y` **2/2** — all exit 0 |
| 17 | `CI=true npm run e2e` ×4 + isolated `core-ui-keyboard` ×4 at `225a1f3` | **NEW RELEASE-BLOCKING FINDING** — the keyboard core-loop spec fails **6/8 initial attempts** with `polite announcement "Task saved" was never made`; root-caused from the runs' own traces → **§7**, evidence `docs/qa/mvp-dod-logs/announce-taskSaved-race.md`, probe `docs/qa/mvp-dod-logs/probes/scan-announce-trace.py` |

---

## 2. Q15 criterion-by-criterion

Q15 (DECIDED, PO 2026-10-23): *capture→complete works offline on desktop + mobile through 30 days
of daily use with zero data loss; export/restore verified; WCAG 2.2 AA passed; budgets green in CI.*

### 2.1 C1 — capture→plan→complete loop works offline on desktop AND mobile viewports — **PASS**

| Layer | Evidence |
|---|---|
| Desktop × offline | `e2e:sw` **16/16** first-hand (runs 3): offline boot keeps the whole app working, `add → complete → reload → data present`, offline write survives offline reload, degraded-network writes stay durable |
| Mobile viewports (320/375 px) | run 6 first-hand: **9/9** incl. touch @375/@320 ≥44×44 and the keyboard-only F1→F6 loop; E2 `e2-epic-verification.md` §7.3/§7.4 (320/375 px flows, axe 0, touch 11/11) |
| **Mobile × offline (the intersection — new probe)** | `docs/qa/mvp-dod-logs/probes/probe-offline-mobile.mjs` → **PASS 14/14** at 375×667 and 320×640: SW controls the page → `setOffline(true)` → capture on `#/all` → **plan** (due-today chip → task is a member of `#/today`) → complete → **offline reload boots the shell** (`h1="Today"`) → completed task present + checked in `#/completed`. Zero console errors. Evidence: `docs/qa/mvp-dod-logs/offline-mobile-probe.json` |

Why the probe exists: E4's offline suites are desktop-only and E2's 320/375 px runs are online —
Q15 requires both at once. The probe drives the real UI (composer, editor, date chip, checkbox)
against the production build served under the Pages base path.

### 2.2 C1b — "through 30 days of daily use" — **PO-PENDING (by design)**

Not automatable. Sign-off request left as a `kanban_comment` on this card for the PO; this report
does **not** claim it.

### 2.3 C2 — zero data loss across the whole test cycle — **PASS**

- **Mechanisms, first-hand at HEAD:** `e2e:data-safety` **16/16** (hostile/malformed imports → zero
  DB writes and no snapshot; corrupt records quarantined to a recovery document that is never
  persisted/importable; `QuotaExceededError` aborts atomically — deletes roll back; snapshot
  rotation last-3 + pre-import snapshot undo byte-equivalent incl. undo-of-undo); `e2e:sw` **16/16**
  (offline durability); unit suite **913/913** incl. the storage corruption drills (23+ scenarios),
  the portability export/import/deleteAllData suite (fresh-profile settings equality), and the
  identity drill *"a quarantined meta survives purge + reboot — deviceId is never reset
  (ADR-002 §3.1)"* — the **purge/identity re-check E1 handed to this gate**.
- **Defect register at HEAD — no open data-loss defect:** E1 D1–D7 all fixed (`bb347b5` Tx.get
  denylist + ADR-004 recovery format, `8580853` D3–D6 incl. atomic purge pass); E2 F-1/F-2/F-3,
  V1, QA-D1 all fixed (`86709cc`, `b32cf9a`, `924c17f`, `c652340`, `cec79ba`); E4's cross-app cache
  purge defect D1 fixed (`75b573b`); E3 all 6 ACs met. Residual advisories are **not** data-loss
  class: E2 QA-D2/D3 (advisory, aggregate gates pass), E5 D1–D4 + 7 design discrepancies,
  E3 §5 iOS-eviction residual (PO-accepted, structural fix = V1 S13).
- **Across the cycle:** every epic's closing gate battery is green at HEAD-equivalent commits, and
  this run reproduced the full battery first-hand with zero failures (§1).

### 2.4 C3 — export/restore verified (export → wipe → import → restored) — **PASS**

Drill 1 green **first-hand in this run** (`e2e:data-safety` 16/16, run 2): scripted **offline**
export → wipe → import → byte-equivalent restore in a real Chromium with real IndexedDB
(records + settings byte-equivalent, tombstones restored, zero network requests). CI job
`e2e-data-safety` runs it on every PR/push (`ci.yml:199`). Backing unit suites (export/import/
apply, 116+ tests) green inside the 913-test run.

### 2.5 C4 — WCAG 2.2 AA passed — **❌ BLOCKED (§7): the gate report says PASS, this run reproduced an SC 4.1.3 violation**

`docs/qa/a11y-gate.md` reads **FULL PASS with explicit PO waivers** (verdict trail §5.2: original
FAIL (B1+B2+O1) → re-run FAIL-with-outstanding-O1 → O1 recorded → FULL PASS; closing-HEAD spot
re-check §5.3 at shipped HEAD `e8ee00d`: 54 axe scans 0 violations, announcements 12/12, reflow/
contrast clean, `e2e:a11y` 2/2). This gate re-ran `e2e:a11y` first-hand today: **2/2** (run 5).

> **Waiver note, verbatim from `a11y-gate.md` §5.2 (sign-off field):** **PO-accepted explicit
> waiver, 2026-10-25 (card `t_2ce8fc1f`):** VoiceOver (macOS), VoiceOver (iOS) and NVDA (Windows)
> not executed — no Mac/iPhone/Windows hardware available to the tester. The submitted matrix's
> "NVDA (Win)" column was executed with Orca (Linux) and is recorded as such above. Thai-voice
> rows: §11.4 constraint handled per row 10 (`lang="th"` correctness + English-voice fallback).

Human AT pass: **Orca (Linux screen reader) / Firefox / Ubuntu 26.04, PO as tester, 10/10 flows
PASS, 2026-10-25** (`docs/qa/keyboard-script.md`). Not a bare PASS — the waivers above are part
of the verdict and must travel with it.

> **⚠️ Blocker found by this gate (2026-10-25, release HEAD `225a1f3`):** the waiver note above
> still travels with `a11y-gate.md`'s verdict, but **C4 cannot be signed while §7 stands.** The
> `a11y.taskSaved` status message is cancelled by the deferred-announce hand-over on **6 of 8**
> keyboard core-loop attempts — WCAG 2.2 **SC 4.1.3** and design `core-domain.md` §5.5
> (`a11y.taskSaved` required on edit save). The gate report's announcement probes (12/12) do not
> cover the save-vs-deferred-persistence collision, so its FULL PASS record is *incomplete* rather
> than self-contradicted. Recorded as a **FAILED criterion** and escalated per the card (§6).

### 2.6 C5 — budgets green in CI (bundle §9.2 + measured perf §9.1) — **PASS** (real GitHub Actions run)

Resolved per the PO's decision of 2026-10-25 ("create the GitHub repo and push — **no waiver, no
local-evidence substitution**"): the repository **`e23thr/browser-todo-app`** exists, `origin/main`
= release HEAD `225a1f3`, the workflow executes for real, and the deployment is live. Verified
first-hand in this gate run:

- **Hosted CI — the criterion's literal requirement:** `gh run view 40197229692` at `225a1f3` →
  **`conclusion: success`, 12/12 jobs green**: lint, typecheck, unit, build, precache-freshness,
  **bundle-budget**, audit, e2e:sw, e2e:data-safety, e2e-smoke, a11y-axe, **deploy** (on the
  runner e2e:sw reports 14 passed + 2 flaky-retried-green; first-hand locally it is 16/16). Run
  `40196895952` (at `e387889`) is green the same way — **two consecutive green runs**. The two
  earlier reds (`40194624821`, `40196421582`) are exactly the defects this gate's parents
  `t_61309e52` (machine-local evidence paths → ENOENT) and `t_46622f83` (Playwright webServer
  bound `::1` while the poll hit `127.0.0.1` → 180 s timeout) were created to fix; both landed
  and are proven green in the hosted runs.
- **§9.2 bundle budgets inside that run:** `bundle-budget` job log → `initial-js 65.6 KB /
  100.0 KB PASS`, `RESULT: PASS` (first-hand locally at `e584488`: css 6.7/20 KB, app-shell
  81.4/200 KB, locales 12.7/20 KB, locales-lazy 0, no-external-refs 0, no-wasm 0).
- **§9.1 measured perf rows** (first-hand; `src/` byte-identical `e584488..225a1f3`): boot /
  offline start-to-interactive <300 ms (40/40 samples), search ≤17.9 ms @10k, add→visible
  1.7–3.4 ms, boot@10k 52.6 ms, virtualization <200 DOM rows (33 of 1,200), 60 fps / 0 dropped
  frames — E2 `e2-epic-verification.md` §7.4 + E4 `e4-epic-close-boot-budget.json`.
- **Pipeline definition:** `.github/workflows/ci.yml` runs every §9.5 gate on PR/push with a
  green-main-only `deploy` job; `nightly.yml` holds the cross-browser matrix. The same command
  chain is also exit 0 locally (§1 runs 1–8).

**What was the blocker (now cleared):**

- At attempt 1 of this gate there was **no git remote at all** and no repository anywhere in the
  authenticated account/orgs, so GitHub Actions and GitHub Pages had never executed; E1's closure
  handoff had explicitly assigned *"the DoD gate should confirm the GitHub Actions run itself"* and
  *"a real GitHub Pages deployment run has still never been exercised from this host — the one
  remaining unverified link in the deploy chain"* to this gate. The gate escalated with
  `kanban_block(kind=needs_input)` (options in §6) rather than sign an unverifiable criterion.
- The PO then chose option A — *"resolve criterion 5 and Q11 FOR REAL; no waiver, no local-evidence
  substitution"* — h_pm created and pushed `e23thr/browser-todo-app`, parents `t_61309e52` +
  `t_46622f83` fixed the two red runs, and this run re-verified the outcome first-hand:
  `git remote -v` → `origin https://github.com/e23thr/browser-todo-app.git`;
  `git ls-remote origin main` → `225a1f380879eeb4b0fc4930038d56b3e9a8dee5`.

**C5 = PASS** — hosted CI green with the `bundle-budget` job green *inside CI*, §9.1 rows measured
green on byte-identical `src/`, local battery exit 0 (§1 runs 1–9). **Consequence for Q11 (§3):**
the live deployment is verified (§1 run 13), so Q11 now passes fully too.

---

## 3. Scope-fidelity audit (Q7 / Q9 / Q11 / Q12 / §2+§7.2)

| Scope rule | Source | Verdict | Evidence (first-hand this run) |
|---|---|---|---|
| **NO manifest / install prompt in MVP** | PO Q12 (§4 M9, §12) | **PASS** | `grep -ri 'beforeinstallprompt\|webmanifest\|rel="manifest"\|manifest.json'` over `src/`, `public/`, `index.html` → **0 hits**; `public/` contains only `favicon.svg`; `e2e:sw`'s *"MVP install scope (PO Q12) — no web manifest and no install prompt anywhere"* green in run 3 (16/16) |
| **NO attachments (no OPFS investment)** | PO Q7 (§4 WON'T) | **PASS** | `grep -ri 'attachment\|OPFS\|origin.private' src/` → **0 hits**; no file-input anywhere except the import picker (data portability, §7.4) |
| **English + Thai both complete** | PO Q9 (§4 M15) | **PASS** | `i18n:check` PASS **339 en / 339 th keys**, placeholders consistent (run 1); E5 handoff: per-locale lazy packs **13.0 KB gzip ≤ 20 KB**, `html lang` tracks the locale both directions, localized document title/meta, zero webfont bytes (Thai = OS fonts) |
| **GitHub Pages deploy with base-path config** | PO Q11 (§9.5) | **PASS (config + live deploy)** | Config: `ci.yml:22` `BASE_PATH: /${{ github.event.repository.name }}/`, `deploy` job (`configure-pages` → `upload-pages-artifact` → `deploy-pages`, green-main-only, after all gates); `vite.config` `base: normalizeBase(process.env.BASE_PATH)`; README Pages-enable instructions; `e2e:smoke` *"boots under a non-root base path with no failed asset requests"* green (run 4). **Live:** `deploy` job green in CI run `40197229692`; `https://e23thr.github.io/browser-todo-app/` **HTTP 200**, and its `index.html` is **byte-identical** to a local `BASE_PATH=/browser-todo-app/ npm run build` of `225a1f3` (same asset hashes `index-CA0Rb68-.js`, `snapshots-api-B23rPcZQ.js`, `dbAccess-Bx1kHfMa.js`, `index-B7sWvTs_.css`) → the release build is served live under the correct base path (§1 run 13) |
| **No accounts / backend / telemetry** | §2 out-of-scope, §7.2 policies | **PASS** | `grep -ri 'password\|signin\|oauth\|document.cookie\|sendBeacon\|analytics\|gtag\|cdn\.\|unpkg\|jsdelivr' src/` → **0 relevant hits** (only same-origin SW cache `fetch` in `src/sw/sw.ts:75`); budget gate **no-external-refs 0 hits** across the 12 shipped files; CSP meta ships the exact §7.2 directive set (`connect-src 'self'`, no `unsafe-inline`, `frame-ancestors` dropped as the documented GitHub-Pages exception); **npm audit 0 vulnerabilities** |

**Also honored (checked, not requested):** no server we operate (Q2), plain-text notes only (Q13),
no recurrence (Q5), JSON export/import only (Q8), keep-completed-forever (Q14), modern-only
browser floor (Q10).

---

## 4. Evidence durability (landing sweep performed by this run)

Per the standing rule ("untracked QA evidence is not done"), this gate landed the outstanding
evidence in the same commit as this report:

- `docs/qa/e1-epic-verification.md`, `docs/qa/e1-scaffold-gates.md` (+ `-logs/`), `docs/qa/e1-storage.md` (+ `-logs/`)
- `docs/qa/e3-epic-verification.md`, `docs/qa/e3-data-safety-ux-review.md`
- `docs/qa/e4-epic-close.md`, `docs/qa/e4-epic-close-boot-budget.json`, `docs/qa/e4-offline.md` (+ `-logs/`)
- `docs/BACKLOG.md`
- this report + `docs/qa/mvp-dod-logs/` (probe + JSON evidence)

After the sweep `git status` shows **zero untracked and zero modified product files** at `e584488`.

---

## 5. What the V1/stretch epics may assume is in place

1. **Core loop (M1–M6)** — capture → today/next-7/all-open/per-list/completed views → complete/
   uncomplete, search, per-list manual reorder (keyboard + drag), virtualized lists: works
   **offline on desktop and on 320/375 px mobile viewports** (incl. this gate's mobile-offline
   probe), with keyboard equivalence for every gesture, ≥44×44 touch targets, per-region
   announcements (§5.5).
2. **All §9.1 performance rows met (measured)** and **all §9.2 bundle budgets green**; `npm run ci`
   is the release battery and it is exit 0 at `e584488`; the same battery runs green **in GitHub
   Actions** (run `40197229692`, 12/12 jobs at `225a1f3`); `npm audit` 0 vulnerabilities.
3. **Data safety (M10–M12)** — export→wipe→import byte-equivalent restore, snapshots (last-3 +
   manual permanence), pre-import snapshot undo, hostile-import rejection, quarantine-to-recovery
   (never silent), quota atomic abort, purge/identity (deviceId survives purge+reboot), settings
   defaults single-sourced from `src/domain/model.ts` `DEFAULT_SETTINGS`.
4. **WCAG 2.2 AA: FULL PASS with explicit PO waivers — with one open exception (§7):** Orca 10/10
   + PO waivers for NVDA/VoiceOver — carry the §2.5 waiver note verbatim; do not restate as a bare
   PASS. **Exception:** the `a11y.taskSaved` deferred-announce race is unfixed at `225a1f3`
   (SC 4.1.3, 6/8 keyboard attempts) — do **not** assume the save announcement is reliable until
   fix card `t_bb9053ec` lands (or the PO waives it in writing).
5. **Bilingual en+th complete** (339 keys, parity-checked, lazy packs ≤20 KB), flash-free theming
   3 modes, `html lang` tracks locale, zero webfont bytes.
6. **Scope floor:** no manifest/install surface (**S13 must add it — first V1 item**), no
   attachments, no accounts/backend/telemetry, CSP meta per §7.2, ADR-002 schema zero drift,
   precache-manifest freshness gate green.
7. **NOT in place (do not assume):** (a) ~~hosted GitHub Actions run / live GitHub Pages
   deployment~~ — **now in place** (CI run `40197229692` 12/12 green at `225a1f3` and
   `https://e23thr.github.io/browser-todo-app/` serving the release build — §2.6/§3); (b) the
   PO's 30-day usage sign-off (PO-PENDING); (c) an
   end-to-end multi-tab UX pass (never an MVP AC — schedule separately if wanted); (d) residual
   non-gating polish register (`e5-epic-verification.md` §5).

---

## 6. Open items, escalation and sign-off

1. **RESOLVED — criterion 5 / Q11 live deploy (was escalated `kind=needs_input`; PO decision
   2026-10-25 chose option A: "resolve FOR REAL — no waiver, no local-evidence substitution"):**
   - h_pm created and pushed **`https://github.com/e23thr/browser-todo-app`** (public; Pages
     enabled with Actions as source → `https://e23thr.github.io/browser-todo-app/`).
   - First run `40194624821` went red on two defects → parents `t_61309e52` (machine-local
     evidence paths) and `t_46622f83` (Playwright webServer `::1`/`127.0.0.1` bind mismatch);
     both landed (`7fe1297`, `e387889` + `225a1f3`).
   - **Re-verified first-hand by this gate:** run **`40197229692`** at release HEAD `225a1f3` =
     `conclusion: success`, **12/12 jobs green** (incl. `bundle-budget` 65.6/100.0 KB PASS and
     `deploy`); run `40196895952` green too; Pages **HTTP 200** and its `index.html`
     **byte-identical** to a local `BASE_PATH=/browser-todo-app/` build of `225a1f3`
     (§1 runs 11–13, §2.6, §3). **No waiver used — C5 and Q11 are signed PASS on hosted
     evidence.**
2. **🔴 BLOCKING — criterion 4 (WCAG 2.2 AA), new first-hand evidence at release HEAD —
   escalated with `kanban_block(kind=needs_input)`:** this run reproduced `a11y.taskSaved` being
   cancelled by the deferred-announce hand-over in **6 of 8** attempts of the keyboard core-loop
   spec (§7; evidence `docs/qa/mvp-dod-logs/announce-taskSaved-race.md`). What the PO/PM must
   choose:
   - **Option A (recommended):** fix the announcer so a deferred hand-over never cancels a pending
     non-deferred message in the same region (root cause + fix direction in §7), land it, re-run
     `core-ui-keyboard` + the announcement probes + `e2e:a11y`, then this gate re-verifies and
     signs C4. Fix card **`t_bb9053ec`** (`h_senior_coder`) is already created for this — the
     announcer contract is subtle and carries the M13-B1 history.
   - **Option B:** PO accepts the known intermittent dropped `"Task saved"` announcement for MVP as
     an explicit written waiver recorded next to this report — C4 then reads *"PASS with PO
     waivers incl. the SC 4.1.3 deferred-announce race (known issue, post-MVP fix)"*, and the
     waiver must note that `nightly.yml` (full suite) stays red until the fix lands.
3. **PO-PENDING — 30 days of daily use:** sign-off request left as a `kanban_comment` on this
   card (and repeated at escalation). Not claimed by this report; the only unsigned element and,
   per the card's design, not a blocker for this gate.
4. Non-blocking, already green but noted: `src/sw/precache-manifest.ts` freshness is re-verified
   in this run (§1 run 9) **and** by CI's `precache-freshness` job in `40197229692`; E2's
   advisory QA-D2/D3 stand as recorded.

**Until item 2 is decided, this gate does not sign the MVP Definition of Done.** Everything else
in the DoD is green first-hand: **C1, C2, C3, C5 and the scope-fidelity audit (Q7 / Q9 / Q11 /
Q12 / §2 + §7.2) all PASS** (§2.1–§2.4, §2.6, §3), and the only other open element remains the
PO's 30-day usage sign-off (item 3).

---

## 7. Release-blocking finding — `a11y.taskSaved` is dropped by the deferred-announce hand-over

**Criterion: 4 (WCAG 2.2 AA) · Severity: blocking · Status: reproduced + root-caused, unfixed**

- **Symptom:** `tests/e2e/core-ui-keyboard.spec.ts:290` fails at `expectPolite(page, 'Task saved')`
  (line 388) with *"polite announcement \"Task saved\" was never made"* — **6 of 8 initial
  attempts** across full-suite and isolated runs at `225a1f3` (§1 run 17). The save itself always
  succeeds (dialog closes, title becomes `Buy oat milk`); only the status message never reaches
  the live region.
- **Mechanism:** `src/app/announce.ts` — each region has one pending slot; `announce()` lands the
  text 60 ms later unless a newer `announce()` on the same region bumps the token (lines 140–152).
  A `deferred` message (E3's first-write persistence notice, `persistGate.ts:65`, hold = 500 ms)
  hands over by calling `announce()` again (lines 128–136) → **token bump → the pending
  `a11y.taskSaved` (`TaskEditor.tsx:124`) is silently dropped** whenever the save happens in the
  ~55 ms before the hold expires. Failing-trace region sequence: `'Task added: Walk dog'` → `''`
  (save issued) → `'This browser did not grant extra protection.'` — `'Task saved'` never appears
  in any snapshot or in the test's 20 s `MutationObserver` recording; in the passing attempt the
  same message lands after the hold has expired.
- **Why nobody caught it:** `tests/unit/announce.test.ts:137` only covers a deferred notice racing
  an *already landed* message, not a *pending* one; the a11y gate's 12 announcement probes do not
  include the save-vs-persistence collision; and the PR CI gate does not run this spec (only
  `nightly.yml` runs the full suite → nightly will be red).
- **Consequences:** WCAG 2.2 **SC 4.1.3** (AA) for that save; design `core-domain.md` §5.5
  requires `a11y.taskSaved` on edit save; the M13-B1/E2 F-1 fix class is incomplete in the other
  direction.
- **Evidence / repro:** `docs/qa/mvp-dod-logs/announce-taskSaved-race.md` (A/B trace sequences,
  arithmetic, repro commands) and probe `docs/qa/mvp-dod-logs/probes/scan-announce-trace.py`.
- **Not applied here:** this gate does not fix code — fix direction is written down in the
  evidence note and routed as a card (§6 item 1, Option A).
