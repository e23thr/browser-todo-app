# Epic E9 (V1) — Review: archive/retention (S6), storage dashboard (S11), backup files (S10), Todo.txt/CSV importers (S12)

**Card:** t_8f8242cc · **Reviewer:** h_reviewer · **Date:** 2026-10-26 ·
**Reviewed commit:** `9ee9669` (the impl card's delivery, t_5166e154) ·
**Verdict:** **REQUEST_CHANGES (round 1)** — 3 blocking items; every other gate passes.

Scope reviewed: `src/portability/foreign/` (bridge + CSV/todo.txt converters),
`src/portability/fsa.ts`, `src/features/data-safety/{importFlow,actions,StoragePanel}`,
the S11 dashboard/restore surface, and the S6 absence.

---

## 1. Verdict summary

| # | Severity | Finding |
|---|---|---|
| **B1** | blocking (AC not met) | **S6 (archive + completed-history retention view, incl. the 10k retention numbers) was not implemented** — deferred with a documented resumption plan; the four engine files it needs are still uncommitted sibling work at review time. |
| **B2** | blocking (hostile-input AC) | **E9-Q2 — a valid JSON backup renamed `.txt` is routed to the todo.txt converter**: first-hand probe shows `accepted {lists:1, tasks:53, quarantined:0}` garbage instead of the JSON control's `{lists:1, tasks:0, quarantined:1}`. Confirming would REPLACE the profile with 53 garbage rows (undo snapshot exists, but preview shows counts only). |
| **B3** | blocking (hostile-input AC) | **E9-Q1 — a UTF-16LE Todo.txt/CSV (Notepad "Unicode") is accepted as mojibake**: first-hand probe shows `ok=true, accepted {lists:1, tasks:2}` of NUL-interleaved garbage instead of a clean `NOTHING_TO_IMPORT`/unreadable-source reject. |

Everything else in this card **passes** — including the four explicit checklist items
(§3) and the full gate battery re-run first-hand (§2). B2/B3 are small, local fixes at
the routing/encoding seam (`src/portability/foreign/index.ts`) and ride the same requeue
as B1; the QA card's `it.fails` pins (`docs/qa/e9-utilities.md` §8) plus this review's
probe (attached to the card) flip to `it()` as the fixes land.

**Severity rationale for B2/B3 (why blocking, not non-blocking):** the ADR-004
data-safety *envelope* does hold (preview gate, pre-import snapshot, source file
untouched — no silent loss), which is why the test card logged them non-blocking. They
still block *this* card because the impl's own acceptance criterion is "malformed
Todo.txt/CSV fixtures **rejected** without side effects", and the epic's binding rule is
that hostile-input rules apply to Todo.txt/CSV too: both inputs are accepted as garbage
rather than rejected, and a REPLACE import of a good profile by mojibake is a domain
correctness bug, not a cosmetic one. The fixes are ~10 lines each.

---

## 2. Automated gates — first-hand at `9ee9669`

Isolated worktree `/home/ubuntu/workspace/e9-verify-5166e154` @ `9ee9669` (clean but for
`node_modules`; logs in `docs/qa/e9-review-logs/`):

| Gate | Result |
|---|---|
| `npm run typecheck` | **PASS** (exit 0) |
| `npm run lint` (`eslint --max-warnings 0`) | **PASS** (exit 0) |
| `npm run i18n:check` | **PASS** (en/th parity incl. the 5 new S10/S12 keys) |
| `npx prettier --check` on every E9 file | **PASS** |
| `npm run test:coverage` | **PASS** — 111/111 files, **1212 passed + 2 expected fail**; statements **86.01%**, branches **80.09%** (domain 97.57/87.36; `portability/foreign` 91.2/84.23; `fsa` 87.8/72.41) |
| `npm run audit:gate` | **PASS** — 0 production vulnerabilities; lockfile untouched by this commit (no new runtime deps) |
| `npx playwright test tests/e2e/e9-utilities.spec.ts --project=chromium` | **PASS** — 5 passed / 1 skipped (the firefox/webkit-only spec), incl. FSA save (no download), failing-picker → download fallback with byte check, FSA open → preview, real filechooser CSV import, malformed-CSV zero-side-effects |
| `npm run build` + `npm run budget` | build PASS; budget `initial-js 76.6/100 KB`, `locales 19.8/20 KB` PASS; `no-external-refs` **FAIL (2 hits)** = the pre-existing sibling red (sync `url.hint` copy), fixed later at `ad4acc3` — **not E9** |
| `npm run format:check` | **FAIL** on `src/domain/model.ts` + `vite.config.ts` — pre-existing (X2), neither touched by `9ee9669` |

3-engine e2e (11 passed / 7 skipped / 0 failed) and the 42-probe hostile-input battery
were run first-hand by the test card at this same commit and are re-cited here:
`docs/qa/e9-utilities.md` §4–§5, logs `docs/qa/e9-utilities-logs/e2e-e9-3engines.txt`.

---

## 3. Explicit checklist (this card's acceptance criteria)

### 3.1 Import-pipeline discipline (ADR-004) — **PASS**

- `prepareForeignImport` (`src/portability/foreign/index.ts:113`) reads through the
  SAME `readImportText` size gate (`FILE_TOO_LARGE` before any decode, `backup-document.ts:491`),
  then wraps converted records in a synthetic ADR-004 document and calls the SAME
  `prepareImport` (`foreign/index.ts:192`) — Stage A shape/malicious-shape → upgrade →
  Stage B per-record validation + caps → quarantine → **pre-import snapshot** →
  ONE-transaction atomic replace. **No second validation path exists** (grep-verified:
  only one `prepareImport` call site for foreign input).
- JSON input short-circuits to `prepareImport` itself (`foreign/index.ts:123`) — one
  entry point regardless of format.
- `grep "eval(|new Function|innerHTML ="` over `src/portability/foreign` + `fsa.ts`:
  **0 hits**. No new runtime dependencies; no secrets; no string-built queries.
- Line-level converter rejects never enter the document: they merge into
  `plan.quarantined` with the source line text and one combined recovery file
  (`foreign/index.ts:196`); a wholly-unimportable file hits `NOTHING_TO_IMPORT`
  **before any write** with `recoveryFile` attached (Decision 5.1 mirror).
- Caps are restated at the parse edge with the same numbers as `storage/validate.ts`
  and **reject, never truncate** (`foreign/record.ts:4-15`); converter rejects carry the
  original row text into recovery.
- Settings ride through verbatim from the TARGET profile (`foreign/index.ts:130-132`) —
  a foreign file can never reset theme/locale.
- First-hand hostile evidence: test card's 15-fixture ledger (§4 of
  `docs/qa/e9-utilities.md`) — 50 MiB+1 reject, 1001 lists / 100 001 tasks
  `LIMIT_EXCEEDED`, `__proto__` columns inert, markup/formula rows imported as text
  (no element created), unescaped-quote CSV fails closed, whitespace-only →
  `NOTHING_TO_IMPORT` with zero side effects. **The one gap in that ledger is B2/B3.**

### 3.2 Fallback universality (§9.4 feature detection) — **PASS**

- Every call site feature-detects: `runExport` → `supportsFsaSave()`
  (`actions.ts:47`), `StoragePanel.pickFile` → `supportsFsaOpen()`
  (`StoragePanel.tsx:98`). No capability-specific label, disabled control or dead
  affordance is ever rendered — Safari/Firefox simply take the hidden-input /
  anchor-download path.
- Gesture rule honoured: `pickSaveFile`/`openPickedFile` invoke the picker
  **synchronously before their first `await`** (`fsa.ts` — `api(...)` is called before
  the await), and `runExport()` is a non-async function that starts the picker before
  `runExportFlow` awaits anything. Dialog `AbortError` = cancel (no fallback, no error
  state); every other picker failure degrades to the universal path.
- Copy honesty: picker write → `dataSafety.backup.doneFsa` ("…the file you chose");
  download fallback → `doneSafe`/`doneShort`; cancel → no toast. en+th both present.
- Evidence: my chromium e2e run (5/5) + test card's 3-engine matrix (11 passed, with
  `typeof showSaveFilePicker === 'undefined'` asserted in-page on firefox/webkit).

### 3.3 Data-safety invariants (§7.4) — **PASS**

- **No shadow copies:** the foreign convert step is pure (reads the settings record
  only; no DB write, no snapshot before confirm); the preview → confirm → apply flow is
  unchanged; the only restore path is `importFlow.restoreSnapshot` →
  `portability.prepareSnapshotRestore` (single call site each, grep-verified).
- **Delete-all is real and immediate:** `runDeleteAll` → confirm dialog →
  `deleteAllData()` → recovery marker, untouched by this commit
  (`actions.ts:139-161`).
- Import apply still takes the automatic pre-import snapshot (the ONE undo) and the
  recovery file covers converter rejects + Stage B rejects in a single document.

### 3.4 Code duplication vs the MVP storage panel (S11) — **PASS**

- S11 adds **no component and no logic**: the E3 panel (`StoragePanel`,
  `QuotaMeter`, `PersistenceRow`, `BackupRow`, `SnapshotList`) is reused as-is; the only
  source change to it in `9ee9669` is the FSA open routing + widened `accept`
  (26 lines). The S11 deliverable is the new
  `tests/component/snapshot-restore-dashboard.test.tsx` proving
  SnapshotList → confirm dialog → data round-trip through the existing restore path.
- No duplicate quota/lastBackup/persistence/restore derivation exists anywhere in the
  diff (no new files under `src/features/data-safety/` other than edits to the three
  named modules).

---

## 4. Blocking findings (concrete fixes)

### B1 — S6 (archive + retention view + 10k numbers) not delivered · AC

- **Status:** the impl card marked `retention_perf_10k: NOT MET` and deferred S6 with a
  resumption plan (kanban comment 169 on t_5166e154); the test card verified the
  deferral is genuine (`grep setArchived|retention` → no archive action, no retention
  partition at `9ee9669` nor `ad4acc3`) and recorded a best-available 10k baseline
  (`docs/qa/e9-utilities.md` §7: completed view @10k → render 50.0 ms, DOM 22/10 000).
- **At review time the four engine files are still uncommitted sibling work**
  (`git status`: `M src/domain/{pipeline,ports}.ts`, `M src/features/tasks/store.ts`,
  `M src/storage/repos/taskRepo.ts`), so S6 cannot land safely yet.
- **Required:** land S6 per the resumption plan — `TaskPort.setArchived` +
  repo/pipeline/store action (archive preserves `completedAt`, unarchive backfills),
  `completedView` retention partition (recent ≤7d / older / archived, empty groups
  omitted), row-menu Archive/Restore + a11y announcements, en+th keys, new test files
  only, **the recorded 10k retention-view numbers**, extension of
  `e9-utilities.spec.ts`, and re-run of probe Q17 (E9-Q3: CSV `status=archived` rows are
  currently stored but visible in no view).

### B2 — E9-Q2: extension-first routing accepts a JSON backup renamed `.txt`

- `src/portability/foreign/index.ts:100` `detectImportFormat` = extension first,
  content sniff only when the extension misses. First-hand probe (attached to this
  card): `fakeFile('my-backup.txt', <valid backup>)` → `format = todotxt` →
  `prepareForeignImport` **ok, `accepted {lists:1, tasks:53, quarantined:0}`** (one
  garbage task per pretty-printed JSON line), while the identical bytes named `.json`
  give `{lists:1, tasks:0, quarantined:1}`. Extension-less content sniff control:
  **works** (accepted equals the `.json` control) — so the sniffer exists and is simply
  never consulted for an extension match.
- **Fix:** when the (extension-routed) text starts with `{`, try the JSON path first —
  or, cheaper, retry the JSON path when a `.txt`/`.todo` file yields
  `NOTHING_TO_IMPORT`/implausible counts. Add the unit pin; flip the QA card's
  `it.fails` E9-Q2 to `it()`.

### B3 — E9-Q1: UTF-16LE source accepted as mojibake

- `File.text()` UTF-8-decodes a UTF-16LE file into NUL-interleaved garbage; nothing at
  the routing seam rejects it. First-hand probe: `ok=true`,
  `accepted {lists:1, tasks:2}` of mojibake (desired: clean reject, zero side effects).
- **Fix:** sniff BOMs (`FF FE` / `FE FF`, and `FF FE 00 00`) before conversion and
  reject as unreadable source (or reject a decode containing NUL runs / a suspicious
  replacement-character density). Add the unit pin; flip the QA card's `it.fails` E9-Q1.

---

## 5. Non-blocking notes

- **N1** `DataSafetyHost.exportNow()` calls `runExport()` after a dynamic
  `import('./actions')` — the save picker therefore opens after a module fetch. If the
  fetch ever exceeds Chromium's transient-activation window the picker rejects with
  `SecurityError`, which is classified as `error` and **falls back to the universal
  download** (graceful, honest toast) — no dead end, so not blocking. A comment or a
  probe asserting the fallback on a synthetic SecurityError would close the loop.
- **N2** `chooseImportFile` sniffs the format from `file.slice(0, 4096)` for the error
  copy while `prepareForeignImport` re-detects from the full text; a file with >4 KB of
  leading whitespace could get an error message naming the wrong format (cosmetic).
- **N3** `src/features/data-safety/actions.ts` statement coverage is 62.5% at
  `9ee9669` (framework/UI, outside §9.5's ≥80% **domain** bar; domain itself
  97.57/87.36). The QA probes add gesture/copy coverage.
- **Cross-card (not E9):** **X1** the unit job is red at tip `ad4acc3` (S7 undo copy
  swept without its tests) — must land green before any push; **X2** `format:check` red
  on `src/domain/model.ts` + `vite.config.ts` (pre-existing, confirmed first-hand);
  **X3** budget `no-external-refs` red at `9ee9669`, resolved by `ad4acc3` (I re-measure
  the 2 hits at `9ee9669` myself).

## 6. Evidence

- `docs/qa/e9-review-logs/` — `typecheck+lint+i18n.txt`, `test-coverage.txt`,
  `e2e-e9-utilities-chromium.txt`, `review-probes.txt`, `budget+format-at-9ee9669.txt`.
- Reviewer probe `tests/unit/portability/e9-review-probe.test.ts` (attached to card
  t_8f8242cc): 1 control passed + 2 `it.fails` defect pins, tsc/eslint/prettier clean.
- Prior card evidence re-cited: `docs/qa/e9-utilities.md` (test card, 42 probes,
  3-engine e2e, gate battery at this commit).
