# Budgets evidence — §9.2 bundle size + §9.1 measured performance

**Card:** t_6f8accdc (MVP DoD Q15 item 5: "budgets green in CI — bundle section 9.2 + measured perf section 9.1")
**Verified by:** h_senior_coder · **Date:** 2026-10-25
**Subject:** `main` @ `6a3f5ab` — CI run [40211837248](https://github.com/e23thr/browser-todo-app/actions/runs/40211837248) (all 12 jobs green), whose `dist` artifact is the build deployed to GitHub Pages at 2026-10-25 16:30:07Z.
**Budgets of record:** PROJECT_ANALYSIS.md §9.1 (perf) and §9.2 (bundle), restated as CI thresholds in `scripts/bundle-budgets.json` (ADR-001 §8).

## 0. Verdict summary

| # | Budget | Threshold | Measured | Verdict |
|---|--------|-----------|----------|---------|
| B1 | Initial JS (entry closure), gzip | ≤ 100 KB (§9.2 gate; warn ≥ 80 KB) | **65.6 KB** | **PASS** |
| B2 | CSS, gzip | ≤ 20 KB (§9.2 gate) | **6.7 KB** | **PASS** |
| B3 | Total app shell, gzip | ≤ 200 KB (§9.2 gate) | **81.4 KB** | **PASS** |
| B4 | Locale packs (en+th), gzip | ≤ 20 KB (§9.2 gate) | **12.6 KB** | **PASS** |
| B5 | Locale packs lazy (never in initial closure) | 0 in closure | 0 | **PASS** |
| B6 | Runtime third-party bytes | 0 | 0 external refs (12 files scanned) | **PASS** |
| B7 | WASM | 0 | 0 | **PASS** |
| B8 | Total JS (all chunks incl. sw.js + locales), gzip | ≤ 120 kB (task-stated DoD line) | **85.1 KB** | **PASS** |
| B9 | CSS, gzip (task-stated stricter line) | ≤ 15 kB | **6.7 KB** | **PASS** |
| B10 | Largest single chunk, gzip | ≤ 50 kB (task-stated) | **41.3 KB** (`index-CA0Rb68-.js`) | **PASS** |
| P1 | LCP — desktop (cold cache) | ≤ 2.5 s (task DoD) / < 1.5 s (§9.1) | **0.286 s** | **PASS** (both lines) |
| P2 | LCP — mobile, §9.1 condition (Moto-G class, 4× CPU, slow 4G) | ≤ 2.5 s (task DoD) / < 1.5 s (§9.1) | **1.624 s** | **PASS (DoD line) / FAIL (§9.1 recommended line)** |
| P3 | LCP — mobile, throttled 3G (400 ms RTT / 400 kbps / 4× CPU) | ≤ 2.5 s (task DoD) / < 1.5 s (§9.1) | **2.436 s** | **PASS (DoD line, 64 ms margin) / FAIL (§9.1 recommended line)** |
| P4 | TBT — all three profiles | ≤ 200 ms | 8.5 / 0 / 0 ms | **PASS** |
| P5 | CLS — all three profiles | ≤ 0.1 | 0 / 0 / 0 | **PASS** |

**Overall: PASS against every budget as stated in the DoD task (B1–B10, P1–P5).** One red against the
stricter *recommended* line inside §9.1 itself: mobile LCP **1.624 s > 1.5 s** at the §9.1
measurement condition (and 2.436 s at throttled 3G). §9.1's header marks that table
"RECOMMENDED"; the task's DoD threshold is LCP ≤ 2.5 s, which is met on every profile. Exact
failing values are captured in §2.2 below so the DoD compiler can rule on which line governs.

**CI-coverage finding (affects the DoD wording "budgets green in CI"):** the §9.2 bundle half is
enforced in CI and green there; the §9.1 measured-perf half has **no CI enforcement** — there is
no Lighthouse/web-vitals job in `ci.yml` or `nightly.yml`, and the Nightly workflow (whose
`e2e-full` job holds the 300 ms §9.1 boot line via `E2E_BOOT_BUDGET_MS`) has **zero runs** since
it was added. The LCP/TBT/CLS numbers below were therefore produced by this verification run
(Lighthouse 12.8.2) against the deployed production build, not extracted from CI artifacts.

## 1. Bundle budget (§9.2) — extracted from CI

- **CI gate:** `bundle-budget` job in run [40211837248](https://github.com/e23thr/browser-todo-app/actions/runs/40211837248)
  — job log: [bundle-budget @ job 121224642977](https://github.com/e23thr/browser-todo-app/actions/runs/40211837248/job/121224642977)
  — `RESULT: PASS`, exit 0.
- **Measurement method (repo of record):** the project is Vite-based; there is no webpack
  bundle-analyzer step. The §9.2 gate is `scripts/check-bundle-budget.mjs` over the production
  `dist/` (Vite manifest graph, gzip level 9, `*.map`/icons/manifest excluded — measurement rules
  frozen in `scripts/bundle-budgets.json`). The report JSON saved here is that gate's `--json`
  output regenerated over the **exact `dist` artifact CI uploaded** (artifact `dist`, run
  40211837248), and it reproduces the CI log numbers exactly.

### 1.1 §9.2 gates (the CI-enforced budgets)

| Gate | Measured (gzip) | Limit | Status |
|------|-----------------|-------|--------|
| initial-js (3 entry-closure chunks) | 67,108 B = 65.6 KB | 100 KB (warn 80 KB) | PASS (under warn target) |
| css (1 file) | 6,845 B = 6.7 KB | 20 KB | PASS |
| app-shell (8 files; 4 lazy chunks excluded; `sw.js` counted per ADR-005 D1) | 83,345 B = 81.4 KB | 200 KB | PASS |
| locales (en+th, 2 packs) | 12,963 B = 12.6 KB | 20 KB | PASS |
| locales-lazy | 0 packs in initial closure | 0 | PASS |
| no-external-refs | 0 hits across 12 shipped files | 0 | PASS |
| no-wasm | 0 `.wasm` assets | 0 | PASS |

### 1.2 Task-stated thresholds (DoD lines B8–B10) and per-chunk sizes

Measured with the gate's own method (node `zlib.gzipSync` level 9), full data in
[`bundle-per-chunk.json`](./bundle-per-chunk.json):

| Check | Measured | Threshold | Status |
|-------|----------|-----------|--------|
| Total JS (all `.js` incl. `sw.js`, lazy + locale chunks) | 87,121 B = 85.1 KB | ≤ 120 kB | PASS |
| Total CSS | 6,845 B = 6.7 KB | ≤ 15 kB | PASS |
| Largest single chunk | 42,275 B = 41.3 KB (`assets/index-CA0Rb68-.js`) | ≤ 50 kB | PASS |

| File (gzip) | Bytes |
|-------------|-------|
| `assets/index-CA0Rb68-.js` | 42,275 |
| `assets/dbAccess-Bx1kHfMa.js` | 17,417 |
| `assets/snapshots-api-B23rPcZQ.js` | 7,416 |
| `assets/locale-th-0z_UgMXl.js` | 7,090 |
| `assets/index-B7sWvTs_.css` | 6,845 |
| `assets/locale-en-DcYtuBhM.js` | 5,873 |
| `assets/SettingsView-LmaLPY36.js` | 3,417 |
| `sw.js` | 1,673 |
| `assets/boot-uZGUMpY0.js` | 1,200 |
| `assets/actions-C-00EtfI.js` | 760 |

**Report JSONs:** [`bundle-budget-report.json`](./bundle-budget-report.json) (gate report),
[`bundle-per-chunk.json`](./bundle-per-chunk.json) (per-file sizes).

## 2. Measured perf budget (§9.1)

### 2.0 Method and provenance

No Lighthouse CI / web-vitals CI output exists to extract (see the CI-coverage finding in §0), so
the metrics below were measured directly:

- **Tool:** Lighthouse 12.8.2, performance category, headless Chrome (Playwright Chromium 1248).
- **Target:** `https://e23thr.github.io/browser-todo-app/` — the Pages deploy of the very `dist`
  artifact verified in §1 (deploy job of run 40211837248; server `last-modified: 2026-10-25
  16:30:07Z`), so bundle and perf evidence cover the same build.
- **Profiles:**
  - `desktop` — Lighthouse desktop preset (simulated cable, 1× CPU), fetched 2026-10-25T16:38:33Z.
  - `mobile-slow4g-cpu4x` — the **§9.1 measurement condition** (emulated Moto-G class, 4× CPU
    throttle, slow 4G; Lighthouse simulated throttling), fetched 2026-10-25T16:38:07Z.
  - `mobile-throttled-3g` — the task's DoD condition (**throttled 3G**: DevTools applied
    throttling 400 ms RTT / 400 kbps / 4× CPU), fetched 2026-10-25T16:38:45Z.
- **LCP element** (mobile): `body > div#app > main.onboarding > p.onboarding-body` — the
  first-load onboarding body (fresh visitor).

### 2.1 Results vs budgets

| Metric | Budget (task DoD) | Budget (§9.1) | desktop | mobile slow-4G (§9.1 condition) | mobile 3G (DoD condition) | Verdict |
|--------|-------------------|---------------|---------|-------------------------------|--------------------------|---------|
| LCP | ≤ 2.5 s | < 1.5 s | **0.286 s** | **1.624 s** | **2.436 s** | **PASS DoD / FAIL §9.1 on mobile** |
| TBT | ≤ 200 ms | < 200 ms | **0 ms** | **8.5 ms** | **0 ms** | **PASS** |
| CLS | ≤ 0.1 | < 0.1 | **0** | **0** | **0** | **PASS** |
| (ref) FCP | — | — | 0.281 s | 1.515 s | 2.436 s | — |
| (ref) Speed Index | — | — | 0.281 s | 2.874 s | 2.433 s | — |
| (ref) TTI | — | — | — | 1.688 s | — | — |
| (ref) Perf score | — | — | 1.00 | 0.99 | 0.94 | — |

### 2.2 Red budget captured (§9.1 recommended LCP line only)

- **Metric:** LCP (first load), mobile at the §9.1 measurement condition.
- **Failing value:** **1,623.6 ms** vs the §9.1 line **< 1,500 ms** — over by **123.6 ms (8.2%)**.
- At throttled 3G the same metric measures **2,436.4 ms** — over the §9.1 line by 936 ms, and only
  **63.6 ms under** the task's 2.5 s DoD line (thin margin; a content or network regression of
  ~2% would flip it).
- TBT and CLS are green everywhere with large margins (worst TBT 8.5 ms of 200 ms; CLS exactly 0).
- Desktop LCP 285.6 ms passes both lines.

**Report JSONs:** [`lighthouse-summary.json`](./lighthouse-summary.json) (extracted metrics),
full Lighthouse reports [`lighthouse-desktop.json`](./lighthouse-desktop.json),
[`lighthouse-mobile-slow4g.json`](./lighthouse-mobile-slow4g.json),
[`lighthouse-mobile-3g.json`](./lighthouse-mobile-3g.json).

### 2.3 Other §9.1 lines (context, not re-measured here)

Already evidenced by prior QA cards, listed for the DoD compiler's §9.1 table:

- **Warm/offline start-to-interactive < 300 ms:** PASS — 40 samples, 4× CPU-throttled medians
  89.5 ms (warm) / 75.9 ms (offline); `e4-epic-close-boot-budget.json` (see
  `../e4-offline.md`).
- **Search over 10,000 tasks < 50 ms:** AMBER — cold first keystroke straddles the line
  (44.7–54.8 ms, median 51.3 ms); warm ≤ 19.4 ms (`../e2-search-reorder.md` O1).
- **Virtualize beyond ~200 DOM rows:** open defect V1 at the time of the E2 M5/M6 report
  (`../e2-search-reorder.md`) — see the scope-fidelity/DoD cards for its current status.

## 3. Full artifacts & links

| Artifact | Location |
|----------|----------|
| CI run (subject) | https://github.com/e23thr/browser-todo-app/actions/runs/40211837248 (HEAD `6a3f5ab`) |
| CI `bundle-budget` job log | https://github.com/e23thr/browser-todo-app/actions/runs/40211837248/job/121224642977 |
| CI `dist` artifact (inputs to §1) | run page → Artifacts → `dist` (7-day retention, uploaded 2026-10-25 16:29Z) |
| Nightly workflow (the only §9.1 boot-line enforcement) | https://github.com/e23thr/browser-todo-app/actions/workflows/nightly.yml — **0 runs to date** |
| Deployed build under test | https://e23thr.github.io/browser-todo-app/ |
| Report JSONs (this folder) | `bundle-budget-report.json`, `bundle-per-chunk.json`, `lighthouse-summary.json`, `lighthouse-desktop.json`, `lighthouse-mobile-slow4g.json`, `lighthouse-mobile-3g.json` |
