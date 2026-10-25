# E1 QA — Scaffold & CI quality gates

**Card:** t_c7d6403e (Test: Scaffold & CI quality gates), Epic E1 · **Reviewer of record:** h_reviewer
**Date:** 2026-10-23 · **Refs:** PROJECT_ANALYSIS.md §9.2 (bundle budgets), §9.5 (quality gates),
§7.2 (privacy/CSP policies)

## 0. Scope, environment and how to reproduce

This report proves that the scaffold's quality gates **actually fail when violated** — a gate that
can never fail is a defect — plus three structural requirements: configurable base path, CSP meta
tag fidelity to §7.2, and the zero-runtime-third-party rule.

| Item | Value |
|---|---|
| Subject under test | clean `git clone` of the project repo at **HEAD `c28de35`** (6 commits, scaffold + CI) |
| Why a clone | the shared working tree carries in-progress sibling cards' untracked files (storage, i18n/theme) that are not part of this scaffold; see D4 |
| Toolchain | Node v22.22.1 (.nvmrc), `npm ci` (387 packages, exit 0), Playwright chromium 1248 |
| Base path under test | `BASE_PATH=/browser-todo-app/` (GitHub Pages project-pages style, as `ci.yml` sets) |
| Raw evidence | `docs/qa/e1-scaffold-gates-logs/` (verbatim stdout of every run below; scratch copies are pruned, these are durable) |

Gate inventory as wired in `.github/workflows/ci.yml` (deploy job `needs:` all eight):

| Job | Command | Gate |
|---|---|---|
| lint | `npm run lint` + `npm run format:check` | ESLint 9 `--max-warnings 0`, Prettier |
| typecheck | `npm run typecheck` | `tsc -b`, strict, 4 project references |
| unit | `npm run test:coverage` | Vitest + v8 coverage thresholds (80% on `src/domain`, `src/storage`) |
| build | `npm run build` | `tsc -b && vite build` under `BASE_PATH` |
| bundle-budget | `node scripts/check-bundle-budget.mjs --dist dist` | §9.2: initial-js, css, app-shell, locales, locales-lazy, no-external-refs, no-wasm |
| e2e-smoke | `npm run e2e:smoke` | 7 Playwright tests incl. CSP listener + zero-third-party + base path |
| a11y-axe | `npm run e2e:a11y` | axe-core wcag2a/2aa/21a/21aa/22aa; serious/critical fail |
| audit | `npm run audit:gate` | `npm audit --omit=dev --audit-level=high` |

## 1. Baseline: the full gate suite on a clean clone

Command (per gate, from the clone root, `BASE_PATH=/browser-todo-app/`):

| Gate | Command | Expected | Actual | Exit |
|---|---|---|---|---|
| Prettier | `npm run format:check` | 0 | "All matched files use Prettier code style!" | 0 |
| ESLint | `npm run lint` | 0 | clean, 0 problems | 0 |
| Typecheck | `npm run typecheck` | 0 | clean | 0 |
| Unit + coverage | `npm run test:coverage` | 0 | 35 tests pass; 88.18% stmts / 81.96% branches | 0 |
| Build | `npm run build` | 0 | 4 emitted assets (entry JS 18.87 kB raw / 7.74 kB gz) | 0 |
| Bundle budgets | `npm run budget` | 0 | `RESULT: PASS` (all 7 sub-gates) | 0 |
| Audit | `npm run audit:gate` | 0 | `found 0 vulnerabilities` | 0 |
| E2E smoke | `npm run e2e:smoke` | 0 | 7/7 passed (4.3 s) | 0 |
| Axe | `npm run e2e:a11y` | 0 | 1/1 passed (4.5 s) | 0 |

Baseline budget report (`e1-scaffold-gates-logs/base-budget.txt`):

```
  gate              measured    limit       status
  initial-js        7.5 KB      100.0 KB    PASS
  css               1.0 KB      20.0 KB     PASS
  app-shell         9.7 KB      200.0 KB    PASS
  locales           0.0 KB      20.0 KB     PASS
  locales-lazy      0 hit(s)    0           PASS
  no-external-refs  0 hit(s)    0           PASS
  no-wasm           0 hit(s)    0           PASS
RESULT: PASS
```

## 2. Deliberate-violation runs (one gate at a time, tree restored after each)

Every run: mutate exactly one thing → run the exact gate command → record exit code → restore
(`git checkout` / rebuild). The clone is byte-clean at the end of each pair.

### 2.1 Prettier (`format:check`) — proven to fail

- Command: add unformatted `src/viol-format.ts`, `npm run format:check`
- Expected: exit 1 · **Actual: exit 1** — `[warn] src/viol-format.ts … Code style issues found`
  (`e1-scaffold-gates-logs/viol-format.txt`)

### 2.2 ESLint (`lint`) — proven to fail

- Command: append `console.log("deliberate lint violation")` to `src/app/router.ts`, `npm run lint`
- Expected: exit 1 · **Actual: exit 1** —
  `159:3 error Unexpected console statement. Only these console methods are allowed: error, warn  no-console`
  (`e1-scaffold-gates-logs/viol-lint.txt`)

### 2.3 Typecheck (`tsc -b`) — proven to fail

- Command: append `export const violType: number = "not a number";` to `src/app/router.ts`,
  `npm run typecheck`
- Expected: exit 2 · **Actual: exit 2** —
  `src/app/router.ts(158,14): error TS2322: Type 'string' is not assignable to type 'number'.`
  (`e1-scaffold-gates-logs/viol-typecheck.txt`)

### 2.4 Unit tests (Vitest) — proven to fail

- Command: add `tests/unit/viol-fail.test.ts` asserting `expect(1).toBe(2)`, `npm run test:coverage`
- Expected: exit 1 · **Actual: exit 1** — `Test Files 1 failed | 3 passed (4)`, `Tests 1 failed | 35 passed (36)`
  (`e1-scaffold-gates-logs/viol-unit.txt`)

### 2.5 Coverage thresholds (unit job) — proven to fail

- Command: add uncovered `src/domain/viol-uncovered.ts`, `npm run test:coverage`
- Expected: exit 1 · **Actual: exit 1** —
  `ERROR: Coverage for lines (0%) does not meet "./src/domain/**/*.ts" threshold (80%)`
  (same for functions/statements/branches) (`e1-scaffold-gates-logs/viol-coverage.txt`)
- Note: with no `src/domain`/`src/storage` files at all the thresholds pass vacuously by design
  (fixture-tested); they activate the moment those dirs gain files — which the sibling storage card
  is about to prove in practice.

### 2.6 Bundle budgets (`npm run budget`) — every sub-gate proven to fail

**2.6a initial-js over budget (the headline requirement).**
Command: append 140 KB of incompressible bytes to the real entry artifact
`dist/assets/index-DyYZh3X9.js`, then `npm run budget`.
Expected: exit 1 · **Actual: exit 1** —

```
  initial-js        148.0 KB    100.0 KB    FAIL
  css               1.0 KB      20.0 KB     PASS
  app-shell         150.2 KB    200.0 KB    PASS
RESULT: FAIL — build is over budget
```

(`e1-scaffold-gates-logs/viol-bundle.txt`) — **explicit statement required by the card:** no
over-budget build passed silently in any run; a measured value above a limit always produced
`RESULT: FAIL` and exit 1, which reddens the `bundle-budget` CI job and blocks `deploy` (`needs:`).
Restored build re-runs `RESULT: PASS`. (app-shell stayed PASS at 150.2 KB because its limit is
200 KB — initial-js is the binding constraint here, and it did bind.)

**2.6b locales over budget.**
Command: install two ~14 KB locale packs (`src/i18n/locales/{en,th}.ts` manifest entries →
`assets/locale-*.js`), `npm run budget`. Expected: exit 1 · **Actual: exit 1** —
`locales 27.9 KB 20.0 KB FAIL` (`viol-locales.txt`).

**2.6c locales must be lazy.**
Command: reference a locale pack from the entry's static `imports`, `npm run budget`.
Expected: exit 1 · **Actual: exit 1** — `locales-lazy 1 hit(s) 0 FAIL` (`viol-locales-lazy.txt`).

**2.6d zero third-party refs.**
Command: append `background-image:url(https://cdn.example.com/tracker.png)` to shipped CSS,
`npm run budget`. Expected: exit 1 · **Actual: exit 1** —

```
  no-external-refs  1 hit(s)    0           FAIL
      assets/index-BxbRxJcw.css → https://cdn.example.com/tracker.png
```

(`viol-external.txt`)

**2.6e no WASM.**
Command: drop `dist/assets/viol-probe.wasm`, `npm run budget`. Expected: exit 1 · **Actual: exit 1** —
`no-wasm 1 hit(s) 0 FAIL … assets/viol-probe.wasm` (`viol-wasm.txt`).

**2.6f css / app-shell** use the same measurement path and fail-close behaviour as 2.6a (a single
`RESULT: FAIL` + exit 1 for any exceeded limit); the css and app-shell limits were not separately
inflated — 2.6a proves the enforcement path they share. Honest gap, called out rather than implied.

### 2.7 E2E smoke — proven to fail (with one defect, see D1)

- Command: rename the Today heading to `Tomorrow` in `src/features/today/TodayView.tsx`,
  `npx playwright test --project=chromium tests/e2e/smoke.spec.ts`
- Expected: exit 1 · **Actual: exit 1** — 3 of 7 tests fail
  (`boots under a non-root base path…`, `hash deep links resolve…`, `no CSP violation fires…`),
  `expect(locator).toBeVisible() failed` (`e1-scaffold-gates-logs/viol-smoke2.txt`)
- Incidental but useful: when the app does not compile at all, the Playwright `webServer` build
  aborts (`Process from config.webServer was not able to start. Exit code: 2`) and the e2e job goes
  red rather than testing a stale artifact (`viol-axe.txt`, first attempt).

### 2.8 axe (`e2e:a11y`) — proven to fail

- Command: add `<img src="/favicon.svg" width="24" height="24" />` (no alt) to TodayView,
  `npx playwright test --project=chromium tests/e2e/a11y.spec.ts`
- Expected: exit 1 · **Actual: exit 1** —
  `+ "image-alt: Images must have alternative text"` in the blocking list, `1 failed`
  (`e1-scaffold-gates-logs/viol-axe.txt`)

### 2.9 Audit (`audit:gate`) — not deliberately violable

Baseline `found 0 vulnerabilities`, exit 0. Failing this gate requires a high/critical advisory
against a production dependency — not something to fabricate on demand. Gate semantics are npm's
(`--audit-level=high`); the dev-dependency audit is warn-only per ADR-001 §4. Recommend relying on
`nightly.yml` + GitHub Dependabot for live coverage. **No violation evidence available; stated
plainly instead of pretending.**

### 2.10 Missing-locale-key / i18n check — NOT PRESENT in the scaffold

The card asked for this "via the i18n check if present". It is not: the scaffold has no `src/i18n`
module, no locale packs and **no key-parity or missing-key check anywhere** (repo search for
i18n/locale/translation surfaces only the budget-gate fixtures). The only locale enforcement today
is byte budget + lazy placement (both proven in 2.6b/2.6c). See D2.

## 3. Configurable base path (§9.5)

| Check | Command | Expected | Actual |
|---|---|---|---|
| Asset URLs prefixed | `BASE_PATH=/browser-todo-app/ npm run build`, inspect `dist/index.html` | all URLs under the base | `href="/browser-todo-app/favicon.svg"`, `src="/browser-todo-app/assets/index-DyYZh3X9.js"`, `href="/browser-todo-app/assets/index-BxbRxJcw.css"`; zero `src="/src/…"` left |
| Serves under `/<repo>/` | `npx vite preview`, `curl` | 200 under base | `GET /browser-todo-app/` → 200; `GET /browser-todo-app/assets/index-*.js` → 200 |
| Routing works under base | network-trace run (below) | Today→Settings→Today | headings `["Today","Settings","Today"]` — the lazy settings chunk loaded from `/browser-todo-app/assets/SettingsView-*.js` (200) |
| Configurable, not hardcoded | `BASE_PATH=/my-portfolio/todo/ npm run build` | URLs follow the new base | `src="/my-portfolio/todo/assets/index-DpiQE5IA.js"` etc., budget `RESULT: PASS` |
| CI wiring | `ci.yml` `env.BASE_PATH` | `/${{ github.event.repository.name }}/` | present; Playwright `webServer` also injects `BASE_PATH` so E2E always runs under a non-root base |

## 4. CSP meta tag vs §7.2

Shipped policy in `dist/index.html` (verified with an independent script that re-parses the meta
tag, checks every directive against §7.2, forbids extras, and recomputes the inline-script hash):

```
default-src 'self'; script-src 'self' 'sha256-LOSsDGWNzMa5G5XIx9VyH2TIWZ5M9GbQCuX/I7u5cKI=';
style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'
```

| Check | Expected (§7.2) | Actual |
|---|---|---|
| directive set | default-src / script-src / style-src / img-src / connect-src / object-src / base-uri, exactly | exact match, no unexpected directives |
| values | `'self'` everywhere; `img-src 'self' data: blob:`; `object-src 'none'`; `base-uri 'none'` | exact match |
| `frame-ancestors` | **dropped** (meta-tag exception, documented in index.html + README) | absent ✓ |
| inline script | only the hashed theme-boot snippet | hash recomputed from the shipped bytes: `sha256-LOSsDGWNzMa5G5XIx9VyH2TIWZ5M9GbQCuX/I7u5cKI=` — **matches** the declared `script-src` hash |
| production strictness | no `'unsafe-inline'` / `'unsafe-eval'` | none present in the build (the dev-only relaxation in `vite.config.ts` applies to `vite dev` and never to the shipped artifact) |
| runtime silence | no CSP violations while booting/navigating | smoke test with a `securitypolicyviolation` listener passes: 0 violations (`base-e2e-smoke.txt`) |

## 5. Zero runtime third-party requests (§7.2 / §9.2)

**Static scan of the built output** (independent of the budget gate): every `http(s)://` occurrence
in `dist/` —

```
1 dist/assets/index-DyYZh3X9.js:http://www.w3.org/1998/Math/MathML
2 dist/assets/index-DyYZh3X9.js:http://www.w3.org/1999/xhtml
2 dist/assets/index-DyYZh3X9.js:http://www.w3.org/2000/svg
1 dist/favicon.svg:http://www.w3.org/2000/svg
```

All four are XML namespace identifiers emitted by Preact (never fetched); `no-external-refs` agrees:
`0 hit(s) PASS`, and 2.6d proves it FAILs when a real external URL appears.

**Network-trace run** (browser, fresh context, production build served under the base path; boots,
navigates to Settings (lazy chunk), back to Today) — `e1-scaffold-gates-logs/net-trace.json`:

```
requestCount: 4
uniqueUrls:
  http://127.0.0.1:4173/browser-todo-app/
  http://127.0.0.1:4173/browser-todo-app/assets/SettingsView-B2VEzhxE.js
  http://127.0.0.1:4173/browser-todo-app/assets/index-BxbRxJcw.css
  http://127.0.0.1:4173/browser-todo-app/assets/index-DyYZh3X9.js
foreignOrigins: []        ← zero third-party requests
responses: all 200
```

Verdict: **zero runtime third-party bytes — rule holds, with both static and live evidence.**

## 6. Defect list

**D1 — MEDIUM (gate reliability): smoke role-name matching is substring-based, so a wrong heading
passes the whole suite.** `tests/e2e/smoke.spec.ts:23,35,65` use
`getByRole('heading', { name: 'Today' })` / `getByRole('link', { name: 'Today' })` with Playwright's
default name matching (case-insensitive substring). Renaming the heading to **`Todayy` produced
exit 0 with 7/7 passing** (`e1-scaffold-gates-logs/viol-smoke.txt`) — the gate can silently accept a
broken label. Fix: add `exact: true` to every `getByRole(..., { name })` in the smoke/a11y suites
(or match by regex `/^Today$/`). Not an over-budget silent-pass (none exists — see 2.6a), but the
same class of problem: a gate that doesn't detect the break it claims to detect.

**D2 — GAP (expected, tracked to the i18n card): no missing-locale-key check exists.** The committed
scaffold has no i18n module and no locale key-parity/missing-key gate (§2.10). The locales budget
gates only police size and lazy placement. An i18n implementation is already in flight in the shared
tree (untracked `src/app/i18n.ts`, owned by the i18n card): when its locale packs land, a key-parity
check (en vs th, plus missing-key detection against the message catalogue) must be added and its
failure path proven — this card's checklist item stays open until then.

**D3 — INFO (local only): `reuseExistingServer: true` outside CI** (`playwright.config.ts`) means a
locally running `vite preview` can serve a stale `dist/` to an E2E run that skips the webServer
build. CI is unaffected (`CI: 'true'` disables reuse and the webServer command always rebuilds).
Suggest `reuseExistingServer: false` or a build-hash assertion if local runs ever gate anything.

**D4 — INFO (not a scaffold defect): the shared working tree is currently red.** Untracked
sibling-card files (`src/storage/*`, `tests/unit/storage/*`, `src/app/theme.ts` — note
`src/app/i18n.ts` is also in flight but currently lint-clean) produce 53 ESLint
errors and would fail prettier/coverage there (`e1-scaffold-gates-logs/shared-tree-lint.txt`).
None belong to the committed scaffold; all runs in this report therefore used a clean clone of
`c28de35`. The storage/i18n cards must land green.

**Explicit attestation requested by the card:** *no run silently passed an over-budget build.* The
three deliberate over-budget runs (2.6a initial-js 148 KB > 100 KB, 2.6b locales 27.9 KB > 20 KB,
2.6c eager locale chunk) each returned `RESULT: FAIL` with exit 1. The only silent-pass defect found
anywhere in the gate suite is D1 (smoke label matching), which is about labels, not budgets.

## 7. Verdict

**PASS with findings.** All 9 exercisable gates fail when deliberately violated (§2.1–2.8), the
base path is genuinely configurable and verified served under `/<repo>/` (§3), the CSP meta tag
matches §7.2 exactly with the documented `frame-ancestors` exception and a verified script hash
(§4), and the built output makes zero third-party requests under both static scan and live network
trace (§5). Open items: D1 (fix smoke `exact: true` — small diff, belongs to the scaffold/impl
card or a follow-up), D2 (locale-key gate with the i18n card), D3/D4 informational.
