# MVP Definition-of-Done release gate — PROJECT_ANALYSIS §12 Q15

**Gate card:** `t_7f1e8f29` · **Compile card:** `t_7998ae0b` (h_reviewer) · **Compiled:** 2026-10-26 (+07)
**Release HEAD verified:** `0a8702a` — every commit above it was docs/evidence only at report time
(no `src/`/`tests/`/`scripts/`/`.github/` delta: `git diff --name-only 0a8702a..059c8f9 -- src tests
scripts .github` is empty). Four routed commits landed above it afterwards — the manifest regens
`1fce11a` and `0b8915d`, the `4ee55bb` F1 fix, and this report's doc flips (`631d347`, `f471556`) —
each verified by its own card and re-battery-ed by this gate (§1).
**Evidence commits:** functional `4fe59e0`, a11y `6f0b731`, budgets `b820ad7`, scope-fidelity
`df331ae`, gate first run `6a3f5ab`.

**Supersedes:** the gate's first-run report (committed at `6a3f5ab`, verdicts at `225a1f3`). That
run's release-blocking SC 4.1.3 finding is now **provenance, not a blocker**: found pre-fix at
`225a1f3`/`b820ad7` (deterministic repro), **fixed in `64c0ee4`** (card `t_bb9053ec`, done
2026-10-26 00:18), and **re-verified PASS at `0a8702a`** (§2 C4). No other verdict was weakened.

---

## Verdict: ✅ PASS — MVP Definition of Done

All five automatable Q15 criteria are **green at the release state `0a8702a`** and re-confirmed by
this gate's closure battery at the then-current tip **`4ee55bb`** (§1 final row); the scope-fidelity
audit is **13/13 PASS**. The *"30 days of daily use"* element is **PO-PENDING with an explicit
PO-accepted deferral** to a separate sign-off (~2026-11-24) — decision quoted verbatim in §2 C1b;
never verified, never dropped.

**Non-blocking open items disclosed in full (§5) — none fails a Q15 criterion:**

1. **main CI red on `precache-freshness` — RESOLVED, and the hazard recurs (audit trail):** fix
   commit `64c0ee4` changed `src/` without regenerating the committed `src/sw/precache-manifest.ts`,
   reddening `precache-freshness` and skipping `deploy` at `0a8702a`/`059c8f9` (live Pages served the
   pre-fix build then). Card `t_27c2b0e8` landed `1fce11a` → CI run
   [`40219201521`](https://github.com/e23thr/browser-todo-app/actions/runs/40219201521): **all 13
   jobs green incl. `precache-freshness` + `deploy`**; live Pages re-checked by this gate — now
   serves `index-BA2njR4y.js` (post-`64c0ee4` build, ≠ `index-CA0Rb68-.js`) → **a11y F-3 closed.**
   It **recurred with `4ee55bb`** (F1 fix changed `src/` without a regen — the repo's 4th ADR-005 D2
   recurrence) and was **resolved again at `0b8915d`** (t_31327c08's default-base regen, pushed with
   this report's closure pass): run
   [`40220511267`](https://github.com/e23thr/browser-todo-app/actions/runs/40220511267) **all 13
   jobs green incl. `precache-freshness` + `deploy`**; live re-checked — serves `index-DwWTyqiF.js`
   (the F1-fixed build; old `index-BA2njR4y.js` → 404). Standing rule: every future `src/` change
   carries a same-push default-base regen (§5 row 1). Duplicate card `t_619b87b9` closed without
   work.
2. **First-ever nightly full-suite run** (`40216306668`, `workflow_dispatch` at `0a8702a`) is red
   on **webkit + firefox** `e2e-full` — webkit: CSP-violation checks (`offline.spec.ts:204`,
   `smoke.spec.ts:89`); firefox: keyboard `tabTo` budget + `persist()` probe; update-toast pair
   flaky on both (pass on retry); **chromium and th-TH locale both green**. Not a Q15 criterion
   (the PR/push gate is chromium and is green),
   but a real V1 signal given the Q10 browser floor (Firefox/Safari in scope). Follow-up: fix card `t_e20c2adb` (h_junior_coder).
3. **C3 functional finding F1** — restored data invisible in the *running* UI after import until
   a manual reload (**no data loss**; fidelity proven 100%). **RESOLVED** in fix card
   `t_85e19c39`, commit `4ee55bb` — re-verified in §2 C3 (probe step
   `post-import-ui-live-without-reload`, 11/11 PASS); no longer an open item, §5 row 3 kept for
   the audit trail. Flip card `t_5586c72b`.
4. **C4 finding F-1** — route change focuses the composer input, not the view `h1`; deviates from
   design `core-domain.md` §5.2 (WCAG 2.4.3 itself satisfied). Needs design/PO ruling.
5. **§9.1 recommended `< 1.5 s` mobile LCP line** measures 1.624 s — WARN only; the CI gate's own
   single source of truth (`scripts/perf-budgets.json`) sets hard limit **2500 ms** (FAIL) and
   1500 ms as an explicitly *non-blocking* `recommended`. Ruled non-governing for this DoD (§2 C5).

---

## 1. Provenance — which commit each verdict was taken at

| Evidence | Card / commit | Verdict basis |
|---|---|---|
| `docs/qa/evidence/functional.md` | `t_eff4b9fa` / `4fe59e0` | Pinned production build `b820ad7` (asset-identical to the deployed release build), real Chromium 156; probes assert behaviour + data, never announcements → unaffected by the `64c0ee4` announce fix |
| `docs/qa/evidence/accessibility.md` | `t_5612df50` / `6f0b731` | Baseline pin `b820ad7` (= deployed pre-fix bytes) + **RC pin `0a8702a`** (local `BASE_PATH` production build) — C4 verdict is against the release state |
| `docs/qa/evidence/budgets.md` | `t_6f8accdc` / `b820ad7` | CI run `40211837248` (`6a3f5ab`) dist artifact + Lighthouse 12.8.2 vs deployed build; **re-verified by this compile** against the CI perf gate at `0a8702a` (run `40216294729`: `RESULT: PASS — every §9.1 hard gate is green (1 non-blocking warning)`) |
| `docs/qa/evidence/scope-fidelity.md` | `t_5511a0f3` / `df331ae` | HEAD `6a3f5ab` + live Pages fetch |
| Gate first run (this file, previous state) | `t_7f1e8f29` / `6a3f5ab` | First-hand battery at `225a1f3` (local `e584488`): C1/C2/C3/C5 PASS, C4 blocker found → §C4 resolution trail |
| Release-state re-check by this compile | `t_7998ae0b` @ `0a8702a` | `gh run view/list` (CI + nightly job matrices), live Pages asset hash + `last-modified`, `git ls-remote origin main`, `scripts/perf-budgets.json`, `ci.yml` job graph |
| C3 / F1 resolution re-check (this card, C3 only) | `t_5586c72b` @ `4ee55bb` (local, on top of `1fce11a`) | `probe-export-restore` **11/11** incl. hard step `post-import-ui-live-without-reload`; unit+component **940/940** (83 files); `e2e:data-safety` **16/16**; format/lint/typecheck/bundle-budget clean |
| Gate closure battery (this card, final run) @ `4ee55bb` | `t_7f1e8f29` | First-hand: `npm run ci` **exit 0** — format/lint/`--max-warnings 0`/typecheck/i18n 339/339/build/budget 7/7 PASS, **940/940 tests (83 files)**; `e2e:data-safety` **16/16**, `e2e:sw` **16/16**, `e2e:smoke` **8/8**, `e2e:a11y` **2/2**, keyboard core-loop **2/2** + F1 **×3 3/3** (earlier at `059c8f9`: F1 **×5 5/5**); scope greps 0 hits (Q12/Q7/§2-7.2), i18n 339/339, live Pages 200/asset 200/manifest 404, live entry `index-BA2njR4y.js` post-fix at check time and **`index-DwWTyqiF.js` after the final deploy**; CI runs `40218743233` (budget jobs green) + `40219201521` (all 13 green incl. deploy) + `40220511267` (final tip `0b8915d`, all 13 green incl. deploy) |

**Suite-count provenance (the `927` vs `926` question):** the `927/927 (81 files)` figures quoted
for `0a8702a` come from `npm run ci` executed inside the RC verification copy, which also carried
the **untracked 1-test diagnostic probe** `tests/unit/audit-race-repro.test.ts` (never committed;
it exists only to reproduce the pre-fix SC 4.1.3 race — evidence `race-repro-unit-*.txt`). The
repository suite on its own measures **926/926 (80 files)** — first-hand at the report push
(`059c8f9`) and green in CI run `40218743233` (unit job, 80 files). At `4ee55bb` the repo suite is
**940/940 (83 files)** (first-hand, this gate and the flip card). Every count is fully green and no
verdict depends on the probe file.

## 2. Q15 criterion-by-criterion

Q15 (DECIDED, PO 2026-10-23): *capture→complete works offline on desktop + mobile through 30 days
of daily use with zero data loss; export/restore verified; WCAG 2.2 AA passed; budgets green in CI.*

### C1 — capture→plan→complete works offline, desktop AND mobile viewports — **PASS**

| Layer | Evidence |
|---|---|
| Desktop × offline, 1920×1080 | `functional.md` §1 — 8/8 steps, 0 console errors, video + 8 ISO-stamped screenshots: SW controls the page → `setOffline(true)` → capture → plan (due-today chip, Today-view membership) → complete → offline reload boots shell → data present |
| Mobile × offline, iPhone 14 Pro 393×852 | `functional.md` §2 — same 8/8 steps, 0 console errors, video + 8 screenshots (FAB/sheet composer path) |
| Mobile 320/375 px touch + keyboard | Gate first run: touch targets ≥44×44 @375/@320, 9/9 playwright; E2 `e2-epic-verification.md` §7.3/§7.4 |
| Offline SW battery | `e2e:sw` **16/16** (first-hand at the gate run; CI-green in runs `40211837248`, `40216294729`) |

### C1b — "through 30 days of daily use" — **PO-PENDING (PO-accepted deferral to ~2026-11-24)**

Not automatable; never verified by this gate. PO decision, relayed verbatim by h_pm 2026-10-26:

> "ปิด MVP gate เลย เริ่ม V1 ทันที (แนะนำ) — เก็บ 30-day เป็น sign-off แยกต่างหาก ~24 พ.ย."

*(Close the MVP gate now, start V1 immediately (recommended) — keep the 30-day as a separate
sign-off, ~24 Nov.)* Carried as a **separate PO sign-off due ~2026-11-24** (reminder scheduled by
h_pm). Recorded inline under PROJECT_ANALYSIS.md Q15 in this compile commit. Non-blocking for
this gate by explicit PO acceptance.

### C2 — zero data loss across the whole test cycle — **PASS**

- `functional.md` §3 — create 50 / complete 30 / delete 10 / refresh → **40 live items with
  correct state** (`missing=0`, `wrongState=0`), IDB user-data snapshots before/after refresh
  **canonically identical** (only volatile `meta.lastOpenedAt` differs), 0 console errors,
  per-item verification + UI cross-check.
- `e2e:data-safety` **16/16** (hostile imports → zero DB writes; corrupt records quarantined;
  `QuotaExceededError` atomic abort; snapshot rotation + pre-import undo byte-equivalent);
  unit suite **927/927** at `0a8702a` (RC-copy count incl. the diagnostic probe — §1 suite-count
  note; repo-only 926/926, now **940/940** at `4ee55bb`) incl. storage-corruption drills and the
  purge/identity drill (deviceId survives purge+reboot, ADR-002 §3.1).
- No open data-loss defect. Documented non-findings: tombstones (`deletedAt`) per ADR-004;
  volatile `lastOpenedAt`; fresh boot's 1 empty auto-snapshot row.

### C3 — export/restore verified (export → wipe → import → restored) — **PASS** (finding F1 resolved — `t_85e19c39` / `4ee55bb`)

- `functional.md` §4 — scripted UI journey: export byte-exact → app "Delete all data" + full
  storage wipe (`IndexedDB=[]`, `localStorage=0`, `caches=[]`, `swRegs=0`) → import → **record
  fidelity 100%** (`tasks/lists/settings diff = 0`), **16/16 Thai+English strings byte-exact**,
  settings (locale=th, theme=dark) restored; re-export differs only in the **5 documented
  device-local paths** (ADR-004/ADR-002 semantics). Diffs saved.
- Scripted drill 1 re-run first-hand: `e2e:data-safety` **16/16** incl. *export → wipe → import →
  byte-equivalent restore, offline*; runs on every PR/push (`ci.yml`).
- **Finding F1 (moderate, NO data loss) — RESOLVED in `t_85e19c39` / commit `4ee55bb`:** restored
  data was not visible in the running UI until a manual reload (`importFlow.applyPlan()` never
  reloaded the tasks/lists store; the tab-sync sweep could miss imported rows). Reproduced 3/3 at
  the gate run; **fixed by the post-commit data-replaced seam** (`src/portability/side-effects.ts`
  — `applyImport` / `restoreSnapshot` / wipe all refresh the acting tab's tasks/lists store and
  settings with no reload and announce `change:'all'` so peer tabs converge; ADR-003 Decision
  8.1, D4 watermark semantics untouched). The data-fidelity verdict was unaffected then and is
  unaffected now.
  - **Probe evidence (the flip):** `probe-export-restore` gained the hard step
    `post-import-ui-live-without-reload` — **11/11 steps, VERDICT PASS**: **6 task rows on `#/all`
    and 2 list rows on `#/lists` visible BEFORE any reload**, Settings theme radio **checked**,
    **`theme=dark` applied immediately** (design/data-safety §8.3 erratum), `html lang` stays `en`
    until next boot (locale's documented timing). Fresh run:
    `docs/qa/evidence/functional-logs/export-restore-summary.json` +
    `export-restore-findings.json` (`status: fixed`) +
    `screens/2026-10-25T17-58-26-816Z-06b-*.png` / `...06b2-*.png`.
  - **Regression coverage:** `tests/component/data-safety-import-refresh.test.tsx` (import +
    undo-restore visible with zero reloads), `tests/unit/app/tabSync.test.ts` (`replaceAll`
    two-tab convergence via `change:'all'`; D4 watermark semantics untouched),
    `tests/unit/domain/pipeline-reload.test.ts`, `tests/unit/portability/data-replaced.test.ts`,
    `tests/unit/settings.test.ts` — **30/30** across those five files.
  - **Gates re-run first-hand by the flip card `t_5586c72b` at `4ee55bb`:** unit+component suite
    **940/940** (83 files), `e2e:data-safety` **16/16**, format/lint/typecheck + `npm run budget`
    all clean.

### C4 — WCAG 2.2 AA passed — **PASS with explicit PO waivers**

> **WCAG 2.2 AA — PASS with explicit PO waivers.** Screen-reader execution: **Orca (Linux /
> Firefox / Ubuntu) executed 10/10 per `docs/qa/keyboard-script.md`** (record `docs/qa/a11y-gate.md`
> §5.2, PO as tester, 2026-10-25); **NVDA (Windows) + VoiceOver (macOS/iOS) waived by explicit PO
> acceptance, `t_2ce8fc1f` thread.** Never a bare unqualified PASS — the waiver scope is part of
> the verdict and travels with it.

Verdict basis: `accessibility.md` (audit `t_5612df50`), audited on a pinned local `BASE_PATH`
production build of **release HEAD `0a8702a`**:

- **SC 4.1.3 resolution trail:** race found pre-fix at `225a1f3`/`b820ad7` (deterministic unit
  repro — the gate's 6/8 keyboard e2e failures), **fixed in `64c0ee4`**, **re-verified PASS at
  `0a8702a`**: unit repro green, keyboard F1 e2e **5/5** isolated (was 6/8 failing), announcements
  **12/12** en+th, `e2e:a11y` **2/2**, `npm run ci` exit 0 (**927/927**, 81 files — RC-copy count,
  see the §1 suite-count note). **Re-verified again by this gate's closure battery at `4ee55bb`:**
  `e2e:a11y` **2/2**, keyboard core-loop **2/2**, F1 **×3 3/3** (plus **×5 5/5** at `059c8f9`),
  `npm run ci` exit 0 **940/940**.
- axe **0 violations across 61 scans** (desktop 9 routes × themes × locales + mobile @360 px,
  incl. `#/week` addendum); CI axe gate 2/2.
- Contrast **0 failures**: 756 route samples + 30 UI-state samples (default/hover/focus/disabled
  × both themes, incl. `aria-disabled` addendum) + 24 status-badge samples.
- Keyboard: 38-step recorded walk, 0 focus-ring violations, skip-link fresh-load 2/2 themes,
  all focus traps pass, 19 screenshots; 200 % zoom + 320 px reflow clean both locales.
- SR scripted spot check **5/5** critical flows + full announcement matrix **12/12** en+th.
- Open, non-blocking on the a11y gate: **F-1** route-focus vs design §5.2 (needs design/PO
  ruling — either honor `[data-autofocus]` only where design grants it, or amend §5.2/F7.2);
  **F-2** stale probe-visual stage-6 matcher (test-infra nit; `probe-announcements` 12/12
  authoritative); **F-3 CLOSED** — live Pages re-checked by this gate: serves
  `index-BA2njR4y.js` (post-`64c0ee4` build) since the green deploy in run `40219201521`,
  i.e. the SC 4.1.3 fix is in production (was `index-CA0Rb68-.js` pre-fix).

### C5 — budgets green in CI (bundle §9.2 + measured perf §9.1) — **PASS**

Verified in **real GitHub Actions at release HEAD `0a8702a`** — run
[`40216294729`](https://github.com/e23thr/browser-todo-app/actions/runs/40216294729); **both budget
jobs re-green in every later run** — `40218743233` (report push, budget jobs green while
`precache-freshness` alone was red) and `40219201521` (`1fce11a`, all 13 jobs green incl. deploy):

- **§9.2 bundle half:** `bundle-budget` job **PASS** (`scripts/check-bundle-budget.mjs`; all 7
  gates: initial-js 65.6/100 KB, css 6.7/20 KB, app-shell 81.4/200 KB, locales 12.6/20 KB,
  locales-lazy 0, no-external-refs 0, no-wasm 0 — evidence `budgets.md` §1, report JSONs
  regenerated from the exact CI dist artifact).
- **§9.1 measured-perf half — now enforced IN CI** (the gap flagged by `budgets.md` was closed by
  `0a8702a` itself, card `t_7c1b251b`): the new `perf-budget` job (Lighthouse CI,
  `scripts/perf-budgets.json` single source of truth) ran at `0a8702a` and reports
  **`RESULT: PASS — every §9.1 hard gate is green (1 non-blocking warning)`** — mobile/desktop
  LCP/TBT/CLS all pass hard limits (desktop LCP 368.3 ms / 2500 ms; TBT 0.0 ms / 200 ms;
  CLS 0.000 / 0.1). Lighthouse reports retained as the `lighthouse-reports` CI artifact.
- **Governing line ruling (the one open question `budgets.md` handed to this compiler):** the
  §9.1 `< 1.5 s` mobile-LCP line is **RECOMMENDED, not binding** — §9.1's own table is marked
  RECOMMENDED and the CI gate encodes 2500 ms as the hard FAIL threshold with 1500 ms as an
  explicitly non-blocking `recommended` warn (`scripts/perf-budgets.json`). Measured 1.624 s
  (slow-4G) / 2.436 s (3G) against the binding ≤2.5 s DoD line → **PASS**; the 1.5 s gap is
  carried as a V1 perf follow-up (WARN), not a DoD failure.
- Supporting: TBT ≤8.5 ms (limit 200), CLS 0 everywhere; boot offline start-to-interactive
  <300 ms (40 samples); `npm audit` 0 vulnerabilities.

## 3. Scope-fidelity audit (source: `docs/qa/evidence/scope-fidelity.md`, 13/13 PASS)

| # | Rule (source) | Verdict | Evidence |
|---|---|---|---|
| 1 | **Q12** — no web app manifest | PASS | 0 hits in `index.html`/`src`/`public`; live `/manifest.webmanifest` + `/manifest.json` both **404**; `dist/` = assets + favicon + index.html + sw.js only |
| 2 | **Q12** — no install prompt / A2HS | PASS | 0 product hits (`beforeinstallprompt` etc.); 0 in shipped JS |
| 3 | **Q12 nuance** — SW app shell IS in scope (M9) | PASS | `src/sw/sw.ts` + `sw-boot.tsx` register `${BASE_URL}sw.js`; raises no install UI |
| 4 | **Q7** — no attachments / OPFS | PASS | 0 hits; `Blob` use only for backup export + snapshot download (§7.4) |
| 5 | **Q7 nuance** — the single `type="file"` input = JSON backup import | PASS | `StoragePanel.tsx:163-173` `accept="application/json"` — restore path, not attachments |
| 6 | **Q9** — en+th catalog parity | PASS | **339 en / 339 th keys**, zero missing/empty; `node scripts/check-i18n.mjs` PASS |
| 7 | **Q9** — real Thai translations | PASS | 20/20 spot-checked keys genuinely translated; only 3 identical values are self-naming by design |
| 8 | **Q11** — Pages base path configured | PASS | `ci.yml:22` `BASE_PATH: /<repo>/`; `vite.config.ts` `normalizeBase(BASE_PATH)` |
| 9 | **Q11** — deployed assets load from that path | PASS | Live 200s for index + all 4 hashed assets + sw.js + favicon under `/browser-todo-app/` |
| 10 | **Q11** — deploy matches source | PASS | Fresh `BASE_PATH` build of HEAD emits the same content-hashed entry as the live page |
| 11 | **§2/§7.2** — no accounts/auth | PASS | 0 identity/cookie hits; storage = IndexedDB + boot-prefs localStorage mirror |
| 12 | **§2/§7.2** — no backend/third-party requests | PASS | Single `fetch` = same-origin SW cache-miss; CSP `connect-src 'self'` fails closed |
| 13 | **§2/§7.2** — no telemetry/analytics | PASS | 0 hits (only comments *denying* telemetry + 1 false positive) |

INFO (carried): the committed `src/sw/precache-manifest.ts` was already flagged stale by this
audit at `6a3f5ab` — **it has since become a red CI job at `0a8702a`** (§5 item 1); the deployed
worker was never affected (CI regenerates), but the repo-state divergence is now release hygiene,
not a nit. Status at gate closure: fixed at `1fce11a` (green incl. deploy, run `40219201521`),
recurred with `4ee55bb`, and **resolved again at `0b8915d`** (t_31327c08 default-base regen, run
`40220511267` all 13 green incl. deploy — §5 row 1).

## 4. Handoff metadata — what V1 epics may assume is in place

1. **Core loop (M1–M6)** — capture → today/next-7/all/per-list/completed → complete/uncomplete,
   search, keyboard+drag reorder, virtualized lists: works **offline on desktop and mobile
   viewports** (320/375/393/1920 px), with keyboard equivalence for every gesture, ≥44×44 touch
   targets, per-region §5.5 announcements.
2. **Offline IndexedDB schema v3 frozen** — ADR-002 zero drift; purge/identity invariant
   (deviceId survives purge+reboot) regression-tested.
3. **Data safety (M10–M12)** — export→wipe→import byte-equivalent restore, snapshots (last-3 +
   manual permanence), pre-import snapshot undo, hostile-import rejection, quarantine-to-recovery,
   quota atomic abort. Post-import/restore UI staleness (finding F1) **fixed at `4ee55bb`** —
   restored data visible with no reload, peer tabs converge via `change:'all'`, regression-tested
   (§2 C3).
4. **WCAG 2.2 AA baseline met — "PASS with explicit PO waivers"** (Orca 10/10 executed; NVDA +
   VoiceOver PO-waived `t_2ce8fc1f`); SC 4.1.3 deferred-announce race fixed (`64c0ee4`) and
   regression-tested. Carry the waiver note verbatim; never restate as a bare PASS. Open design
   question: route-focus target (F-1).
5. **i18n keys complete for en/th** — 339/339 parity-checked, per-locale lazy packs ≤20 KB gzip,
   `html lang` tracks locale, zero webfont bytes (Thai = OS fonts).
6. **Bundle budgets enforced in CI** (`bundle-budget`, §9.2) **AND measured perf enforced in CI**
   (`perf-budget`, §9.1 via Lighthouse CI — hard gates LCP ≤2.5 s / TBT ≤200 ms / CLS ≤0.1);
   both green at `0a8702a`. `npm audit` 0 vulnerabilities. `npm run ci` = format/lint/typecheck/
   i18n/coverage(≥80 % domain+storage)/build/budget, exit 0.
7. **GitHub Pages deploy pipeline** — green-main-only `deploy` job, base path `/browser-todo-app/`
   wired through `BASE_PATH`; live site re-checked by this gate twice: `index-BA2njR4y.js` after the
   green deploy of run `40219201521`, and **`index-DwWTyqiF.js` — the `4ee55bb` F1-fixed build —
   after run `40220511267`**; each live hash byte-identical to a fresh `BASE_PATH` build of its
   commit (Q11 row 10 method).
8. **Scope floor:** no manifest/install surface (**S13 must add it — first V1 item**), no
   attachments, no accounts/backend/telemetry, CSP meta per §7.2.
9. **NOT in place (do not assume):** (a) the PO's 30-day usage sign-off (PO-deferred ~2026-11-24);
   (b) cross-browser (webkit/firefox) full-suite green — nightly matrix currently red there
   (`t_e20c2adb`); (c) mobile LCP under the §9.1 *recommended* 1.5 s (WARN-tracked). *(Both fixes
   previously listed here — the SC 4.1.3 and F1 deploys — are now live: §4.7.)*

## 5. Open items and follow-ups

| # | Item | Severity | Routing |
|---|---|---|---|
| 1 | `precache-freshness` red at `0a8702a` (stale manifest after `64c0ee4`) → `deploy` skipped → live Pages served the pre-fix build; **RESOLVED at `1fce11a`** — run `40219201521` all 13 jobs green incl. `precache-freshness` + `deploy`, live re-checked by this gate (`index-BA2njR4y.js` ≠ `index-CA0Rb68-.js`, F-3 closed). **RECURRED with `4ee55bb`** (F1 fix changed `src/` without a regen; 4th ADR-005 D2 recurrence) → **RESOLVED again at `0b8915d`** — run `40220511267` all 13 green incl. `precache-freshness` + `deploy`, live re-checked: `index-DwWTyqiF.js` (F1-fixed build, == fresh HEAD `BASE_PATH` build; `index-BA2njR4y.js` → 404) | **Closed** — both recurrences fixed; standing rule: every future `src/` change carries a same-push default-base regen | Landed by **`t_31327c08`** (h_junior_coder, done): default-base `npm run build` (BASE_PATH unset — `ci.yml` pins `BASE_PATH: /` for this job; a Pages-BASE_PATH build yields different hashes), committed **only** `src/sw/precache-manifest.ts` as `chore(sw): regenerate… after 4ee55bb (ADR-005 Decision 2)`, pushed, verified all 13 jobs green incl. `deploy`. First recurrence fixed by `t_27c2b0e8` (`1fce11a`); duplicate card `t_619b87b9` closed without work |
| 2 | Nightly `e2e-full` red on webkit + firefox at `0a8702a` (webkit: CSP checks; firefox: keyboard `tabTo` + `persist()` probe; update-toast pair flaky on both); chromium + th-TH green | Cross-browser signal (Q10 floor) | Triage card **`t_e20c2adb`** (h_junior_coder) |
| 3 | F1 post-import UI staleness (no data loss) — **RESOLVED** at `4ee55bb` (probe step `post-import-ui-live-without-reload`, 11/11 PASS — §2 C3) | Moderate → **closed** | Fixed by card **`t_85e19c39`** (h_senior_coder); flipped by `t_5586c72b`. Row kept for the audit trail. |
| 4 | F-1 route-change focus target deviates from design §5.2 | Non-blocking, decision needed | Design/PO ruling (amend impl or §5.2/F7.2) |
| 5 | Mobile LCP 1.624 s vs §9.1 *recommended* <1.5 s | WARN (non-binding) | V1 perf follow-up |
| 6 | **30 days of daily use** | PO-PENDING, deferred by PO | Separate sign-off ~2026-11-24 (h_pm reminder) |

## 6. PO sign-off

- **Automatable DoD: PASS** — signed by h_reviewer as gate compiler at `0a8702a`, evidence-linked
  above (§2, §3), first-hand runs in the gate's battery + the four evidence cards.
- **30-day usage element:** PO has explicitly accepted deferring it to a separate sign-off
  (~2026-11-24; decision quoted in §2 C1b, recorded in PROJECT_ANALYSIS.md Q15).
- **Sign-off request:** posted as a `kanban_comment` on the gate card `t_7f1e8f29` for the PO.
- **Closure verification (gate run 4, first-hand):** full battery green at `4ee55bb` — `npm run ci`
  exit 0 (940/940), `e2e:data-safety`/`e2e:sw`/`e2e:smoke`/`e2e:a11y` 16/16 + 16/16 + 8/8 + 2/2,
  keyboard core-loop 2/2 (+ F1 ×5 ×3), scope greps 0 hits, live Pages re-checked (§1 final row).
- **This gate does not claim the 30-day element; it is the only unsigned DoD element.**
