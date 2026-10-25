# Release-blocking a11y finding — `a11y.taskSaved` is dropped by the deferred-announce hand-over

**Card:** t_7f1e8f29 (MVP Definition-of-Done gate) · **Found:** 2026-10-25 · **HEAD:** `225a1f3`
**Class:** WCAG 2.2 AA — SC 4.1.3 Status Messages (and design `core-domain.md` §5.5, which
requires `a11y.taskSaved` on an edit save) · **Status: reproduced, root-caused, unfixed**

## Symptom

`tests/e2e/core-ui-keyboard.spec.ts:290` — *"keyboard-only: F1 capture → F2 edit → F3 complete →
F4 delete → F6 delete list"* — fails at the assertion `expectPolite(page, 'Task saved')` (line 388):

```
Error: polite announcement "Task saved" was never made
```

Observed at release HEAD in this gate run (`CI=true npx playwright test --project=chromium
tests/e2e/core-ui-keyboard.spec.ts`):

| context | initial attempts | failed | passed |
|---|---|---|---|
| full suite `npm run e2e` (4 runs) | 4 | 4 (1 later passed on Playwright retry) | 0 |
| isolated spec (2 runs) | 2 | 1 | 1 |
| isolated spec, `-g "F1 capture" --trace on` (2 runs) | 2 | 1 | 1 |
| **total** | **8** | **6** | **2** |

The save itself works every time (the dialog closes, the row shows `Buy oat milk`) — only the
status message never reaches the live region. This spec is **not** in the PR gate (`ci.yml` runs
only `e2e:smoke`, `a11y-axe`, `e2e:sw`, `e2e:data-safety`), so CI stays green — but `nightly.yml`
runs `npx playwright test --project=<browser>` (the whole suite), so **nightly is red** on this.

## Mechanism (from the failing run's own Playwright trace)

The announcer (`src/app/announce.ts`) gives each region one pending slot: `announce()` clears the
region and lands the text `ANNOUNCE_DELAY_MS` (60 ms) later, *unless* another `announce()` on the
same region increments the token first (lines 140–152) — then the pending message is silently
dropped. A `deferred` message sits in its own hold (`DEFERRED_ANNOUNCE_DELAY_MS` = 500 ms) and
then **hands over to the normal path** by calling `announce()` again (lines 128–136) — which
increments the token and therefore **cancels whatever non-deferred message is pending in that
moment**.

Sequence read out of the DOM snapshots inside the traces (region text over time, ms timestamps):

*Failing attempt (trace `…/core-ui-keyboard…-retry1/trace.zip`)*

```
34475  'Task added: Walk dog'
34685  ''                 <- announce() cleared the region for 'Task saved' (issued here)
34800  'This browser did not grant extra protection.'
       (the E3 first-write persistence notice, deferred hand-over, issued ~34740 — inside the
        60 ms window opened by 'Task saved' → token bumped → 'Task saved' never lands)
       -> the test polls window.__announcements.polite for 20 s: 'Task saved' never appears
```

*Passing attempt (same command, next run, trace `…/core-ui-keyboard…/trace.zip`)*

```
12415  'Task added: Walk dog'
12606  ''                 <- deferred hold expires: persistence notice issued
12735  'This browser did not grant extra protection.'
       ('Task saved' is issued AFTER that window closes → lands → assertion passes)
12886  'Task completed'
```

So the outcome is decided purely by whether the save's `announce()` lands inside the 55 ms
lead time before the deferred persistence notice fires (`first task write + 500 ms`) — a timing
race between `src/features/tasks/TaskEditor.tsx:124` (`announce(t('a11y.taskSaved'))`) and
`src/features/data-safety/persistGate.ts:65` (`announce(…, 'polite', { deferred: true })`).

Relevant arithmetic in the failing trace: first write ≈ 34324 ms → deferred fires ≈ 34824 ms;
save issued 34685 ms, would have landed 34745 ms — the hand-over at ≈34740 ms wins by ~5 ms.

## Why every gate so far stayed green

- `tests/unit/announce.test.ts:137` *"lands a deferred message after the window instead of
  superseding the one in flight"* only covers the case where the earlier message has **already
  landed** (it asserts `polite.textContent === 'Task added: Buy milk'` *before* the hold
  expires). The uncovered case is a non-deferred message still **pending** (issued <60 ms ago)
  when the deferred hand-over fires — exactly the failing interaction.
- `docs/qa/a11y-gate.md` announcements probes (12/12) and the E2/E5 keyboard evidence measure the
  add/complete/list/view messages; the save-vs-deferred-persistence collision is not in the probe
  matrix, and the race only appears when the test moves fast (automation, not manual timing).
- `e2e:smoke` / `e2e:a11y` / `e2e:sw` / `e2e:data-safety` (the CI PR gate) do not run this spec.

## Impact

1. **WCAG 2.2 AA SC 4.1.3**: a status message the app issued never reaches the user. The
   announcer's own contract (`src/app/announce.ts` header, lines 11–17) says the carve-out
   exists precisely so *"a status notice fired in the same tick cannot cancel the one in flight
   (WCAG 2.2 SC 4.1.3)"* — the reverse direction (deferred hand-over cancelling a pending
   user-facing message) is not covered.
2. **Design fidelity**: `docs/design/core-domain.md` §5.5 (line 226, 307, 529) requires
   `a11y.taskSaved` on an edit save.
3. **Nightly CI**: `nightly.yml` runs the whole suite in 4 browser projects → will be red.

## Repro (from the repo root, at `225a1f3`)

```bash
CI=true npx playwright test --project=chromium tests/e2e/core-ui-keyboard.spec.ts --trace on -g "F1 capture"
# then read the polite region out of the trace:
python3 docs/qa/mvp-dod-logs/probes/scan-announce-trace.py <dir-containing-trace.zip>
```

## Fix direction (for the implementer — not applied by this gate)

The deferred hand-over must not cancel a pending non-deferred message in the same region: when
`DEFERRED_ANNOUNCE_DELAY_MS` elapses while the region still has a message inside its 60 ms
landing window, the hand-over has to wait out that window (queue behind it) instead of bumping
the token. Any fix must keep `tests/unit/announce.test.ts` green and add a case for
"deferred fires while a non-deferred message is pending". Alternative (narrower, and it would
only move the race): issue `a11y.taskSaved` deferred — but the same collision then moves to the
next polite message, so the general fix is the honest one.
