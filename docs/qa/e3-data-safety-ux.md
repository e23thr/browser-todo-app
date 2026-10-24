# E3 Data-safety UX — QA report (test card t_b1595f03)

Tested by: h_reviewer
Tested at: 2026-10-25 00:24 (UTC+07)
Tree state: HEAD `b747c8e` + uncommitted review-rework diff (`git diff` sha256 `0520c7d6…`)
(the E3 UX rework from review round 1 — card t_f5453962 — was mid-flight in this shared
tree while this pass ran; every measurement below is pinned to that exact tree state)

Binding refs: PROJECT_ANALYSIS.md §5.5 / §7.4 / §10 (E1/E2/E3/E10), §11 (R1/R2);
docs/design/data-safety.md (BINDING); docs/dev/data-safety-api.md (parent handoff);
ADR-004 Decision 5.5 / 8 / 10; review round 1 evidence in docs/qa/e3-data-safety-ux-review.md.

## VERDICT: PASS — the R1/R2 defence surface behaves as designed; 1 open product defect (D1,
## 2 rework-in-flight test breakages (D4), 1 process nit (D5). No data-loss path is silently
## dropped.

Deliverables of this card:

- `tests/component/data-safety-ux-qa.test.tsx` — 40 scripted scenarios (jsdom, mocked
  StorageManager states + real ADR-004 engine on fake-indexeddb): 39 pass + 1 expected-fail
  (that expected-fail IS the D1 defect evidence).
- `tests/e2e/data-safety-ux.spec.ts` + `tests/e2e/data-safety-ux/{harness.tsx,css.d.ts,
  index.html,vite.config.mjs}` — REAL-browser pass (real Chromium `StorageManager`, real
  IndexedDB, real key events): 5/5.
- Evidence logs: `docs/qa/e3-data-safety-ux-logs/{qa-suite.log,e2e-real-storage.log,gates.log}`.

## Gates (pinned tree state above)

| Gate | Result |
|---|---|
| `npx tsc -b` | EXIT 0 |
| `node scripts/check-i18n.mjs` | PASS (en/th key sets, values, placeholders consistent) |
| `npx eslint <this card's files> --max-warnings 0` | EXIT 0 |
| `npx vitest run tests/component/data-safety-ux-qa.test.tsx` | 39 passed + 1 expected fail (40) |
| `npx playwright test --config playwright.data-safety.config.ts tests/e2e/data-safety-ux.spec.ts` | 5 passed |
| Repo-wide `npx eslint .` | FAILS — only on E5's probe scripts + generated `coverage-e2b/` (D5, not this card's files) |
| Repo-wide `npx vitest run` | 739 passed / 3 failed / 1 expected fail — failures are D4 (rework-in-flight impl tests) + my S7 before its race fix; see Defects |

## Scenario evidence (card goal, one row each)

| # | Scenario (card goal) | Verdict | Evidence |
|---|---|---|---|
| S2 | Storage/backup panel values — quota bar + 80% warning, persistence granted/denied, lastBackupAt age, with MOCKED states | PASS | qa-suite S2 (7 tests): healthy estimate → "41 MB of ≈2 GB (2%)" + meter aria-valuenow; 80% warn tier text + `quota-warn` banner arms at exactly 80 and not at 79; 90% crit label; no StorageManager → unknown meter + "Storage details aren't available" + unsupported row; estimate() without total → indeterminate copy, never a fake number; persistence not-requested/denied/throw each render their own copy; age labels Never/Today/Yesterday/N days/N months; export+import+danger-zone always reachable |
| S2r | Same, with REAL StorageManager | PASS | e2e test 1: meter aria-valuenow equals `Math.round(usage/quota*100)` from the browser's OWN `navigator.storage.estimate()` (±1 for drift); visible value line carries the same %; e2e test 2: row truthfully reports real `persisted()` |
| S3 | `persist()` requested after first task created | PASS | qa-suite S3 (2): first successful `addTask` fires the gate exactly once (persist spy = 1); a FAILED first write does not; e2e test 3: against the REAL permission API — one `persist()` round trip, second write does not re-request, row shows the browser's real granted/denied answer (headless Chromium denies → banner + row both offer "Ask again") |
| S3n | Backup-reminder nudge fires at >14 days, NOT otherwise | PASS | qa-suite S3 nudge (4): 13d quiet, 14d fires, 400d fires; "never backed up" variant only when data exists; snooze = 7-day suppression (not permanent); clears after successful backup; e2e test 5: real-clock derivation — 13d quiet, 20d fires with the REAL calendar-day count, fresh backup clears |
| S4 | QuotaExceededError dialog on simulated full-quota write; write never silently dropped | PASS (with D1) | qa-suite S4 (3): production write path (MutationRunner over quota-failing ports) → blocking dialog with exactly the three §6.4 actions; Escape closes but the pending entry SURVIVES; retry-while-full keeps it; free space + retry lands the write and retires the entry (created = ['Buy milk']); two queued failures count up in dialog AND banner. D1: the Escape→T2-banner replacement is missing (see Defects) |
| S5 | Eviction/wipe detection (persisted() false + boot-validation wipe) incl. lastBackupAt surfacing | PASS | qa-suite S5 (5): wiped classification → recovery screen surfacing "Your last backup was 5 days ago" + the iOS rule + Restore action; "Start fresh" confirms inline, acks, and the SAME store is not re-flagged (classifyBoot → normal) while a store re-created AFTER the ack warns again; long-absence ≥7d banner interpolates lastBackupAt (and the never-backed-up variant); boundary 7 vs 6 days; >30% drop vs baseline raises the shrunken T2 with the 70% figure |
| S6 | Private-browsing warning at first write | PASS | qa-suite S6 (2): persist denied + private-looking quota (8 MB) → one-time dialog, copy honest ("may not be there next time"), Export + Got it actions, never re-opens; persist granted (even with small quota) → no warning |
| S1 | Onboarding copy present and honest, names the iOS 7-day rule, keys in both locales | PASS | qa-suite S1 (2): onboarding renders BEFORE any task UI, single CTA, durable `todo:prefs:v1:onboardingStep='done'` marker; the 7-day rule + "Your protection is backups." asserted verbatim in EN **and** TH; `check-i18n.mjs` confirms 140 `dataSafety.*` keys with identical en/th key+placeholder sets |
| S7 | Import confirm + pre-import snapshot undo path works | PASS | qa-suite S7 (2, real engine on fake-indexeddb): pick→validate→preview writes NOTHING (0 rows, 0 snapshots while dialog open); Cancel changes nothing; Confirm replaces atomically and stamps a `pre-import` snapshot; undo toast offers BOTH "Restore previous data" and "Download snapshot" (review B2); restore-confirm → previous data comes back (synced on DB state, not copy); an invalid file mutates nothing and always offers "Choose another file" |
| R | Review round-1 rework verified (B1 copy facts, B2 undo durability, B3 recovery offer, N4, N5) | PASS | qa-suite R (5): confirm dialog now carries all three binding ADR-004 D5.5 facts — settings-replacement truth, snapshot location + download, tombstone-resurrection caveat; pre-import rows show "kept for 7 days" only while protected + a download affordance (autos carry neither); whole-file NOTHING_TO_IMPORT reject shows the extended copy AND a "Download recovery file" toast with zero writes; N4 evicted-snapshot restore says "That snapshot is no longer available."; N5 busy lifecycle: `answerDialog(true)` keeps the dialog mounted until `closeDialog()`, cancel still drains at once |
| P | §8.4 retention protection (pre-import undo can't silently vanish) | PASS | qa-suite P (real engine): 2 protected pre-imports hold their slots inside the rolling 3 (survive 2 newer autos); a 3rd protected pushes out the OLDEST protected; past 7 days protection lapses and the row rolls out like any auto; constants match the UI promise exactly (7d × 2 protected × rolling 3) |
| K | Keyboard/a11y pass on every dialog | PASS | see matrix below — all 5 T3 kinds + busy states |

## Keyboard / a11y matrix (acceptance criterion 2)

Every T3 dialog kind driven through the shared `SafetyDialog` focus machinery (§5.6) in
jsdom, plus the quota dialog again with REAL key events in Chromium (e2e test 4).

| Contract | quota-exceeded | private-browsing | import-confirm | delete-all-confirm | restore-confirm |
|---|---|---|---|---|---|
| role=alertdialog + aria-modal + labelled/described ids resolve | PASS | PASS | PASS | PASS | PASS |
| Initial focus = safest action (never the destructive confirm) | PASS "Free up space" | PASS "Got it" | PASS "Cancel" | PASS "Export a backup first" | PASS "Cancel" |
| Tab trap (last→first) + Shift+Tab (first→last) | PASS | PASS | PASS | PASS | PASS |
| Escape = safe path (destructive confirm NEVER fires) | PASS (closes, write kept) | PASS (dismiss) | PASS (cancel) | PASS (no wipe) | PASS (no restore) |
| Backdrop/scrim click = same safe path | PASS | PASS | PASS | PASS | PASS |
| Focus returns to opener on close | PASS | PASS | PASS | PASS | PASS |
| REAL-browser keys (Tab wrap both ways, Escape, focus return) | PASS (e2e) | n/a | n/a | n/a | n/a |
| §5.6 busy: buttons disabled, aria-busy, focus moved to dialog, Escape/scrim INERT, role=status gerund | n/a | n/a | PASS "Importing…" | PASS "Deleting…" | PASS "Restoring…" |

## Defects

### D1 (OPEN, product, non-data-loss) — Escape on the quota dialog leaves no T2 "N changes waiting" banner (§6.4)

Design §6.4 verbatim: "Escaping the dialog (Escape / close): allowed, but a persistent T2
banner replaces it: '1 change is waiting to be saved.' with the same three actions."
Observed: the banner is absent until an UNRELATED derive trigger fires.

Root cause (verified): `src/features/data-safety/DataSafetyHost.tsx:177-179` — the derive
effect subscribes to `[state, quota, persistence]` but NOT to `pendingWrites`, and the
write-failure path (`pendingWrites.noteWriteFailure`) never calls `deriveBanners()`.

Severity: non-blocking for data safety (the pending write itself is never dropped — that is
tested and holds), but it hides the §6.4 promised "your change is waiting" reassurance at
the exact moment a user fears loss.

Evidence: `tests/component/data-safety-ux-qa.test.tsx` → S4 test
"D1 (defect evidence) — §6.4: Escape must leave the persistent T2 banner", kept as
`it.fails` so the suite stays green and turns RED (as a plain failure) the moment the fix
lands. Fix direction: include `pendingWrites` in the derive dependency (or call
`deriveBanners()` from `noteWriteFailure`).

### D4a/D4b (OPEN, rework-in-flight, test-only) — the uncommitted review rework broke two of the impl's own tests

These two failures exist ONLY with the rework diff applied (they pass at clean HEAD
`b8fcba1`); they are stale assertions, not product regressions — each behavior change is
verified correct by this card's R/K suites. Owner: rework card t_f5453962.

- D4a `tests/component/data-safety.test.tsx` → "is an alertdialog whose initial focus is
  the safe action" asserts the PRE-rework import-confirm copy ("…replaced by the backup."
  without the settings-replacement fact). The copy change is the B1 fix; update the string.
- D4b `tests/unit/data-safety/notices.test.ts` → "resolves the promise with the verdict and
  drains one at a time" expects `answerDialog(true)` to pop the queue immediately. The
  rework's §5.6 busy-state keeps the dialog mounted until `closeDialog()` (correct per
  design — verified by R-suite "N5 §5.6 busy lifecycle"); update the test to the new
  contract (assert busy=true, then closeDialog() → null).

### D2/D3 (CLOSED mid-flight) — wall-clock time bombs in the impl's banner tests

Found by this card at 2026-10-24 23:36 UTC+07: `tests/unit/data-safety/notices.test.ts`
("hides snoozed banners…") and `tests/component/data-safety-host.test.tsx` ("renders the
backup-reminder nudge…") pinned `NOW = Date.UTC(2026,9,23)` but drove production seams that
default to the REAL clock (`snoozeBanner` has no `now` seam; `deriveBanners()` defaults to
`Date.now()`), so both went red when the wall clock passed 2026-10-24 12:00 UTC — they had
passed during review round 1 on Oct 23. Fixed in commit `e11245f` (h_junior_coder, clock
pinned via `vi.useFakeTimers({toFake:['Date']})`) with the same root cause and trigger
timestamp independently identified; this pass re-verified both tests green at the pinned
tree state. Follow-up (non-blocking): `snoozeBanner(id, days)` still lacks a `now` seam —
the fake-timers fix contains it, but an injectable clock would remove the class.

### D5 (OPEN, process, repo-wide) — `npm run lint` is red for reasons outside src/ and tests/

`npx eslint . --max-warnings 0` fails only on (a) `docs/qa/e5-shell-logs/probes/*.mjs`
(E5 card's probe scripts use `console.log`; 18 errors), (b) generated `coverage-e2b/`
artifacts (istanbuls's scripts + not gitignored — `.gitignore` covers `coverage/` only).
Neither touches product code; both will fail the `ci` pipeline's `lint` step. Owner: E5
card / whoever owns `.gitignore`. This card's files pass the same rule set clean.

### Info (found & fixed here, no action needed)

- The S7 undo assertion originally synced on the undo-toast TEXT; the rework's persistent
  "Import complete…" toast from the first import satisfied it before the restore landed
  (flaky by design). Fixed in this card: sync on DB state, not copy.
- Real-browser bonus evidence: the persist-denied state surfaces "Ask again" in BOTH the T2
  banner and the persistence row (strict-mode collision in the e2e locator proved the
  duplication) — consistent with §6.5/§4.3, locator scoped to the "Keeping your data" region.
- `tests/component/zz-scratch.test.tsx` (scratch D1 root-cause probe from an interrupted
  earlier attempt of this card) removed; its finding is preserved as the D1 `it.fails` test.

## What this pass did NOT cover (honesty note)

- Real eviction (`navigator.storage.persist()` granted then browser evicts) cannot be
  forced in CI; wipe/eviction detection is covered via scripted boot classification (S5)
  and the engine drill suite (card t_f0702c05, docs/qa/e3-data-engine.md).
- Real quota exhaustion (actual `QuotaExceededError` from IndexedDB) is covered by the
  engine drills; the UX pass simulates it through the production MutationRunner seam (S4).
- The §8.3-vs-ADR-004 "does import replace theme/locale?" spec conflict is escalated to
  h_pm on epic card t_57b9ef8f; this pass verified the COPY states the CURRENT engine truth
  (it does), not which behavior is right.
