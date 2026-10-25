# MVP Definition-of-Done release gate — PROJECT_ANALYSIS §12 Q15

**Card:** t_7f1e8f29 (h_reviewer) · **Run date:** 2026-10-25 · **HEAD verified:** `e584488`
(working tree `src/`, `tests/`, `scripts/` byte-clean vs HEAD for every run below; only this
report's own files are new).

**Verdict: BLOCKED — criterion 5 escalated (`kind=needs_input`).** Four of the five Q15 criteria
are verified green first-hand; the "30 days of daily use" element is PO-PENDING by design; the
remaining element of criterion 5 ("budgets green **in CI**") cannot be verified from this host
because **no GitHub repository exists for this project — CI has never executed on GitHub** (see §2.5).
The scope-fidelity audit (§3) passes on every row that is verifiable locally; Q11's *live* GitHub
Pages deployment shares criterion 5's blocker.

---

## 1. First-hand verification runs (this gate, at `e584488`)

| # | Command | Result |
|---|---|---|
| 1 | `npm run ci` (format:check → lint → typecheck → i18n:check → test:coverage → build → budget) | **exit 0** — prettier clean, eslint `--max-warnings 0`, `tsc -b` clean, i18n **339 en / 339 th keys** parity PASS, **913/913 tests (78 files)**, coverage `All files 85.48/79.90/84.72/87.86`, `src/domain 97.51/87.05/99.44/99.13`, `src/storage 96.03/93.47/98.73/97.67` (≥80 % gates PASS), build OK, **budget PASS** |
| 2 | `CI=true npm run e2e:data-safety` | **16/16 passed, exit 0** — incl. drill 1 (export → wipe → import → byte-equivalent restored, offline), hostile imports, quarantine, quota atomic-abort, snapshot rotation/undo |
| 3 | `CI=true npm run e2e:sw` | **16/16 passed, exit 0** — offline boot, `add → complete → reload → data present` offline, offline-write-survives-reload, degraded network, §9.1 boot budget, **MVP install scope (PO Q12)** |
| 4 | `CI=true npm run e2e:smoke` | **8/8 passed, exit 0** — non-root base path, hash routes, CSP listener, zero third-party |
| 5 | `CI=true npm run e2e:a11y` | **2/2 passed, exit 0** — B2 shell-landmark guard live |
| 6 | `CI=true npx playwright test --project=chromium` on `core-ui-keyboard` + `qa-search-reorder` + `qa-f2-remeasure` | **9/9 passed, exit 0** — keyboard-only capture→edit→complete→delete, **touch targets @375 px and @320 px ≥44×44**, search @10k latency, virtualization windowing, keyboard↔drag reorder byte-parity |
| 7 | `node docs/qa/mvp-dod-logs/probes/probe-offline-mobile.mjs` (new gate probe, see §2.1) | **PASS — 14/14 steps** across 375×667 and 320×640, **0 console errors** (`docs/qa/mvp-dod-logs/offline-mobile-probe.json`) |
| 8 | `npm run audit:gate` + `npm audit` | **0 vulnerabilities** (prod and dev) |
| 9 | default-base `npm run build` after restoring `src/sw/precache-manifest.ts` | **`[unchanged]`** (shellVersion `c6bef87e0491796c`) — ADR-005 Decision 2 freshness gate green; `git status src/` clean |
| 10 | scope-fidelity source scans (§3) | zero hits for manifest/install-prompt, attachments/OPFS, accounts/auth/cookies, telemetry/third-party requests |

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

### 2.5 C4 — WCAG 2.2 AA passed — **PASS with explicit PO waivers** (waiver note carried verbatim)

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

### 2.6 C5 — budgets green in CI (bundle §9.2 + measured perf §9.1) — **❌ BLOCKING EVIDENCE GAP**

**What IS green (first-hand):**

- §9.2 bundle budgets: `npm run budget` **PASS** — initial-js **65.5/100 KB**, css **6.7/20 KB**,
  app-shell **81.4/200 KB**, locales **12.7/20 KB**, locales-lazy **0**, no-external-refs **0**,
  no-wasm **0** (runs 1 and 9).
- §9.1 measured perf rows: boot/offline start-to-interactive <300 ms (in `e2e:sw`, run 3),
  search ≤17.9 ms @10k and virtualization/scroll rows (run 6), add→visible 1.7–3.4 ms, boot@10k
  52.6 ms, 60 fps/0 dropped (E2 `e2-epic-verification.md` §7.4, measured at `ef83108` — `src/`
  byte-identical to `e584488`).
- The CI **pipeline definition**: `.github/workflows/ci.yml` runs every §9.5 gate on PR/push
  (lint, typecheck, unit+coverage, build, precache-freshness, bundle-budget, e2e-smoke, a11y-axe,
  e2e-sw, e2e-data-safety, audit) with a green-main-only `deploy` job, and `nightly.yml` holds the
  cross-browser matrix. Running that pipeline's exact command chain locally — `npm run ci` plus
  every e2e job's suite — is **exit 0 / green at `e584488`** (§1 runs 1–8).

**What is NOT verifiable — the blocker:**

- **There is no GitHub repository for this project, so GitHub Actions has never run and GitHub
  Pages has never deployed.** Verified first-hand: the local repo has **no git remote at all**
  (`git config` has no `remote.*`), and `gh api user/repos` across the account **and all 23
  organizations** the authenticated user belongs to contains **no repository for this code**
  (name search for todo/browser-todo → 0 matches).
- E1's closure handoff explicitly assigned this to the gate: *"the DoD gate should confirm the
  GitHub Actions run itself"* and *"a real GitHub Pages deployment run has still never been
  exercised from this host — the one remaining unverified link in the deploy chain."* Both links
  are the same root cause: the code has never been pushed.
- Consequence for **Q11** (§3): base-path *configuration* is complete and locally proven, but the
  *live* GitHub Pages deployment is unverified for the same reason.

**Escalation (per this card's acceptance criteria):** a named DoD criterion that cannot be verified
is not signed. Recorded loudly here and escalated with `kanban_block(kind=needs_input)` — options
in §6. Note the substance of the criterion (budgets green, enforced by CI) *is* green; what is
missing is the hosted execution.

---

## 3. Scope-fidelity audit (Q7 / Q9 / Q11 / Q12 / §2+§7.2)

| Scope rule | Source | Verdict | Evidence (first-hand this run) |
|---|---|---|---|
| **NO manifest / install prompt in MVP** | PO Q12 (§4 M9, §12) | **PASS** | `grep -ri 'beforeinstallprompt\|webmanifest\|rel="manifest"\|manifest.json'` over `src/`, `public/`, `index.html` → **0 hits**; `public/` contains only `favicon.svg`; `e2e:sw`'s *"MVP install scope (PO Q12) — no web manifest and no install prompt anywhere"* green in run 3 (16/16) |
| **NO attachments (no OPFS investment)** | PO Q7 (§4 WON'T) | **PASS** | `grep -ri 'attachment\|OPFS\|origin.private' src/` → **0 hits**; no file-input anywhere except the import picker (data portability, §7.4) |
| **English + Thai both complete** | PO Q9 (§4 M15) | **PASS** | `i18n:check` PASS **339 en / 339 th keys**, placeholders consistent (run 1); E5 handoff: per-locale lazy packs **13.0 KB gzip ≤ 20 KB**, `html lang` tracks the locale both directions, localized document title/meta, zero webfont bytes (Thai = OS fonts) |
| **GitHub Pages deploy with base-path config** | PO Q11 (§9.5) | **CONFIG PASS / LIVE DEPLOY UNVERIFIED** | `ci.yml:22` `BASE_PATH: /${{ github.event.repository.name }}/`, `deploy` job (`configure-pages` → `upload-pages-artifact` → `deploy-pages`, green-main-only, after all gates); `vite.config` `base: normalizeBase(process.env.BASE_PATH)`; README Pages-enable instructions; `e2e:smoke` *"boots under a non-root base path with no failed asset requests"* green (run 4). **Live run impossible — no repository exists (§2.6).** |
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
   is the release battery and it is exit 0 at `e584488`; `npm audit` 0 vulnerabilities.
3. **Data safety (M10–M12)** — export→wipe→import byte-equivalent restore, snapshots (last-3 +
   manual permanence), pre-import snapshot undo, hostile-import rejection, quarantine-to-recovery
   (never silent), quota atomic abort, purge/identity (deviceId survives purge+reboot), settings
   defaults single-sourced from `src/domain/model.ts` `DEFAULT_SETTINGS`.
4. **WCAG 2.2 AA: FULL PASS with explicit PO waivers** (Orca 10/10 + PO waivers for NVDA/VoiceOver —
   carry the §2.5 waiver note verbatim; do not restate as a bare PASS).
5. **Bilingual en+th complete** (339 keys, parity-checked, lazy packs ≤20 KB), flash-free theming
   3 modes, `html lang` tracks locale, zero webfont bytes.
6. **Scope floor:** no manifest/install surface (**S13 must add it — first V1 item**), no
   attachments, no accounts/backend/telemetry, CSP meta per §7.2, ADR-002 schema zero drift,
   precache-manifest freshness gate green.
7. **NOT in place (do not assume):** (a) a hosted GitHub Actions run / live GitHub Pages
   deployment — pending the §6 decision; (b) the PO's 30-day usage sign-off (PO-PENDING); (c) an
   end-to-end multi-tab UX pass (never an MVP AC — schedule separately if wanted); (d) residual
   non-gating polish register (`e5-epic-verification.md` §5).

---

## 6. Open items, escalation and sign-off

1. **BLOCKING — criterion 5 / Q11 live deploy (escalated to the PO/PM via `kanban_block`):**
   - **Option A (recommended):** create the GitHub repository and push `main` → the CI workflow
     runs for real and the Pages deploy executes; this gate then confirms a green Actions run at
     release HEAD and a working `https://<owner>.github.io/<repo>/` deployment, and signs C5 + Q11
     live. *(Publishing the repo — name, owner, public/private — is the human's call, not the
     gate's.)*
   - **Option B:** PO formally accepts the local evidence (`npm run ci` exit 0 + every `ci.yml`
     e2e job green first-hand at `e584488`, budget gate PASS) as satisfying "budgets green in CI"
     for MVP sign-off, recorded as an explicit waiver next to this report; C5 then reads
     "PASS (local battery) with PO waiver — hosted CI run never executed".
2. **PO-PENDING — 30 days of daily use:** sign-off request left as a `kanban_comment` on this
   card. Not claimed by this report.
3. Non-blocking, already green but noted: `src/sw/precache-manifest.ts` freshness is re-verified
   in this run (§1 run 9); E2's advisory QA-D2/D3 stand as recorded.

**Until item 1 is decided, this gate does not sign the MVP Definition of Done.**
