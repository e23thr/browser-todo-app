# [E8] Fix — E8-UI-D1 sync-apply store refresh + E8-UI-D5 probe the configured path

**Card:** `[E8] Fix: E8-UI-D1 sync-apply store refresh + E8-UI-D5 probe the configured path`
(t_2dec7c9d, epic t_15e14284; defects from the sync-UI QA card t_98a1b4a5, report
`docs/qa/e8-sync-ui.md`)
**Author:** h_senior_coder · **Date:** 2026-10-26
**Commits:** `94d429d` (E8-UI-D5), `15bdcdf` (E8-UI-D1), `f138230` (ADR-006 Addendum C), this
report + evidence.
**Decisions:** ADR-006 **Addendum C** (probe protocol + sync-apply `data-replaced` seam).
PROJECT_ANALYSIS §6.2 untouched (R3).

---

## 1. What was broken (both verified open at `52b03b9` by the h_pm run)

| Defect | Root cause | User impact |
|---|---|---|
| **E8-UI-D5** | `WebDavClient.probe()` → `url('')` → `new URL('/', base)` = **origin root**; every connection test OPTIONSed `/` | Dead typed paths PASSED setup; wrong credentials were ACCEPTED (401 only at first run); the test never validated path or auth |
| **E8-UI-D1** | The apply tx commits through the engine's own `db.tx`, bypassing `MutationRunner.onCommitted`; `notifyDataReplaced()` fired only from `src/portability/{import,export}.ts` | Pulled rows and `Conflict copy of …` rows invisible until a full page reload; keep-copy/discard-copy resolves failed `TASK_MISSING` in the gap (loud + pending, no loss) |

## 2. The fixes

- **E8-UI-D5 (`94d429d`, `src/sync/webdav.ts`):** `url('')` now resolves to the collection
  itself (its `DavEntry.path` meaning), and the capability probe is a **`PROPFIND` `Depth: 0`
  on the configured base URL** (ADR-006 Addendum C Decision 1). `207` = the collection exists
  AND the credentials work; `404` → `REMOTE_MISSING` (dead path fails setup); `401`/`403` →
  `AUTH` ("Sign-in rejected" — never the CORS misattribution copy). `OPTIONS` cannot be the
  test: WebDAV servers answer it unauthenticated (CORS preflight reality).
- **E8-UI-D1 (`15bdcdf`, `src/sync/engine.ts`):** after a COMMITTED merge that materialized
  rows (`plan.puts + plan.copies > 0`) the engine fires the existing `notifyDataReplaced()`
  seam — the same one the portability import/export path uses (ADR-004 Decision 3; Addendum C
  Decision 2) — so `wireDataReplacedRefresh()` re-reads the running store and other tabs
  converge. A no-op merge fires nothing (no UI churn on periodic passes). No change to
  `src/features/tasks/store.ts` (sibling recurrence WIP untouched — the wiring is entirely on
  the sync side).

## 3. Acceptance mapping (re-review checklist)

### E8-UI-D1

| # | Acceptance | Evidence | Result |
|---|---|---|---|
| 1 | Q10 + Q11a flipped `it.fails` → `it`, bodies verbatim, AND pass | `tests/component/e8-sync-ui-storegap.test.tsx`; flip markers carry the e8-qa-probes "Was `it.fails`…" comment; bodies content-identical (the diff is indent-only reflow forced by the Prettier gate — machine-verified) | PASS (5/5 in file) |
| 2 | Pulled row + materialized conflict copy visible in the rendered list WITHOUT reload | Q10 (asserts store state + rendered DOM) / Q11a (asserts store state) | PASS |
| 3 | keep-copy / discard-copy resolves succeed without reload | Q11b (discard-copy: polite "Conflict resolved: Buy milk", copy tombstoned, sticky state cleared) + Q11c (keep-copy: original tombstoned, copy survives + stays visible) + Q11d (keep-both, zero writes) | PASS |
| 4 | No regression in src/sync suites (incl. Q1/Q2, M15–M18, E13/E14) | clean-worktree `npx vitest run tests/unit/sync` → **115/115** (the 109 pre-existing incl. Q1/Q2, M15–M18, E13/E14 + 6 new probe rows); full suite **1401/1401** | PASS |

**Q11b rewrite — deliberate and documented.** The card said "Q11b stays green"; its old body
asserted the DEFECT's impact ("discard fails LOUD under the store gap"), i.e. it asserted the
bug — with D1 fixed and acceptance 3 requiring resolves to SUCCEED, the old body cannot pass.
It is rewritten as the post-fix regression guard over the SAME scenario (this is recorded in
the file docstring and per-test comments). The loud failed-resolve path remains covered by
`sync-conflicts.test.tsx` "a failed resolve reports loudly and leaves the conflict pending"
(genuinely-absent row), which stays green.

### E8-UI-D5

| # | Acceptance | Evidence | Result |
|---|---|---|---|
| 1 | Unit tests prove the probe request URL = configured base (not `/`/origin root), incl. deep path | `tests/unit/sync/webdav.test.ts` "probe() contacts the CONFIGURED base URL": constructed URL asserted EXACTLY (`https://dav.test/remote.php/dav/files/alice/todo/` === `client.baseUrl`, pathname exact, `!== https://dav.test[/]`), trailing-slash normalization, `url('')` semantics, method `PROPFIND` + `Depth: 0` + `Authorization` | PASS (6 new rows) |
| 2 | Dead configured path FAILS setup; wrong creds FAIL setup with the auth error attributed correctly | `tests/component/sync-setup-wizard.test.tsx` new "a dead configured path FAILS the connection test" (copy "The storage folder is missing", NOT the CORS copy, rollback, probe hit the typed path) + strengthened "wrong credentials" ("Sign-in rejected", NOT "The browser blocked the request"); unit rows prove `404 → REMOTE_MISSING` / `401 → AUTH` against a path- and auth-sensitive fake | PASS |
| 3 | Real-browser re-probe: server-side request log shows the TYPED PATH on the probe | §4 below — `docs/qa/e8-ui-d1-d5-fix-logs/qa-e8-fix-dav-requests.jsonl` (server-side, `PROPFIND /dav/deep/nested/coll/`) + `qa-e8-fix-browser.log` 14/14 | PASS |
| 4 | Q10/Q11a as regular tests + all sync suites green | As D1 #1/#4 | PASS |

## 4. Real-browser re-probe (Chromium 1248, BUILT app at `f138230`, fake WebDAV host)

Method: `qa-e8-fix-dav.mjs` serves `dist/` + a WebDAV double whose behavior is deliberately
realistic where the E8 QA double was not — `OPTIONS` answered **pre-auth** on every path (the
CORS-preflight reality that made the old probe auth-blind), everything else **Basic-auth
checked**, `PROPFIND` **path-sensitive** (207 = known collection, 404 = dead). EVERY request
logged server-side (JSONL). `qa-e8-fix-probe.mjs` drives the real setup wizard (three fresh
browser profiles) and asserts against the SERVER log, not the client's claims.

| Check | Result |
|---|---|
| A1 setup COMPLETES for valid credentials on the deep typed path `/dav/deep/nested/coll/` | PASS |
| A2 the probe request hits the TYPED PATH `/dav/deep/nested/coll/` | PASS |
| A3 the origin root is only ever loaded as the app shell — the setup phase makes exactly ONE engine request: `PROPFIND` on the typed path | PASS |
| A4 "Sync now" runs against the same configured base (`/dav/deep/nested/coll/todo-sync/…`) | PASS |
| A5 status surface shows `Last synced:` after the run | PASS |
| A6 zero CSP violations from the probe/run traffic | PASS |
| B1 a dead configured path FAILS setup | PASS |
| B2 the error names the MISSING folder ("The storage folder is missing") | PASS |
| B3 the failure is NOT misattributed to CORS | PASS |
| B4 the TYPED dead path WAS contacted by the probe (log evidence) | PASS |
| C1 wrong credentials FAIL setup (rolled back) | PASS |
| C2 the 401 is attributed to the SIGN-IN ("Sign-in rejected") | PASS |
| C3 the 401 is NOT misattributed to CORS | PASS |
| C4 the probe hit the TYPED PATH with the WRONG credentials (401) | PASS |

Server-side log extract (the E8-UI-D5 acceptance artifact — full log committed alongside):

```json
{"t":"2026-10-26T01:59:31.431Z","method":"PROPFIND","path":"/dav/deep/nested/coll/","authorization":"valid"}
{"t":"2026-10-26T01:59:31.497Z","method":"PROPFIND","path":"/dav/deep/nested/coll/","authorization":"valid"}
{"t":"2026-10-26T01:59:31.499Z","method":"MKCOL","path":"/dav/deep/nested/coll/todo-sync","authorization":"valid"}
...
{"t":"2026-10-26T01:59:34.231Z","method":"PROPFIND","path":"/dav/dead/path/","authorization":"valid"}
{"t":"2026-10-26T01:59:34.481Z","method":"PROPFIND","path":"/dav/deep/nested/coll/","authorization":"wrong"}
```

The pre-fix log for the same journey showed `OPTIONS /` (the QA's `runProbeRoot`); the probe
now contacts the typed path, and setup fails for dead paths and wrong credentials.

## 5. Gate battery (clean worktree at `f138230`, /tmp/e8-fix-verify)

| Gate | Result |
|---|---|
| `npm test` (full) | **1401 passed / 131 files** (0 failures, 0 expected-fail — the D1 markers are gone) |
| `npm run lint` | 0 |
| `npm run typecheck` | 0 |
| `npm run format:check` | PASS |
| `npm run i18n:check` | PASS (en/th consistent) |
| `npm run build` | 0 |
| `npm run budget` | PASS (all 7 gates; locales 22.3/24.0 KB) |
| `npm run test:coverage` | PASS — no threshold errors (all files 84.25 stmts / 78.2 branches / 83.2 funcs / 86.61 lines) |
| Coverage `src/sync` (sync-scope run) | 87.92 stmts / 80.4 branches / 90.51 funcs / 90.89 lines — floor holds (Addendum B baseline was 87.61/79.88/89.78/90.57; improved) |

Shared-tree note (attribution): the sibling cards' UNCOMMITTED WIP leaves `npm test`, lint and
typecheck red in `/home/ubuntu/workspace/browser-todo-app` — `tests/unit/crypto/e10-qa-probes.test.ts`
Q6 (untracked E10 QA WIP; reproduced identically on a clean HEAD worktree without any of this
card's changes) and the recurrence WIP (`src/domain/pipeline.ts`, `src/features/tasks/*`,
`tests/unit/domain/*` FakeTaskPort fakes). None of these files are in this card's scope or
commits; the clean-worktree battery above is the authoritative gate record.

## 6. Changed files (this card)

- `src/sync/webdav.ts` — `url('')` root-cause fix + `PROPFIND Depth: 0` probe (E8-UI-D5)
- `src/sync/engine.ts` — `notifyDataReplaced()` at the committed sync-apply seam (E8-UI-D1)
- `tests/unit/sync/webdav.test.ts` — 6 new probe rows (URL construction, dead path, auth)
- `tests/unit/sync/fixtures.ts` — path-sensitive `hidePath` + auth-sensitive `faults.auth`
  (`OPTIONS` stays pre-auth, like real servers)
- `tests/unit/sync/engine-api.test.ts` — P2 pinned to the Addendum C protocol
- `tests/component/sync-setup-wizard.test.tsx` — protocol assertions updated (OPTIONS→PROPFIND,
  comments cite Addendum C) + new dead-path setup test
- `tests/component/e8-sync-ui-qa.test.tsx` — Q1/Q2 protocol literals updated (assertions'
  intent — "the setup probe and nothing else" — unchanged)
- `tests/component/e8-sync-ui-storegap.test.tsx` — Q10/Q11a flipped (bodies verbatim),
  Q11b rewritten to the post-fix contract, Q11c/Q11d added
- `docs/adr/ADR-006-webdav-sync.md` — Addendum C + Links
- `docs/qa/e8-ui-d1-d5-fix.md` + `docs/qa/e8-ui-d1-d5-fix-logs/` — this report + evidence

## 7. Evidence inventory (`docs/qa/e8-ui-d1-d5-fix-logs/`)

- `qa-e8-fix-dav-requests.jsonl` — SERVER-SIDE request log (the E8-UI-D5 acceptance artifact:
  the typed path on the probe)
- `qa-e8-fix-browser.log` — real-Chromium probe run (14/14)
- `qa-e8-fix-evidence.jsonl` — per-check records incl. the captured request lists
- `qa-e8-fix-dav.mjs` — fake WebDAV host (pre-auth OPTIONS, auth-checked verbs, path-sensitive
  PROPFIND) + app static serving
- `qa-e8-fix-probe.mjs` — the 14-check real-browser driver
