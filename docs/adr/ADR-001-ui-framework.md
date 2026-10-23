# ADR-001: UI framework & build tooling

**Status**: Accepted
**Decider**: h_senior_coder (sole decider per task t_9fa51c86; single-decider rule — no other card may choose UI framework or build tooling)
**Date**: 2026-10-23
**Epic**: E1 Infrastructure & DevOps

---

## Context

The app is a privacy-preserving, local-first todo web app: static output only, no backend, deployed
to GitHub Pages via GitHub Actions (PO Q11). Section 9.2 of `PROJECT_ANALYSIS.md` explicitly leaves
the UI framework choice (Preact vs Svelte vs vanilla+TS) to this ADR, constrained by hard bundle
budgets. Downstream implementation cards (scaffold, core domain, i18n, service worker) cannot start
until the framework, toolchain and CI shape are fixed.

**Hard budgets (§9.2, binding):**

| Asset | Budget |
|---|---|
| Initial JS (gzip) | ≤ 100 KB (target 80 KB) |
| CSS (gzip) | ≤ 20 KB |
| Total app shell (gzip, excl. icons/manifest) | ≤ 200 KB |
| Runtime third-party bytes | **0** |
| WASM | 0 in MVP (a WASM payload is a budget exception requiring its own ADR) |
| Locale strings (en + th, lazy per-locale) | ≤ 20 KB gzip total |

Route-level code-splitting is required for settings/features beyond the core loop.

**Binding constraints (already decided elsewhere — NOT re-decided here):**

- Static output only, no backend; local-first, offline-first (§0).
- Deploy target: GitHub Pages via GitHub Actions (PO Q11, §9.5). Consequences already folded in
  there and restated here only as *build requirements*:
  - the build MUST accept a configurable **base path** (project pages serve under `/<repo>/`, which
    sets service-worker scope and, in V1, manifest `start_url`/`scope`);
  - CSP ships as a `<meta http-equiv>` tag (GitHub Pages sets no response headers);
    `frame-ancestors` is dropped as a documented exception (§7.2);
  - HTTPS comes from `*.github.io`.
- System font stack only; no webfonts (§7.2, §9.2 — Thai renders via system fallbacks).
- Dependency policy (§7.2): minimal deps, committed lockfile, bundled output, license review,
  routine audit; user content rendered as text (no `dangerouslySetInnerHTML`).
- Testing stack is pre-decided (§9.5): TypeScript strict, Vitest for unit, Playwright for E2E,
  axe-core checks in CI, coverage ≥ 80% on domain/migrations/merge modules.

**Interpretation note (recorded to prevent downstream confusion):** "Runtime third-party bytes: 0"
means zero bytes fetched from third-party origins at runtime (no CDNs, no hosted fonts, no remote
icons — §7.2). Bundled, license-reviewed, lockfile-pinned open-source library code served from our
own origin is permitted (§7.2 dependency policy explicitly contemplates "storage wrapper, router if
any, bundled output"). The CI gate enforces this as "no external-origin references in `dist/`".

## Decision

**UI framework: Preact 10.x + `@preact/signals` + TSX.**
**Build tooling: Vite 8 + TypeScript 6 strict + npm (committed lockfile) + ESLint/Prettier,
Vitest + Testing Library + Playwright + axe-core, CI matrix with a build-failing bundle-budget gate.**

### 1. UI framework — Preact + signals

- **Preact 10.29.x** with **`@preact/signals` 2.x** for state. Measured footprint: Preact core
  4.72 KB gzip; the full Vite `preact-ts` template build (framework + demo app) is **7.01 KB gzip**
  (evidence below). This leaves roughly 73–93 KB gzip of the initial-JS budget for application
  code — the budget is won or lost on app code discipline, not framework choice.
- **Version stance**: pin Preact **10.x** at scaffold time — the combination exercised by the
  official Vite template and peer-supported by `@preact/signals@2.11.3` (`preact >= 10.25.0 ||
  >= 11.0.0-0`). Preact 11.0.x exists (verified 2026-10-23) but adopting a fresh major at scaffold
  time is churn we don't need; upgrading 10 → 11 is a **routine dependency PR** gated by the same
  CI suite, not an architectural change and not a re-open of this ADR.
- **No `preact/compat`** — we never need the React compatibility layer. It is the documented escape
  hatch only (see Consequences).
- Components are **typed TSX function components** (props are exact interfaces, no `any` — enforced
  by `tsc` strict + lint). Signals for shared reactive state (task store, view state); local
  component state via hooks where a signal is overkill.
- Rendering discipline (§7.2): user content flows through JSX text nodes only —
  no `dangerouslySetInnerHTML`, no `innerHTML`, ever.

### 2. Routing — in-house hash router (no router dependency)

- ~100–150 LOC `src/app/router.ts` over `location.hash` (`#/today`, `#/list/:id`, `#/settings`, …),
  unit-tested. **Hash routing** because GitHub Pages serves static files with no rewrite rules:
  deep links like `/repo/settings` would 404, while `/#/settings` always resolves. This is the
  boring, zero-config answer for static hosting and independent of the asset base path.
- **Route-level code-splitting**: each route's view is a dynamic `import()` chunk; the core loop
  (capture → today view → complete) is the only always-loaded UI. Settings, export/import, storage
  dashboard, and locale packs are lazy chunks. Vite's Rollup-based output enforces this structurally.
- §7.2 anticipated at most a router dependency; we take zero, keeping the dependency surface at
  exactly two runtime packages at scaffold (`preact`, `@preact/signals`).

### 3. Build tool — Vite 8

- `base` is configurable via **`BASE_PATH` env** (`vite.config.ts`:
  `base: process.env.BASE_PATH ?? '/'`). Local dev defaults to `/`; the GitHub Actions deploy job
  sets `BASE_PATH=/<repo>/`. This satisfies the §9.5 base-path requirement; the service-worker
  card (ADR-003) derives its scope from the same value.
- Production `build.sourcemap: false` (maps are not published to Pages — smaller artifact, no
  source disclosure; dev keeps full maps). Debugging story is local error log + repro (no telemetry
  is a hard policy, §7.2).
- No inline runtime scripts; the single allowed inline **theme-boot snippet** (anti-FOUC,
  localStorage theme read before first paint) ships as a hashed inline `<script>` whose SHA-256 is
  allow-listed in the CSP `<meta http-equiv>` tag per §7.2.
- **CSP interplay caveat**: the meta CSP carries `style-src 'self'`. Prefer CSS classes and custom
  properties over inline `style` attributes in components; where Preact style objects are
  unavoidable, verify in E2E with a `securitypolicyviolation` listener (CSSOM property assignment
  is not blocked, but attribute-based inline styles are). The E2E suite fails on any CSP violation.

### 4. Package manager & lockfile policy — npm

- **npm** with committed **`package-lock.json`** (lockfile v3, integrity hashes). Rationale: ships
  with Node, zero extra tooling, universal CI/agent support. (`pnpm` was considered; its strict
  layout is nice but adds a toolchain assumption for no budget benefit at this dependency count.)
- CI installs with **`npm ci`** (never `npm install`); a stale lockfile fails the build.
- Node LTS pinned exactly via `.nvmrc` + `actions/setup-node` `node-version-file`. Verified
  baseline at ADR time: **Node v22.22.1 / npm 9.2.0** with the Vite 8 + TypeScript 6.0.3 toolchain
  (this ADR's measurements were produced on it).
- Runtime dependency allow-list (this ADR is the license + size review for the initial set):
  `preact`, `@preact/signals`. Planned addition, reviewed here as acceptable in class:
  `idb` (thin typed IndexedDB wrapper, ~1.5 KB gz — finalized in the storage ADR). Everything
  else (i18n frameworks, date libraries, UI kits, icon packs) is **out**: locales use a minimal
  in-house helper + `Intl.PluralRules`; dates are `YYYY-MM-DD` strings (§5.2) needing no library;
  icons are inlined SVG components. New runtime deps require: license review (permissive only),
  gzip-size entry in the PR description, and an ADR amendment note.
- Dependency updates: monthly grouped PRs (Dependabot), never auto-merged; same CI gates apply.
  `npm audit` gate: **fails on high/critical advisories in production dependencies**; dev
  dependencies warn only (plus a weekly scheduled full audit).

### 5. Lint / format / type-check toolchain

- **ESLint 9 (flat config)** + `typescript-eslint` in `strictTypeChecked` mode (type-aware linting),
  `eslint-plugin-jsx-a11y` (static a11y catches at author time — labels, roles, alt text),
  `eslint-config-prettier` (no stylistic duplication). CI runs `eslint --max-warnings 0`.
- **Prettier** owns formatting; `prettier --check` in CI. No style bikeshedding in review.
- **TypeScript strict config** (`tsconfig.app.json`, beyond `strict: true`):

  ```jsonc
  {
    "compilerOptions": {
      "strict": true,
      "noUncheckedIndexedAccess": true,
      "exactOptionalPropertyTypes": true,
      "noImplicitOverride": true,
      "noFallthroughCasesInSwitch": true,
      "noPropertyAccessFromIndexSignature": true,
      "verbatimModuleSyntax": true,
      "isolatedModules": true,
      "target": "ES2022",
      "lib": ["ES2022", "DOM", "DOM.Iterable"],
      "module": "ESNext",
      "moduleResolution": "bundler",
      "jsx": "react-jsx",
      "jsxImportSource": "preact",
      "noEmit": true,
      "skipLibCheck": true
    }
  }
  ```

  `target: ES2022` is validated by the §9.4 browser floor (iOS Safari ≥ 16.4, Android Chrome ≥
  110, last 2 majors elsewhere). `skipLibCheck: true` only silences dependency `.d.ts` noise — our
  code is fully checked. Type-check gate: `tsc -b` (project references, app + node configs).

### 6. Testing toolchain (fixed by §9.5; concretized here)

- **Unit**: Vitest. **Component**: Vitest + `@testing-library/preact` + jsdom. **E2E**: Playwright
  (chromium smoke on every PR; chromium + firefox + webkit on main/nightly). **a11y**:
  `@axe-core/playwright` scans on core views + keyboard-only scripted flows. Coverage gate: ≥ 80%
  lines/branches on `src/domain/`, `src/storage/` (migrations, merge rules) — per §9.5.
- The mandated E2E spine runs **offline**: add → complete → reload → data present → export → wipe →
  import → data restored.

### 7. CI job matrix shape (GitHub Actions)

| Job | Trigger | What it runs | Gate behavior |
|---|---|---|---|
| `lint` | every PR + main | `eslint --max-warnings 0`, `prettier --check` | fail on any warning/error |
| `typecheck` | every PR + main | `tsc -b` | fail on any error |
| `unit` | every PR + main | `vitest run --coverage` | fail on test failure or coverage < 80% on gated modules |
| `build` | every PR + main | `BASE_PATH=/<repo>/ npm run build` | fail on build error; uploads `dist/` artifact |
| `bundle-budget` | every PR + main (needs `build`) | `node scripts/check-bundle-budget.mjs` | **FAILS the build over budget** (thresholds below) |
| `e2e-smoke` | every PR + main (needs `build`) | Playwright chromium: core loop + offline data spine + CSP-violation listener | fail on any test failure or CSP violation |
| `a11y-axe` | every PR + main (needs `build`) | axe-core scans of core views (en + th), keyboard-only script | fail on any serious/critical violation |
| `audit` | every PR + main + weekly schedule | `npm audit` | fail on high/critical in production deps; dev deps warn |
| `deploy` | main only, after all gates | upload Pages artifact + `actions/deploy-pages` | deploy only from green main |
| `e2e-full` | main/nightly | chromium + firefox + webkit matrix, Thai-locale pass | fail on any failure |

All jobs run on `ubuntu-latest` with `npm ci` + Node from `.nvmrc`; concurrency group cancels
superseded PR runs.

### 8. Budget table restated as explicit CI gate thresholds

Single source of truth: `scripts/bundle-budgets.json`, enforced by `scripts/check-bundle-budget.mjs`.
Measurement method (fixed to prevent gate drift): production build via `npm run build`, then gzip
**level 9** over `dist/` files, excluding `*.map` (never published) and excluding `icons/` +
`manifest` from the app-shell sum.

| §9.2 asset | Budget | CI gate | Threshold semantics |
|---|---|---|---|
| Initial JS (gzip) | ≤ 100 KB (target 80 KB) | `initial-js` | sum of all JS chunks in the entry's static import closure (framework + app core + always-loaded UI); **FAIL > 100 KB**, warn ≥ 80 KB |
| CSS (gzip) | ≤ 20 KB | `css` | sum of all CSS in `dist/`; **FAIL > 20 KB** |
| Total app shell (gzip, excl. icons/manifest) | ≤ 200 KB | `app-shell` | HTML + initial JS + CSS + service worker + initial locale chunk; lazy route/locale chunks excluded; **FAIL > 200 KB** |
| Runtime third-party bytes | 0 | `no-external-refs` | **FAIL** on any `http(s)://` external-origin reference in shipped JS/CSS/HTML (CSP `connect-src 'self'` is the runtime backstop) |
| WASM | 0 in MVP | `no-wasm` | **FAIL** on any `.wasm` asset in `dist/` (any future WASM payload requires its own ADR first) |
| Locale strings (en + th) | ≤ 20 KB gzip total | `locales` | **FAIL** > 20 KB combined; **FAIL** if any locale pack is found inside the initial JS closure (each locale must be a lazy chunk) |

### 9. Repo layout convention

```
/                     project root: package.json, package-lock.json, tsconfig*, eslint/prettier config,
                      .nvmrc, .editorconfig, vite.config.ts, GitHub Actions workflows
  public/             static assets copied verbatim (favicon etc.; zero third-party bytes)
  src/
    app/              bootstrap, hash router, app shell, providers, theme-boot
    features/         feature modules (tasks/, lists/, search/, settings/, backup/, ...)
    components/       shared presentational + a11y primitives (focus trap, live region, ...)
    domain/           pure domain logic — no DOM, no IDB imports (primary unit-test target)
    storage/          IDB wrapper, repositories, migrations (governed by the storage ADR)
    i18n/             minimal i18n helper + lazy locale chunk loading (en, th)
    styles/           global CSS, design tokens (CSS custom properties, system font stack)
    sw/               service worker source (governed by the service-worker ADR)
  tests/
    unit/             Vitest specs (domain, storage, migrations, merge rules)
    component/        Vitest + Testing Library (preact) specs
    e2e/              Playwright specs, offline data spine, axe scans, keyboard scripts
  docs/
    adr/              Architecture Decision Records (this file + index README)
    design/           Design Specs from h_designer, UX notes
  scripts/            check-bundle-budget.mjs, bundle-budgets.json, other CI/build scripts
```

Import boundaries (enforced by ESLint `no-restricted-imports` + review):
`domain/` imports nothing from `app/`, `features/`, `storage/`, or the DOM; `components/` and
`features/` may import `domain/` and `storage/` but never each other's internals (public
`index.ts` surfaces only).

## Alternatives considered

Budget-impact numbers are **measured** (this ADR's spike, 2026-10-23: Vite 8 official templates,
`npm run build`, gzip level 9, template demo app included):

| Option | Framework JS (gzip) | Est. MVP initial JS (gzip) | Pros | Cons | Why not |
|---|---|---|---|---|---|
| **Preact + signals (CHOSEN)** | 7.01 KB (template build incl. demo; preact core 4.72 KB) | ~45–65 KB | Smallest mainstream component runtime (measured smallest of the two frameworks); TSX gives airtight strict typing of component APIs; React-shaped idiom is the most widely known — lowest idiomatic risk for a multi-agent/junior team; signals give fine-grained updates for the 10k-task virtualized list; escape hatch to React via `preact/compat` | Virtual DOM concepts to learn; JSX build step needed; a11y warnings are lint-time (jsx-a11y), not compile-time | — |
| Svelte 5 (runes) | 11.97 KB (template build incl. demo — larger than Preact here) | ~50–70 KB | Compile-time a11y warnings (valuable for the WCAG gate); scoped styles; no VDOM | Measured **larger** output than Preact at this app size (runes runtime); template type-checking looser than full TSX strict; compiler lock-in — Svelte majors change compile output (migration = touch every component); smaller agent-training footprint → more idiomatic review churn | Fit budgets fine but loses on typing rigor, migration risk, and team fluency |
| Vanilla + TS | 0 framework (1.94 KB demo app) | ~35–60 KB **plus** 5–15 KB homegrown view/state glue | Absolute minimum bytes | We must build and *own* diffing, state→view sync, event lifecycle, focus management, list virtualization glue — pure liability code ("write less" violated); highest defect surface exactly where the product is hardest (a11y live regions, focus traps, 10k-row virtualization); slowest delivery; component testing story weakest | Saves maybe 3–8 KB gz vs Preact while adding weeks of framework-building and a permanent maintenance burden |
| React / Vue / Solid / others | React ~45 KB gz alone | likely > 100 KB | ecosystems | Not in the §9.2 candidate set; React core alone would eat ~half the initial-JS budget before app code | Out of scope by §9.2 |

**Decisive insight**: at scaffold scale all three candidates fit the budget with enormous headroom
(measured 2–12 KB gz against a 100 KB budget), so the budget cannot and should not decide this.
The decision is made on defect surface and team economics: a typed component model that juniors
and agents write reliably, with the smallest measured runtime. Preact wins; Svelte is a close,
respectable second; vanilla+TS is false economy.

## Consequences

**Positive**

- Initial-JS headroom of ~73–93 KB gzip for app code against the 80/100 KB targets — budgets are
  comfortable to hold with the bundle gate as enforcement.
- Strict TSX means component APIs (props/events) are compiler-checked contracts — this is the
  surface h_designer and I co-design in Epic 2/5, and it is reviewable as types.
- Two runtime dependencies at scaffold; both permissive-licensed and lockfile-pinned. Audit and
  budget gates make supply-chain and bloat regressions build-breaking, not review opinions.
- Hash routing + `BASE_PATH` build parameter means GitHub Pages deployment needs no rewrite hacks
  and the future service worker (ADR-003) inherits a clean scope story.
- Preact/compat escape hatch: if the ecosystem pull toward React ever becomes overwhelming, the
  migration is an import-alias change (+~2–3 KB), not a rewrite.

**Negative / costs**

- Virtual DOM + signals has a small learning/idiom cost; mitigated by the review checklist and the
  `components/` primitives layer (juniors compose primitives rather than touching DOM).
- jsx-a11y is static analysis only — dynamic a11y (focus return, live-region timing) still needs
  the Playwright keyboard scripts and axe scans in CI plus the manual NVDA/VoiceOver passes (§8).
- Pinned to Preact 10 until the routine 11.x upgrade PR lands; a known, bounded deferral.
- Prettier/ESLint strictness will reject some syntactically valid code — deliberate (zero-warning
  policy is a team baseline).

**Risks & mitigations**

| Risk | Mitigation |
|---|---|
| App code bloat erodes the 80 KB target | `bundle-budget` gate fails > 100 KB and warns ≥ 80 KB on every PR; route/locale chunks must stay lazy (gate checks locale laziness structurally) |
| Gate drift (gzip method, what counts as "initial") | thresholds + method live in `scripts/bundle-budgets.json` + one script; this ADR is the normative definition |
| Inline `style` attributes vs CSP `style-src 'self'` | convention: classes/custom properties; E2E `securitypolicyviolation` listener fails the build |
| Preact 10→11 upgrade churn | routine dependency PR; full CI suite (incl. E2E matrix) is the acceptance bar |
| Dependabot supply chain | no auto-merge; production-dep audit gate; license review for any new runtime dep |
| Hash-route deep links vs V1 PWA `start_url` (S13) | `start_url: "./#/today"` composes cleanly with hash routing; recorded for the PWA card |

**Migration path** (framework/toolchain scope only)

- Preact → React: `preact/compat` aliasing (+2–3 KB) if ever needed; components keep compiling.
- Vite major upgrades: routine PRs; `BASE_PATH` contract and budget script are ours and stable.
- Any WASM future (e.g. Argon2 for C1 encryption) is a **budget exception** that must open its own
  ADR before a `.wasm` asset may pass the `no-wasm` gate (the gate would otherwise fail the build).

## Implementation notes for downstream cards (handoff)

1. **Scaffold card** (h_junior_coder): Vite `preact-ts` template baseline in the repo root; apply
   the tsconfig above, ESLint flat config (strictTypeChecked + jsx-a11y + prettier), Prettier,
   `.nvmrc`, `BASE_PATH` in `vite.config.ts`, `sourcemap: false` for prod, hashed inline theme-boot
   snippet + CSP `<meta http-equiv>` in `index.html` (per §7.2, `frame-ancestors` dropped), and the
   CI workflow matrix with `scripts/check-bundle-budget.mjs` + `scripts/bundle-budgets.json`.
2. **State**: `@preact/signals` stores in `src/features/*/store.ts`; domain logic in `src/domain/`
   stays pure and framework-free (this is what the 80% coverage gate targets).
3. **i18n**: no i18n dependency; `src/i18n/` helper with lazy `import()` per locale chunk
   (`en`, `th`), `Intl.PluralRules` for plurals, `html lang` switched with locale (§8).
4. **Component API co-design with h_designer** happens in Epic 2/5 design tasks on top of this
   substrate: TSX function components, exact prop interfaces, a11y primitives from
   `src/components/`. This ADR fixes the substrate only and does not pre-empt those specs.

## Links

- PROJECT_ANALYSIS.md §9.2 (bundle budgets), §9.5 (quality/engineering, GitHub Pages), §7.2
  (dependency + CSP policies), §9.4 (browser floor), §8 (accessibility), §12 Q11/Q12 (PO answers)
- docs/adr/README.md (ADR index)
- Task t_9fa51c86 (this decision); decomposition card t_1b9ee0e6
- Measurement evidence: Vite 8 template builds, gzip level 9, 2026-10-23
  (preact 10.29.8: 7.01 KB JS / 1.44 KB CSS; svelte 5.57.2: 11.97 KB JS / 1.43 KB CSS;
  vanilla-ts: 1.94 KB JS / 1.43 KB CSS; preact core ESM: 4.72 KB gz)
