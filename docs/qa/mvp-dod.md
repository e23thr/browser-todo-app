# MVP Definition-of-Done release gate — PROJECT_ANALYSIS §12 Q15

**Gate card:** `t_7f1e8f29` · **Compile card:** `t_7998ae0b` (h_reviewer) · **Compiled:** 2026-10-26 (+07)
**Release HEAD verified:** `0a8702a` (`main == origin/main`; the local-only commit `6f0b731` is a
docs/evidence commit — no `src/` difference). **Evidence commits:** functional `4fe59e0`, a11y
`6f0b731`, budgets `b820ad7`, scope-fidelity `df331ae`, gate first run `6a3f5ab`.

**Supersedes:** the gate's first-run report (committed at `6a3f5ab`, verdicts at `225a1f3`). That
run's release-blocking SC 4.1.3 finding is now **provenance, not a blocker**: found pre-fix at
`225a1f3`/`b820ad7` (deterministic repro), **fixed in `64c0ee4`** (card `t_bb9053ec`, done
2026-10-26 00:18), and **re-verified PASS at `0a8702a`** (§2 C4). No other verdict was weakened.

---

## Verdict: ✅ PASS — MVP Definition of Done

All five automatable Q15 criteria are **green at the release state `0a8702a`**; the scope-fidelity
audit is **13/13 PASS**. The *"30 days of daily use"* element is **PO-PENDING with an explicit
PO-accepted deferral** to a separate sign-off (~2026-11-24) — decision quoted verbatim in §2 C1b;
never verified, never dropped.

**Non-blocking open items disclosed in full (§5) — none fails a Q15 criterion:**

1. **main CI at release HEAD is red on one job (`precache-freshness`)** — fix commit `64c0ee4`
   changed `src/` without regenerating the committed `src/sw/precache-manifest.ts` (the repo's
   established pattern is a follow-up `chore(sw): regenerate…` commit; 5 precedents, latest
   `ef83108`). Consequence: the run's `deploy` job was **skipped**, so **live Pages still serves
   the pre-fix build** (`index-CA0Rb68-.js`, last-modified 2026-10-25T16:30:07Z — re-checked by
   this compile). The a11y fix reaches production only after the follow-up card lands and a
   green-main deploy runs (a11y F-3 re-check). Follow-up: `t_40f4faf5`.
2. **First-ever nightly full-suite run** (`40216306668`, `workflow_dispatch` at `0a8702a`) is red
   on **webkit + firefox** `e2e-full` (CSP-violation checks + update-toast tests); **chromium and
   th-TH locale both green**. Not a Q15 criterion (the PR/push gate is chromium and is green),
   but a real V1 signal given the Q10 browser floor (Firefox/Safari in scope). Follow-up: `t_1b7f519b`.
3. **C3 functional finding F1** — restored data invisible in the *running* UI after import until
   a manual reload (**no data loss**; fidelity proven 100%). Fix card `t_85e19c39` open.
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
  unit suite **927/927** at `0a8702a` incl. storage-corruption drills and the purge/identity
  drill (deviceId survives purge+reboot, ADR-002 §3.1).
- No open data-loss defect. Documented non-findings: tombstones (`deletedAt`) per ADR-004;
  volatile `lastOpenedAt`; fresh boot's 1 empty auto-snapshot row.

### C3 — export/restore verified (export → wipe → import → restored) — **PASS** (open finding F1)

- `functional.md` §4 — scripted UI journey: export byte-exact → app "Delete all data" + full
  storage wipe (`IndexedDB=[]`, `localStorage=0`, `caches=[]`, `swRegs=0`) → import → **record
  fidelity 100%** (`tasks/lists/settings diff = 0`), **16/16 Thai+English strings byte-exact**,
  settings (locale=th, theme=dark) restored; re-export differs only in the **5 documented
  device-local paths** (ADR-004/ADR-002 semantics). Diffs saved.
- Scripted drill 1 re-run first-hand: `e2e:data-safety` **16/16** incl. *export → wipe → import →
  byte-equivalent restore, offline*; runs on every PR/push (`ci.yml`).
- **Open finding F1 (moderate, NO data loss):** restored data is not visible in the running UI
  until a manual reload (`importFlow.applyPlan()` never reloads the tasks/lists store; tab-sync
  sweep can miss imported rows). Reproduced 3/3. Fix card **`t_85e19c39`** (h_senior_coder).
  Data-fidelity verdict unaffected.

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
  **12/12** en+th, `e2e:a11y` **2/2**, `npm run ci` exit 0 (**927/927**, 81 files).
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
  authoritative); **F-3** live Pages still pre-fix at audit time (deploy re-check, see §5 item 1).

### C5 — budgets green in CI (bundle §9.2 + measured perf §9.1) — **PASS**

Verified in **real GitHub Actions at release HEAD `0a8702a`** — run
[`40216294729`](https://github.com/e23thr/browser-todo-app/actions/runs/40216294729):

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
not a nit.

## 4. Handoff metadata — what V1 epics may assume is in place

1. **Core loop (M1–M6)** — capture → today/next-7/all/per-list/completed → complete/uncomplete,
   search, keyboard+drag reorder, virtualized lists: works **offline on desktop and mobile
   viewports** (320/375/393/1920 px), with keyboard equivalence for every gesture, ≥44×44 touch
   targets, per-region §5.5 announcements.
2. **Offline IndexedDB schema v3 frozen** — ADR-002 zero drift; purge/identity invariant
   (deviceId survives purge+reboot) regression-tested.
3. **Data safety (M10–M12)** — export→wipe→import byte-equivalent restore, snapshots (last-3 +
   manual permanence), pre-import snapshot undo, hostile-import rejection, quarantine-to-recovery,
   quota atomic abort. Known UX gap: post-import UI staleness until reload (`t_85e19c39`).
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
   wired through `BASE_PATH`; live site verified byte-identical to release builds (currently
   serving the pre-fix build — see §5 item 1).
8. **Scope floor:** no manifest/install surface (**S13 must add it — first V1 item**), no
   attachments, no accounts/backend/telemetry, CSP meta per §7.2.
9. **NOT in place (do not assume):** (a) the PO's 30-day usage sign-off (PO-deferred ~2026-11-24);
   (b) the SC 4.1.3 fix **deployed to production** (committed at `0a8702a`, deploy pending the
   precache-freshness fix); (c) cross-browser (webkit/firefox) full-suite green — nightly matrix
   currently red there; (d) mobile LCP under the §9.1 *recommended* 1.5 s (WARN-tracked).

## 5. Open items and follow-ups

| # | Item | Severity | Routing |
|---|---|---|---|
| 1 | `precache-freshness` red at `0a8702a` (committed manifest stale after `64c0ee4`) → `deploy` skipped → live Pages still pre-fix; F-3 re-check pending | Release hygiene — **blocks shipping the a11y fix**, not a Q15 criterion | Fix card **`t_40f4faf5`** (h_junior_coder): regenerate + commit `src/sw/precache-manifest.ts` per ADR-005 D2, verify green-main run incl. deploy, confirm live asset hash ≠ `index-CA0Rb68-.js` |
| 2 | Nightly `e2e-full` red on webkit + firefox at `0a8702a` (CSP-violation checks + update-toast tests); chromium + th-TH green | Cross-browser signal (Q10 floor) | Triage card **`t_1b7f519b`** (h_senior_coder) |
| 3 | F1 post-import UI staleness (no data loss) | Moderate | Fix card **`t_85e19c39`** (h_senior_coder) |
| 4 | F-1 route-change focus target deviates from design §5.2 | Non-blocking, decision needed | Design/PO ruling (amend impl or §5.2/F7.2) |
| 5 | Mobile LCP 1.624 s vs §9.1 *recommended* <1.5 s | WARN (non-binding) | V1 perf follow-up |
| 6 | **30 days of daily use** | PO-PENDING, deferred by PO | Separate sign-off ~2026-11-24 (h_pm reminder) |

## 6. PO sign-off

- **Automatable DoD: PASS** — signed by h_reviewer as gate compiler at `0a8702a`, evidence-linked
  above (§2, §3), first-hand runs in the gate's battery + the four evidence cards.
- **30-day usage element:** PO has explicitly accepted deferring it to a separate sign-off
  (~2026-11-24; decision quoted in §2 C1b, recorded in PROJECT_ANALYSIS.md Q15).
- **Sign-off request:** posted as a `kanban_comment` on the gate card `t_7f1e8f29` for the PO.
- **This gate does not claim the 30-day element; it is the only unsigned DoD element.**
