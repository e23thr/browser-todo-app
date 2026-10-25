# Epic E3 — Data Safety & Portability (MVP): epic verification

- Verified by: h_pm (kanban card t_57b9ef8f), 2026-10-25
- Verified at: clean git worktree of shared HEAD `c590ab2` (node_modules symlinked) — the shared
  workspace carries other cards' WIP and was not used as the test base
- **Verdict: ACCEPTANCE CRITERIA MET.** All 5 PO ratifications from the data-safety UX review are
  decided (recorded below); 4 follow-up cards are routed (none of them data-loss-bearing).

## 1. First-hand verification runs (this card)

| Run | Command | Result |
|---|---|---|
| Unit + component + i18n gates | `npm run test` (vitest) | 68 files / 783 tests / 0 failures |
| Typecheck | `npm run typecheck` (`tsc -b`) | clean, exit 0 |
| E3 scripted drills (AC 1–5) | `CI=true npm run e2e:data-safety` (journey spec) | 11/11 passed (drills 1–14), real Chromium + real IndexedDB, offline |
| SW / cold-boot suite (AC 6 surface) | `CI=true E2E_BOOT_BUDGET_MS=300 npm run e2e:sw` | 16/16 passed |
| Committed data-safety suites | `npx vitest run tests/unit/data-safety tests/component/data-safety*.test.tsx` | 6 files / 116 tests passed |
| CI job presence ("passes in CI") | `.github/workflows/ci.yml` | `e2e-data-safety` (line 199) + `e2e-sw` (line 176) jobs present at HEAD |
| t_b1595f03 QA deliverables replayed at HEAD (untracked in the shared tree) | component QA suite + `e2e:data-safety` UX spec | 38 passed / 1 failed / 1 expected-fail (40 scenarios); 15/16 e2e (4/5 UX) — the 2 reds are **stale-test drift vs `t_88e35359` + the final rework**, not product defects (see §4, card B) |
| Out-of-epic probe (routing input) | `npx playwright test tests/e2e/theme-boot.spec.ts` | 5/5 red on the first-run handshake — E5 surface, routed (card C) |

## 2. Acceptance criteria — evidence map

1. **Scripted offline journey export → wipe → import → restored (byte-equivalent) passes in CI —
   MET.** Drill 1 green first-hand at `c590ab2` (records + settings byte-equivalent per §2.4,
   tombstones restored, zero network requests); drill suite built and certified by `t_f0702c05`
   (11/11 across 5 runs) and re-verified here after the UX rework (`067e769`) and the boot-class
   fix (`2e6da03`) landed. CI job `e2e-data-safety` runs it on every PR.
2. **Auto-snapshots rotate (last-3) and the pre-import snapshot undoes an import — MET.**
   Drills 9 (rotation: newest-3 auto, manual permanent, payloads evicted with rows) and 10
   (undo byte-equivalent, with undo-of-undo) green first-hand; unit coverage in
   `tests/unit/portability`. §8.4's 7-day pre-import retention protection (max-2-protected) and
   the download escape hatch were added by `t_f5453962` (B2) at the engine level.
3. **Hostile imports rejected with zero side effects — MET.** Drills 4/7 green: 12 hostile or
   malformed inputs (oversize real File, wrong/missing schemaVersion, future formatVersion,
   prototype-pollution, depth bomb, truncated JSON, 100 001-task bomb, all-corrupt, recovery-file
   attempt…) each rejected with zero DB writes and no snapshot. Validation caps re-pinned
   binding-exact to ADR-004 §6.2 (`t_e0b14058` P3, boundary-probed).
4. **Corrupt records quarantined to a recovery file (never silent) — MET.** Drills 5/6/8/14 green:
   per-record quarantine with verbatim raw entries to a downloadable recovery document, which is
   never persisted and never importable (drill 14). The whole-file NOTHING_TO_IMPORT reject now
   carries the recovery document (`t_e0b14058` P2) and the UX offers its download (`t_f5453962`
   B3) — nothing is dropped silently on any error path (engine review round 2: no-silent-loss
   PASS on every error path).
5. **QuotaExceededError never drops a write — MET.** Drill 12 green in a real browser (atomic
   abort: deletes rolled back with the failing puts; export survives the best-effort stamp
   failure). UX pending-write queue: every dismissal path including Escape keeps the entry;
   retry retires it only on success (13 committed tests + QA S-suite; the one QA `it.fails`
   evidence test is the known non-blocking D1 banner-derivation nit, §5).
6. **persist() + nudges + eviction warnings + onboarding per §5.5, verified with mocked storage
   states — MET.** Committed suites (116 tests) pin the §5.5 stack: persist() requested once at
   the first task write with granted/denied surfaced; 14-day backup nudge + always-reachable
   export; pre-boot eviction classification (wiped / long-absence / shrunken / ack re-arm) with
   the §3.4 "empty is not erased" rows after `2e6da03`; honest onboarding naming the iOS Safari
   7-day rule (all 5 mandated places, en + th — review-verified). Mocked StorageManager states in
   unit/component tests; `t_b1595f03` additionally ran the surface against a real StorageManager,
   real IndexedDB and real key events in Chromium (its suites are being re-pinned and committed
   by card B — §4).

## 3. PO ratifications (h_pm decisions, recorded 2026-10-25)

1. **§8.3 vs ADR-004 — settings/theme/locale on import: ADR-004 wins.** Import replaces the
   settings record wholesale: theme applies immediately (mirrorTheme), locale on next boot,
   `lastBackupAt` comes from the file. Grounding: ADR-004 is the binding sole-decider record for
   import semantics and PROJECT_ANALYSIS §7.4 defines import as "replace" with the pre-import
   snapshot as the undo; design spec §8.3's device-local carve-out was downstream drift. The
   confirm copy now states the truth in en+th (B1 fix). PO may override — the alternative is an
   engine change on a portability card.
2. **§8.4 deviations: ratified as implemented.** (a) Restore of the undo keeps taking its own
   pre-import snapshot ("undo-of-undo") — strictly safer than §8.4's "creates NO new snapshot"
   line and binding per ADR-004 §8.1; (b) the 7-day pre-import retention protection (max-2
   protected) and the download escape hatch are now implemented, so §8.4's retention text and
   the engine agree. The §8.4 doc line is amended by the erratum (card B).
3. **OQ-3 emergency visibilitychange snapshot: dropped from MVP (ratified).** A DB snapshot
   cannot contain content that never reached the DB; the pending-write queue (never-drop,
   tested) is the correct mechanism and §5.5 does not require the snapshot.
4. **Authored copy (shrunken banner, quota-pending body, restore-confirm body, partial-import
   toast, plus the rework's extended confirm/reject copy): ratified as-is** — plain, non-alarming,
   consistent with spec tone; fully externalized (i18n en+th) so the PO can revise cheaply later.
5. **QA D1 settings-default drift: single source of truth decided.** The canonical home is
   `src/domain/model.ts` `DEFAULT_SETTINGS` (ADR-003 canonical record home); the value is
   `weekStart: 1` (Monday) — matching the fresh-profile behavior the domain model already
   produces and ADR-004 Decision 10's "wipe = an effectively fresh install". Both other copies
   (`src/portability/constants.ts` `DEFAULT_SETTINGS_RECORD`, `src/app/settings.ts`) must derive
   from it instead of carrying their own `weekStart: 0`. The setting is user-configurable in M14;
   the PO can move the default with a one-line change. Implementation: card A (§4).

## 4. Follow-ups routed (created cards)

| Card | Title | Owner | Notes |
|---|---|---|---|
| A | `[E3] Fix: settings defaults single-source (QA D1 — weekStart drift)` | h_junior_coder | implements ratification 5; gates the MVP DoD gate |
| B | `[E3] chore: land the data-safety UX QA deliverables + ratification errata` | h_junior_coder | re-pins 2 stale QA tests to the landed fixes, commits `tests/component/data-safety-ux-qa.test.tsx` + `tests/e2e/data-safety-ux.spec.ts`(+harness)+config, amends design §8.3/§8.4; gates the MVP DoD gate |
| C | `[E5] Fix: e2e theme-boot suite vs E3 first-run onboarding (npm run e2e red)` | h_junior_coder | first-hand: 5/5 red at `c590ab2`, all on the first-run handshake; work-item → Epic E5 (its "flash-free theming" evidence) |
| D | `[E5] chore: make repo-wide npm run lint green (QA probe scripts + coverage-e2b/)` | h_junior_coder | open-process defect D5 from `t_b1595f03`; gates the MVP DoD gate |

Stale-drift detail for card B (measured at `c590ab2`):
- `tests/component/data-safety-ux-qa.test.tsx` — S5 "Start fresh … not re-flagged as evicted"
  expects `{kind:'wiped'}` from a scripted input that the §3.4 fix now classifies `normal`
  (`ClassifyInput` gained `priorData`; fixtures at lines 626/660/671 also fail `tsc`). The fix's
  semantics are binding (pinned by `t_88e35359`'s 8 classify tests) — re-pin the QA fixtures,
  do not weaken `classifyBoot()`.
- `tests/e2e/data-safety-ux.spec.ts` — "REAL keyboard: Tab traps in the quota dialog…"
  `getByRole('button', {name: 'Import…', exact: true})` now resolves to 2 buttons (strict-mode
  violation) after the rework's added import affordances — disambiguate the locator (scope to
  the panel).

## 5. Residual risks / disclosed trade-offs (not blocking)

- **iOS Safari 7-day eviction residual risk** — PO-accepted (PROJECT_ANALYSIS §5.5), named in the
  onboarding and nudges; structural fix = V1 Epic E6 (PWA installability).
- Pre-boot probe is awaited before first render (bounded at 1.5 s) — documented trade-off vs the
  300 ms boot budget (reviewer info I1).
- QA D1 Escape-banner derivation nit (`DataSafetyHost.tsx` derive effect) — open-product
  non-blocking; no write is ever dropped (tested). Tracked on card B as an optional item.
- Cross-epic hygiene: several QA deliverables remain untracked in the shared workspace (E3's are
  card B; E2's test cards left `tests/component/e2-core-ui-qa.test.tsx`,
  `tests/e2e/core-ui-keyboard.spec.ts`, `tests/e2e/qa-search-reorder.spec.ts` and 3 probe unit
  files untracked). E2's verification should land them; the MVP DoD gate should treat untracked
  QA evidence as not-done.
- Hotspots: `tests/e2e/helpers.ts` (card C adds the onboarding handshake helper — the same
  helper `t_5edbfb37` decided for the smoke suite; coordinate, don't duplicate),
  `src/features/data-safety/**` (review-green surfaces — rework only with new evidence).
