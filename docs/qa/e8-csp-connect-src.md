# E8 — CSP `connect-src` decision & real-browser verification (t_11670709)

Date: 2026-10-26 · Owner: h_senior_coder · Raised by: sync-UI review t_7567495e (finding B2) ·
Re-review: t_9114bd20 (R2) · Decision record: **ADR-006 Addendum A** (Accepted).

## 1. Decision

**Option A — ship the feature and widen the policy.** `connect-src` goes from `'self'` to

```
connect-src 'self' https: http://localhost:* http://127.0.0.1:*
```

Invariant: **the shipped CSP is never narrower than the engine's own allow-list**
(`src/sync/webdav.ts` `assertSecureRemote`: any https host; plain-HTTP `localhost`/`127.0.0.1`
for development — the same list the wizard copy `sync.error.config.body` promises). Never wider:
plain-HTTP egress to non-loopback hosts stays blocked. `upgrade-insecure-requests` evaluated and
rejected (the engine refuses insecure URLs with an explicit error instead of silently rewriting
them). Rationale, alternatives table and consequences: ADR-006 Addendum A. Documentation trail:
`index.html` CSP comment (exception 2), README "CSP and the documented exceptions", PROJECT_ANALYSIS
§7.2 amendment note, ADR-001 §8 row + ADR-005 two backstop rows, `docs/dev/sync-engine-api.md` §3
"CSP precondition" note.

## 2. Real-browser A/B verification (Chromium, built `dist`, 2026-10-26)

Method: the built `dist` served twice — **FIXED** (shipped policy) and **CONTROL** (byte-identical
dist with `connect-src 'self'` restored in the meta tag) — plus a fake WebDAV host on loopback
(any port is a cross-origin origin for the app) answering CORS preflight + the engine's OPTIONS
probe. Full log: `e8-csp-connect-src-logs/probe-run.json`.

| Probe | FIXED (new policy) | CONTROL (old policy) |
|---|---|---|
| Control: same-origin `./manifest.webmanifest` | 200 | 200 |
| Page fetch, external **https** origin (`no-cors`) | `resolved:opaque`, request seen by browser, **0 violations** | `rejected:TypeError`, request never left the browser, violation `connect-src blocked=https://example.com/` |
| Page fetch, **plain-http** external | rejected + exactly 1 violation `connect-src blocked=http://example.com/` (tightness holds) | rejected + same violation |
| Sync wizard "Test connection & enable" → fake WebDAV host (cross-origin) | **SUCCESS** — status surface ("Sync now"); host saw preflight `OPTIONS` then authed `OPTIONS` with `Authorization` (the engine's probe) | **FAILURE box** = the B2 misattribution verbatim: "The browser blocked the request / The storage server must allow this app's origin (Nextcloud: Access-Control-Allow-Origin)…"; violation `connect-src blocked=http://127.0.0.1:<dav-port>/`; host saw **0 requests** |
| CSP violation listener liveness | fires for the deliberate plain-http probe (1 event) | fires 3 events — listener demonstrably live |

The CONTROL column reproduces defect B2 first-hand (including the misleading copy), and the FIXED
column meets AC3 in full: CSP layer open, external https no longer violation-blocked, and the
**wizard probe completes against a fake WebDAV host served cross-origin**.

## 3. Committed regression guard (why this cannot regress silently)

`tests/e2e/smoke.spec.ts` (runs in the `e2e-smoke` CI job):

1. *the document ships the section 7.2 CSP meta tag…* now pins the `connect-src` directive value
   **exactly** — any widening or narrowing fails the suite.
2. *connect-src admits a user-provided WebDAV origin and still blocks plain-HTTP egress* — real
   browser against the built artifact: loopback fake host receives a WebDAV-style `PROPFIND`
   (Basic auth + `Depth`, i.e. preflighted) with zero violations; plain-HTTP external fetch is
   refused with exactly one `connect-src` violation (negative control proving the listener is
   live and the policy is still tight). Loopback only — the test never touches an external
   network.

Green evidence: `E2E_PORT=4517 npx playwright test --project=chromium tests/e2e/smoke.spec.ts`
→ **9/9 passed** (including both guards). Sensitivity: the guard's assertions are exactly the
PROBE rows above, whose CONTROL column fails them.

## 4. Gate battery (clean worktree at 69dc2bc, node_modules symlinked)

| Gate | Result |
|---|---|
| `format:check` | PASS |
| `lint` | PASS (one `no-unnecessary-type-conversion` found in the new spec on first run, fixed in 69dc2bc) |
| `typecheck` | PASS |
| `i18n:check` | PASS (en/th consistent — no locale bytes touched; budget headroom untouched) |
| `test:coverage` | 1293 passed / 4 expected-fail / **3 load-flake failures** — see note below |
| `build` | PASS |
| `budget` | PASS — **`no-external-refs` 0 hits over 13 shipped files**, i.e. the CSP edit does not trip the gate; its new loopback allow-list entry is unit-tested both ways (`tests/unit/bundle-budget.test.ts` 15/15: CSP meta passes, `http://cdn.example.com/` still FAILs) |

*Load-flake note:* the 3 first-run failures (and a different set of 6 on a second run) are timing
budgets (`repos-e7` sweep < 60 s, `e2-qa-probes` search/boot budgets, `core-ui-virtual`
window-math, plus two component tests) on a host shared with concurrently running sibling workers.
Every one of them re-run green in isolation (`repos-e7` 8/8; `app/core-ui-search/core-ui-virtual/
e2-qa-probes` 56/56), the failing set differs run-to-run, and none touches this change's blast
radius (index.html, `bundle-budgets.json`, one unit test file, smoke e2e, docs).

## 5. Files (commit 81fc501 + lint follow-up 69dc2bc)

- `index.html` — policy + documented exception 2 (no literal `http(s)://` in the comment, so the
  dist scanner stays quiet)
- `scripts/bundle-budgets.json` + `tests/unit/bundle-budget.test.ts` — `no-external-refs` loopback
  policy-text allow-list + 2 new unit cases
- `tests/e2e/smoke.spec.ts` — exact `connect-src` pin + cross-origin PROPFIND guard
- `docs/adr/ADR-006-webdav-sync.md` (Addendum A), `docs/adr/ADR-001-ui-framework.md`,
  `docs/adr/ADR-005-service-worker.md`, `PROJECT_ANALYSIS.md` §7.2 amendment, `README.md`,
  `docs/dev/sync-engine-api.md`

## 6. Process note (shared-tree hazard, for the orchestrator)

A `git commit --amend` racing a sibling's `git commit` on the shared `main` swept a one-line lint
fix into the sibling's commit (t_ed1fa949's 99cc305 → amended 2d9d774). Repaired via plumbing the
same minute: 99cc305 restored byte-identical (it is back in history as-is) and the lint fix
re-homed as its own commit 69dc2bc. Lesson for the board: on a shared branch, `--amend` is only
safe with an explicit `git rev-parse HEAD` guard immediately before; prefer follow-up commits.
