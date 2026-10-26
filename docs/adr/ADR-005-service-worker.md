# ADR-005: Service worker & update strategy

**Status**: Accepted
**Date**: 2026-10-23
**Decider**: h_senior_coder (sole decider — service-worker & caching strategy, single-decider rule; task t_a7b86d9c)
**Scope**: MVP (M9) service-worker architecture — app-shell precache, cache lifecycle & versioning, request routing, update flow state machine, base-path/scope handling, and the Playwright offline test strategy.
**Out of scope (binding, PO Q12)**: PWA installability — no web app manifest, no install prompt, no `beforeinstallprompt` handling in MVP. Installability is V1 S13 (see Migration path).

**Numbering note (canonical, per h_pm's hotspot note on t_a7b86d9c)**: the epic decomposition
(t_1b9ee0e6) sets the canonical ADR numbering — ADR-001 UI framework & build tooling · ADR-002
storage schema & IDB wrapper · ADR-003 domain layer · ADR-004 export/import format · **ADR-005
service worker & update strategy (this record)** · ADR-006 WebDAV sync protocol · ADR-007
encryption at rest. The PROVISIONAL numbering in ADR-001's completion metadata / follow-ups
(ADR-003 = service worker, ADR-004 = sync, ADR-005 = encryption) is **superseded**. Earlier
references to "the service worker (ADR-003)" (ADR-001 §3 and Consequences, and the original
planned table in `docs/adr/README.md`) mean **this** record; that placeholder number is not a
separate decision.

---

## Context

- **M9 (MVP)**: offline app shell — "service worker app-shell cache + versioned caches,
  offline-complete; NO manifest/install in MVP (PO Q12) — installability = S13 (V1)".
- **§6.1 offline behavior (binding)**: zero network in the app's logic path (all data local);
  offline is the app's normal mode — there is no "offline toggle" and no UI degradation;
  precache app shell on install, versioned caches with cleanup on activate, navigation fallback to
  the cached shell, cache-first for assets, network only for checking for app updates; update flow =
  version check when online → "Update available" toast → apply on user action, **never force-reload
  mid-edit (E9)**.
- **§9.1 (budget)**: warm/offline start to interactive **< 300 ms**.
- **§9.5**: GitHub Pages (PO Q11) — project pages serve under `/<repo>/`; the build must accept a
  configurable base path, which sets service-worker scope. HTTPS comes from `*.github.io`.
- **§7.2 (binding)**: zero runtime third-party requests (the update check hits the same origin);
  CSP ships as a `<meta http-equiv>` tag (`frame-ancestors` dropped as a documented exception);
  minimal dependencies, committed lockfile.
- **E9 (§10)**: "App update mid-edit → never force reload; apply on user action."
- **ADR-001 (binding toolchain, present)**: Preact 10 + Vite 8 + TS strict + npm; in-house **hash
  router** (GitHub Pages has no rewrites); `BASE_PATH` env → Vite `base` (`vite.config.ts`:
  `base: process.env.BASE_PATH ?? '/'`); repo layout has `src/sw/` "governed by the service-worker
  ADR"; the `app-shell` budget gate (≤ 200 KB gz) explicitly counts **the service worker** alongside
  HTML + initial JS + CSS + initial locale chunk; no new runtime deps without ADR amendment.
- **ADR-002 (binding storage contract)**: app data lives in IndexedDB behind a `Result`/
  `StorageError` wrapper; **localStorage is prefs-only** (`todo:prefs:v1:*`, ≤ 4 KiB, "never
  task/list/snapshot data"). Therefore uncommitted edit content cannot be stashed in localStorage —
  the only durable route for an in-flight edit is an IDB write through the storage layer.

Constraints this ADR must satisfy together: offline-complete **and** < 300 ms warm start **and**
never force a reload **and** never leave a stale tab broken **and** survive a configurable base path
**and** stay inside the shell budget **and** add zero runtime dependencies.

---

## Decision summary (the short version)

1. **A hand-written, dependency-free service worker** in `src/sw/` (no Workbox, no
   `vite-plugin-pwa`), built as a second, unhashed `dist/sw.js`, fed by a generated precache
   manifest. Expected ≤ 3 KB gz (counts in the `app-shell` gate).
2. **Precache = the complete app artifact set** (HTML, all JS chunks incl. lazy routes and locale
   packs, CSS, icons). Deliberately **no manifest** (none exists in MVP — PO Q12), no `*.map`, no
   `sw.js` itself. "The whole build output is the app shell" — that is what offline-complete (M9)
   means when part of the UI is lazy-loaded.
3. **One versioned cache per build**, named `todo-shell:<baseSlug>:v:<shellVersion>` (shellVersion
   derived from content hashes). New install → populate new cache → **activate purges all other
   `todo-shell:*` caches**; navigation falls back to the cached shell document.
4. **Routing: cache-first for everything in scope** (navigations and assets), write-through on a
   rare cache miss; **network otherwise only for the SW update check** (`registration.update()`,
   `updateViaCache: 'none'`). No `version.json`. App data never touches the network (§6.1).
5. **Update flow = a user-gated state machine** (Decision 5): check when online → new SW installs
   and **waits** → "Update available" toast → **apply only on an explicit user click** (the single
   `skipWaiting()` call site) → **reload happens in exactly one place**: that click's tab, after any
   in-flight edit is durably persisted (or the reload is aborted). Nothing ever auto-reloads (E9).
6. **Failed update checks are silent** (Decision 6) — offline is the normal mode; nothing in the UX
   depends on a check succeeding.
7. **Scope is derived from `BASE_PATH`** (ADR-001): register `${BASE_URL}sw.js` with scope
   `${BASE_URL}`; cache names and all SW-built URLs are namespaced by the base path (Decision 8).
8. **Playwright offline/update tests run against a two-build fixture server** that swaps build
   output at runtime (Decision 9) — `page.route` cannot intercept service-worker fetches.

---

## Decision 1 — Implementation shape: hand-written SW, no framework

- Files: `src/sw/sw.ts` (handlers), `src/sw/routing.ts` (pure routing decision — unit-testable
  without SW globals), generated `src/sw/precache-manifest.ts`, `scripts/build-sw.mjs`,
  `scripts/generate-precache.mjs`. Built as a **single classic worker script** (iife, ES2022 target
  per the §9.4 browser floor) — no `importScripts`, no module worker (module workers are not
  needed and add compat surface for no benefit).
- `dist/sw.js` is emitted **unhashed** (the browser needs a stable URL for update checks) as a
  second Vite build after the client build; `npm run build` = client build → precache manifest
  generation → SW build. The budget script runs last and must include `dist/sw.js` in the
  `app-shell` sum (ADR-001 §8 already names "service worker" in that gate).
- **No new runtime dependencies** (§7.2). The required surface — precache, cache-first fetch,
  versioned cleanup, navigation fallback, one message handler — is ~250 LOC of deliberately boring
  code, fully covered by the tests in Decision 9. Workbox/vite-plugin-pwa is rejected in
  Alternatives.

## Decision 2 — Precache contents & manifest generation

**Precached (the complete run-the-app-offline set):**

- `index.html` — the shell document (includes the hashed inline theme-boot snippet and the CSP meta
  tag, ADR-001 §3 / §7.2);
- **all** hashed JS chunks: entry static closure **and** lazy route chunks (settings, backup/…)
  **and** locale packs (`en`, `th`);
- all CSS; all icons (`public/`: favicon, touch icons — SVG/PNG);
- `404.html` if GitHub Pages project config emits one (copied verbatim, same fallback semantics).

**Explicitly NOT precached:** `manifest.webmanifest` (**there is no manifest in MVP** — PO Q12;
M9's older wording "…icons/manifest" is superseded by Q12 for this release), `*.map` (never
published per ADR-001), `sw.js` (managed by the browser's update mechanism, not the fetch handler),
anything external-origin (§7.2 — there is nothing external to precache).

**Whole-artifact rationale (normative):** M9 demands offline-*complete*. A lazy chunk (settings,
backup, Thai locale) requested for the first time while offline must work; therefore lazy chunks are
precached even though they stay **out of the initial JS closure** (no startup cost — the budget gate
and lazy-loading discipline of ADR-001 are untouched). Cache cost is kilobytes of disk.

**Manifest generation:** `scripts/generate-precache.mjs` walks `dist/` (excluding `*.map`, `sw.js`),
emits a sorted manifest of `{ url, sha256 }` entries with URLs **relative to the base**, injected
into `sw.js` at build time as `self.__PRECACHE_MANIFEST`. `shellVersion` = first 16 hex chars of
SHA-256 over the serialized manifest. Any content change anywhere → new `shellVersion` → new cache
name **and** new `sw.js` bytes → the browser's byte-diff update check fires. This is the only
versioning channel; nothing else needs bumping at deploy time.

**Install semantics:** populate the new cache with `cache.addAll` over the manifest — **all-or-nothing**
(a failed entry fails the install; the previous version keeps serving untouched and the next update
check retries). First install (no existing controller) proceeds straight to activation and
`clients.claim()` so the very first page is controlled without a reload.

## Decision 3 — Cache lifecycle, versioned migration & the stale-tab guard

**Naming:** `todo-shell:<baseSlug>:v:<shellVersion>`, e.g. `todo-shell:repo-name:v:a1b2…`.
`baseSlug` is the sanitized `BASE_PATH` (`repo-name`, or `root` for `/`). CacheStorage is **per
origin**, and `*.github.io` can host several project pages on one origin — the slug prevents
cross-app cache collisions (Decision 8).

**Lifecycle:**

1. `install`: populate `todo-shell:<baseSlug>:v:<new>` (atomic, see Decision 2).
2. `waiting` (updates only): the new SW waits for the user's Apply click — `skipWaiting()` is called
   **only** from that one message handler (Decision 5). First install skips this phase.
3. `activate` (only after the user applied): `clients.claim()` + **purge every `todo-shell:*` cache
   except the current one** (acceptance criterion: "old caches purged on activate"). Because
   `skipWaiting` is user-gated, the purge can only run once the applying tab is about to reload;
   sibling tabs are handled below.

**Deploy migration:** deploys are pure content-addressing — new build → new `shellVersion` →
parallel install → atomic swap on apply. **Rollback = redeploy the previous build** (it gets a fresh
`shellVersion`; there is no schema coupling — app data is IDB (ADR-002), independent of caches).

**Stale-tab hazard & guard (explicit, tested):** after apply + purge, a sibling tab still running
old code has its old hashed chunks neither in any cache nor on the server (the deploy replaced
`dist/`). Rules:

- The router's lazy `import()` wrapper catches chunk-load failures and renders a non-blocking
  **"The app was updated in another tab — reload to continue here"** state with an explicit Refresh
  button. **Never auto-reload** (E9).
- Practical blast radius is small: core-loop chunks are in the initial closure (already loaded at
  boot and cached), so only "first visit to a lazy route in a stale tab" can hit this — and the
  guard turns it into an explained, user-initiated refresh instead of a crash.
- Sibling tabs also receive an **"Updated — refresh when ready"** notice on `controllerchange`
  (Decision 5, rule 2) *before* anything fails.

## Decision 4 — Request routing (fetch handler)

| Request class | Strategy | Notes |
|---|---|---|
| In-scope `GET` navigation to the shell (`${BASE_URL}` or `${BASE_URL}index.html`) | **cache-first** | single cache read → fast boot (< 300 ms, §9.1); network never consulted (offline is the default mode, §6.1) |
| Any other in-scope navigation | **fallback to cached `index.html`** | SPA-style fallback; GitHub Pages has no rewrites. With hash routing this is mostly defensive (deep links are `…/#/route`, resolved to the shell document) |
| In-scope `GET` static assets (hashed JS/CSS/locales/icons) | **cache-first**, write-through on miss | miss (should not happen — whole artifact set is precached) → network fetch → `cache.put` into the *current* versioned cache; same-origin, in-scope, `GET` only |
| `sw.js` | **not in the fetch handler** | browser-managed update fetch; `updateViaCache: 'none'` keeps it off the HTTP cache |
| Update check (`registration.update()`) | **network only** | the one intentional network path; same-origin (§7.2) |
| Everything else (non-`GET`, out of scope, any future endpoint) | **pass-through network** | MVP has no such traffic — app data is IDB only (§6.1); since V1 sync (E8) the page's WebDAV fetches (cross-origin PROPFIND/GET/PUT) pass through here untouched; the CSP `connect-src` backstop is `'self' https: <plain-HTTP loopback>` (ADR-006 Addendum A — was `'self'`, which silently blocked all sync egress) |

No `stale-while-revalidate` anywhere: assets are content-hashed, so revalidation costs network
chatter for zero freshness value. No `version.json` (Alternatives).

## Offline behavior matrix (normative)

Cross-cutting summary of Decisions 2–6. "Serves" = what the user gets; the app's data layer (IDB,
ADR-002) is identical in every row — offline changes nothing about functionality (§6.1).

| Scenario | Serves | Network use | Update check | UI & invariants |
|---|---|---|---|---|
| **First load** (online, no SW yet) | shell from network | network (only time the shell comes from the network) | n/a — the SW just installed | SW installs + precaches + `clients.claim()` **without reloading** the page; full function; from now on the app is offline-capable |
| **Warm start** (online, SW active) | cache-first shell → interactive **< 300 ms** (§9.1) | none for assets/data; update check only (throttled, Decision 5) | yes — `registration.update()`, silent | full function; "Update available" toast only when a new version is fully installed & waiting |
| **Offline boot** (SW active) | cache-first shell → interactive **< 300 ms** | none | skipped / fails silently (Decision 6) | full function (add/complete/reload → data present, from IDB); no error UI of any kind; a toast may show **only** if an update was already fully downloaded before going offline (`update-ready` is safe to apply offline) |
| **Update pending** (`update-ready`, online) | **old** version keeps serving (cache-first on the old cache) | update check already done; nothing else | idle | toast with Apply/Dismiss; nothing auto-applies; apply → flush edit (if any) → reload → new cache; old caches purged on activate |
| **Update pending** (`update-ready`, offline) | old version serving | none | silent | identical to the online row — **Apply works offline** (the new SW is already fully installed); flush-then-reload still guarantees the edit survives (E9) |
| **Update pending + mid-edit** (E9) | old version serving | none | idle | **no reload ever** until the user clicks Apply *and* the in-flight edit flushes `Ok`; on flush error the reload is aborted and the edit stays intact (Decision 7) |
| **First visit, offline** | *nothing* — the app has never been downloaded | n/a | n/a | honest, documented failure: static hosting cannot serve a never-visited app; onboarding says "open once online" |
| **Stale sibling tab** (update applied elsewhere) | old code keeps running; old lazy chunks may be gone | none | idle | never reloaded by anyone (E9); "Updated — refresh when ready" notice; first lazy import in that tab hits the guarded "updated elsewhere" state (Decision 3) — explicit Refresh button, no crash |

## Decision 5 — Update flow state machine (normative)

**States:**

| State | Meaning | UI |
|---|---|---|
| `idle` | current version serving; no check running | none |
| `checking` | `registration.update()` in flight | none (silent) |
| `update-found` | new SW downloading/installing | none yet |
| `update-ready` | new SW **installed & waiting** — fully downloaded, so Apply is safe **offline** | "Update available" toast (aria-live `polite`, Apply + Dismiss, ≥ 44 px targets per §8) |
| `reload-pending` | Apply requested but an edit is in flight — flush required first | flush spinner, or save-error copy on failure |
| `applying` | `SKIP_WAITING` posted, awaiting `controllerchange` | toast shows "Updating…" |
| `reloading` | the applying tab reloads **deliberately** | brief "Updating…" |
| `check-failed` | transient failure; silent; counter + backoff (Decision 6) | none |
| `applied-elsewhere` | `controllerchange` arrived **without** our Apply (sibling tab) | "Updated — refresh when ready" notice + explicit Refresh button |

**Transitions (event → from → to → action):**

1. `boot` (after `load`) / `visibilitychange`→visible / `online` → `idle` → `checking`, **iff**
   `navigator.onLine` and throttle allows (≥ 30 min since last attempt) → `registration.update()`.
2. `updatefound` → `checking` → `update-found` (track the installing worker's `statechange`).
3. `statechange: installed` **alongside a different, running version** (`registration.active` is
   another worker) → `update-found` → `update-ready` → show toast. `installed` as the
   registration's **first** worker → `idle` (claim; no toast — nothing to update). Whether the
   page has a controller at handler time is **not** part of the test (Addendum A: `clients.claim()`
   can beat `statechange` delivery under load). `statechange: redundant` before `installed` →
   `check-failed` (Decision 6).
4. `user-dismiss` → `update-ready` → `idle` (toast snoozed in-memory for this session; a *new*
   waiting version re-toasts). No localStorage — ADR-002 restricts it to prefs keys (Decision 7).
5. `user-apply` → `update-ready` → `reload-pending` **if an edit is in flight** (Decision 7): flush
   through the storage layer; `Ok` → `applying`; `Err` (e.g. `QUOTA_EXCEEDED`) → back to
   `update-ready` with "Couldn't save — free space and try again" and the edit intact (§5.5/E3:
   never silent loss). No edit in flight → `applying` directly.
6. `applying`: post `{ type: 'SKIP_WAITING' }` — **the single `skipWaiting()` call site in the
   codebase** (linted: `skipWaiting` may only appear in that handler).
7. `controllerchange` **with** pending apply → `applying` → `reloading`: `location.reload()` —
   **the only reload in the codebase** (linted: `location.reload`/`location.replace` restricted to
   `applyUpdate()`).
8. `controllerchange` **without** pending apply (a sibling tab) → `applied-elsewhere`: **no
   reload** (rule: nothing may reload this tab but its own user), show the refresh-when-ready
   notice; the tab keeps running old code until its user refreshes or it navigates naturally.
9. `lazy-import-failed` (any tab) → guarded "updated elsewhere — reload to continue here" state
   (Decision 3). No reload.

**Trigger policy details:** checks run on `load`, on `visibilitychange`→visible, and on the `online`
event — throttled to one `registration.update()` per 30 min, never while `navigator.onLine ===
false`, and never before the first install has produced a running version (`registration.active ===
null` — Addendum A: such a check has nothing to compare against and can only race the first
install). (The browser performs its own update checks on navigation; harmless, and rare after boot
because hash routing produces no navigations.) Check latency on GitHub Pages is bounded by its CDN
caching (~10 min) — acceptable: updates are user-applied anyway.

## Decision 6 — Failed update check: silent, retried, never blocking (explicit answer)

A check "fails" when `registration.update()` rejects (offline, DNS, 5xx, timeout) or the fetched
worker goes `redundant` before `installed` (corrupt/truncated download). **Handling: complete
silence.** No toast, no error UI, no spinner, no functional impact — the app keeps serving the
current version from cache and stays fully usable. This is not an error path: for an offline-first
app an unreachable update endpoint is the *normal offline case* (§6.1 — "offline is just the app",
no toggle). Details:

- Logged to the **local error log only** (no telemetry, ever — §7.2).
- Retry policy: next throttled trigger (≥ 30 min), or immediately on the `online` event. On
  consecutive failures the throttle doubles, capped at 24 h.
- A download interrupted mid-install behaves identically (`redundant` → silent).
- The toast appears **only** in `update-ready`, i.e. only after a *complete, installed* new version
  is waiting — so the user can never be offered an Apply that would fail offline.
- E2E evidence (Decision 9, test 6): with update checks failing, no toast appears, the state
  machine returns to `idle`, and edit + offline reload still work.

## Decision 7 — In-flight edit protection (explicit answer; E9)

**Definition.** An edit is *in flight* from `edit-begin` (focus in an editable field with dirty,
uncommitted content, or a pending optimistic write transaction) until `edit-persisted` (the
committing IDB transaction from the ADR-002 storage layer has acknowledged `Ok`).

**Protection rules (normative):**

1. **There is no automatic reload, ever.** Only `applyUpdate()` (the toast's Apply button, or the
   explicit Refresh button in the `applied-elsewhere` notice) may trigger a reload, and only for
   the tab whose user clicked (Decision 5, rules 7–8). Lint restricts `location.reload` to that
   module; tests assert it (boot-marker + navigation counting).
2. **Apply during an edit flushes first.** `applyUpdate()` awaits a durable write of the in-flight
   edit through the storage layer (ADR-002 repo/wrapper; `Result` must be `Ok`) **before** the
   reload fires. On `Err`, the reload is **aborted**, the toast returns to `update-ready` with
   save-error copy (e.g. quota — E3/§5.5 dialog flow), and the edit remains untouched in the DOM.
3. **No `beforeunload` blocking dialogs.** Persistence-first instead of trapping the user; the
   reload always follows a confirmed durable write or an explicit user action on an idle app.
4. **localStorage is not a draft store.** ADR-002 Decision 7 allows `todo:prefs:v1:*` only (≤ 4 KiB,
   never task data), so the flush in rule 2 is an IDB write — the reload waits for its ack.
5. Sibling tabs are never reloaded (rule 1 + Decision 5 rule 8) — a mid-edit session in another tab
   cannot be destroyed by an update applied elsewhere.

**Evidence for impl:** E2E "mid-edit session is never reloaded" — type uncommitted text, drive the
app to `update-ready`, assert the page did not navigate (marker + zero navigation events) and the
input value is intact; then Apply and assert exactly one deliberate reload with the edit flushed
and restorable (test 4, Decision 9).

## Decision 8 — Base path & scope handling (§9.5)

- Registration (in `src/app/sw-register.ts`):

  ```ts
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
    scope: import.meta.env.BASE_URL,
    updateViaCache: 'none',
  })
  ```

  `import.meta.env.BASE_URL` is Vite's `base` = `BASE_PATH` (ADR-001 §3; local dev `/`, deploy
  `/<repo>/`). On GitHub Pages project pages the SW lands at `/<repo>/sw.js` with scope `/<repo>/`.
- **Scope is necessarily the script's directory**: GitHub Pages cannot set `Service-Worker-Allowed`,
  so an explicit scope can never be *above* `sw.js`'s directory — keeping the script at the base
  root is what makes `/<repo>/` scope correct. This constraint is documented here so nobody "helps"
  by moving `sw.js` into `assets/`.
- **Every URL the SW builds** (manifest entries, navigation fallback) is derived from the same
  `BASE_URL` baked at build time (`new URL('./index.html', self.registration.scope)` etc.). No
  root-absolute `/…` URLs — those would escape `/<repo>/` and 404.
- **Hash router interaction**: the app's only navigation URL is the shell document (+ hash
  fragments, which never reach the SW or network). Deep links like `/<repo>/#/settings` always
  resolve to the cached shell — offline-capable with zero rewrite rules. This is the "clean scope
  story" ADR-001 promised; nothing in the router needs SW awareness.
- **Cache namespacing** (`baseSlug`, Decision 3) because CacheStorage is per-origin and one origin
  can host several base paths.
- **Base-path change** (repo rename / custom domain): the new deploy registers a fresh SW at the new
  scope; the old-scope registration is inert (its paths are gone) and its namespaced caches cannot
  collide with the new ones. Rare ops event: visiting the old path once clears it; documented in the
  project README (scaffold card's ops notes).
- The E2E suite runs the offline tests under a **non-root base path** in CI (Decision 9, test 8), so
  base-path regressions are build-breaking, not production surprises.

## Decision 9 — Playwright offline & update test strategy (normative)

**Harness.** In-process static fixture server (`tests/e2e/fixtures/static-server.mjs`, node `http`)
serving `dist/` with a **mutable root pointer** and an optional sub-path mount (`/repo-name/`).
Update tests swap the root from build A to build B **at the server** at runtime. Rationale:
Playwright's `page.route`/`context.route` do **not** intercept service-worker-driven fetches nor the
browser's `sw.js` update fetch — a server-side swap is also exactly what a GitHub Pages deploy looks
like (same origin, byte-different `sw.js`). CI builds two marked versions first
(`VITE_BUILD_ID=vA|vB` → `data-build-id` on `<html>` via Vite `define`).

**Per-context discipline:** `serviceWorkers: 'allow'` (never `'block'` in these specs); after
`page.goto`, wait for `navigator.serviceWorker.ready` **and** `navigator.serviceWorker.controller`
(claim) **before** `context.setOffline(true)` — otherwise first-load caching races make the suite
flaky. Offline via `context.setOffline(true)`.

**Tests (chromium in `e2e-smoke` on PR; full matrix nightly per ADR-001 CI):**

1. **Offline-complete spine (M9)**: cold load online → assert SW active and precache populated
   (`caches.keys()` = exactly the versioned cache; its entries = the manifest set, incl. lazy
   chunks and locales; **no** manifest entry, **no** external-origin URLs) → `setOffline(true)` →
   reload → boots to interactive → add task → complete → reload (still offline) → data present.
2. **Warm/offline start budget (§9.1)**: measure boot to interactive (`performance.mark(
   'app:interactive')` on root commit; read `performance.getEntriesByType('navigation')` +
   marks). Smoke asserts a loose < 1500 ms (PR-flake guard); the **nightly job holds the 300 ms
   line** and the measured value is recorded in the completing card's metadata.
3. **Update flow**: boot build A (SW active) → server swaps to build B → trigger the check (call the
   app's exposed check hook / `registration.update()` via `page.evaluate`) → assert toast ("Update
   available", aria-live, focusable actions) → click Apply → assert **exactly one** reload
   (navigation events; `data-build-id` flips A→B) → `caches.keys()` = only the new versioned cache
   (old purged on activate).
4. **E9 mid-edit (acceptance evidence)**: boot build A → server swaps to build B → type uncommitted
   text into the title input → trigger check → toast appears → assert **no** navigation (test marker
   survives; input value intact) → click Apply → assert exactly one deliberate reload **and** the
   edit is durably flushed/restored (Decision 7 semantics) with no data loss.
5. **Multi-tab E9**: two pages, one context → Apply in tab A → tab B must **not** reload (marker
   stable) and shows "Updated — refresh when ready"; its Refresh button reloads deliberately.
6. **Failed update check (acceptance evidence)**: server aborts `sw.js` requests / context offline
   at check time → no toast, state `idle` (silent), app fully functional (edit + offline reload).
7. **Cache migration + stale-tab guard**: post-apply, old caches are gone; a stale sibling tab's
   first lazy-route import renders the guarded "updated elsewhere" state — no crash, no reload.
8. **Base-path run**: the full offline suite runs a second time with the fixture server mounting
   `dist/` under `/repo-name/` and `BASE_PATH=/repo-name/`: assert
   `registration.scope === origin + '/repo-name/'`, offline boot works, navigation fallback serves
   the *scoped* `index.html`. (`e2e-smoke` runs the `/` variant; `e2e-full` runs both.)
9. **CSP parity**: the specs reuse ADR-001's `securitypolicyviolation` listener — the SW-era UI
   (toast) must introduce no violations.

Unit tests (Vitest): `src/sw/routing.ts` decision table (pure), cache-name/version construction,
precache manifest generation (deterministic ordering, exclusion rules), and the update state
machine reducer (every transition in Decision 5, incl. apply-during-edit failure).

---

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| **Hand-written SW (CHOSEN)** | ~250 LOC, ≤ 3 KB gz; zero deps; exactly the surface M9 needs; fully testable (Decision 9); boring | we own the fetch/install/activate code | — |
| Workbox (e.g. `vite-plugin-pwa`, generateSW) | battle-tested runtime; less code to write | Workbox runtime (~20 KB class) counts against the **`app-shell`** gate (ADR-001 §8 names the SW in that sum); plugin pushes manifest generation + auto-registration we must *disable* per PO Q12; config surface exceeds the code it replaces; new dep needs ADR amendment (§7.2) | Cost > benefit at this app's size; Q12 makes half the plugin's value dead weight |
| `version.json` update checks (Workbox-style) | explicit, testable endpoint | second source of truth next to the browser's own `sw.js` byte-diff; extra network path + cache-busting semantics; more failure modes | `registration.update()` already *is* the version check (Decision 5); one channel, fewer lies |
| `skipWaiting` + `clients.claim()` + auto-reload on `controllerchange` (classic "always fresh") | simplest; everyone is on the newest build instantly | **violates E9 and §6.1's update flow directly** — forces reloads, including mid-edit | Non-starter: "never force reload mid-edit" is binding |
| Network-first / stale-while-revalidate shell | fresher shell without waiting for the toast | first paint waits on the network → < 300 ms warm budget at risk; contradicts "offline is the default mode" | Freshness is the update state machine's job; boot speed and determinism win |
| Cache-on-use for lazy chunks (precache core only) | slightly smaller cache | offline-complete breaks: first visit to settings/backup/th-locale offline fails | M9 says offline-*complete*; whole-artifact precache is the honest reading |
| No service worker at all | zero SW complexity | no offline boot, no app shell — M9 impossible | Out of scope |

---

## Consequences

**Positive**

- Deterministic offline-complete behavior at any base path; warm/offline boot is a single cache
  read (< 300 ms target with room to spare).
- The update channel is the browser's own mechanism (`sw.js` byte-diff + `registration.update()`) —
  no invented version protocol, one source of truth.
- E9 is enforced structurally: one reload call site, one `skipWaiting` call site, both behind the
  user's explicit action and a durable flush; sibling tabs are safe by construction.
- Zero new runtime dependencies; `dist/sw.js` ≤ ~3 KB gz keeps the `app-shell` gate comfortable.
- Content-addressed caches make deploy migration and rollback the same boring operation.

**Negative / costs**

- We own ~250 LOC of SW code — mitigated by the pure `routing.ts` extraction + the Decision 9 suite.
- Whole-artifact precache stores lazy chunks too (cache bytes, not startup cost) — trivial against
  gigabyte-class quotas; bounded to exactly one version at a time by activate-purge.
- `dist/sw.js` must be excluded from Vite's asset hashing and included in the budget script — two
  build-config footnotes the scaffold/impl cards must get right.
- Stale tabs can lose lazy chunks after an apply — surfaced, guarded, never auto-fixed (E9 trade).

**Risks & mitigations**

| Risk | Mitigation |
|---|---|
| Update race: apply while edits in flight (E9) | flush-then-reload with abort-on-error (Decision 7); only user-initiated reloads exist |
| GitHub Pages CDN caches `sw.js` (~10 min) | `updateViaCache: 'none'`; detection latency bounded and harmless (updates are user-applied); checks throttled at 30 min anyway |
| iOS Safari 7-day cache eviction (E1/R1) | app **data** is IDB with `persist()` + backup discipline (ADR-002 / §5.5); an evicted shell cache simply re-pre caches on the next online visit — eviction detection + honest onboarding are the storage epic's contract |
| First-ever visit offline | physically unservable (static hosting, nothing cached yet) — onboarding states "open once online"; not a defect |
| Broken partial install | `cache.addAll` atomicity (Decision 2): failure leaves the previous version serving |
| Cross-app cache collision on shared origin (`*.github.io`) | `baseSlug` in cache names (Decision 3/8) |
| Scope drift with base path | `BASE_URL`-derived URLs only + non-root-base e2e run in CI (Decision 8/9) |
| SW oversteps CSP (`connect-src` — `'self' https: <plain-HTTP loopback>` since ADR-006 Addendum A) | same-origin only; update check is same-origin; WebDAV sync fetches cross-origin by design (user-provided origin) and pass through the SW untouched; CSP-violation listener runs in the SW-era specs (Decision 9, test 9) |

**Migration path**

- **V1 S13 (PWA installability)**: add `manifest.webmanifest` + install-prompt UX in its own
  card/ADR amendment; this ADR then adds the manifest + install icons to the precache set and
  `start_url: './#/today'` / `scope` compose with the hash router (per ADR-001's recorded note).
  The update state machine is untouched by installability.
- **Rollback**: redeploy the previous build (fresh `shellVersion`; caches are content-derived).
- **Base-path change**: new scope + new namespaced caches (Decision 8); no code migration.

---

## Implementation handoff (for card t_6460ac5a)

**Files / contracts (build on the ADR-001 scaffold; do not re-decide anything above):**

1. `src/sw/sw.ts` — install/activate/fetch/message handlers per Decisions 2–4; `SKIP_WAITING`
   message handler is the **only** `self.skipWaiting()` call site.
2. `src/sw/routing.ts` — pure request→strategy decision (table in Decision 4); unit-tested.
3. `src/sw/precache-manifest.ts` — **generated** by `scripts/generate-precache.mjs` (never
   hand-edited); manifest + `shellVersion` per Decision 2.
4. `scripts/build-sw.mjs` — second Vite build → unhashed `dist/sw.js` (classic, ES2022, minified);
   wired into `npm run build` after client build + manifest generation.
5. `src/app/sw-register.ts` — registration exactly per Decision 8 (`updateViaCache: 'none'`).
6. `src/app/update.ts` — the Decision 5 state machine as `@preact/signals` (`updateState`,
   `canApply`, `editInFlight`), `applyUpdate()` as the single flush-then-reload call site (Decision
   7); lint restrictions: `location.reload`/`location.replace` only here, `skipWaiting` only in the
   SW message handler.
7. Router lazy-import wrapper — catch chunk-load failure → guarded "updated elsewhere" state
   (Decision 3).
8. Update toast — `src/components/` a11y primitives (aria-live `polite`, Apply/Dismiss, ≥ 44 px
   targets); behavior contract is fixed here, visuals are the E5 design card's (co-design with
   h_designer; do not block on it for the state machine).
9. Tests per Decision 9 (`tests/e2e/fixtures/static-server.mjs`, two-marked-build CI step,
   `VITE_BUILD_ID` → `data-build-id`); unit tests listed at the end of Decision 9.

**Hard constraints checklist (verify all before completing):**

- [ ] NO `manifest.webmanifest`, NO install prompt / `beforeinstallprompt` (PO Q12, authoritative).
- [ ] No inline scripts beyond the hashed theme-boot snippet (ADR-001 §3 / §7.2).
- [ ] Zero external-origin references (budget gate `no-external-refs`).
- [ ] `dist/sw.js` included in the `app-shell` budget sum (ADR-001 §8).
- [ ] No new runtime dependencies (§7.2).
- [ ] ADR-002 contracts untouched (localStorage prefs-only; edits flush through the IDB layer).
- [ ] Offline is the default mode: no "offline" toggle, no degradation UI (§6.1).

**Done criteria (acceptance evidence recorded in the card's completion metadata):**

- Playwright: cold load online → offline boot → add/complete/reload → data present (test 1).
- Update flow: detect → toast → apply-on-action; **mid-edit session never reloaded** (tests 3–4, E9).
- Old caches purged on activate; correct scope under `/<repo>/` base path (tests 3, 8).
- Measured warm/offline start-to-interactive recorded vs the 300 ms budget (test 2; nightly value).

## Links

- PROJECT_ANALYSIS.md §6.1 (offline behavior), §4 M9, §10 E9, §9.5 (GitHub Pages, base path, ADR
  requirement), §9.1 (300 ms budget), §7.2 (CSP meta tag, zero third-party), §12 Q12 (no manifest /
  install in MVP — authoritative), §5.5 / R1 (iOS eviction context)
- docs/adr/ADR-001-ui-framework.md (binding toolchain: Vite 8, `BASE_PATH`, hash router, `src/sw/`
  layout, budget gates) — note its "ADR-003" references mean this record (numbering note above)
- docs/adr/ADR-002-storage-schema.md (storage layer for edit flush; localStorage prefs-only
  contract; `Result`/`StorageError` error handling)
- docs/adr/README.md (ADR index + numbering note)
- Task t_a7b86d9c (this decision); impl card t_6460ac5a (consumes this handoff); decomposition card
  t_1b9ee0e6

## Addendum A (2026-10-26) — `installed` announces only a real update (first-install race, t_f6f3cb6b)

**Bug.** On a single-build origin (byte-identical `sw.js` — no update possible) the "Update
available" toast appeared intermittently on FIRST loads (~1/6 under runner load, webkit only in
Nightly), and the spurious toast broke `offline.spec.ts`'s Decision 6 silence assertion
(`[data-update-notice]` expected 0, received 1 — e.g. Nightly 40262079123). Rule 3's old
discriminator — "`statechange: installed` **with** an existing controller" — is a handler-time race.

**Evidence (instrumented fresh-load probe, webkit, load-correlated, reproduced 2×):** the first
worker's `statechange: installed` reached the app's handler with
`state: 'installed'`, `controller: <this very worker>` (`clients.claim()` had already run),
`registration.active: null`, and the first install's transient `registration.waiting` slot still
set — so "a controller exists" was true on a first install with nothing to update. Both naive
discriminators fail: `navigator.serviceWorker.controller` is non-null after claim, and
`registration.waiting !== null` is true during the first install's brief waiting→activating
window (verified in every engine probed).

**Decision (amended rule 3, normative).** `installed` dispatches `installed-waiting` **iff the
installing worker is a real update** — `registration.active` is a *different* worker at handler
time. A first install (`active === null`, or `active === installing` once it has claimed) dispatches
`installed-first`. The same rule guards the boot-time adoption of an already-waiting worker
(Decision 5 rule 4): `waiting !== null && active !== null`. Additionally no update check runs while
`registration.active === null` (Decision 5 trigger policy): there is nothing to compare against
(the initial `register()` already fetched the freshest `sw.js` with `updateViaCache: 'none'`), and
the forced boot check could only race the first install.

**Alternatives considered.**

| Option | Why not |
|---|---|
| Keep `controller !== null` (status quo) | Races `clients.claim()`; proven misfire (above) |
| `registration.waiting === installing` | First install parks in `waiting` transiently — false positives |
| Byte-diff handshake (page asks active + waiting workers for `SHELL_VERSION` over `MessageChannel`) | Only exact way to catch a duplicate byte-identical install; adds a cross-thread protocol and failure modes for a case the spec's newest-worker byte-compare already prevents — rejected as over-engineering |
| Hide the toast for N seconds / debounce | Masks the race; the state machine would still announce a version that does not exist |

**Consequences.**

- Positive: first installs are silent on every engine regardless of event-delivery order; a real
  update (new worker alongside a running version) still toasts, offline-safe Apply unchanged;
  `offline.spec.ts` Decision 6 is deterministic.
- Negative/limits: a hypothetical byte-identical *duplicate* install (browser-internal update
  check racing `register()`) would still be announced as an update — indistinguishable from the
  page; the app-side trigger for that race is now closed by the `active === null` check gate.
  An update whose `statechange` arrives after a sibling tab already applied it announces
  `applied-elsewhere` instead of a stale toast (considered correct).
- Tests: `tests/unit/update-flow-runtime.test.ts` (classification contract, incl. the captured
  interleaving) and `tests/e2e/update-first-install.spec.ts` (deterministic real-browser
  reproduction of the claim-before-delivery interleaving; fails on the pre-fix code with the exact
  offline:128 signature).
