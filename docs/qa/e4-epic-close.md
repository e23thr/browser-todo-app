# Epic E4 — Offline & App Shell — CLOSING verification report (round 3)

- **Epic card:** t_5ea89a3f (h_pm)
- **Date:** 2026-10-25 (round 3; round 1 held on QA-D1 + journey evidence, round 2 held on t_88e35359)
- **Verified commit:** `c590ab2` (shared main HEAD at verification time)
- **Verification environment:** clean clone `~/.hermes/profiles/h_pm/cache/scratch/e4-final-verify-838`
  of `c590ab2` (the shared tree carries siblings' uncommitted WIP and is never used for verification),
  `npm ci`, gates run in the clone.

## Verdict: ALL 6 acceptance criteria MET — epic CLOSED

The round-2 hold (`t_88e35359`, E3 boot-classification regression) landed at `c590ab2`. The
`e2e:sw` suite went from 8 passed / 8 failed to **16 passed / 0 failed / 0 skipped, exit 0** —
including the two E4-scoped specs that were red in round 2 (M9 cold boot, root-base Decision 8).

## Acceptance criteria — all verified first-hand at `c590ab2`

| Criterion | Status | Evidence (this run) |
|---|---|---|
| Network-disabled offline boot gives full function (add/complete/reload -> data present) via offline Playwright journey | **MET** | `offline task journey: add -> complete -> reload -> data present (E2 core UI)` PASS (2.4s) + `offline data journey: an offline write survives an offline reload` PASS (0.9s) |
| Warm/offline start-to-interactive <300 ms (measured) | **MET** | QA's independent probe re-run at `c590ab2`: 40/40 samples <300 ms. Unthrottled warm median 26.8 ms (max 36.4) / offline median 17.3 ms (max 21.6); 4x CPU-throttled warm median 89.5 ms (max 107.7) / offline median 75.9 ms (max 107.5). `withinBudget: true`. Raw: `docs/qa/e4-epic-close-boot-budget.json`. The strict budget ALSO asserted inside e2e:sw (`E2E_BOOT_BUDGET_MS=300`, `warm and offline start-to-interactive stay inside the boot budget (§9.1)` PASS) |
| Update applies only on user action, never mid-edit (E9 proven) | **MET** | 4/4 update specs PASS: detect -> toast -> apply -> exactly one reload (2.4s); E9 mid-edit no-reload + Apply flushes the draft first (2.6s); E9 multi-tab never reloads siblings (2.5s); stale-tab guard (2.4s) |
| Versioned caches cleaned on activate (QA D1) | **MET** | `cache lifecycle: activate purges old VERSIONS of this app only (Decision 3)` PASS (1.9s) — the landed red test, un-annotated |
| Correct SW scope under /<repo>/ base path | **MET** | `the non-root base path yields the scoped registration and cache namespace` PASS (152ms) AND the round-2-red root-base contrast `scope and cache naming are correct under a root base path (Decision 8)` PASS (263ms) — the E3 recovery-screen blocker is gone |
| NO manifest / install prompt ships in MVP (Q12) | **MET** | `MVP install scope (PO Q12): no web manifest and no install prompt anywhere` PASS (743ms) + my own static audit of the clean clone at `c590ab2`: ZERO hits for `beforeinstallprompt` / `rel=manifest` / `.webmanifest` in `src/`, `public/` (only `favicon.svg`), `index.html` |

## Full gate matrix on the clean clone of `c590ab2`

| Gate | Result |
|---|---|
| `CI=true E2E_BOOT_BUDGET_MS=300 npm run e2e:sw` | **16 passed / 0 failed / 0 skipped**, exit 0 (9.4s) |
| `npm run test` (unit+component) | **783 passed (68 files)**, exit 0 |
| `npm run typecheck` | clean, exit 0 |
| `npm run lint` (`--max-warnings 0`) | clean, exit 0 |
| `npm run format:check` | clean, exit 0 |
| `npm run build` + `node scripts/check-bundle-budget.mjs` | build OK, **budget RESULT: PASS** (no-wasm 0 hits, 12 shipped files); precache manifest reports `[unchanged]` on rebuild — fresh at HEAD |

All 16 e2e:sw specs named green: both offline journeys, degraded-network x2, cache lifecycle (D1),
M9 cold boot, boot budget §9.1, silent failed check, root base (Decision 8), non-root base scope,
CSP parity (Decision 9), Q12 install scope, and the 4 update-flow specs (E9 x2, single reload,
stale-tab guard).

## Work items (all done)

- t_a7b86d9c ADR-005 Service worker & update strategy — done
- t_6460ac5a Impl: SW app shell, update flow & offline-complete (M9) — done
- t_be7f0810 Test: offline journeys, update flow & cache lifecycle — done (PASS, D1/D2/D3)
- t_5b4c7b35 Review: service worker & update flow — done (APPROVE)
- Gating fixes landed during holds: t_55ba8e9f (QA-D1 purge scoping), t_fa3af43d (task journey +
  real-composer E9 evidence), t_88e35359 (E3 boot classification — the round-2 gate)

## Non-gating follow-ups (tracked on the board, none block this epic)

- t_b3e4116a — QA-D2 CI hardening: set `E2E_BOOT_BUDGET_MS=300` in the nightly env + put `e2e:sw`
  in the PR gate (process only; the measured-budget criterion is evidenced).
- t_254ddae8 — precache-manifest staleness (3rd recurrence) + CI freshness gate — completed by
  h_junior_coder after round 2; manifest verified fresh at `c590ab2` in this run.
- t_4dfee282 — V1 S13 install flow (epic E6, first V1 item; the structural R1 fix). MVP keeps
  shipping WITHOUT manifest/install prompt (Q12).

## Board routing performed by this run (cross-epic PM duty flagged by t_88e35359)

- **NEW: theme-boot fix card** (h_junior_coder) — `tests/e2e/theme-boot.spec.ts` (E5/M7 no-FOUC
  surface) has 5 red specs in every configured browser project (20 reds) at `c590ab2`, all failing
  at the `Today` h1 wait because fresh profiles now land on E3's first-run onboarding screen — the
  same staleness class the smoke suite has. I reproduced this first-hand. The card is sequenced
  behind t_5edbfb37 (shared `seedOnboardingDone` helper, collision avoidance on
  tests/e2e/helpers.ts) and is linked as a dependency parent of **E5's epic t_db6845bc** (same
  standard as E1/E4: an epic whose own e2e suite is red at HEAD is not closable).
- **t_5edbfb37** (smoke suite fix, E1's gate) is `needs_input`-blocked awaiting the orchestrator's
  A/B/C call. **Decision: Option A confirmed** — t_88e35359 fixed the P1/P2 product defects the
  block report documented, so the originally decided `seedOnboardingDone` fix can land verbatim.
  Left as a comment on the card; a human unblock will respawn it.

## MVP release gate (t_7f1e8f29)

E4 is now done, satisfying one of the release gate's five parent edges. Remaining gates: E1
(t_18f28c32, blocked on the smoke fix), E2 (t_9b61ecf5), E3 (t_57b9ef8f, running), E5
(t_db6845bc, now also gated on the theme-boot fix).
