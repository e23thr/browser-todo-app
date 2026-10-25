# E4 QA — Offline journeys, update flow & cache lifecycle

**Card:** t_be7f0810 (Test: offline journeys, update flow & cache lifecycle, child of impl t_6460ac5a),
Epic E4 · **Reviewer of record:** h_reviewer · **Date:** 2026-10-23
**Refs:** PROJECT_ANALYSIS.md §6.1 (offline behaviour), §9.1 (performance budgets), §9.5 (quality —
offline E2E journey), §10 E9 (update mid-edit), §12 Q12 (no PWA install in MVP) ·
docs/adr/ADR-005-service-worker.md (Decisions 2–9)

## Verdict

**PASS with 1 blocking defect (D1), 1 non-blocking process defect (D2), 1 test defect found and
fixed in this card (D3), and 2 known dependency gaps** (not defects of this card's subject).

Every scenario in the card body was exercised against the real production pipeline output (the
ADR-005 Decision 9 two-build fixture harness: fixture builds `vA`/`vB`/`root-vA`, GitHub-Pages-like
static server). The headline numbers:

- **Offline boot works with the whole app** — cold load online → network disabled → boot, lazy
  routes (`#/settings`), deep-link navigation fallback and repeated offline reloads all work
  (suite `tests/e2e/offline.spec.ts`).
- **Warm/offline start-to-interactive is well inside the < 300 ms budget (§9.1)** — 40 measured
  samples (10 warm + 10 offline, unthrottled and at the §9.1 measurement condition of 4× CPU
  throttle): worst sample **105.5 ms**, i.e. ≥ 2.8× headroom even throttled (§3).
- **Update flow is user-gated and never destructive (E9)** — detect → toast → apply on user action
  → exactly one reload; a mid-edit session is never force-reloaded (apply is REFUSED with
  "Save or discard your edit before updating."), and applying in one tab never reloads another
  (§4).
- **Cache lifecycle is correct except for one real bug (D1)** — versioned caches are named
  `todo-shell:<slug>:v:<16-hex>`, exactly one cache exists after every transition, old versions are
  purged on activate, and scope/cache naming are correct under both `/<repo>/` and `/` base paths.
  **D1: the activate purge deletes OTHER apps' shell caches on the same origin** (§5).
- **Degraded networks never touch local writes** — with every response delayed 2 s the optimistic
  write feedback was **50.3 ms** (budget 100 ms); with every response failing (500) writes persist,
  reloads work and the update check stays completely silent (§6).
- **MVP ships no manifest and no install prompt (PO Q12)** — asserted from four angles (§7).

Evidence: `docs/qa/e4-offline-logs/` (verbatim run logs, JSON reports, measured boot samples, and
the probe script itself under `e4-offline-logs/probes/`).

## 0. Scope, environment and how to reproduce

| Item | Value |
|---|---|
| Subject under test | service-worker app shell + update flow (impl t_6460ac5a, HEAD `bf74495`) |
| Test target | clean scratch checkout of HEAD + this card's test changes (`/home/ubuntu/.hermes/profiles/h_reviewer/cache/scratch/e4-ci-parity-2310`), plus runs in the shared workspace |
| Suites | `tests/e2e/offline.spec.ts`, `update.spec.ts`, `offline-data-journey.spec.ts` (impl) + `offline-robustness.spec.ts` (added by this card) |
| Reproduce (SW suites, strict budget) | `E2E_BOOT_BUDGET_MS=300 npm run e2e:sw` |
| Reproduce (CI parity) | `CI=true npx playwright test --project=chromium` (main config; builds `dist` + fixtures exactly as CI does) |
| Reproduce (boot budget probe) | `node docs/qa/e4-offline-logs/probes/boot-budget-probe.mjs` |
| Raw evidence | `docs/qa/e4-offline-logs/` |

Runs captured in the logs dir:

| Log | What it shows |
|---|---|
| `sw-e2e-strict-run-1.txt` | SW suites, strict 300 ms line, before this card's additions — 11 passed, 1 skipped |
| `sw-e2e-strict-run-2.txt` | SW suites + this card's additions, `CI=true`, strict 300 ms — 15 passed (1 of them an expected failure = D1 evidence), 1 skipped |
| `ci-parity-main-config-run.txt` | full `--project=chromium` matrix run on a clean checkout (smoke, axe both themes, theme-boot, offline, update, robustness) — 29 passed, 1 skipped, exit 0 |
| `robustness-json-run.json` | JSON report of the new robustness suite: D1 failure text (verbatim cache list) + the degraded-network measurement annotation |
| `boot-budget-results.json` | 40 start-to-interactive samples (probe output) |
| `probes/boot-budget-probe.mjs` | the independent probe (written from §9.1, not from the card's own e2e) |

Tree caveat: the shared workspace holds sibling cards' in-flight files; the gate runs above were
therefore taken from a clean `git archive HEAD` checkout with only this card's test files copied in.
`tests/e2e/fixtures/*.mjs` changes are harness additions (`setLatency`, `setFailingAll`) used by the
new degraded-network scenarios.

## 1. Scenario: cold load online → network-disabled offline boot with full function (M9, §6.1)

**Result: PASS for the shell + persistence loop; the task add/complete loop is scripted but
activation-gated on E2 core UI (see §8).**

Evidence (`offline.spec.ts`, `offline-data-journey.spec.ts`, `sw-e2e-strict-run-2.txt`):

- Cold load online → SW claims the page → the precache holds **exactly the whole shipped artifact
  set** (every HTML/JS/CSS/icon the build emits, including lazy route chunks and both locale
  packs; no external URLs, no `.webmanifest`).
- Network disabled → reload → the shell boots from cache (`Today` heading visible).
- Lazy route `#/settings` works offline (whole-artifact precache = M9 "offline-complete").
- Unknown in-scope path (`…/browser-todo-app/no-such-page`) falls back to the cached shell
  (ADR-005 Decision 4 navigation fallback) — this is what makes hash deep links survive a cold
  offline boot.
- Repeated offline reloads keep working.
- **Data loop offline (real persistence path)**: write while offline through the settings surface →
  reload offline → value still applied; full re-boot of `#/settings` → value still checked
  (`offline-data-journey.spec.ts`, runs today).
- Zero `securitypolicyviolation` events across offline boot + lazy navigation (Decision 9 test 9).

## 2. Scenario: warm/offline start-to-interactive vs the < 300 ms budget (§9.1)

**Result: PASS — all 40 measured samples inside budget, including at the §9.1 measurement
condition (4× CPU throttle).**

The card's own suite asserts the budget at runtime (`E2E_BOOT_BUDGET_MS=300`); this card adds an
independent probe (`probes/boot-budget-probe.mjs`) that measures the same `app:interactive` mark
10× per mode directly from `performance.getEntriesByName`, unthrottled and at 4× CPU throttle
(§9.1 budgets are stated for a mid-tier Moto-G-class device):

| Mode | Metric | min | median | max | Budget | Verdict |
|---|---|---|---|---|---|---|
| unthrottled | warm start-to-interactive | 18.8 ms | 29.9 ms | 91.0 ms | 300 ms | PASS |
| unthrottled | offline start-to-interactive | 15.0 ms | 17.4 ms | 105.5 ms | 300 ms | PASS |
| 4× CPU throttle | warm start-to-interactive | 75.2 ms | 87.8 ms | 101.2 ms | 300 ms | PASS |
| 4× CPU throttle | offline start-to-interactive | 65.6 ms | 73.2 ms | 86.7 ms | 300 ms | PASS |

Raw samples: `e4-offline-logs/boot-budget-results.json`. Worst sample across all 40 runs is
105.5 ms — **≥ 2.8× headroom** to the budget even before throttling is considered. The offline
reload is consistently faster than the warm online one (cache-first, no network round trip).

Not measurable yet: §9.1's "Boot with 10,000 tasks to first data paint < 500 ms" — needs the E2
task model to seed 10k records (belongs to the E2 test card).

## 3. Scenario: update flow (detect → toast → apply) and E9 never-force-reload

**Result: PASS** (`update.spec.ts`, 4 scenarios, all green in both strict runs):

- Deploy of build `vB` (byte-different `sw.js`, same origin — what a GitHub Pages deploy looks
  like) is detected; the "Update available" toast appears in a polite `role="status"` live region
  with focusable **Apply** and **Dismiss** actions.
- Nothing reloads before the user acts (window marker survives a 1 s wait) — E9 core claim.
- **Apply** reloads exactly once (navigation counter = 1) and the `<html data-build-id>` flips
  `vA → vB`, so "exactly one deliberate reload" is directly observable.
- Mid-edit (uncommitted text in an editable field): the toast appears mid-edit and nothing
  reloads; clicking Apply with unflushable content is **REFUSED** ("Save or discard your edit
  before updating.") with the content intact; after the edit is resolved, Apply reloads exactly
  once. (The stand-in field exercises the same Decision 7 machinery the real editor drives;
  editor↔update wiring is tracked in followup card t_fa3af43d.)
- Multi-tab: applying in tab A never reloads tab B (marker survives); tab B gets an
  "Updated — refresh when ready" notice and reloads only on its own user's click (exactly once).
- Stale-tab guard: a tab left on the old build whose lazy chunk vanished gets an explained notice
  with an explicit Refresh — never an auto-fix, never a silent crash.
- A failing update check is completely silent (Decision 6): no toast, no error UI, app stays
  usable, offline reload still works.

## 4. Scenario: cache lifecycle and SW scope under `/<repo>/` base path

**Result: PASS except D1 (blocking).**

Verified (independently re-run by this card):

- Cache naming `todo-shell:<slug>:v:<16-hex>` where `<slug>` derives from the registration scope at
  runtime (`browser-todo-app` under `/browser-todo-app/`, `root` under `/`) — asserted for both
  base paths, so the GitHub Pages project-page case is covered.
- Registration scope equals the base path; `sw.js` sits at the base root (Pages cannot raise the
  scope) and is served 200.
- Exactly **one** versioned cache exists after cold install and after every update transition;
  old versions are purged on activate (both the previous real version and a seeded stale
  same-slug cache are gone after Apply).
- Navigation fallback works offline (unknown in-scope path serves the cached shell).

**D1 (BLOCKING) — activate purges OTHER apps' shell caches.** `src/sw/sw.ts` `activateShell()`
filters with `isShellCacheName()`, and `src/sw/routing.ts:90` defines that as
`name.startsWith('todo-shell:')` — **any slug**. On the shared `*.github.io` origin (the actual
deployment target, §9.5) one app's update therefore deletes a sibling project page's shell cache,
breaking that app's offline boot until it next loads online. This contradicts ADR-005 Decision 3
("the slug prevents cross-app cache collisions") and the `sw.ts` header comment ("cross-app caches
are protected by the base-path slug in the name") — the slug namespaces the cache but does not
protect it from deletion.

Executable evidence: `offline-robustness.spec.ts` "cache lifecycle: activate purges old VERSIONS of
this app only" seeds `todo-shell:other-app:v:1111111111111111` alongside a stale same-slug cache,
applies an update, and asserts both the old version AND the foreign cache survive the purge. The
same-slug assertions pass; the foreign one fails (verbatim from `robustness-json-run.json`):

    expect(received).toContain(expected)
    Expected value: "todo-shell:other-app:v:1111111111111111"
    Received array: ["todo-shell:browser-todo-app:v:a421e35055099eb7"]

The test is landed with `test.fail(...)` + the defect text so the suite stays green while the bug
exists and **flips red the moment it is fixed** (then delete the annotation).
**Fix:** scope the purge to the current slug — delete only `todo-shell:<thisSlug>:v:*` names that
are not the current cache.

## 5. Scenario: degraded network leaves local writes unaffected (§6.1)

**Result: PASS** (`offline-robustness.spec.ts`, added by this card; fixture server gained
`setLatency(ms)` / `setFailingAll(bool)` for the two conditions):

- **Slow (2 s on every response):** an optimistic local write (theme change through the settings
  surface) showed its UI feedback in **50.3 ms** — inside the §9.1 optimistic budget (100 ms) and
  40× faster than the network latency, proving the write loop has no network dependency. The
  value then survived a reload and a fresh settings boot (served cache-first). No error UI at any
  point. Measured in-page (MutationObserver timestamp vs a `performance.now()` taken just before
  the click), so Playwright polling cannot inflate the number.
- **Flaky/dead (every response 500):** an update check fails **silently** (no toast, no error UI —
  Decision 6), a local write lands, an offline reload shows it, exactly one versioned cache
  remains, and nothing in the shell errors.

## 6. Scenario: MVP install scope — no manifest, no install prompt (PO Q12)

**Result: PASS** (`offline-robustness.spec.ts` "MVP install scope"), asserted four ways:

1. the served shell document has **zero** `<link rel="manifest">` elements;
2. the build output contains **no** `*.webmanifest` file;
3. **no** shipped JS (including `sw.js`) references `beforeinstallprompt` — nothing can raise an
   install prompt;
4. nothing manifest-y is precached (ADR-005 Decision 2: Q12 supersedes M9's older
   "icons/manifest" wording).

## 7. Offline task journey (add → complete → reload → data present) — scripted, activation-gated

**Result: scripted and CI-runnable, but it cannot execute until E2 core UI lands (t_a2c647e1,
status `todo`) — known dependency gap, not a defect of the SW card.** The journey self-skips with
the dependency named (`offline-data-journey.spec.ts`), and the settings write→reload loop stands in
as today's real-path data evidence (§1).

**D3 (found and FIXED by this card):** the journey as delivered would *not* have "activated
unchanged" — it contradicted the binding design contract (docs/design/core-domain.md) in four
places, each of which would have failed once the composer landed:

1. **Checkbox accessible name** — the row checkbox is labelled `a11y.toggleTask` ("Mark \"{title}\"
   as complete", S2 a11y), not the bare title; the old exact-title role lookup could never match.
   Fixed: rows are located by visible title text and the checkbox scoped to the row.
2. **Wrong view for an undated capture** — Today lists `dueDate ≤ today` only (S2 matrix), so a
   captured task with no due date is invisible there. Fixed: capture on `#/all` ("No due date"
   group).
3. **Missing list prerequisite** — with zero lists the composer is DISABLED (S3: `composer.needsList`
   + `list.action.new`), so a fresh profile could not capture at all. Fixed: the journey creates a
   list first when the New-list affordance is present.
4. **Completed tasks leave open views** — F3 collapses a completed row out of the open views after
   ~900 ms, so "data present" must be asserted in `#/completed` (checked), not in the capture view.
   Fixed accordingly.

The rewritten journey is written against the design contract + registered i18n keys
(`composer.placeholder`, `composer.add`, `list.action.new`, `list.dialog.name`, `list.dialog.save`)
with each step annotated to its spec section. It remains **unvalidated against real UI** — when the
E2 composer lands, re-run `npm run e2e:sw` and confirm it goes green unchanged (if the E2 card
deviates from the S2/S3/F1/F3 contract in any of these four details, the journey must be adjusted
to the deviation).

## 8. Automated gates (clean checkout of HEAD + this card's test files)

| Gate | Result |
|---|---|
| `npx eslint . --max-warnings 0` | PASS |
| `npx prettier --check .` | RED in 11 files — **all** `src/storage/*` + `tests/unit/storage/*` (storage card's committed files, out of scope for this card; matches the known "format:check red" handoff). This card's files are Prettier-clean (verified individually) |
| `npm run typecheck` (shared tree) | PASS |
| `npx vitest run` | 367/367 PASS (37 files) |
| `E2E_BOOT_BUDGET_MS=300 npm run e2e:sw` | 15 passed / 1 skipped (the skip = §7's gated task journey; the "failure" is D1's expected-failure evidence) — exit 0 |
| `CI=true npx playwright test --project=chromium` (main config, full build) | 29 passed / 1 skipped — exit 0 (smoke 7, axe 2 themes, theme-boot 5, offline 6, data-journey 1+1 skip, robustness 4 incl. D1 expected failure, update 4) |
| Boot budget probe (40 samples) | PASS — worst 105.5 ms vs 300 ms |

## 9. Defect list

| # | Severity | Where | What | Action |
|---|---|---|---|---|
| **D1** | **BLOCKING** | `src/sw/sw.ts` `activateShell()` + `src/sw/routing.ts:90` | Activate purges every `todo-shell:*` cache, including sibling project pages' caches on the shared `*.github.io` origin — contradicts ADR-005 Decision 3 and the `sw.ts` header comment | Scope the purge to the current base slug (`todo-shell:<slug>:v:*`, minus the current cache); executable red test already landed (`offline-robustness.spec.ts`, `test.fail`) — remove the annotation when fixing |
| **D2** | Non-blocking (process) | `.github/workflows/ci.yml`, `nightly.yml`, `tests/e2e/sw-utils.ts:15` | The comment claims "the nightly job … set `E2E_BOOT_BUDGET_MS=300`" — **no workflow sets it** (the var appears nowhere outside `sw-utils.ts`), so CI asserts a loose 1500 ms line instead of the real 300 ms budget. Also: the offline/update/robustness suites run only in the nightly matrix, not in the PR gate (`ci.yml` runs smoke + axe only) | Set `E2E_BOOT_BUDGET_MS: '300'` in the nightly env (and ideally add an `e2e:sw` job to `ci.yml`); fix the comment if the intent changed |
| **D3** | Fixed in this card | `tests/e2e/offline-data-journey.spec.ts` | The offline task journey violated the design contract in 4 ways (checkbox name, wrong view for undated capture, missing list prerequisite, completed-row visibility) and would not have activated unchanged | Rewritten against S2/S3/F1/F3 (§7); re-verify when the E2 composer lands |

**Info (not defects of this card):**

- `npm run format:check` is red at HEAD in 11 storage-card files (§8) — owned by the E1 storage
  card.
- The stale-cache/foreign-cache probe data (`stale-probe.txt`, `foreign-probe.txt`) is written only
  into seeded CacheStorage entries inside a throwaway browser context; no user data involved.

**Known dependency gaps (explicitly out of this card's reach):**

- Task add/complete/reload offline loop needs the E2 core-UI composer (t_a2c647e1, `todo`) —
  scripted and gated (§7). The §9.5 full journey's export → wipe → import tail belongs to the
  portability epic.
- Real-editor↔update-flow (E9) wiring is tracked in followup card t_fa3af43d; today's E9 evidence
  uses the Decision 7 machinery via a stand-in editable field (§3).
- §9.1 "boot with 10,000 tasks" measurement waits on the E2 task model.
