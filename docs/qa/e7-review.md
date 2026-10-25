# E7 Review — Tags, subtasks & priority migration (S1–S3)

- **Verdict: PASS (approve)** — commit `6370493`, reviewed by h_reviewer (t_d45b8cf7), 2026-10-26.
- **Spec deviation adjudicated: the meaning-preserving priority migration is RATIFIED** (see §1).
- All evidence below is first-hand: a clean worktree pinned to `6370493`
  (`git worktree add … 6370493`, shared `node_modules`), not the in-flight shared tree.

## 0. Gates (first-hand at 6370493)

| Check | Result |
| --- | --- |
| `npm test` (vitest run) | **1154/1154 green, 105 files** (includes the 4-file E7 battery: 38 tests) |
| `npm run typecheck` (`tsc -b`) | clean |
| `npm run lint` (`eslint . --max-warnings 0`) | clean (exit 0) |
| `npm run i18n:check` | PASS — en/th key sets, values, placeholders consistent |
| `npm audit --omit=dev` | 0 vulnerabilities (commit changes no dependencies) |
| `npm run test:coverage` | exit 0 against the configured per-glob thresholds (`src/domain/**`, `src/storage/**`, `src/portability/**` ≥ 80 all-four). Overall 85.75 stmts / 79.86 branch / 84.87 funcs / 88.06 lines; `taskRepo.ts` 89.74/81.35/100/99.37 |
| `npm run build` | green (tsc + vite + precache regen + sw build) |
| `npm run format:check` | **RED on 2 files — NOT E7's**: `src/domain/model.ts` + `vite.config.ts`, both last-touched by `fed96f5` (sync commit); the offending lines are the sync `StoreName` union entry and the sync coverage block. Every file changed by `6370493` is prettier-clean (verified file-by-file). Already disclosed in `cbf779c`. **Pre-push fix, cross-card (sync), not a reason to hold E7.** |
| TODO/FIXME without issue link | none in the diff |

## 1. Adjudication: priority migration mapping (the flagged deviation)

The decomposition's binding row was `0->P1, 1->P2, 2->P3, unset->P4`. The implementation maps
`2/High -> P1, 1/Medium -> P2, 0/Low -> P3, unset/unknown -> P4` (`legacyPriorityToLevel`,
src/storage/migrations.ts:54).

**Ruling: the implementation is correct and the deviation is ratified.** Evidence:

1. **The MVP encoding is `2`=High, `1`=Medium, `0`=Low** — verified first-hand in the pre-change
   tree (`6370493^:src/features/tasks/fields.tsx` `PRIORITIES` = `0→priority.low,
   1→priority.medium, 2→priority.high`; `TaskRow.tsx` `PRIORITY_ICON = {1: flag-medium, 2: flag-high}`).
2. **PROJECT_ANALYSIS does not pin a numeric direction.** §4 S3 is only "Proper priority model
   (P1–P4 or high/med/low refined per usage)". The literal row came from the decomposition, not
   the source-of-truth analysis.
3. **The literal row inverts user meaning**: legacy `0` (Low) would become `P1` (most urgent) and
   legacy `2` (High) would land at `P3`, one level above "no priority" — a domain-correctness
   defect against every existing user's data.
4. **The row's intent is preserved exactly**: three legacy levels → P1..P3 in priority order,
   unset → P4 = no priority (P4 default for new tasks). Record kept, never dropped; already-migrated
   `P1..P4` values pass through (idempotency tested).
5. Documented in the ADR-002 amendment §Decisions 1 with the revert switch named; the code comment
   flags this review card.

Consequence for the epic (t_eb2174d7): its acceptance text still quotes the literal row —
a comment has been left on the epic card so h_pm verifies against the **ratified** mapping
(`2→P1, 1→P2, 0→P3, unset→P4`), not the superseded literal one.

The two smaller deviations are also accepted: reserved `Recurrence` drops `count` (R4 line —
end-count is out of V1), and the subtask-delete disposition `{mode:'cascade'|'promote'}` with
default `promote` mirrors the list-deletion UX (both preselect the non-destructive option B).

## 2. Checklist — migration correctness / rollback

PASS.

- **One atomic step per version**: `toSchemaVersion3.stores = ['tasks']` (+`meta` added
  automatically); the version bump is written inside the same transaction (`executeStep`).
- **Auto-snapshot first**: `takeSnapshot` before any step; failure aborts with no data touched;
  a mid-chain step failure restores the snapshot and resets the in-memory schema version
  (`runMigrations`, migrations.ts:224–250).
- **Registry completeness**: exactly one contiguous step per version enforced; chain is
  `[to:2 sync_state, to:3 E7]` — numbering conforms to ADR-006 D3 + ADR-007 ("after sync_state
  step 2; never renumbered") and the cross-card hotspot resolution.
- **Rollback drill proven in tests** (tests/unit/storage/migration-v3.test.ts:128): 1→3 with
  snapshot; restore → **exact v1 bytes** (numeric priority, `count` present); re-run → converges
  to identical v3 rows.
- **Old exports upgrade through the same chain**: `migrateRows` + a v1 backup-document import test.
- **Never restamps** (migration is not a user write): `updatedAt` byte-identical assertion in tests.
- **Malformed data policy**: a well-formed-but-invalid recurrence (bad `freq`/`interval`) survives
  migration and is quarantined by boot validation — data preserved in the recovery file, never
  silently dropped; a recurrence missing `freq`/`interval` is left untouched. Verified against
  `checkRecurrence` (validate.ts:241).
- **Review-fix battery landed**: boot/drills schema pins → 3, scheduler `Priority` fixture → `'P2'`
  (invariant under both mapping readings), and the `to:2` step now sanitizes `sync_state.deviceId`
  with `isUlid` (the E1 P2 +1-quarantine fix — legitimate: validator accepts `''`, engine adopts a
  real id at setup).

## 3. Checklist — decision conformance (no re-litigated priority model)

PASS (with §1's ratified mapping).

- **P1..P4 four-level model**: `Priority` union, `PRIORITY_LEVELS`, `compareByPriority` (P1 first …
  P4 last), per-level sort as the PRIMARY key inside groups with manual order as default
  (views.ts:67; tests). UI offers exactly four levels, default `P4` = no priority.
- **Single-level subtasks**: enforced in **three** layers — repo `#checkParent` rejects a parent
  that itself has `parentTaskId` (taskRepo.ts:316–324), pipeline `createTask` optimistic guard
  (pipeline.ts:237), pipeline `move` guard (pipeline.ts:423); `PARENT_DEPTH_EXCEEDED` rule code.
  Completion is per-child (`setDone` on the child). Membership changes go through `move`, never a
  patch — `TaskPatch` deliberately has no `parentTaskId`.
- **Delete disposition**: `remove(id, {cascade|promote})` in ONE transaction; `cascade` reproduces
  the MVP tombstone+direct-child behavior; `promote` re-parents direct subtasks to the list top
  level (sortOrder kept — the `(sortOrder, id)` order is total). Default `promote` in the dialog
  (ConfirmDialog:74). Atomicity verified: mid-loop validation failures return `err` from inside
  `db.tx`, which **aborts the raw transaction** (db.ts:272–281) — no partial writes possible.
- **Recurrence reserved format**: `Recurrence = { freq: 'daily'|'weekly'|'monthly'|'weekdays',
  interval: number; until?: string }` — exactly the binding shape; no exceptions, no end-count;
  validator enforces freq union + integer `interval >= 1` + `YYYY-MM-DD` until and rejects unknown
  fields inside `recurrence`.
- **Tags denormalized with rename sweep**: `tags: string[]` unchanged on layout (no `tags` store);
  `TaskRepo.sweepTag` = ONE transaction over `getAll`, tombstoned rows included, rename
  de-duplicates, changed rows restamped like every write; validation per row; `txApp` aborts the
  whole sweep on any failure. Pipeline wraps it as a bulk optimistic op announcing `'all'`
  (ADR-003 D8.1), with committed-baseline rollback tested. **10k rename measured 31.2 ms** through
  the real repo (recorded in ADR-002 amendment §3 as mandated; the emulated-IDB 2k/7.2 s point is
  disclosed as a fake-indexeddb substrate artifact). Justification recorded: no Tag store; revisit
  only with evidence. Note: PROJECT_ANALYSIS §5.2 had suggested a `tags` store — the decomposition
  decision explicitly superseded it and the measurement justification is on file, so this is
  conformance, not drift.
- **i18n**: all new strings externalized, en/th parity green.

## 4. Checklist — schema-drift vs the ADR-002 chain

PASS.

- `APP_SCHEMA_VERSION = 3`; `idbVersion` stays **2** (no new stores/indexes — correct: tags stay
  denormalized and `by_parent` already existed). `onupgradeneeded` unchanged.
- Validator extended in lockstep: `TASK_FIELDS` + `tags`/`recurrence`, priority enum check,
  `checkRecurrence`, tag caps (ADR-004 §6.2: 1..100 chars, ≤50 tags) — the pipeline's
  `isTagName` (1..100) matches `MAX_TAG_LEN = 100` exactly (no rule drift).
- ADR-002 amendment (E7) appended with chain map v1/v2/v3, decisions, consequences;
  `docs/dev/domain-api.md` handoff updated for `remove(disposition)` / `sweepTag` /
  the ratified mapping.
- **LWW/tombstone semantics unchanged**: `src/domain/merge.ts` untouched since the domain core
  (`23f1430`); `6370493` only adds `remove`+`sweepTag` to taskRepo — both stamp
  `updatedAt`/`deviceId` exactly like every other write; no merge/tombstone/purge logic in the
  diff; merge/quarantine/tombstone-purge regression suites all green in the 1154.
- **Co-edit boundary**: `model.ts`/`schema.ts`/`validate.ts` and the first landing of the v3 step
  rode into `fed96f5` as disclosed coordinated co-edits (hotspot comments on both cards); `6370493`
  itself was committed with an explicit path list — no sibling in-flight content swept in. Final
  tree at `6370493` is complete and self-consistent.

## 5. Security

PASS (local-only app: no auth/endpoint/rate-limit/crypto surface in this diff).

- Input validation at every boundary: tag names (1..100, trimmed non-blank, RULE `TAG_INVALID`),
  priority enum, recurrence shape, parent ULID + live-parent + depth checks.
- No injection sinks: IndexedDB typed API only; no `innerHTML`/`dangerouslySetInnerHTML` in any
  touched UI (tag chips/dialogs render through Preact escaping); no string-built queries.
- No secrets, no dependency changes, `npm audit` 0 vulns; CSP untouched.

## 6. Non-blocking findings (fix before merge, no re-review needed)

1. `docs/dev/domain-api.md:92` — cheat-sheet line still reads `removeTask(id)`; the normative
   section (line 274) and `store.ts` both use `removeTask(id, disposition)`. One-word doc fix.
2. `npm run format:check` red on `src/domain/model.ts` + `vite.config.ts` — introduced by
   `fed96f5` (sync), disclosed in `cbf779c`; **must be prettier-written before the next push**
   (house verify runs format). Not E7-owned: every `6370493`-changed file is clean.
3. ADR-005 D2 precache regen still pending at HEAD — deliberately deferred to the last writer
   (flagged on t_00d7f17b + t_b5078638); `npm run build` proves the regen is mechanical. Required
   before push (CI `precache-freshness` reddens otherwise). **Cross-card, has an owner.**
4. ADR-002 amendment wording: "a malformed recurrence is left untouched" is true only when
   `freq`/`interval` are absent; a present-but-invalid pair is rewritten to the reserved key set
   first. Outcome identical (boot validation quarantines; data preserved) — wording nit only.

## 7. Verdict

**PASS.** Migration correctness/rollback, decision conformance (with the §1 ratified mapping),
schema-drift, and boundary discipline all hold; automated gates green first-hand on a clean
`6370493` worktree. Zero blocking findings. The four §6 items are cross-card/doc nits with owners.
