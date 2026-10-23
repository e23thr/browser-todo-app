# E3 QA — Export/import, snapshots & recovery drills (data engine)

- **Card:** t_f0702c05 `[E3] Test: Export/import, snapshots & recovery drills`
- **Engine under test:** `src/portability/` + `src/storage/` (impl card t_a7c2087f, ADR-004)
- **Binding spec:** `docs/adr/ADR-004-export-import-format.md` "Testing contract" (drills 1–15)
- **Refs:** PROJECT_ANALYSIS.md §5.4, §5.5, §7.4, §9.3, §10 (E2/E3/E4/E8)
- **Verdict:** **PASS — no drill path loses or silently corrupts data** (explicit confirmation
  below), with **1 non-blocking defect (D1)** and 2 info notes. Nothing blocking.

## 0. What was executed and where

Two drill layers, both against the real engine (no reimplemented pipeline stages):

| Layer | Where | How to run | Result |
|---|---|---|---|
| A. Real-browser drills (this card's deliverable) | `tests/e2e/data-safety-journey.spec.ts` + harness `tests/e2e/data-safety/harness.ts` | `npm run e2e:data-safety` (CI job `e2e-data-safety` in `.github/workflows/ci.yml`) | **11/11 passing**, 5 consecutive runs, real Chromium + real IndexedDB, context **offline** |
| B. ADR-004 unit drill suite (impl card, re-run for evidence) | `tests/unit/portability/*` | `npx vitest run tests/unit/portability tests/unit/storage` | **227/227 passing** (incl. the 65 ADR-004 drill tests) |

Gates on this card's files: `tsc -b` clean (whole repo), `eslint` clean on every file this card
added/touched, Prettier clean. (Repo-wide `npm run lint` is currently red from 61 findings in
OTHER cards' in-flight files — `coverage-e2b/`, `docs/qa/e5-shell-logs/probes/`, `src/app/*`,
`src/features/lists/*` — none in this card's files; those cards' own gates own them.)

### The real-browser harness (why this is a real drill, not a mock)

`tests/e2e/data-safety/harness.ts` is bundled by `tests/e2e/data-safety/vite.config.mjs` into a
gitignored fixture dir and served by the ADR-005 static fixture server. The page runs the
production engine exactly as the composition root will (`openForTests` + `bindDataSafetyDb` +
`exportBackup`/`prepareImport`/`applyImport`/`deleteAllData`/`takeSnapshot`/`restoreSnapshot`)
against **real IndexedDB transactions** in a real Chromium page. Every drill boots a fresh
per-test database, then `context.setOffline(true)` — drill 1 additionally asserts
`navigator.onLine === false` AND **zero network requests** for the whole journey (§6.1).
Test-only seams (deterministic corpus, ADR-004 §2.4 canonical-byte fingerprinting, and an
`IDBObjectStore.put` fault injector) live in the harness; `src/` is untouched by this card.

## 1. Per-drill evidence (ADR-004 testing contract)

Browser column = `tests/e2e/data-safety-journey.spec.ts` (log:
`docs/qa/e3-data-engine-logs/playwright-data-safety-run.txt`; re-run green against engine
commit `675a154` which landed mid-review — UTF-8 byte caps + rollback payload validation).
Unit column =
`tests/unit/portability/*` (log: `docs/qa/e3-data-engine-logs/vitest-portability-storage.txt`).

| Drill | Requirement | Browser (real IDB, offline) | Unit suite | Evidence / notes |
|---|---|---|---|---|
| 1 (acceptance) | export → wipe → import → restored, records + settings **byte-equivalent**, counts match, tombstones restored | **PASS** (scripted as Decision 10's four `test.step`s; CI-runnable) | PASS (`apply.test.ts`) | Byte-equivalence asserted vs the export document's canonical bytes (§2.4 `canonicalizeRecord`); tombstones (1 list, 1 task) restored; `meta.deviceId` preserved; boot prefs cleared; NO pre-wipe snapshot; imported snapshot metadata ignored with warning; zero network requests during the journey |
| 2 | double export differs only in `exportedAt`/`settings.lastBackupAt` | **PASS** | PASS | Field-scoped masking (`"exportedAt":<TS>` / `"lastBackupAt":<TS>`) — the canonical serializer is byte-stable |
| 3 | old export upgrades through the migration chain; failing step = `UPGRADE_FAILED`, zero side effects | **PASS** (injected v1→v2 registry over the in-memory adapter) | PASS | `fileSummary {schemaVersion: 1, upgradedTo: 2}`; backfilled `notes: ''` validates at v2; DB fingerprint unchanged before/after both the good and the failing step |
| 4 | malicious fixtures rejected with zero DB writes and NO snapshot | **PASS** — 12 cases: wrong format token, recovery-as-backup, `formatVersion` future, `schemaVersion` future, **missing schemaVersion**, missing `data.settings`, `__proto__` keys, depth bomb, truncated JSON, **oversize real `File` (> 50 MiB)**, 100 001-task count bomb, all-corrupt (drill 7) | PASS (same corpus + generated bombs) | Every case typed-rejected with the expected code (`NOT_A_BACKUP`/`FORMAT_TOO_NEW`/`NEWER_SCHEMA`/`MALICIOUS_SHAPE`/`PARSE_ERROR`/`FILE_TOO_LARGE`/`LIMIT_EXCEEDED`/`NOTHING_TO_IMPORT`); fingerprint AND snapshot list identical before/after — the oversize cap fires **before** the File is read |
| 5/6/8 | quarantine, referential cascade, duplicate ids (first wins) | **PASS** (combined `corrupt-mixed` document) | PASS (separate drills) | 2 lists + 3 tasks accepted; exactly 3 quarantined (bad `title` type, dangling `listId`, duplicate id); outcome `partial`; recovery document holds exactly the 3 with `issues` + `raw`; quarantined rows never land in the DB |
| 7 | all records corrupt → `NOTHING_TO_IMPORT`, zero side effects | **PASS** (fixture `drill7-all-records-corrupt.json` in the drill-4 table) | PASS | A corrupt file is never an empty backup; a legit empty backup imports as replace-with-empty (unit drill) |
| 9 | 5 auto snapshots → newest 3 remain; payloads evicted; manual permanent; `deleteSnapshot` works | **PASS** | PASS | 5 `takeSnapshot('scheduled')` → exactly 3 newest rows AND 3 payload rows; a manual snapshot survives 5 further autos; delete works for a manual row |
| 10 | import → `restoreSnapshot(pre-import id)` → byte-equivalent to pre-import state; undo-of-undo exists | **PASS** | PASS | lists/tasks/settings canonical bytes equal the pre-import fingerprint; 2 `pre-import` rows exist afterwards (the import's undo + the restore's own undo) |
| 11 | snapshot-write failure → `applyImport` aborts (`SNAPSHOT_FAILED`) unless `allowWithoutSnapshot` | **PASS** (fault-injected `snapshot_payloads` put) | PASS | Without opt-in: typed `SNAPSHOT_FAILED`, DB untouched. With opt-in: applies, `undoSnapshot: null`, loud warning — never silent |
| 12 | `QuotaExceededError` on apply → transaction aborts, DB unchanged, typed `QUOTA_EXCEEDED`; stamp failure never costs the download | **PASS** (fault-injected `QuotaExceededError` on `tasks.put`) | PASS | **Atomicity proven in a real browser:** the pending hard-deletes rolled back together with the failing puts — lists/tasks/settings byte-identical to before. Export with a failing `settings.lastBackupAt` write still delivers the full document + warning |
| 13 | imported `data.snapshots` ignored with warning; store unchanged except the pre-import row | **PASS** | PASS | Document declared 3 snapshot rows (2 unknown to the DB) — none materialized; only the pre-import undo joined the store |
| 14 | recovery document round-trips `serializeRecoveryDoc` → NOT importable; never persisted | **PASS** (the REAL recovery file from a partial import) | PASS | `format: "local-first-todo-recovery"` with 3 entries (`issues` + `raw` verbatim); `prepareImport` rejects it `NOT_A_BACKUP`; the only payload row in the DB is the pre-import undo's — the recovery file exists in memory/download only (§7.4 no shadow copies) |
| 15 | manual QA: Decision 10's four steps on a real browser; archive the two files | **PARTIAL — automated** | n/a | The four steps run in real Chromium offline and the two files are archived (`docs/qa/e3-data-engine-logs/backup-document.json`, `recovery-document.json`, generated via `E3_ARCHIVE_DIR=… npm run e2e:data-safety`). The iOS Safari narrative (E2/E1) cannot be automated here — see §4 |

## 2. Explicit no-data-loss / no-silent-corruption confirmation

**Confirmed: no drill path loses or silently corrupts data.** Specifically verified:

1. **Every whole-file reject (drill 4 family) is zero-side-effect** — DB fingerprint and snapshot
   list are byte-identical before and after all 12 hostile/malformed inputs; no snapshot is taken.
2. **Every apply is atomic** — a mid-transaction `QuotaExceededError` (drill 12) and a
   pre-import snapshot failure (drill 11) leave lists/tasks/settings byte-identical to before;
   there is no partial write in real Chromium (§9.3 "IDB transactions are the guarantee").
3. **Nothing is silently dropped** — corrupt records quarantine to the downloadable recovery
   file with `issues` + verbatim `raw` (drills 5/6/8/14); `QUOTA_EXCEEDED`/`SNAPSHOT_FAILED`
   are typed, never swallowed; the best-effort `lastBackupAt` stamp failure lands in
   `warnings` while the export still delivers.
4. **The restore path is loss-free** — export → wipe → import restores every record and
   `settings` byte-equivalently (drill 1), and the pre-import snapshot undoes an import
   byte-equivalently (drill 10). Tombstones round-trip on purpose (documented old-backup
   resurrection risk in the UX confirm copy).

## 3. Defect list (also in completion metadata)

### D1 (non-blocking, domain correctness) — "Delete all data" resets `settings` to a different default than a fresh install

- **What:** `deleteAllData` resets `settings` to `src/portability/constants.ts`
  `DEFAULT_SETTINGS_RECORD` (`weekStart: 0`), but the domain model's fresh-profile default
  `src/domain/model.ts` `DEFAULT_SETTINGS` is `weekStart: 1`. A third copy in
  `src/app/settings.ts` `DEFAULT_SETTINGS` also says `0`. ADR-004 Decision 10 pins the wipe
  result as "an effectively fresh install with the same `deviceId`" — with the domain layer
  (ADR-003 Decision 1.2) as the canonical record home, the wipe currently lands on a settings
  state a fresh profile would not have (week starts Sunday instead of Monday).
- **Impact:** low. No data is lost (export → import restores exactly), but the triplicated
  default is drift-adjacent: the next settings-field addition will diverge further. Visible to
  a user who wipes and keeps using the app (week view starts on a different day than a fresh
  profile).
- **Evidence:** `docs/qa/e3-data-engine-logs/backup-document.json` (seeded/exported
  `weekStart: 1`) vs the post-wipe settings (asserted in drill 1 against the engine's own
  reset target, with the divergence called out in the test comment).
- **Suggested fix (owner: engine card + h_pm decision):** decide the true default once
  (h_pm/PO), then make `DEFAULT_SETTINGS_RECORD` derive from `domain/model.DEFAULT_SETTINGS`
  (single source of truth) and align `src/app/settings.ts`. The drill-1 assertion compares
  against `DEFAULT_SETTINGS_RECORD`, so it will keep passing through the fix.

### Info notes (no action required for MVP)

- **I1** — A failed `applyImport` leaves the stage-5 pre-import snapshot behind (an undo of an
  import that never happened). Documented behavior (the snapshot is taken before the replace
  tx) and harmless — but the snapshots list will show it; the data-safety UX card may want to
  label it in the confirm/error copy.
- **I2** — When `readSnapshotSource` leaves `meta` unpopulated, the export envelope's
  `deviceId` falls back to `AppDBImpl.deviceId` (already noted by the impl card's codec
  comment). In production both are the same value (boot seeds `AppDBImpl` from the meta row);
  only test scaffolding with mismatched meta can observe it.

### Known erratum (carried from impl card, not re-opened here)

- ADR-004 §2.1's EXAMPLE document uses `sortOrder: "h0"`, which the validator rejects as
  non-canonical (trailing-zero form). The validator is authoritative; an ADR erratum is
  tracked by the impl card.

## 4. Coverage boundaries (honest scope)

- **UX flows** (Settings → Export/Import buttons, confirm dialog copy, quota dialog, recovery
  download affordance) belong to the data-safety UX card (t_9f6f9631) and its test card
  (t_b1595f03). This card drills the ENGINE; the engine was exercised exactly as the UX card's
  handoff (`docs/dev/data-safety-api.md`) calls it.
- **Real OS quota exhaustion** is fault-injected (a synchronous `QuotaExceededError` from
  `IDBObjectStore.put`) — the ADR testing contract's own technique; driving a browser to real
  quota exhaustion is not reproducible in CI.
- **iOS Safari (drill 15's manual part / §10 E1/E2 narrative)** cannot be automated in this
  environment. The PO-accepted residual risk (§5.5) stays on the manual QA checklist.
- **Cross-browser:** verified in Chromium locally and in the CI PR gate; the nightly
  `e2e-full` matrix runs the same specs under Firefox/WebKit and `chromium-th`.
- The **drill-1 "app usable immediately"** clause needs the app UI (in-flight in t_9f6f9631);
  the engine-level guarantee (records restored byte-equivalently and readable) is what this
  card verifies.

## 5. Artifacts

- `docs/qa/e3-data-engine-logs/backup-document.json` — the exact export bytes from drill 1
  (Decision 10 step 1 checksum: `counts {lists: 2, tasks: 3, snapshots: 1}`)
- `docs/qa/e3-data-engine-logs/recovery-document.json` — the real recovery file produced by
  the drill-5/14 partial import (3 quarantined entries with `issues` + verbatim `raw`)
- `docs/qa/e3-data-engine-logs/playwright-data-safety-run.txt` — final green browser run (11/11)
- `docs/qa/e3-data-engine-logs/vitest-portability-storage.txt` — unit drill suites (227/227)

## 6. Reproduction

```sh
npm run e2e:data-safety                                        # browser drills (CI job e2e-data-safety)
npx vitest run tests/unit/portability tests/unit/storage       # unit drill suites
E3_ARCHIVE_DIR=docs/qa/e3-data-engine-logs npm run e2e:data-safety   # regenerate the archived files
```
