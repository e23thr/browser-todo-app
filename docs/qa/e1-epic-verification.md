# Epic E1 — Infrastructure & DevOps: epic-level verification (h_pm)

- Epic card: t_18f28c32 · Verified: 2026-10-23 (UTC+7) by h_pm
- Method: clean clone of HEAD `bf74495` in scratch (`~/.hermes/profiles/h_pm/cache/scratch/e1-verify-1`,
  `npm ci` from the committed lockfile) with the full CI battery executed locally; live-tree spot
  checks re-run at HEAD `450f473` after sibling cards landed work.
- Verdict: **NOT YET CLOSEABLE — 2 open items** (both routed to fix card `t_eff7b105`):
  1. `npm run format:check` is RED at HEAD (11 files) and the CI `lint` job runs it — the
     "ships from CI" clause of acceptance criterion 1 is currently broken.
  2. QA fix card `t_dbe04ac6` (D3–D6) is verified green but its changes are UNCOMMITTED in the
     shared working tree.
  All six acceptance criteria are otherwise verified PASS.

## 1. Acceptance criteria matrix

| # | Criterion | Verdict | Evidence |
|---|-----------|---------|----------|
| 1 | Static build deploys from CI to GitHub Pages under a non-root base path | **PARTIAL** | Build green under `BASE_PATH=/browser-todo-app/`; all dist asset URLs `/browser-todo-app/`-prefixed (favicon.svg, css, js in dist/index.html). `ci.yml` deploy job needs all 8 gates, green-main-only (`push` to `main`), `configure-pages@v5` + `upload-pages-artifact@v3` + `deploy-pages@v4`. **Broken clause:** `format:check` exits 1 at HEAD → the CI lint job fails → deploy cannot run (fix `t_eff7b105`). Limitation: no live GitHub run possible from this host (no remote); every job's exact command executed locally on a clean clone. |
| 2 | Every CI gate demonstrably fails when violated | **PASS** | QA `t_c7d6403e`: 31 verbatim logs in `docs/qa/e1-scaffold-gates-logs/` proving per-gate failure (prettier, eslint, tsc, vitest, coverage thresholds, all 7 bundle-budget sub-gates incl. a real 148 KB over-budget artifact, e2e smoke, axe); independently re-proven by review `t_51180c4b` on a clean clone. My spot-check this run: 130 KB random append to the real entry artifact → `initial-js 151.5 KB > 100.0 KB FAIL` exit 1; restored → PASS exit 0. |
| 3 | CSP meta per §7.2 (frame-ancestors exception documented) | **PASS** | `dist/index.html` meta = `default-src 'self'; script-src 'self' 'sha256-…'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'` — the §7.2 set, no `unsafe-inline` in production, hashed inline theme-boot snippet. `frame-ancestors` dropped with the exception documented in the index.html comment and README §"CSP and the frame-ancestors exception". E2E smoke carries a `securitypolicyviolation` listener (0 violations) + the §7.2 meta-tag test — 7/7 in my run. |
| 4 | Storage schema documented in ADR-002 with zero drift in code | **PASS** (1 doc nit) | `src/storage/schema.ts` `STORE_DEFS` matches ADR-002 Decision 3.1–3.6 verbatim: 6 stores (meta out-of-line key `'meta'`, lists, tasks, settings `id='settings'`, snapshots, snapshot_payloads); all 8 indexes incl. compound `by_list_sort ['listId','sortOrder']`, `by_dueDate`/`by_parent` sparse by construction; `tags` reserved per §3.7 and absent from code. Nit: ADR-002 line 98 "Seven object stores in idbVersion 1" contradicts its own §3.7 (doc-internal count error; code correct) — fix routed to `t_eff7b105`. |
| 5 | Migration chain + boot validation + quarantine proven by corruption drills | **PASS** (fixes pending commit) | `tests/unit/storage/drills-qa.test.ts` 17/17 green in my clean-clone run: mid-chain migration interruption rolls back byte-equivalent via the pre-migration snapshot (incl. meta, raw-IDB-verified) and re-migrates cleanly; invalid records quarantined non-destructively, recovery file loadable after a real disk round-trip with records verbatim (never-silent-drop attested; explicit purge the only exit); QuotaExceededError surfaced as typed `QUOTA_EXCEEDED` on every write surface and in boot warnings; tombstone purge honors 90 d TTL / 24 h throttle; snapshot restore keeps deviceId. Drill-campaign defects D1–D6 all fixed: D1 via `bb347b5`, D2 via `d605e7e` (purge now skips the meta/settings singletons — identity preserved), D3–D6 in `t_dbe04ac6` (boot quota classification, corrupt-schemaVersion handling, fixture meta read-and-keep, atomic purge pass) — verified 143/143 storage tests in the shared tree at 20:55, **pending commit** via `t_eff7b105`. D7 (recovery-format drift) resolved: writer now emits the ADR-004 Decision 7.1 envelope. Evidence: `docs/qa/e1-storage.md` + `docs/qa/e1-storage-logs/`. |
| 6 | Wrapper/migration unit coverage ≥ 80% | **PASS** | Clean-clone coverage: `db.ts` 92.57 stmts / 94.28 branches; `migrations.ts` 97.69 / 86.58; project-wide threshold gate green (All files 82.87 / 83.04). |

## 2. Full CI battery on a clean clone of `bf74495` (h_pm, this run)

| Gate | Command | Result |
|------|---------|--------|
| format | `npm run format:check` | **FAIL exit 1** — 11 files (see §3) |
| lint | `npm run lint` | PASS exit 0 |
| typecheck | `npm run typecheck` | PASS exit 0 |
| i18n catalog | `npm run i18n:check` | PASS exit 0 |
| unit + coverage | `npm run test:coverage` | PASS — 30 files, 293/293; thresholds green |
| build | `BASE_PATH=/browser-todo-app/ npm run build` | PASS |
| bundle budgets | `npm run budget` | PASS — initial-js 24.6/100 KB, css 3.4/20, app-shell 33.3/200 (6 files, 2 lazy chunks excluded), locales 5.6/20, locales-lazy 0, no-external-refs 0, no-wasm 0 |
| e2e smoke | `E2E_PORT=4199 npm run e2e:smoke` | PASS 7/7 (non-root base path; `E2E_PORT` used because 4173/4174 are occupied on this host) |
| e2e axe | `E2E_PORT=4199 npm run e2e:a11y` | PASS 2/2 (dark + light) |
| budget violation probe | inflate entry artifact + `npm run budget` | FAIL exit 1 as required (151.5 KB > 100 KB); restored → PASS |

## 3. The closure blocker: prettier gate red at HEAD

`npm run format:check` exits 1 on 11 committed files — cosmetic line-wrapping introduced by
storage commit `25a25d3` and never swept (later reviews only checked their touched files):

- src/storage/boot.ts, errors.ts, index.ts, migrations.ts, orderKey.ts, types.ts, validate.ts
- tests/unit/storage/errors.test.ts, migrations.test.ts, orderKey.test.ts, validate.test.ts

The CI `lint` job runs Prettier (`ci.yml`), so main is RED and the Pages deploy gate cannot pass.
Fix card `t_eff7b105` (h_junior_coder): commit `t_dbe04ac6`'s uncommitted D3–D6 leftovers as their
own attributed commit first (verified 143/143 green in the shared tree at 20:55), then the
formatting sweep as a separate commit, then the ADR-002 "Seven → Six" wording fix, then re-run the
battery on a clean clone.

## 4. Work-item status (all 8 listed work items DONE)

- t_9fa51c86 ADR-001 UI framework & build tooling — done (Preact 10.29 + @preact/signals on Vite 8, npm+lockfile, ESLint 9/Prettier, CI matrix)
- t_576c2376 ADR-002 Storage schema & wrapper design — done
- t_3c5ef00d Impl: scaffold, build & Pages CI/CD — done (6 commits, gates proven both ways)
- t_eba4b531 Impl: IndexedDB wrapper, versioning & migration/boot-validation — done (87 tests, API handoff docs/dev/storage-api.md)
- t_c7d6403e Test: scaffold & CI gates — done (docs/qa/e1-scaffold-gates.md + 31 logs)
- t_51180c4b Review: scaffold & CI/CD — APPROVE (all 6 checklist items, clean-clone re-proof)
- t_ae894274 Test: storage wrapper & corruption drills — done (docs/qa/e1-storage.md + logs, 7 findings)
- t_70062edb Review: storage framework — REQUEST CHANGES → t_d40034ae re-review APPROVE (R1–R3 verified fixed in bb347b5/42427ee)
- (QA follow-up) t_dbe04ac6 fix D1–D6 — done, work pending commit (see §3)

## 5. Handoff to the MVP DoD gate (t_7f1e8f29)

**May assume in place:** ADR-001/002 accepted; the scaffold, full CI gate matrix, §9.2 budget
thresholds as build-breaking gates, §7.2 CSP meta with documented frame-ancestors exception,
configurable base path; the storage framework (6 stores, ULID ids, base-36 order keys, forward-only
migration chain with pre-migration snapshot + rollback, boot validation with non-destructive
quarantine + ADR-004 7.1 recovery file, tombstone purge, typed error contract) with 143 storage
tests and the corruption-drill suite in-repo.

**Must re-check at release time:** CI actually green at the release HEAD (incl. the prettier gate);
the D3–D6 commit present (currently uncommitted); zero data loss over the whole test cycle —
especially purge/identity behavior of the D2 class; and a real GitHub Pages run (never exercised
from this host).

---

## 6. Round-2 re-verification (h_pm, 2026-10-25, clean clone of HEAD `15defe6`)

Trigger: fix card `t_eff7b105` landed (prettier gate restored at `e11245f`; the D3–D6 storage
fixes committed as `8580853`; ADR-002 "Seven object stores" typo fixed as `2b20fac`). Both round-1
blockers are RESOLVED: `npm run format:check` exits 0 and the D3–D6 commit is present.

Full battery re-run on a clean clone of `15defe6` (npm ci exit 0, 0 vulnerabilities):

| Gate | Result |
|---|---|
| `npm run format:check` | PASS (exit 0) — round-1 blocker cleared |
| `npm run lint` | PASS (exit 0) |
| `npm run typecheck` | PASS (exit 0) |
| `npm run i18n:check` | PASS (exit 0) |
| `npm run test:coverage` | PASS — 675/675 tests (61 files); storage wrapper/migration coverage ≥80% (db.ts 93.14 stmts/94.28 branches, migrations.ts 97.69/86.58) |
| `BASE_PATH=/browser-todo-app/ npm run build` + `npm run budget` | PASS — all budgets green (app-shell 74.3/200 KB, locales 12.1/20 KB, 0 lazy leaks, 0 external refs, 0 wasm); all asset URLs `/browser-todo-app/`-prefixed |
| CSP §7.2 | PASS — shipped meta exact; theme-boot SHA-256 recomputed and matches (`sha256-ff2Sh/y3LQDw1aTLOVBX27tVhu8uBVoaLKulIlwroVY=`); frame-ancestors exception documented in index.html + README §CSP |
| ADR-002 ↔ code schema | PASS — zero drift: 6 stores / 8 indexes, key paths + `by_list_sort` compound verbatim; `tags` reserved only (schema.ts is the single upgrade-path source) |
| Corruption drills | PASS — `tests/unit/storage/drills-qa.test.ts` 23/23 (17 QA drills + P1–P4 regression pins from t_dbe04ac6) |
| `npm run e2e:a11y` | PASS (2/2) |
| `npm run e2e:smoke` | **FAIL (6 of 7)** — see below |

### 6.1 The round-2 blocker: e2e:smoke is red at HEAD (cross-epic regression)

Root cause: E3's first-run onboarding screen (`src/features/data-safety/Onboarding.tsx`, landed
in `d2770bf` AFTER round-1's `bf74495`) is the first paint on a fresh browser profile — exactly
what CI runs. The committed `tests/e2e/smoke.spec.ts` predates it and expects the Today h1
directly after `goto`, so 6 of 7 tests fail ("Today" / "Settings" / "Page not found" headings
never appear; only the CSP-meta test passes). The app itself is healthy: clicking "Get started"
renders the Today view with zero console errors and zero failed requests (headless Chromium
probe, both directions: served without the BASE_PATH env the dist 404s assets — a serving
artifact, not an app bug).

Since `e2e:smoke` runs on every PR and push to main in ci.yml, the pipeline is RED at HEAD and
the "app ships from CI to GitHub Pages" acceptance clause is false at the pipeline level — the
same class of blocker as round-1's prettier gate.

Routed to fix card `t_5edbfb37` (h_junior_coder): test-only alignment — seed the
`todo:prefs:v1:onboardingStep = 'done'` marker (ADR-002 Decision 7 contract) in the 5
app-shell tests, rework the boot test to cover the real first-run journey (onboarding →
CTA → Today), and add one dismissal-persistence test. `e2e:a11y` is green and untouched.
The epic is dependency-gated on that card and resumes for round-3 re-verification + close.

Everything else in the round-1 verdict stands, strengthened: the D3–D6 fixes are now committed
(`8580853`, storage suite 143/143 at that commit; 675/675 repo-wide now), the ADR-002 store-count
nit is fixed (`2b20fac`), and CI gained two more PR gates (e2e:sw, e2e:data-safety) from sibling
epics — gate coverage only grew.

### 6.2 Handoff to the MVP DoD gate (t_7f1e8f29) — updated

Supersedes §5's "must re-check" list:
- CI green at the release HEAD incl. `e2e:smoke` (blocked on t_5edbfb37 as of this round).
- D3–D6 commit `8580853` IS present (done). Zero-data-loss re-check over the whole test cycle
  (purge/identity behavior especially) still stands.
- A real GitHub Pages run has still never been exercised from this host.
- Note (non-blocking, tracked as t_3b903351): `src/sw/precache-manifest.ts` is stale — any
  `npm run build` dirties a tracked file; no CI job checks its freshness (hygiene, not a red).

## 7. Round-3 re-verification & CLOSURE (h_pm, 2026-10-25, clean clone of HEAD `818d02a`)

**Verdict: ALL 6 acceptance criteria PASS — Epic E1 is CLOSED.** The round-2 blocker is
resolved: fix card `t_5edbfb37` landed the smoke-suite alignment as commit `818d02a`
(tests/e2e/smoke.spec.ts only, +38/-1): 5 shell-bound tests seed the ADR-002 Decision 7
`todo:prefs:v1:onboardingStep='done'` marker via the shared `seedOnboardingDone()` helper,
the base-path test walks the real unseeded first-run journey (onboarding h1 → "Get started"
→ Today h1), and a new "first-run onboarding shows once and never again" reload test guards
the zero-task classification. `src/` untouched.

Full CI battery executed first-hand on a clean clone of `818d02a` (npm ci exit 0, 387 pkgs):

| Gate | Result |
| --- | --- |
| `npm run format:check` | PASS (exit 0) |
| `npm run lint` | PASS (exit 0) |
| `npm run typecheck` | PASS (exit 0) |
| `npm run i18n:check` | PASS (exit 0) — en/th keys, values, placeholders consistent |
| `npm run test:coverage` | PASS — 910/910 tests (77 files); storage wrapper/migration ≥80% (src/storage 96.03 stmts/93.47 branches; db.ts 93.14/94.28, migrations.ts 97.69/86.58) |
| `BASE_PATH=/browser-todo-app/ npm run build` + `npm run budget` | PASS — initial-js 65.5/100 KB, css 6.7/20 KB, app-shell 81.4/200 KB, locales 12.7/20 KB, 0 lazy leaks, 0 external refs, 0 wasm; all asset URLs `/browser-todo-app/`-prefixed |
| CSP §7.2 | PASS — shipped meta exact directive set; theme-boot SHA-256 recomputed and matching (`sha256-ff2Sh/y3LQDw1aTLOVBX27tVhu8uBVoaLKulIlwroVY=`); no `unsafe-inline`; frame-ancestors exception documented (index.html + README) |
| ADR-002 ↔ code schema | PASS — zero drift: `src/storage/schema.ts` STORE_DEFS = 6 stores (meta out-of-line, lists, tasks, settings, snapshots, snapshot_payloads) / 8 indexes (by_updatedAt×2, by_listId, by_status, by_dueDate, by_list_sort compound, by_parent, by_takenAt), `tags` reserved only |
| Corruption drills | PASS — `tests/unit/storage/drills-qa.test.ts` 23/23; whole storage suite 152/152 (14 files) |
| `npm run e2e:smoke` | **PASS (8/8)** at `818d02a` |
| `npm run e2e:a11y` | PASS (2/2) |

**Gate-discriminating probe (this round, first-hand):** the QA-D1 scenario is now closed —
with `view.today` renamed to "Todayy" in `src/i18n/en.json` (the exact wrong-heading case
that passed 7/7 before the D1 fix), `e2e:smoke` FAILS 5 of 8 (exit 1) and passes again after
revert. Every `getByRole` name in tests/e2e/ carries `exact: true` (22/22 locators).
Prior deliberate-violation evidence stands for the other gates (round-1 probe battery:
prettier/eslint/tsc/vitest/coverage/all 7 budget sub-gates with a real 148 KB over-budget
artifact/smoke/axe all proven FAIL; budget FAIL-then-PASS re-proven in round 2).

**Acceptance criteria matrix — final:**

| Criterion | Status |
| --- | --- |
| Static build deploys from CI to GitHub Pages under a non-root base path | PASS — ci.yml intact: all §9.5 gates on every PR/push, green-main-only `github-pages` deploy job, workflow-level `BASE_PATH: /<repo>/`, built URLs verified prefixed |
| Every CI gate demonstrably fails when violated | PASS — full probe battery + this round's smoke probe |
| CSP meta per §7.2 (frame-ancestors exception documented) | PASS |
| Storage schema documented in ADR-002 with zero drift in code | PASS |
| Migration chain + boot validation + quarantine proven by corruption drills | PASS — 23/23 |
| Wrapper/migration unit coverage ≥80% | PASS — well over (see battery) |

### 7.1 Handoff to the MVP DoD gate (t_7f1e8f29) — final

- CI green at release HEAD incl. `e2e:smoke`: satisfied at `818d02a` (locally verified; the
  DoD gate should confirm the GitHub Actions run itself).
- D3–D6 commit `8580853`: present. Zero-data-loss re-check over the whole test cycle
  (purge/identity especially) still stands as a DoD item.
- A real GitHub Pages deployment run has still never been exercised from this host — the one
  remaining unverified link in the deploy chain; belongs to the DoD gate, not to E1's
  repo-verifiable criteria.
- Non-blocking hygiene (t_3b903351): `src/sw/precache-manifest.ts` staleness unchanged.
