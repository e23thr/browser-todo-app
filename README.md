# browser-todo-app

A privacy-first, **local-first todo web app**: static output only, no backend, no accounts, no
telemetry, no third-party runtime requests. Everything runs in your browser and all data stays on
the device.

This repository currently holds the **scaffold**: TypeScript-strict app shell, build pipeline with
a configurable base path, and the full CI quality-gate matrix that deploys to GitHub Pages.
Product features land in the epics that build on top of it.

- Decision register and requirements: [`PROJECT_ANALYSIS.md`](PROJECT_ANALYSIS.md)
- Architecture decisions: [`docs/adr/`](docs/adr/README.md) — **ADR-001** (UI framework & build
  tooling) is binding for everything below.

---

## Requirements

| Tool    | Version                                                                |
| ------- | ---------------------------------------------------------------------- |
| Node.js | pinned by [`.nvmrc`](.nvmrc) — `nvm use` reads it (baseline: v22.22.1) |
| npm     | ships with Node (baseline: npm 9.2.0); lockfile v3 is committed        |

## Setup

```sh
npm ci            # exact lockfile install (never `npm install` — CI treats a stale lockfile as a failure)
npm run dev       # http://localhost:5173
```

## Commands

| Command                                                  | What it does                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                                            | Vite dev server                                                                                                     |
| `npm run build`                                          | `tsc -b` + production build into `dist/` (honours `BASE_PATH`)                                                      |
| `npm run preview`                                        | Serve `dist/` locally                                                                                               |
| `npm run typecheck`                                      | `tsc -b` over app, node, test and e2e projects                                                                      |
| `npm run lint`                                           | ESLint (type-aware strict + jsx-a11y), `--max-warnings 0`                                                           |
| `npm run format:check` / `npm run format`                | Prettier check / write                                                                                              |
| `npm run i18n:check`                                     | i18n catalog gate: en/th key + `{name}` placeholder parity, flat keys, every literal `t()` call site resolves       |
| `npm test`                                               | Vitest unit + component tests                                                                                       |
| `npm run test:coverage`                                  | Vitest with coverage thresholds (§9.5)                                                                              |
| `npm run budget`                                         | Bundle-budget gate over `dist/` (build first)                                                                       |
| `npm run e2e:install`                                    | Install the Chromium browser for Playwright                                                                         |
| `npm run e2e:smoke` / `npm run e2e:a11y` / `npm run e2e` | Playwright suites (build + preview are started automatically)                                                       |
| `npm run audit:gate`                                     | `npm audit --omit=dev --audit-level=high`                                                                           |
| `npm run ci`                                             | Everything CI runs locally, in order (minus the browser suites). `BASE_PATH=/<repo>/ npm run ci` matches CI exactly |

---

## Build and the configurable base path

GitHub Pages serves **project** pages under `/<repo>/`, so every emitted asset URL must carry that
prefix (this also sets the future service-worker scope, §9.5). The build reads it from `BASE_PATH`:

```sh
# local default
npm run build                      # base = /

# exactly what CI runs for a project page
BASE_PATH=/my-repo/ npm run build  # base = /my-repo/
```

`vite.config.ts` normalises the value (adds the leading/trailing slash) and passes it to Vite's
`base`. Production builds also set `sourcemap: false` (no source disclosure, smaller artifact).

### Verifying the base path locally (the non-root serve test)

```sh
BASE_PATH=/repo-demo/ npm run build
BASE_PATH=/repo-demo/ npx vite preview --port 4180 --strictPort
```

Then confirm all three things:

```sh
curl -sI http://127.0.0.1:4180/repo-demo/ | head -1                 # HTTP/1.1 200
curl -s   http://127.0.0.1:4180/repo-demo/ | grep -oE '(src|href)="[^"]+"'
                                                                     # every URL starts with /repo-demo/
curl -sI http://127.0.0.1:4180/assets/index-*.js | head -1           # NOT served at the root
```

The Playwright suite runs the same check on every run: `playwright.config.ts` builds with
`BASE_PATH=/browser-todo-app/` and starts `vite preview`, so a base-path regression fails E2E
before it reaches a deploy.

---

## CI gates (GitHub Actions → GitHub Pages)

Workflow: [`.github/workflows/ci.yml`](.github/workflows/ci.yml) on every PR and push to `main`;
[`.github/workflows/nightly.yml`](.github/workflows/nightly.yml) for the cross-browser matrix and
the weekly full audit.

| Job                  | Command                                            | Fails when                                                                                                |
| -------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `lint`               | `npm run lint` + `npm run format:check`            | any ESLint warning/error (zero-warning policy) or an unformatted file                                     |
| `typecheck`          | `npm run typecheck` (`tsc -b`)                     | any type error under `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + …             |
| `unit`               | `npm run test:coverage`                            | a failing test, or coverage < 80% on `src/domain/**` and `src/storage/**`                                 |
| `build`              | `BASE_PATH=/<repo>/ npm run build`                 | build error; uploads `dist/` for the jobs below                                                           |
| `bundle-budget`      | `node scripts/check-bundle-budget.mjs --dist dist` | any §9.2 budget is exceeded (see below)                                                                   |
| `e2e-smoke`          | `npm run e2e:smoke`                                | boot/routing failure, a CSP `securitypolicyviolation`, a non-2xx asset, or any third-party request origin |
| `a11y-axe`           | `npm run e2e:a11y`                                 | any axe-core violation with `serious` or `critical` impact                                                |
| `audit`              | `npm run audit:gate`                               | high/critical advisory in production dependencies (dev advisories warn)                                   |
| `deploy`             | upload `dist/` → `actions/deploy-pages`            | runs only on green `main`, after **all** gates pass                                                       |
| `e2e-full` (nightly) | `npx playwright test --project=<browser>`          | any failure in chromium/firefox/webkit, plus the `th-TH` locale pass                                      |

**Enabling Pages for a new repository:** _Settings → Pages → Source: **GitHub Actions**._ The build
sets `BASE_PATH=/${{ github.event.repository.name }}/`, so the site is served at
`https://<owner>.github.io/<repo>/` with no further configuration.

Every job installs with `npm ci` on the Node version in `.nvmrc`, and superseded PR runs are
cancelled by the concurrency group.

---

## Bundle budgets (§9.2 → CI thresholds)

Single source of truth: [`scripts/bundle-budgets.json`](scripts/bundle-budgets.json); enforcement:
[`scripts/check-bundle-budget.mjs`](scripts/check-bundle-budget.mjs). Measurement is fixed to
prevent gate drift: production `dist/`, **gzip level 9**, `*.map` excluded (never published),
1 KB = 1024 bytes.

| Gate               | Budget                   | Behaviour                                                                                                                                                    |
| ------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `initial-js`       | ≤ 100 KB gz              | **FAIL** over 100 KB; **WARN** from 80 KB (the §9.2 target)                                                                                                  |
| `css`              | ≤ 20 KB gz               | **FAIL** over 20 KB                                                                                                                                          |
| `app-shell`        | ≤ 200 KB gz              | **FAIL** over 200 KB — every shipped file except `icons/`, `*.webmanifest`, source maps, lazy route chunks and non-boot locale chunks                        |
| `locales`          | ≤ 20 KB gz (en + th)     | **FAIL** over 20 KB combined                                                                                                                                 |
| `locales-lazy`     | 0 in the initial closure | **FAIL** if a locale pack is statically reachable from the entry — locale packs must be lazy `import()`s                                                     |
| `no-external-refs` | 0 bytes                  | **FAIL** on any `http(s)://` reference in shipped JS/CSS/HTML/SVG (the only allowed prefixes are `www.w3.org` XML namespaces, which are not network fetches) |
| `no-wasm`          | 0 files                  | **FAIL** on any `.wasm` in `dist/` — a WASM payload requires its own ADR first                                                                               |

"Initial JS" is the entry's **static** import closure taken from `.vite/manifest.json`
(`build.manifest: true`), i.e. framework + app core + always-loaded UI. Dynamic route chunks —
`SettingsView` today, settings/backup/storage views later — are deliberately outside it.

### Locale-pack convention (implemented — M15)

Shipped: `src/i18n/` lazy packs + the `npm run i18n:check` catalog gate. See
[`docs/i18n/README.md`](docs/i18n/README.md) for the API, key conventions and the workflow
for adding strings. The budget gate recognises a locale pack as a chunk whose manifest key
starts with `src/i18n/` (or a file named `locale-<tag>-*.js`). Tag extraction takes the
source basename (`src/i18n/locale-th.ts` → `th`), and `en` is the boot locale counted inside
the app-shell sum. With no packs present the gate reports `0.0 KB` and passes — it does not
silently pass a real violation:

```sh
npx vitest run tests/unit/bundle-budget.test.ts   # proves every FAIL path, including over-budget
```

### Dry-running a failure by hand

```sh
npm run build
ENTRY=$(ls dist/assets/index-*.js | head -1)
head -c 130000 /dev/urandom >> "$ENTRY"           # incompressible payload over the 100 KB gz limit
node scripts/check-bundle-budget.mjs; echo "exit=$?"
#   initial-js   127.x KB   100.0 KB   FAIL
#   RESULT: FAIL — build is over budget
#   exit=1
npm run build                                     # clean artifact again
```

The same guarantee is asserted in CI by the unit suite, so a gate that stops failing fails the
build.

---

## CSP and the documented exceptions

GitHub Pages cannot set custom response headers (§7.2, PO Q11), so the policy ships as a
`<meta http-equiv>` tag in `index.html`:

```
default-src 'self'; script-src 'self' 'sha256-…'; style-src 'self'; img-src 'self' data: blob:;
connect-src 'self' https: http://localhost:* http://127.0.0.1:*; object-src 'none'; base-uri 'none'
```

**Documented exception 1 — `frame-ancestors` is dropped.** It is ignored inside a `meta` CSP (only
HTTP response headers honour it), and the exception is accepted because the app has no cookies or
sessions to protect: it is entirely client-side and stores nothing server-side. Clickjacking risk
is therefore limited to rendering a static, script-locked page in a frame.

**Documented exception 2 — `connect-src` is widened for V1 WebDAV sync** (ADR-006 Addendum A).
Sync talks to a **user-provided** WebDAV origin, which cannot be enumerated in a static policy, so
the source list is exactly as wide as the sync engine's own allow-list
(`assertSecureRemote`: any **https** host, plus plain-HTTP `localhost`/`127.0.0.1` at any port,
which the engine permits for development) and never narrower. The invariant: **the shipped CSP
never blocks a request the app itself is willing to make** — otherwise every sync failure is
silently misattributed to the user's server (this was defect B2: `connect-src 'self'` made the
wizard's "Test connection & enable" impossible against any real server while the error copy blamed
CORS on the server side).

What stays blocked: plain-HTTP egress to any non-loopback host (`https:` scheme source, plus
mixed-content blocking), every origin for every other directive, and all inline script except the
hashed theme-boot snippet. `upgrade-insecure-requests` is deliberately **not** set — the engine
refuses insecure URLs with an explicit error instead of silently rewriting them, and the wizard
tells the user so ("a valid HTTPS WebDAV URL (plain HTTP only for localhost)").

The `no-external-refs` bundle gate (ADR-001 §8) keeps the "zero third-party bytes" promise
unchanged: its allow-list covers the loopback CSP source expressions as _policy text_ (like the
XML namespace constants), and any other external `http(s)://` reference in shipped JS/CSS/HTML
still fails the build.

Other notes:

- The inline **theme-boot snippet** (`<script id="theme-boot">`, anti-FOUC: reads the stored theme
  from `localStorage` before first paint) is the only inline script permitted. Its SHA-256 is
  computed at build time by a `transformIndexHtml` hook in `vite.config.ts` and written into
  `script-src`, so the hash always matches the shipped markup.
- `vite dev` relaxes `script-src`/`style-src` with `'unsafe-inline'` **only in the dev server**,
  because Vite injects styles and HMR code as inline DOM nodes. The production artifact is never
  relaxed.
- The E2E suite installs a `securitypolicyviolation` listener and fails the build on any hit.

---

## Repo layout (ADR-001 §9)

```
/                     package.json, package-lock.json, tsconfig* (project references),
                      eslint.config.js, .prettierrc.json, .nvmrc, .editorconfig,
                      vite.config.ts, playwright.config.ts, .github/workflows/
  public/             static assets copied verbatim (favicon — zero third-party bytes)
  src/
    app/              bootstrap (main.tsx), app shell (App.tsx), hash router (router.ts)
    features/         feature modules (today/, settings/, …)
    components/       shared presentational + a11y primitives
    domain/           pure domain logic — no DOM, no IDB imports (primary unit-test target)
    storage/          IDB wrapper, repositories, migrations (governed by ADR-002)
    i18n/             minimal i18n helper + lazy per-locale chunks (en, th)
    styles/           design tokens (CSS custom properties) + global CSS, system font stack
    sw/               service worker source (governed by ADR-003)
  tests/
    unit/             Vitest specs (router, domain, storage, migrations, merge rules)
    component/        Vitest + Testing Library (preact) specs
    setup.ts          global test setup (Testing Library cleanup)
    e2e/              Playwright specs: smoke (base path, CSP, zero third-party) + axe scans
  docs/
    adr/              Architecture Decision Records (ADR-001 index: docs/adr/README.md)
    design/           Design specs from h_designer, UX notes
  scripts/            check-bundle-budget.mjs (+ .d.mts), bundle-budgets.json (CI budget gate)
  .github/workflows/  ci.yml (gates + Pages deploy), nightly.yml (browser matrix + full audit)
```

Import boundaries, enforced by ESLint `no-restricted-imports`:
`src/domain/` may not import `app/`, `features/`, `components/`, `storage/`, `i18n/`, `preact` or
any `@preact/*` package, and may not touch browser globals — it stays pure and framework-free.

---

## Testing

| Layer     | Tool                                       | Where                                                          |
| --------- | ------------------------------------------ | -------------------------------------------------------------- |
| Unit      | Vitest                                     | `tests/unit/` — hash router, bundle gate, domain/storage logic |
| Component | Vitest + `@testing-library/preact` (jsdom) | `tests/component/`                                             |
| E2E smoke | Playwright (Chromium)                      | `tests/e2e/smoke.spec.ts`                                      |
| a11y      | Playwright + `@axe-core/playwright`        | `tests/e2e/a11y.spec.ts`                                       |

Coverage thresholds are configured for `src/domain/**` and `src/storage/**` (≥ 80%, §9.5). Those
directories are still empty at scaffold stage, so the threshold currently has nothing to measure;
it activates the moment the first file lands — verified: an uncovered `src/domain/` file fails
`npm run test:coverage` with `ERROR: Coverage for lines (0%) … threshold (80%)`.

---

## Dependency policy (§7.2)

- Runtime dependencies, allow-listed by ADR-001: `preact`, `@preact/signals` (`idb` arrives with
  ADR-002). Everything else is out — no i18n framework, no date library, no UI kit, no icon pack.
- Lockfile committed; CI installs with `npm ci`; updates are monthly grouped PRs, never auto-merged.
- New runtime dependency = permissive license review + gzip-size entry in the PR description +
  ADR-001 amendment note.
- Zero runtime third-party bytes: no CDNs, no hosted fonts (system font stack only), no remote
  icons — enforced by the `no-external-refs` gate rather than by review goodwill.

## Not in the MVP (PO decisions)

No web app manifest and no install prompt in MVP (PO Q12) — PWA installability was the first V1
item. MVP keeps the service-worker app-shell cache, which arrives with ADR-003.

**V1 update (2026-10-26)**: installability has landed — a base-aware web app manifest,
self-hosted icons and the post-first-task install offer (ADR-008; see docs/dev/pwa-install.md).
It is the structural fix for R1 (iOS Safari's 7-day storage eviction exempts installed
home-screen apps); the `persist()` + backup discipline remain in force alongside it.
