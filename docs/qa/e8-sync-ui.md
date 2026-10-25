# [E8] QA — Sync UI flows & opt-in boundary (t_98a1b4a5)

**Card:** `[E8] Test: Sync UI flows & opt-in boundary` (epic t_15e14284, impl parent t_5f4fe7db)
**Tester:** h_reviewer · **Date:** 2026-10-26
**State under test:** `ad4acc3` (the sync-UI delivery commit 0bdec3d + budget fix ad4acc3), measured on a clean
git worktree — plus a HEAD (`dce8f40`-region) re-verification of every finding, because sibling cards landed
fixes mid-test (see §5).
**Method:** independent component probes (13 checks, `tests/component/e8-sync-ui-{qa,storegap}.test.tsx`) +
real-Chromium browser probe against the **built app** (79 checks, run twice, stable `79/79`) over a
same-origin WebDAV double + a cross-origin mock, all keyboard-driven + code forensics.
**Evidence:** `docs/qa/e8-sync-ui-logs/` (25 files: browser logs ×3, per-check evidence JSONL, dav/mock request
logs, gate logs, diagnostic scripts).

---

## 1. Verdict summary

| Card scenario | Result | Where |
|---|---|---|
| Setup wizard: valid credentials | PASS (probe-only, no surprise run; status surface appears) | Browser D7–D12 |
| Setup wizard: wrong credentials | **FAIL — connection test inaccurate (E8-UI-D5)**; wrong creds accepted at setup; 401 only surfaces at first run | Browser C2–C8 |
| Setup wizard: unreachable server | PASS — graceful copy, rollback, announced, base path untouched | Browser B0–B5 |
| Connection test accurate | **FAIL (E8-UI-D5, open)** — probe OPTIONSes the origin root, not the configured base; never validates path or credentials | Browser B4/C4/D9 + `webdav.ts:141-145,222` |
| Manual trigger (`Sync now`) | PASS — real PROPFIND/PUT/GET read-back on the configured base; idle + `Last synced:` + polite "Sync finished" | Browser F0–F5 |
| Periodic-when-online | PASS — online event runs only while the surface toggle is ON; toggle keyboard-operable, zero surprise traffic | jsdom Q4 (impl+mine), Browser H1–H2 |
| Status surface (idle/syncing/last-synced/error) + live regions | PASS — polite on start/finish/enabled/forgotten, assertive on every failure transition | Browser C7/D8/F2–F3/G1–G4/I3, jsdom 10/10 |
| Conflict surfacing + 3 resolve actions vs engine fixtures | PASS at component level (engine fixtures): surface-all, keep-both ack, keep-copy, discard-copy, loud-fail-pending — incl. new Q11b under the store gap | impl 5/5 + Q11b |
| Offline attempt → clear error + local data untouched | PASS — visible error box, assertive "Sync failed…", ZERO requests during offline, row intact ×1 after recovery | Browser G1–G5 |
| **Opt-in boundary: ZERO requests before setup** | **PASS** — zero non-app-origin AND zero WebDAV-host requests across boot, navigation, typing, step nav, Back, insecure refusal; only submit-time traffic | Browser A1–A10, D11, Z1; jsdom fetch recorder |
| Keyboard-only pass (wizard + resolve + status) | PASS — every flow driven by Tab/Enter/Space only; tab sequences recorded in evidence JSONL | Browser A3–A9, B–J |
| Sync apply → running store visibility | **FAIL (E8-UI-D1, open)** — pulled rows & conflict copies invisible until reload | Q10/Q11a (it.fails) + forensics |

**Blocking findings open at HEAD: E8-UI-D1, E8-UI-D5.** Three findings raised at `ad4acc3` were fixed by
sibling cards during this test and re-verified here (E8-UI-D2, D3, D4).

---

## 2. Per-scenario evidence

### 2.1 Setup wizard (browser, keyboard-only, built app)

- **A3–A10 (boundary + navigation):** Tab reaches `#sync-url` (sequence in JSONL); insecure URL
  `http://evil.example/` refused locally with the HTTPS copy and **zero requests** (A4/A6); Enter advances to
  step 2 with `aria-current="step"` + polite "Step 2 of 2: Sign-in details" (A7); Back returns focus to the URL
  field (A8/A9); across the whole pre-submit interaction: **0 requests to any non-app origin and 0 WebDAV
  requests** (A10). URL replacement verified by read-back at every retyping (A7a/B0/C0/D2b/J2b).
- **B (unreachable):** root-dead flag destroys the socket at the probe target → error box with the
  CORS/network-honest copy ("The browser blocked the request … may also be unreachable or mistyped"), rollback
  (still unconfigured), assertive "Sync failed: …", configured base path never contacted (B0–B5).
- **C (wrong credentials — defect evidence):** setup **ACCEPTED** wrong credentials (`/dav-bad/` got ZERO
  requests during setup — the probe only ever hit the origin root), "Sync enabled" announced; the 401 surfaces
  at the first `Sync now` as error-box "Sign-in rejected" + assertive announcement + an "Enter credentials
  again" re-entry affordance (C2–C8).
- **D (re-entry + valid setup):** "Enter credentials again" prefills address + user, password NEVER read back
  (D1–D5), field masked `type=password` (D6), one single root-OPTIONS probe, no surprise run, status line
  "Not synced yet", polite "Sync enabled" (D7–D12).
- **I (forget):** toolbar Forget wipes address + user from the device (wizard re-emptied), announced politely
  "Sync off — credentials removed"; password never readable on ANY re-entry (I1–I6).

### 2.2 Status surface, manual run, offline, recovery (browser)

- **F:** keyboard reaches `Sync now`; run performs real WebDAV (`PROPFIND` discovery + `MKCOL` layout +
  `PUT` batch + byte-identical `GET` read-back) on the configured base `/dav/todo-sync/…`; status line
  → `Last synced:`; polite "Sync finished" (F0–F5). The run's own capability phase repeats the root probe
  (E8-UI-D5 affects runs too; recorded in `runProbeRoot`).
- **G:** `context.setOffline(true)` → `Sync now` → visible error box + assertive "Sync failed: …" +
  **ZERO requests** during the offline attempt; going online → manual retry clears the error and restores
  `Last synced:`; the local task row is intact exactly once afterwards (G1–G5).
- **H:** auto-sync checkbox flips by Space alone, zero sync traffic from toggling (H1–H2).
- jsdom complements: impl suites (8+10+5+4) + my Q1–Q9/Q11b: recovery after failed probe, double-submit
  single-probe guard, online-event gating, error→retry transition announcements, hostile conflict title
  rendered as text, password never in live regions, autoSync persisted→unchecked.

### 2.3 Conflicts (component, engine fixtures)

- impl `sync-conflicts.test.tsx` 5/5 (keep-both / keep-copy / discard-copy / surface-all / failed-resolve
  loud+pending) re-run green.
- **New Q11b** (production wiring: real `boot()` + `startTaskStore()` + `wireDataReplacedRefresh()` exactly as
  `main.tsx`): the conflict surfaces from engine state even while the store gap exists; **discard fails LOUDLY
  ("The conflict could not be resolved"), conflict stays pending, row untouched (no silent loss)**; keep-both
  acks and clears. Q11a/Q10 (it.fails) document the E8-UI-D1 expectation.

### 2.4 Opt-in boundary — the zero-request assertion

Three independent layers, all zero:

1. **Browser network log:** `page.on('request')` — zero requests to any origin other than the app across the
   entire session except the user-initiated cross-origin CSP probe (which is blocked pre-network anyway →
   `Z1: zero cross-origin requests for the ENTIRE session`); dav/mock server JSONL logs are empty until the
   first submit.
2. **Server-side:** the WebDAV double logs EVERY request; log is empty through boot + route + typing + step
   nav + refusals (A2/A6/A10), then exactly one `OPTIONS` per submit (B4, D9).
3. **jsdom:** impl wizard suite asserts `rig.fake.state.requests.length === 0` for form fill/step nav/Back and
   a production-path global fetch recorder asserts 0 fetch calls across boot+render+configure; my Q6 replays
   the whole pre-submit surface against a rejecting global fetch — 0 calls.

---

## 3. Defects

### E8-UI-D1 — sync apply never refreshes the running task store (OPEN at HEAD, blocking)

- **Impact:** after a run PULLS a remote row or materializes `"Conflict copy of <task>"`, the row exists in
  IndexedDB but the running store state never learns about it → **invisible in the task list until a full page
  reload** (§6.2 requires conflict copies to be *visible*; a pull that never surfaces is indistinguishable from
  broken sync). Under this gap, `keep-copy`/`discard-copy` resolve actions fail `TASK_MISSING` until reload —
  loud, pending, no data loss (Q11b), i.e. resolution is *blocked*, not corrupted. This is E3's F1 finding
  (`t_85e19c39`) recurring at the sync seam.
- **Root cause:** `notifyDataReplaced()` is fired only from `src/portability/{import,export}.ts`;
  `src/sync/engine.ts` commits with its own `db.tx` and never fires it; `bootSyncEngine()`
  (`src/features/sync/syncHost.ts`) wires no store refresh; `SyncPanel` only renders engine state.
- **Evidence:** `tests/component/e8-sync-ui-storegap.test.tsx` Q10 + Q11a are `it.fails` markers — they are
  green-as-expected at HEAD (`11 passed | 2 expected fail`), i.e. still open; Q11b records the impact path.
- **Owner:** sync-UI impl / E8 epic (one-line candidate: fire the existing `notifyDataReplaced()` seam from the
  engine's post-commit side effects — the decision belongs to the author/ADR owner).

### E8-UI-D5 — connection test probes the ORIGIN ROOT, not the configured WebDAV path (OPEN at HEAD, blocking)

- **Impact:** `WebDavClient.probe()` is the only caller of `url('')`; `url('')` builds
  `new URL('/', base)` → absolute-path reference → **origin root** (`webdav.ts:141-145`, probe at
  `webdav.ts:222`, engine `state.ts` runSync phase 'probe' repeats it every run). Consequences proven in the
  browser:
  - **False positive:** a *dead* configured path passed the test because the root answered 200 — setup
    reported "Sync enabled" against an unreachable target (server log: `OPTIONS /`, typed path never hit);
  - **Wrong credentials accepted at setup** (C2/C4) — the test can never validate auth, so "Test connection &
    enable" is inaccurate; wrong creds only fail at the first real run;
  - **False negative risk in production:** a healthy Nextcloud under
    `/remote.php/dav/files/<user>/` is judged by whatever its *root* answers to `OPTIONS` (incl. CORS), not by
    the WebDAV endpoint the user configured.
- **Why the impl tests missed it:** the fake WebDAV answers per-transport, not per-URL-path, so path confusion
  is invisible in jsdom.
- **Status:** `src/sync/webdav.ts` is byte-identical `ad4acc3..HEAD` → **open at HEAD**.
- **Owner:** engine / ADR-006 card (fix in `url()` or build the probe URL against the base path; add a
  path-sensitive fixture to the fake).

### E8-UI-D2 — swept delete-confirm copy left the delivery commit red (FIXED at HEAD by 339cf6c)

- At `ad4acc3`: locale sweep in the sync card's commits carried a sibling's WIP copy
  (`"…You can undo this for 10 seconds."` with no undo implementation anywhere in `src/`) and left two
  committed tests asserting the old copy → `npm test` RED at the delivery commit:
  `core-ui-composer.test.tsx` "deletes through the S7.1 confirm" + `e2-core-ui-qa.test.tsx` "Escape cancels…"
  (both PASS at parent `9ee9669`, FAIL at `ad4acc3` — attribution by checkout, logs
  `e8ui-g-final-full.log` / `e8ui-probes-run3.log`). Dishonest copy until an undo feature exists.
- **Fixed:** `339cf6c` restored `"…This can't be undone."`; re-verified here: both files 39/39 green at HEAD.

### E8-UI-D3 — wizard local-validation failures not announced (FIXED at HEAD by 339cf6c)

- At `ad4acc3`, insecure-URL refusal and empty-password guard rendered the error box but never called
  `announce()` — contradicting the component's own docstring ("step changes + outcomes go through
  announce()") and SyncPanel's "assertive for failures" contract. Evidence: browser A5 (assertive + polite
  both empty at refusal) + jsdom Q3a/Q3b (were `it.fails`).
- **Fixed:** `339cf6c` (review round-1 finding B1) announces both paths; Q3a/Q3b are now unmarked regression
  guards — **11 passed + 2 expected-fail at HEAD** (the 2 remaining = D1 markers).

### E8-UI-D4 — shipped CSP `connect-src 'self'` blocked ALL cross-origin sync (FIXED at HEAD — ADR-006 Addendum A)

- At `ad4acc3`, the built app's CSP refused every fetch to the configured host:
  `securitypolicyviolation` events (`directive: connect-src`, blockedURI = the mock), console
  *"Refused to connect because it violates the document's Content Security Policy"*, healthy mock received
  **zero** requests while the wizard reported the server unreachable (browser J1–J4 +
  `qa-e8-cspdiag.mjs`/`qa-e8-fetchdiag.mjs` outputs captured in this session). Feature-dead in production
  builds; jsdom never sees CSP, which is why 27/27 impl tests were green.
- **Fixed during this test:** `c2bc820` ADR-006 Addendum A widened the policy to
  `connect-src 'self' https: http://localhost:* http://127.0.0.1:*` (independent card t_11670709, report
  `docs/qa/e8-csp-connect-src.md`, full CI green at `1b047ee`). Re-verified from HEAD's `index.html` here.
- **Residual (informational):** plain-HTTP non-localhost origins (e.g. `http://192.168.x.x/` LAN Nextcloud)
  remain blocked — deliberate per Addendum A; called out so the limitation stays visible.

---

## 4. Gate battery (clean worktree at ad4acc3) + coverage

| Gate | Result |
|---|---|
| `npm run lint` | **0** (exit 0; also 0 with QA probes present) |
| `npm run typecheck` | **0** |
| `npm run i18n:check` | **PASS** (540/540 en/th) |
| `npm run budget` | **PASS** (all 7 gates; locales 20.0/20.0 KB) |
| `npm run build` | **0** (preview serves the probe) |
| `npm run format:check` | RED on **exactly 2 pre-existing files** (`src/domain/model.ts`, `vite.config.ts` = known E8-D2 from `fed96f5`; NOT sync-UI scope; green again at HEAD per 1b047ee CI) |
| `npm test` (full) | **2 failed \| 1246 passed \| 6 expected fail (1254)** — the 2 = E8-UI-D2 pair (fixed at HEAD); the 6 = 4 documented D1/D3 defect markers + 2 pre-existing expected-fails |
| Sync UI component suites (impl 4 + QA 2) | **36 passed + 4 expected-fail (40)** |
| Coverage `src/features/sync/**` (6 suites) | **94.76 stmts / 94.73 branches / 100 funcs / 94.87 lines** (floor 80; SetupWizard 88.88/94.11 after QA probes, SyncPanel 98.73/93.1, syncHost 94.28/100; uncovered = 2 defensive catches + SyncPanel:180) |
| Browser probe (built app) | **79/79, twice** (`e8ui-browser-final-1/2.log`) |
| QA probes at HEAD (shared tree) | **11 passed + 2 expected-fail**, eslint 0, prettier clean |

Load notes: two full-suite entries (`data-safety-ux` quota, `e2-qa-probes` 10k benchmark) fail only under
concurrent load and pass isolated — pre-existing flake pattern, not sync-UI.

---

## 5. Observations (non-blocking)

1. **Offline/CSP errors surface the CORS-honest copy** ("The browser blocked the request … missing
   Access-Control-Allow-Origin … may also be unreachable"): honest-but-noisy — an offline attempt is
   attributed to CORS/server config. The detail line hedges ("may also be unreachable"); consider an
   `navigator.onLine` fast-path copy.
2. **Intermittent automation-only focus loss while typing the wizard password** (observed 2 of 7 browser runs;
   single char landed, rest dropped; not reproducible by hand, probe hardened with read-back retries).
   Needs human keyboard confirmation before anyone treats it as a product defect.
3. **Announcement ordering under load:** after first list creation the polite region showed "View: Today"
   rather than "List created: QA sync" at observation time (E4c), same family as E2's known F-1 announce-race.
   Creation itself verified by DOM.
4. `runSync` repeats the root-OPTIONS probe on every run (same E8-UI-D5 root), visible in F's `runProbeRoot`.

---

## 6. Residual gaps (not covered here)

- **Browser-level conflict surfacing** was not driven end-to-end (needs a two-device fixture over HTTP);
  covered at component level against real engine fixtures (impl 5/5 + Q11a/Q11b). If the epic wants a
  Playwright conflict journey, that is a follow-up card.
- Visual/axe/WCAG audit of the wizard = Review card (t_7567495e) scope; CSP A/B evidence =
  `docs/qa/e8-csp-connect-src.md`.
- Human screen-reader pass (NVDA/VoiceOver) remains the M13 release gate; this card verifies the
  programmatic live-region contract only.

---

## 7. Evidence inventory (`docs/qa/e8-sync-ui-logs/`)

- `e8ui-browser-final-1.log`, `e8ui-browser-final-2.log` — the two stable 79/79 browser runs.
- `browser-evidence.jsonl` — per-check records (incl. A5/E4c observations, tab sequences, probe targets).
- `qa-e8-browser-probe.mjs` — the 79-check browser probe; `qa-e8-preview-dav.mjs` (same-origin preview+WebDAV
  double, root-dead flag), `qa-e8-mock-webdav.mjs` (cross-origin mock + request log).
- `qa-e8-cspdiag.mjs`, `qa-e8-fetchdiag.mjs`, `qa-e8-submitdiag.mjs`, `qa-e8-bdiag.mjs` — diagnostics that
  pinned D4 (CSP), D5 (probe URL + fetch trace) and the wizard-state traces.
- `e8ui-g-final-{lint,tsc,i18n,fmt,full}.log` — gate battery at ad4acc3.
- `e8ui-cov-final.log` — scoped coverage; `e8ui-probes-run3.log` — first defect-attribution run;
  `e8ui-gates.log`, `e8ui-cov.log` — attempt-1 baseline.
- Component probes committed as `tests/component/e8-sync-ui-qa.test.tsx` (Q1–Q9) and
  `tests/component/e8-sync-ui-storegap.test.tsx` (Q10/Q11a = D1 `it.fails` markers, Q11b = impact record).
