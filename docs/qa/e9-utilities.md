# Epic E9 (V1) — Utilities QA: archive/retention (S6), storage dashboard (S11), backup files (S10), Todo.txt/CSV importers (S12)

**Card:** t_adbd2e36 · **Run:** h_reviewer · **Date:** 2026-10-26 · **Scope:** the impl card's
delivery (t_5166e154, commit `9ee9669`) — `src/portability/foreign/`, `src/portability/fsa.ts`,
`src/features/data-safety/{importFlow,actions,StoragePanel}`, the S11 dashboard surface, and the
absence/deferred state of S6.

**Verdict:** **S10, S11 and S12 verified first-hand and hold** — including under an independent
hostile-input battery the impl card never wrote (42 new probes: 40 green + 2 pinned defect repros),
a first-hand 3-engine e2e run (11 passed / 0 failed), and the full gate chain at the exact delivery
commit. **S6 (archive + completed-history retention view, incl. the 10k retention-view numbers) is
NOT MET — it is genuinely deferred**, not silently skipped: the four engine files it needs are owned
by the in-flight S4 recurrence card, no `setArchived`/retention code exists at HEAD (grep-verified),
and the impl card's deferral is documented with a resumption plan. Best-available 10k baseline
numbers are recorded in §7 for the S6 resumption card.

**3 findings, all non-blocking for this card** (E9-Q1, E9-Q2 = two "wrong file accepted as garbage
instead of rejected" cases in S12's format/encoding edge; E9-Q3 = archived-status rows are invisible
until S6 lands — a tripwire, resolved by S6 itself). Plus **2 cross-card reds at HEAD that are NOT
E9's** (X1: the unit job is red at `ad4acc3` because that commit swept S7's delete-confirm copy
without its tests; X2: `format:check` red on `src/domain/model.ts` + `vite.config.ts`, pre-existing
and previously disclosed).

---

## 1. Method & evidence

Every claim below was re-run **first-hand**, not read off the impl handoff:

- **Isolated worktree** `/home/ubuntu/.hermes/profiles/h_reviewer/cache/scratch/e9qa-t_adbd2e36`
  pinned to the delivery commit `9ee9669` (the shared tree oscillates red on sibling in-flight
  waves, so attribution stays clean), then re-measured at the tip `ad4acc3`.
- **New independent probe suites** (not written by the impl card):
  `tests/unit/portability/e9-qa-probes.test.ts` (15),
  `tests/unit/data-safety/e9-qa-export-probes.test.ts` (6),
  `tests/component/e9-qa-dashboard-probes.test.tsx` (21) — 42 tests, all
  prettier/eslint/tsc-clean; 40 green + 2 `it.fails` defect pins (E9-Q1, E9-Q2, flip to `it()` when
  fixed — the E8 probe convention).
- **e2e:** `tests/e2e/e9-utilities.spec.ts` on chromium + firefox + webkit, first-hand, on a fresh
  build (`E2E_PORT=4187` to avoid a concurrent card's server on 4173).
- **Logs:** `docs/qa/e9-utilities-logs/` — `battery-9ee9669.txt`, `battery-ad4acc3.txt`,
  `e2e-e9-3engines.txt`, `full-suite-with-probes.txt`, `probes-final.txt`,
  `probes-at-tip-ad4acc3.txt`, `sibling-fail-repro.txt`, `tip-lint-after-fix.txt`, plus the probe
  discovery runs and the two gate scripts (`run-battery.sh`, `run-tip-check.sh`).

## 2. Acceptance criteria status

| AC (card body) | Status | Evidence |
|---|---|---|
| `docs/qa/e9-utilities.md` with per-feature evidence | **MET** | this report; logs dir |
| **10k retention-view numbers** | **NOT MET — S6 deferred** | §7: deferral verified genuine (no `setArchived`/retention code at `9ee9669` nor `ad4acc3`); best-available 10k completed-view baseline recorded; retention partition cannot be measured because it does not exist yet. Rides the review cycle (t_8f8242cc requeues the impl card) per the impl handoff |
| Malicious/malformed import fixtures listed with outcomes (all rejected cleanly) | **MET with 2 disclosed exceptions** | §4 ledger: 15 fixtures — 12 reject/hold cleanly; **E9-Q1 (UTF-16LE) and E9-Q2 (JSON-backup-renamed-`.txt`) are ACCEPTED as garbage instead of rejected** → defects below. Hostile markup/formula rows are *correctly* accepted as inert data (row 6/8), that is not a reject |
| Defect list in report AND completion metadata | **MET** | §8 + completion metadata |
| FSA path AND download/upload fallback both exercised (per browser) | **MET** | §5: unit gesture/copy probes + e2e matrix on 3 engines |
| Snapshot list can restore | **MET** | §6: engine-level undo round-trip probe + dashboard wiring probes + impl's `snapshot-restore-dashboard.test.tsx` green in my runs |
| Malformed Todo.txt/CSV fixtures rejected without side effects | **MET** (except the two encoding/extension cases above) | §4: `expectUntouched` = 0 snapshots, 1 list, 1 task unchanged on every reject |
| i18n en+th for new copy | **MET** | `i18n:check` PASS at both commits; probe Q10 asserts the 5 new S10/S12 keys exist in both packs with identical placeholders |

## 3. Gate battery

**At the delivery commit `9ee9669`** (`docs/qa/e9-utilities-logs/battery-9ee9669.txt`):

| Gate | Result | Note |
|---|---|---|
| `format:check` | **FAIL** | `src/domain/model.ts`, `vite.config.ts` — **pre-existing**, neither file touched by `9ee9669` (X2 below) |
| `lint` (eslint --max-warnings 0) | PASS | |
| `typecheck` | PASS | |
| `i18n:check` | PASS | |
| `test:coverage` | PASS | 111 files, **1212 passed + 2 expected fail**; statements **86.01%**, branches **80.09%**; domain 97.57/87.36, portability/foreign 91.2/84.23, fsa 87.8/72.41 |
| `build` | PASS | initial-js 76.6/100 KB |
| `budget` | **FAIL** | `no-external-refs`: `https://cloud.example/...` inside the **locale packs** (sync `url.hint` copy, E8/E7-owned; disclosed by the impl card) — **fixed later by `ad4acc3`**, verified below |
| `audit:gate` | PASS | 0 production vulnerabilities |
| **full suite + my 42 probes** | PASS | **114 files, 1252 passed + 4 expected fail** (`full-suite-with-probes.txt`) |

**Re-measured at tip `ad4acc3`** (`battery-ad4acc3.txt`, `tip-lint-after-fix.txt`):

| Gate | Result | Note |
|---|---|---|
| `format:check` | FAIL (same 2 files) | X2 unchanged |
| `lint` | **PASS** | after fixing 2 lint errors in my own probe file (template-literal numbers) — full `npm run lint` exit 0 at tip |
| `typecheck` / `i18n:check` | PASS | |
| `test:coverage` | **FAIL — 2 tests** | `core-ui-composer.test.tsx` + `e2-core-ui-qa.test.tsx`: **cross-card, not E9, not QA probes** — see X1 (reproduced standalone: `sibling-fail-repro.txt`) |
| `build` | PASS | |
| `budget` | **PASS** | `no-external-refs` 0 hits, locales 20 452/20 480 — X3 resolved by `ad4acc3` |
| `audit:gate` | PASS | 0 vulnerabilities |
| QA probes at tip | PASS | 40 passed + 2 expected fail (`probes-at-tip-ad4acc3.txt`) |

## 4. S12 — hostile / malformed fixture ledger (independent fixtures)

Oracle: PROJECT_ANALYSIS §7.4 + §10 E8 + ADR-004 (size caps, schema validation, never eval,
pre-import snapshot). "Untouched" = 0 snapshots + seeded 1 list/1 task byte-identical after the
reject (`expectUntouched`).

| # | Fixture | Expected (E8 / ADR-004) | Observed | Verdict |
|---|---|---|---|---|
| 1 | Source over 50 MiB (`MAX_IMPORT_BYTES+1`) | rejected before read, untouched | `FILE_TOO_LARGE`, untouched | **PASS** |
| 2 | CSV converting to 1001 lists | document cap `MAX_LISTS=1000` | `LIMIT_EXCEEDED {data.lists, 1001, 1000}`, untouched | **PASS** |
| 3 | CSV converting to 100 001 tasks | document cap `MAX_TASKS=100 000` | `LIMIT_EXCEEDED {data.tasks, …}`, untouched | **PASS** (ran in 1.4 s, no OOM) |
| 4 | CSV columns `__proto__`/`constructor`/`prototype` | no pollution | row imports as plain data; `Object.prototype` clean; prepare stays pure | **PASS** |
| 5 | JSON backup with `__proto__` smuggled inside a task | malicious-shape reject | `MALICIOUS_SHAPE`, untouched, no pollution | **PASS** |
| 6 | Markup/formula titles: `<img onerror>`, `<script>`, `=cmd\|'/C calc'!A0`, `javascript:`, `onload=` | inert data, byte-exact | all 5 import byte-exact; `globalThis.__pwned` never set; rendered as **text** in the list (probe Q16: no `<img>`/`<script>` element created) | **PASS** |
| 7 | CSV row opening with an unescaped quote | whole-file reject (indistinguishable from truncation) | `PARSE_ERROR`, untouched — fail-closed, never a half import | **PASS** |
| 8 | Titles with NUL / RTL-override (`U+202E`) | data or reject — never crash | preserved as literal data, no crash, no stripping (pinned as documented behaviour) | **PASS (behaviour pinned)** |
| 9 | **UTF-16LE todo.txt** (Notepad "Unicode"; `File.text()` → NUL-interleaved mojibake) | reject as unreadable source | **ACCEPTED — imports as mojibake rows** (`prepared.ok === true`) | **DEFECT E9-Q1** (`it.fails` pin) |
| 10 | CSV bytes named `.json` | reject as bad JSON | `PARSE_ERROR`, untouched | **PASS** |
| 11 | **Valid JSON backup renamed `.txt`** | routed to the JSON backup path | **ACCEPTED as todo.txt — 53 garbage tasks** (one per pretty-printed JSON line) instead of 1 list/1 task | **DEFECT E9-Q2** (`it.fails` pin) |
| 12 | Whitespace-only todo.txt | reject, no side effects | `NOTHING_TO_IMPORT`, `recoveryFile: null`, untouched | **PASS** |
| 13 | Malformed-CSV drill against the real app (impl fixture, re-run by me on 3 engines) | inline notice + zero side effects | e2e: guard task survives, mystery row never lands — chromium/firefox/webkit | **PASS** |
| 14 | Orphan row inside a snapshot payload (restore path) | quarantine + recovery, no silent drop | `outcome: "partial"`, 1 quarantined with verbatim record, recovery file present | **PASS** |
| 15 | Whole-file rejects after conversion (bad dates / over-cap titles / contradiction rows) | `NOTHING_TO_IMPORT` + recovery offer | covered by impl's 15 foreign tests — green in my full-suite runs; recovery toast path (`B3`) verified in `import-flow.test.ts` | **PASS** |

Pipeline identity (the epic's binding decision) also holds structurally: `prepareForeignImport`
converts → wraps in a synthetic ADR-004 document → calls the SAME `prepareImport` (Stage A → upgrade
→ Stage B → quarantine → snapshot → atomic replace); `grep eval|new Function` over `src/` returns
nothing; settings ride through verbatim (probe Q7: `theme: 'dark'` survives apply — checked on the
**applied DB**, not just the plan); the undo snapshot restores the exact pre-import rows through the
same pipeline (probe Q7 round trip: seeded → replace → undo → seeded title back, `quarantined: []`).

## 5. S10 — File System Access save/open vs universal fallback

**Unit probes (what the impl suite did not pin):**

- **Gesture rule (§9.4):** `runExport()` enters `showSaveFilePicker` **synchronously inside the
  call** — asserted with a picker that flags on entry before any `await` — and `exportState` is
  already `saving` on that same tick. This is the only ordering Chromium accepts for a
  gesture-bound dialog.
- **Copy honesty:** picker write → toast is exactly `dataSafety.backup.doneFsa` ("…the file you
  chose"), byte-verified write (`"format": "local-first-todo-backup"`), **zero** anchor downloads;
  picker failure → anchor download + `doneSafe`/`doneShort` (never the FSA copy); cancel
  (`AbortError`) → **no toast at all**, no error state, no download. `lastBackupAt` is fed by both
  delivery paths (the dashboard value, §6).
- **Panel side (no dead UI):** without `showOpenFilePicker` the visible Import button drives the
  hidden input (Safari/Firefox path); with it, the system dialog runs and the input stays silent;
  hidden input `accept` carries `.json,.txt,.todo,.csv`.

**e2e matrix, first-hand, fresh build (`e2e-e9-3engines.txt`) — 11 passed / 7 skipped / 0 failed:**

| Spec | chromium | firefox | webkit |
|---|---|---|---|
| S10 save via FSA picker, no download | ✅ | skipped (chromium-only) | skipped |
| S10 failing picker → universal download | ✅ | skipped (chromium-only) | skipped |
| S10 non-Chromium: no FSA globals + download delivers | skipped | ✅ | ✅ |
| S10 open via FSA picker → import preview | ✅ | skipped (chromium-only) | skipped |
| S10/S12 upload fallback: real CSV picker → confirm → rows | ✅ | ✅ | ✅ |
| S12 malformed CSV → inline notice + zero side effects | ✅ | ✅ | ✅ |

The firefox/webkit "non-Chromium" specs additionally assert
`typeof showSaveFilePicker === 'undefined'` in the page — the feature-detection floor of §9.4.

## 6. S11 — storage dashboard values + restore

Probes Q11–Q14 (mocked storage states, fixed clock `now`):

| Surface | States verified | Observed |
|---|---|---|
| Quota meter | known (25%), browser-silent (`totalBytes: null`), near-full (95%), unavailable | percent line `(25%)` + `aria-valuenow=25`; silent → unknown copy and `data-tier="loading"` (**never "0% full"**); 95% → `crit` tier with its own words (not colour-alone); `unavailable` replaces the meter with the §9.4 degrade copy |
| Persistence row | granted / denied / not-requested / unsupported | all four copy lines; **granted + unsupported render no button** (no dead control), denied → "Ask again", not-requested → "Request protection" |
| Last backup | never + data / never + no data / 3-days-old | "Last backup: Never" with `data-danger`; neutral "Nothing to back up…" when no data (no danger styling); "Last backup: 3 days ago (Oct 22, 2026)" |
| Snapshot list | 2 rows / fresh pre-import / empty | Restore fires with its own id; **Download escape hatch only on `pre-import` rows** (ADR-004 5.5b); "kept for 7 days" note; empty list still explains what snapshots are |
| **Restore end-to-end** | engine + dashboard | my probe: REPLACE apply → undo snapshot → `prepareSnapshotRestore` → apply → **exact original rows, `quarantined: []`**; impl's `snapshot-restore-dashboard.test.tsx` (SnapshotList → confirm dialog → data round trip) green in my runs |

## 7. S6 — deferral verification and the 10k baseline

**Deferral is genuine (verified, not taken on trust):**

- `grep setArchived|retention` over `src/` at `9ee9669` (and `ad4acc3`): **no archive action, no
  retention partition** — `views.ts` still partitions `list` = open only, `completed` = done only.
- The four files S6 must touch (`src/domain/{pipeline,ports}.ts`, `src/features/tasks/store.ts`,
  `src/storage/repos/taskRepo.ts`) are owned by the in-flight S4 recurrence card — the impl card
  documented the hotspot and the full resumption plan (kanban comment on t_5166e154) instead of
  racing it. The pre-created Review card (t_8f8242cc) covers S6 and requeues the impl card.
- Therefore **the retention-view number AC cannot be measured today**: the view it names does not
  exist. Recording "0" or a proxy as if it were the AC would be a false PASS — it is logged
  **NOT MET** in §2.

**Best-available 10k baseline for the S6 resumption card** (probe Q18, jsdom, fixed corpus of
10 000 `done` tasks in one list, existing `completed` view — the surface S6 will partition):

```
[E9-QA baseline] completed view @10k done: seed 6.0ms, render 50.0ms, DOM rows 22 of 10000
```

- Render **50.0 ms** (well under §9.1's 200 ms INP-class budget), DOM rows **22 / 10 000**
  (virtualization floor: §9.1 "virtualize beyond ~200 rows" — PASS with a 9× margin).
- The shared virtualization suite (`core-ui-virtual.test.tsx`) is green in my full runs and pins
  the window math at 1k/10k (`computeWindow` sub-millisecond) — S6's retention groups must keep
  the same DOM-row cap; re-run Q18 renamed to the real retention view when S6 lands.

**S6-coupled finding:** the CSV importer already maps `status=archived` onto the model's
`archived` status, but no view consumes it yet — such rows are in the DB yet invisible everywhere
(tripwire probe Q17 pins this). Resolved by S6 itself; must be re-verified with S6 (E9-Q3 below).

## 8. Defects & findings

### E9 defects (this card's scope)

| id | Sev | Area | File | Finding | Fix direction |
|---|---|---|---|---|---|
| **E9-Q1** | non-blocking | S12 encoding | `src/portability/foreign/index.ts` (routing) + `backup-document.ts` `readImportText` | A **UTF-16LE** todo.txt/CSV (Notepad "Unicode") is UTF-8-decoded by `File.text()` into NUL-interleaved mojibake and **imported as garbage rows** instead of rejected as an unreadable source (§10 E8 wants a clean reject). No data loss: preview gate, pre-import snapshot, source file untouched — hence non-blocking. Probe: `e9-qa-probes.test.ts` `it.fails` E9-Q1 | sniff BOMs (`FF FE`/`FE FF`) or reject input whose decode contains replacement/NUL runs before conversion |
| **E9-Q2** | non-blocking | S12 format routing | `src/portability/foreign/index.ts` `detectImportFormat` | Routing is **extension-first**: a valid JSON backup renamed `.txt` (common pasting/mail-filter workaround) runs through the todo.txt converter → **observed 53 garbage tasks** instead of the backup's 1 list/1 task; confirming would REPLACE the profile with garbage (undo snapshot exists; preview shows counts but not the detected format). Content sniffing already exists (`formatFromContent`) but runs only after the extension misses. Probe: `it.fails` E9-Q2 | when the content starts with `{`, try the JSON path first (or on `NOTHING_TO_IMPORT` from a `.txt`/`.todo` file) |
| **E9-Q3** | non-blocking (**S6-coupled tripwire**) | S12 × S6 | `src/domain/views.ts` (no `archived` consumer) | CSV rows with `status=archived` land in the DB but **appear in no view** while S6 is deferred. Invisible-but-stored data; resolved by the S6 archived group. Probe Q17 pins today's behaviour with an explicit "update when S6 lands" name | ship S6 (already required by the epic); re-run Q17 then — if S6 slips, the importer must not emit `archived` |

Severity rationale (all three): the ADR-004 data-safety envelope holds in every case — nothing is
silently LOST (preview gate, pre-import snapshot/undo, recovery files, source file untouched);
the failures are "wrong content accepted" / "content invisible", not corruption or loss.

### Cross-card findings (NOT E9, surfaced because the gate sees HEAD)

| id | Sev | Finding |
|---|---|---|
| **X1** | **resolved** | **The unit job was RED at tip `ad4acc3`**: that commit's locale write swept the in-flight **S7 undo copy** — `confirm.deleteTask.body` changed from `…This can't be undone.` to `…You can undo this for 10 seconds.` — while the committed tests `core-ui-composer.test.tsx` ("deletes through the S7.1 confirm naming the task") and `e2-core-ui-qa.test.tsx` ("Escape cancels…") still assert the old text. Reproduced standalone with my probes removed (`sibling-fail-repro.txt`); the failing files are untouched since `6370493`. Owner: the S7/S5-S8 card (its uncommitted tree carries the updated tests) — land them, or the copy, consistently. **RESOLVED by `339cf6c`**: the sweep was reverted (the 10-second line had no undo implementation anywhere in `src/`), so the S7.1 no-undo copy is the intended V1 behavior — both tests re-verified PASS 39/39 at `fca1e79` (t_f8f4a6f5). |
| **X2** | pre-existing, disclosed | `format:check` FAIL at `9ee9669` **and** `ad4acc3` on `src/domain/model.ts` + `vite.config.ts` (Prettier drift; first disclosed in cbf779c). Neither file belongs to E9. First gate of `npm run ci` → no push until greened. |
| **X3** | resolved | `budget / no-external-refs` FAIL at `9ee9669` (locale packs carry `https://cloud.example/…`, E8 sync copy) → **PASS at `ad4acc3`** (re-measured: 0 hits, locales 20 452/20 480). Recorded so the E9 handoff does not re-cite a fixed red. |

### Info

- `src/features/data-safety/actions.ts` statement coverage **62.5%** at `9ee9669` (branch 73.5) —
  framework/UI code, outside §9.5's ≥80% **domain** bar (domain itself: 97.57/87.36 PASS). My probes
  add coverage for the gesture/copy branches.
- Probe convention: the two `it.fails` tests PASS **because** the defect reproduces; when someone
  fixes E9-Q1/E9-Q2 the test reddens → flip it to `it()` as the fix lands (same as E8's probes).

## 9. What the reviewer (t_8f8242cc) should weigh

1. E9-Q1/E9-Q2: accept as non-blocking (data-safety envelope intact) or require the encoding/JSON
   sniff in this epic — both fixes are small and local to the routing seam.
2. S6 remains the epic's open AC: retention partition + the real 10k numbers + the archived-group
   re-run of probe Q17.
3. X1 must land green before any push of `ad4acc3`+ (the unit gate, together with X2's
   `format:check`, is what currently keeps main's `npm run ci` red).
   *Update 2026-10-26 (t_f8f4a6f5): X1 green since `339cf6c` (39/39 re-verified at `fca1e79`);
   X2's named files greened by `869a1f9`, `validate.ts` by `fca1e79` — `format:check` exit 0.
   The remaining `npm run ci` red is now the `src/storage` branch-coverage threshold from the
   later crypto commit `c1ed860` — tracked on t_b910527a, not on X1/X2.*
