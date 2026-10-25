# E3 Data-safety UX — Review (t_3d95d5ef), round 1

Reviewed by: h_reviewer
Reviewed at: 2026-10-23T22:05 (UTC+07)
Base: clean worktree of HEAD `e4b5601` (impl card t_9f6f9631, commits d2770bf + carry commits 3866cd8/63ba421/e4b5601)
Scope: src/features/data-safety/** (24 modules + 11 components), src/app/{App,main,bootCodec,settingsPersistence}.ts(x),
src/i18n/{en,th}.json + settingsPersistence, src/features/settings/SettingsView.tsx, src/features/tasks/store.ts (hooks),
src/styles/data-safety.css, tests/unit/data-safety/**, tests/component/data-safety*.test.tsx
Binding refs: docs/design/data-safety.md (BINDING), docs/dev/data-safety-api.md (parent handoff contract),
docs/adr/ADR-004-export-import-format.md Decision 5.5 / 8 / 10, docs/adr/ADR-002-storage-schema.md Decision 7,
PROJECT_ANALYSIS.md §5.5 / §7.4 / §11 (R1/R2)

## VERDICT: REQUEST CHANGES — 3 blocking, 6 non-blocking, 2 info

### Automated checks (clean worktree of HEAD e4b5601)

- `npx tsc -b`            → EXIT 0
- `npx eslint . --max-warnings 0` → EXIT 0
- `node scripts/check-i18n.mjs`   → PASS (en/th key sets, values, placeholders consistent)
- `npx vitest run`        → 55 files / 615 tests / 0 failures (89 of them this card's)

### Explicit checklist (task acceptance criteria)

| Item | Verdict | Evidence |
|---|---|---|
| Copy conformance (both locales) | PASS (nits N1/N3/N6) | every §6/§7/§8 string verbatim in en + th; 133 `dataSafety.*` keys, identical key + placeholder sets both locales |
| iOS 7-day rule in the 5 §11-mandated places, BOTH locales | PASS | onboarding.body2, banner.backup.body, banner.longAbsence.body, banner.persistDenied.body, recovery.body (verified in en.json + th.json) |
| R1 stack completeness (§5.5) | PASS | persist() at first meaningful use (store.ts:336 → persistGate) + granted/denied/unsupported/not-requested row + Ask again; 14-day nudge (BACKUP_NUDGE_DAYS=14, never+data variant, always-reachable export); eviction detection (pre-boot meta probe BEFORE boot() stamps lastOpenedAt; classifyBoot wiped/long-absence/shrunken/ack-re-arm per §3.4 table; recovery screen + long-absence banner + lastBackupAt surfaced); honest onboarding naming the iOS 7-day rule |
| No-silent-loss paths | FAIL (B2, B3) | write/quota paths PASS (pending queue, Escape keeps the entry — tested; delete-all real/immediate/confirmed; snapshot-failure aborts before destructive write). Failures: undo snapshot can silently vanish (B2); recovery file dropped on a whole-file reject (B3) |
| a11y of dialogs | PASS | alertdialog + aria-modal + labelled/described; initial focus on safest action per kind; focus trap; Escape = safe path; focus return; scrim = Escape; banners/toasts role=status; meter role=meter + visible text; tier label + icon (never colour alone); focus behaviours covered by component tests |
| API-contract fidelity (no UI/engine divergence) | FAIL (B1, B2, B3) | engine calls/Result contract/quota typing all correct; ADR-004 Decision 5.5 confirm-copy facts incomplete (B1); undo escape hatch missing (B2); reject-path recovery offer missing (B3) |

### BLOCKING findings

**B1 — Import-confirm copy omits binding ADR-004 Decision 5.5 facts.**
The parent handoff (docs/dev/data-safety-api.md:83-87) binds three confirm-copy facts; ADR-004:788 restates them
("replaces-all warning with counts, undo snapshot pointer, tombstone-resurrection caveat"). Implemented copy
(SafetyDialog.tsx:213-242, keys dataSafety.import.confirm.body/body2/body3) provides:
(a) PARTIAL — body2 names only tasks+lists, while `applyImport` replaces the `settings` record too
    (one tx over ['lists','tasks','settings'], import.ts:106-110 / :208-209); `mirrorTheme()` then overwrites the
    device theme from the FILE's settings and `locale` is taken from the imported record on next boot —
    this contradicts design §8.3 ("imported settings apply weekStart, defaultListId, but NOT theme, locale").
    The UI currently under-promises what the engine does to a user's settings. (Semantic conflict
    §8.3 vs ADR-004 is escalated to h_pm — see epic comment; the COPY must at least state the truth.)
(b) PARTIAL — body3 names the snapshot + one-tap restore but not "lives in Settings → Storage & back up → Snapshots",
    and the binding `downloadSnapshot(undoSnapshot.id)` escape hatch is not offered (see B2).
(c) MISSING — no tombstone-resurrection caveat anywhere in the catalog (importing an older backup resurrects
    rows deleted since; engine restores tombstones on purpose).
Fix: add en+th keys for the tombstone caveat + the settings-replacement fact; render them in the confirm body;
name the snapshot location in body3.

**B2 — The import undo can be silently destroyed; both promised protections are absent.**
`takeSnapshot('pre-import')` maps to `kind:'auto'` (src/portability/snapshots-api.ts:149-158) and rolls at 3,
so the pre-import undo is evictable by three newer snapshots. Design §8.4 requires pre-import snapshots to be
protected from rolling purge for 7 days (max 2 protected) — NOT implemented (declared deviation). The binding
parent handoff compensates exactly this risk: "offer `downloadSnapshot(undoSnapshot.id)` — the rolling-3 can evict
it, the download is the durable escape hatch" (docs/dev/data-safety-api.md:85-86) — NOT implemented either
(SnapshotList.tsx renders kind/when/size/Restore only; no download affordance, no key). Meanwhile the UI keeps
promising the undo: UndoToast "Import complete. Your previous data is saved as a snapshot." and the per-row
"can be restored" note (dataSafety.snapshots.protected). A user can lose the undo of the most destructive flow
with zero action on their part.
Fix (either closes it; both is best): implement §8.4 retention protection for `pre-import` snapshots, and/or add a
download affordance (downloadSnapshot) on pre-import rows + the undo toast; align the "can be restored" note
with whatever retention reality remains.

**B3 — Whole-file reject drops the recovery document (no-silent-loss gap).**
When `prepareImport` rejects with `NOTHING_TO_IMPORT`, the typed error carries `recoveryFile` — that was engine
review round-2 fix P2, and the API doc says "offer it in the UX" (docs/dev/data-safety-api.md:101-105). The invalid
path (importFlow.ts:160-171 → invalidFrom:127-128) renders only the static message
("Nothing in this file could be imported. Nothing was changed.") and discards the payload: the quarantined raw
records of a rejected file become unreachable with no notice. The partial-apply path does this correctly
("Download recovery file" toast, importFlow.ts:221-233) — the reject path must do the same.
Fix: when `plan.error.code === 'NOTHING_TO_IMPORT' && plan.error.recoveryFile !== null`, surface a
"Download recovery file" action (inline notice under the picker or a toast) and extend the copy to say damaged
records can be saved.

### NON-BLOCKING (fix before merge, no re-review)

N1 QuotaMeter.tsx:52-54 — value line template `${used} of ${total} (${percent}%)` is hardcoded English with no
   `dataSafety.*` key; violates §11 "must not inline English" (Thai locale shows "of"). Localize (key or
   valueTemplate passed from the container).
N2 storageInfo.ts:181-192 — `localStorageProbeFails()` writes transient key `todo:prefs:v1:probe`; ADR-002
   Decision 7 (ADR-002-storage-schema.md:383-386) closes the localStorage list at exactly three keys, a rule this
   card's own constants.ts/flags.ts restate. Probe with an allowed key, sessionStorage, or file an ADR erratum.
N3 dataSafety.recovery.lastBackup renders "1 days ago" when the last backup was one day before the wipe
   (N=1 singular edge; §11 asks for ICU plurals and the M15 runtime has none). Handle the singular like
   relativeAge() does, or add plural variants.
N4 importFlow.ts:257-286 — `restoreSnapshot()` silently returns when the snapshot lookup misses after a
   successful `prepareSnapshotRestore` (line 275), and a restore of an evicted snapshot falls through to the
   generic "Nothing was changed" copy. Add a specific "this snapshot no longer exists" message.
N5 §5.6/§10.6 `busy` confirm state unimplemented: the dialog closes via `answerDialog(true)` BEFORE the
   destructive write runs (actions.ts:78-81); the `import-busy` SafetyDialog kind is dead code (no producer);
   `runDeleteAll` has no isBusy()/double-submit guard (runExport has one).
N6 Copy nits: export toast always uses the §7 first-ever variant ("Keep it somewhere safe.") instead of §9's
   short "Backup saved to your downloads."; NudgeBanner renders the 'link' action variant as button-secondary;
   SnapshotList's Restore button carries a download icon.

### INFO

I1 main.tsx:38-48 — the pre-boot probe is awaited before first render: a hung IndexedDB delays paint up to its
   1.5 s bound. Documented trade-off (correct classification needs pre-boot `lastOpenedAt`); note vs the 300 ms
   boot budget in the pathological case only.
I2 Ratifications still open for h_pm/PO (impl deviations + this review): authored copy (shrunken banner,
   quota-pending body, restore-confirm body, partial-import toast); OQ-3 emergency visibilitychange snapshot
   dropped (rationale sound: a DB snapshot cannot contain a write that never reached the DB); §8.4 "restore
   creates NO new snapshot" vs ADR-004 undo-of-undo (current behaviour is the safer direction); §8.3
   theme/locale-on-import vs ADR-004 wholesale settings replace (B1).

### Verified-good (spot evidence)

- §6.1–§6.8 copy verbatim en+th incl. onboarding bodies 1-3 + "How backups work" details/summary; §8.1 confirm
  bodies 1-3; §8.4 undo message + restore-confirm; §7 empty/first-run states (backup.empty, snapshots.empty,
  meter unknown + panel unavailable, invalid-file + "Choose another file").
- §2 hierarchy: BANNER_PRIORITY = long-absence > shrunken > quota-pending > quota-warn > persist-denied >
  backup-reminder (S5 > S4-context > quota 80% > persist denied > nudge), MAX_VISIBLE_BANNERS=2, overflow
  "N more notices" on the top banner only; T3 dialogs queued, never stacked; tier label + icon on every banner.
- §3.3/§6.4 quota path: pendingWrites keeps the entry across every dismissal (no OK-discard path), Escape/close
  = keep + close + T2 banner with the same three actions, retry retires only on success (tests:
  "keeps the entry when the dialog is dismissed (Escape), then retires it after a good retry").
- §3.4 classification order wiped → long-absence → shrunken → normal, fresh-profile NOT misread as wipe,
  ack re-arm semantics (storeCreatedAt < ack), safe-direction degradation (probe failure ⇒ hasData=true).
- §3.5 private heuristic: persisted() false + (quota < 50 MB | localStorage probe throws), once per profile.
- Delete-all (§6.8/§7.4): focus starts on "Export a backup first", counts in body, real immediate wipe via
  engine `deleteAllData`, wipe ack written AFTER prefs clear (deliberate wipe ≠ eviction).
- Security: no innerHTML/eval/fetch in the surface; bounded untrusted reads (readExportedAt 8 KiB slice);
  JSON.parse try-guarded; user-initiated blob downloads only; no secrets; feature-detected StorageManager with
  graceful degradation (§9.4).

---

## Rework status (fix card t_f5453962, round 1 → round 2 handoff)

All 3 blocking and all 6 non-blocking findings from round 1 are fixed. Re-review should verify
each item below; evidence is the test suite (698 tests, up from 615) plus the diff.

| Finding | Status | Where the fix lives | Binding test(s) |
|---|---|---|---|
| B1 (a) settings-replacement fact | FIXED | `dataSafety.import.confirm.body2` now states the settings record is replaced too (theme + language come from the file) — TRUE of current engine behaviour (`applyImport` tx spans `['lists','tasks','settings']`; `mirrorTheme()` rewrites the device theme). The §8.3-vs-ADR-004 semantic conflict is NOT re-decided here — it stays escalated to h_pm on epic t_57b9ef8f. | `tests/component/data-safety.test.tsx` "states the three ADR-004 Decision 5.5 confirm facts (en)" |
| B1 (b) undo pointer + download escape hatch | FIXED | `body3` names "Settings → Storage & back up → Snapshots" and the one-tap restore OR file download; the undo toast carries the binding `downloadSnapshot(undoSnapshot.id)` action (B2). | same test + `tests/unit/data-safety/import-flow.test.ts` "keeps the undo downloadable…" |
| B1 (c) tombstone-resurrection caveat | FIXED | New `dataSafety.import.confirm.body4` (en+th), rendered in the confirm body. | same B1 test (en + Thai variants) |
| B2 undo durability | FIXED (both halves) | (1) Engine: §8.4 protection — `PRE_IMPORT_PROTECTION_MS` (7 d) + `MAX_PROTECTED_SNAPSHOTS` (2) in `src/storage/snapshots.ts`; protected rows hold slots inside the rolling 3 so the list never grows past 3, a third protected pushes the OLDEST out, protection lapses after 7 d. (2) UX: `downloadSnapshot` affordance on pre-import rows (`SnapshotList`), a secondary download action on the undo toast, and the per-row note now says "kept for 7 days" only while the protection actually holds (it ages out with the engine constant). | `tests/unit/storage/snapshots.test.ts` §8.4 describe (3 tests) + `SnapshotList`/`UndoToast` component tests + import-flow undo test |
| B3 reject-path recovery offer | FIXED | `chooseImportFile`'s invalid path now surfaces the engine's `recoveryFile` as the same "Download recovery file" toast the partial-apply path uses; `dataSafety.import.error.nothing` copy extended to say damaged records can be saved. | `tests/unit/data-safety/import-flow.test.ts` B3 describe (2 tests incl. the no-recovery-file negative) |
| N1 QuotaMeter inline English | FIXED | Value line comes from `dataSafety.quota.value` (en+th) via the container's `valueTemplate`. | component test incl. Thai locale |
| N2 probe key | FIXED | The localStorage probe rewrites the ALLOWED `dismissedBanners` key byte-for-byte (removed again when it was absent) instead of creating `todo:prefs:v1:probe`. ADR-002 Decision 7's 3-key list stands; no erratum needed. | existing `storage-info.test.ts` §3.5 suite (probe behaviour unchanged) |
| N3 "1 days ago" | FIXED | `lastBackupOne` / `lastBackupToday` catalog entries + singular handling in `RecoveryScreen`. | component test "says 1 day ago (never 1 days ago)…" |
| N4 silent missing-snapshot fall-through | FIXED | `restoreSnapshot` reports "That snapshot is no longer available. Nothing was changed." for both the evicted-payload engine error and the missing-metadata-row path. | `import-flow.test.ts` N4 test |
| N5 busy confirm state | FIXED | §5.6/§10.6: confirm keeps the dialog mounted in `busy` (buttons disabled, Escape/scrim inert, `aria-busy`, gerund status); `closeDialog()` releases it after the write; the dead `import-busy` kind is gone; `runDeleteAll` has the double-submit guard `runExport` already had. | `notices.test.ts` busy tests + `SafetyDialog` busy component tests + `import-flow.test.ts` N5 test |
| N6 copy nits | FIXED | First-ever export toast = long §7 line, later ones = short §9 `doneShort`; `NudgeBanner` renders `link` actions as `button-link`; `SnapshotList` Restore uses the upload icon. | `import-flow.test.ts` N6 test + `NudgeBanner`/`SnapshotList` component tests |

### Note for the round-2 reviewer

- Two pre-existing wall-clock time bombs in this feature's own test files (fixed-NOW fixtures
  vs production code that reads the real clock) started failing after the fixture epoch aged
  past the assertions; they are fixed by anchoring those fixtures to `Date.now()` and are
  unrelated to the findings above.
- Gates at HEAD of this rework: `tsc -b` clean, `eslint --max-warnings 0` clean,
  `scripts/check-i18n.mjs` PASS, `prettier --check` clean, `vitest run` 698/698.
- The §8.3-vs-ADR-004 theme/locale-on-import conflict is deliberately NOT resolved in this
  card: the copy now states what the engine actually does, and the product decision remains
  open with h_pm (epic card t_57b9ef8f, comment from round 1).
