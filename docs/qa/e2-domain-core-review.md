# QA evidence — [E2] Review: Domain core (t_371b966c)

Reviewer: h_reviewer. Reviewed scope: commits 23f1430, 8adc449, 4fbab11, 322986d
(src/domain/**, src/storage/repos/**, src/storage/errorLog.ts, src/app/tabSync.ts,
docs/dev/domain-api.md) against ADR-003 (binding), ADR-002 (binding), PROJECT_ANALYSIS
§5.2/5.3/6.2/9.3.

Verification ran in an isolated clean clone of 322986d (scratch e2-domain-review-56), not the
shared workspace — the workspace tree carries other cards' in-flight work (e.g. the untracked
tests/unit/i18n-document-meta.test.ts that currently fails `tsc -b`; NOT this card's).

## Automated checks (clean clone, 322986d)

- `npm run lint` (eslint --max-warnings 0): PASS, zero warnings.
- `npm run typecheck` (tsc -b, strict + noUncheckedIndexedAccess): PASS.
- `npx vitest run`: 517/517 tests, 49 files, all PASS.
- Coverage (lcov, independent aggregation): src/domain lines 95.65% / funcs 93.26% /
  branches 82.34% — ≥80 gate PASS. src/storage/repos lines 89.80% / branches 70.00%
  (aggregated src/storage gate passes; see N2 for the listRepo gap).

## Checklist verdicts (task AC)

| Checklist item | Verdict |
|---|---|
| ADR conformance | **FAIL** — D1/D2 break ADR-003 Decision 3 step 4a/4b invariants at the multi-record boundary; D3 violates Decision 8.1 sender rule 2; N2 violates Decision 4's error-log observability for the list rebalance |
| LWW fidelity (§6.2) | PASS — merge.ts compareLww is exactly (updatedAt, deviceId), antisymmetric, tested; conflictCopyTitle 1000-cap; MVP import is REPLACE-only per ADR-004 Decision 11 (no silent overwrite); upsertImported stays the reserved hook |
| Tombstone/purge policy | PASS — repos tombstone + single-bounded child cascade in one tx (idempotent remove), list-delete disposition per ADR-002 Decision 6 verbatim, auto purge >90d throttled 24h, explicit purge all-ages, never live rows |
| Single-write reorder | PASS — exactly one put per move (put-counting tests), neighbors untouched; rebalance hatch is the documented exception (see N2) |
| Boundary discipline | PASS — ESLint no-restricted-imports/no-restricted-globals enforce domain purity; domain imports only domain; repos adapt ports; lint clean |
| Error contract | PASS with notes — Result<T, AppError> at every seam; QUOTA_EXCEEDED typed end-to-end, surfaces via write-failed + onError; nothing throws across seams. Info: tabSync refresh/sweep read failures return silently without an error-log entry |

## Blocking findings (all reproduced; see repro source below)

D1 (optimistic-rollback correctness — silent UI/store divergence).
`MutationRunner` never updates the committed baseline for multi-record ops whose port returns
`Result<void>` (`src/domain/pipeline.ts` — `removeList` settle callbacks return `{}` and
`#rememberCommitted({})` is a no-op). After a settled `removeList(L1, {mode:'move'})` the store
has the moved task in L2 but `#committedTasks` still holds its pre-move image. A later FAILED
write on that task re-anchors it to the OLD list — repro line 78: expected 'L2', received 'L1'.
This violates the card AC ("no silent divergence between UI state and store") and the documented
invariant ("rollback re-anchors to the LAST COMMITTED image"). Fix: on success of a multi-record
op, update/drop the committed baseline for every touched id (moved rows → new image, evicted ids
→ delete). To also honor "stamps are authoritative from the repo" (step 4a) for moved rows, have
`ListPort.remove` return the written rows or re-read them at settle.

D2 (ghost committed images resurrect deleted rows).
`removeTask`/`removeList(tombstone)` settle with `{}`, so `#committedTasks`/`#committedLists`
keep the deleted rows' images forever. A subsequent failed `upsertImported` of a row whose id was
previously deleted re-anchors the ghost into state — repro: task 'X' reappears after the failed
import although it is tombstoned in the store. Fix: on successful delete, record
`{evictTasks: [...]}` / `{evictLists: [...]}` into the committed baseline.

D3 (BroadcastChannel protocol vs binding ADR — Decision 8.1 sender rule 2).
Normative: "ops that touched many rows (list-delete disposition, import, purge, rebalance) send
'all'". Actual onCommitted payloads: `removeList` disposition → `{lists:['L1'], tasks:['X']}`;
`upsertImported` → `{tasks:['A','B','C']}`. Additionally the rebalance hatch (which rewrites
EVERY row of the sibling group) has no signal path at all — receivers re-read only the moved row,
and rebalanced fresh keys can sort outside the old key space, so another tab can show scrambled
order until its next sweep. Fix: announce `'all'` for these op classes; give the rebalance hatch a
signal (e.g. repo result flag) so a rebalance also announces `'all'`.

D4 (watermark sweep leapfrog — backstop does not guarantee eventual consistency).
`tabSync.ts` advances the watermark on every announce/receive/commit to `max(watermark, clock())`
and to received rows' `updatedAt`. Rows written by another tab with `updatedAt` below the advanced
watermark are permanently invisible to `changedSince(> watermark)` — repro C: tab B's row (t=110,
broadcast lost) never converges after tab A's own commit (t=120) bumps the watermark; the control
without the interleaved announce converges. Breaks ADR-003 Decision 8.2's guarantee for
interleaved activity (the idle-overnight case still works). Fix: advance the watermark only from
full sweeps (max updatedAt actually observed in a sweep), or sweep with `>=` + dedup; targeted
refreshes and own commits must not advance it.

## Non-blocking (fix before merge, no re-review)

N1. `#clearPending` (pipeline.ts) clears a record's `pending` entry when the FIRST of two queued
ops on that record settles (repro D: expected pending=true while op2 in flight, got false). This
also bypasses `reconcile`'s in-flight skip for the second op. Clear only when no live entry
references the id.

N2. ListRepo's rebalance hatch (src/storage/repos/listRepo.ts:176-201) is untested (coverage:
176-201 uncovered; listRepo branches 52.83%) and does not write to the structured error log,
while TaskRepo's does (`logAppError('repos','reorder-rebalance',…)`). ADR-003 Decision 4 makes the
rebalance "observable in the local error log". Add the same 32-char-exhaustion drill for lists and
log it.

N3 (info). Interpretation notes (docs/dev/domain-api.md §10) adjudicated: 2–7 ACCEPTED.
Note 1 accepted with a nit: `createTask`/`createList` mint their own ids and silently override a
caller-supplied `draft.id`/`input.id` — harmless (the runner is the minter of record) but either
honor it or document that it is ignored. Note 2 accepted with a requirement: moving a parent task
to another list orphans its direct subtasks in the old list (uniform view rule renders them at
depth 0 there) — pin this with a test and record it in an ADR-003 amendment so the UI cards don't
assume children follow the parent.

## Repro suite (fails 6/8 on 322986d; 2 controls pass)

Run: `npx vitest run tests/unit/domain/review-repro.test.ts` (uses tests/unit/domain/fakes.ts).
Failing: A (D1, line 78 post-rollback), A2 (D2), B×2 (D3), D (N1), C (D4). Passing: the sanity
rollback test and the C control. Source below.

```ts
/**
 * REVIEW REPRO (h_reviewer, t_371b966c) — expected-behavior assertions for
 * suspected defects. A FAILING test here is evidence of the defect.
 */
import { describe, expect, it } from 'vitest';
import { ok, type AppError } from '../../../src/domain/kernel';
import { MutationRunner } from '../../../src/domain/pipeline';
import type { ChangeSet } from '../../../src/domain/sync';
import { createTabSync, type TabSyncReads } from '../../../src/app/tabSync';
import {
  FakeListPort,
  FakeRecorder,
  FakeSettingsPort,
  FakeTaskPort,
  flushMicrotasks,
  makeListRow,
  makeSettingsRow,
  makeTaskRow,
} from './fakes';

function makeRunner(rec: FakeRecorder, committed: ChangeSet[] = []) {
  const tasks = new FakeTaskPort(rec);
  const lists = new FakeListPort(rec);
  const settings = new FakeSettingsPort(rec);
  let now = 100;
  let n = 0;
  const runner = new MutationRunner({
    tasks,
    lists,
    settings,
    clock: () => now,
    ids: () => `ID${String((n += 1))}`,
    orderKeys: { between: () => 'm', first: () => 'h' },
    deviceId: 'TAB-A',
    onCommitted: (c) => committed.push(c),
  });
  return {
    runner,
    tasks,
    lists,
    bump: (t: number) => {
      now = t;
    },
  };
}

const L1 = makeListRow({ id: 'L1', name: 'One', sortOrder: 'h' });
const L2 = makeListRow({ id: 'L2', name: 'Two', sortOrder: 'i' });
const X = makeTaskRow({ id: 'X', listId: 'L1', sortOrder: 'h', title: 'old', updatedAt: 50 });

describe('review repro A: settled removeList(move) keeps the store as rollback baseline', () => {
  it('a later failed write must NOT roll the moved task back to the pre-move list', async () => {
    const rec = new FakeRecorder();
    const committed: ChangeSet[] = [];
    const { runner, tasks, bump } = makeRunner(rec, committed);
    tasks.loaded = { tasks: [X], lists: [L1, L2], settings: makeSettingsRow() };
    await runner.load();

    // Delete list L1 with disposition move -> L2 (one repo transaction).
    const p = runner.removeList('L1', { mode: 'move', targetListId: 'L2' });
    await flushMicrotasks();
    rec.succeed(undefined); // repo committed: X.listId = 'L2', stamped
    await p;

    // Store truth after commit: X lives in L2.
    expect(runner.getState().tasks.get('X')?.listId).toBe('L2');

    // Now a failing write on X (e.g. QUOTA_EXCEEDED).
    bump(200);
    const p2 = runner.patchTask('X', { title: 'new' });
    await flushMicrotasks();
    rec.fail({ code: 'QUOTA_EXCEEDED' });
    await p2;

    // INVARIANT (task AC: "no silent divergence between UI state and store"):
    // rollback re-anchors to the LAST COMMITTED image = X in L2.
    const after = runner.getState().tasks.get('X');
    expect(after?.listId).toBe('L2');
    expect(after?.title).toBe('old');
  });
});

describe('review repro A2: ghost committed images must not resurrect deleted rows', () => {
  it('a failed import of a previously deleted task must not resurrect it', async () => {
    const rec = new FakeRecorder();
    const { runner, tasks, bump } = makeRunner(rec);
    tasks.loaded = { tasks: [X], lists: [L1, L2], settings: makeSettingsRow() };
    await runner.load();

    // Delete X (succeeds -> tombstoned in the store).
    const p = runner.removeTask('X');
    await flushMicrotasks();
    rec.succeed(undefined);
    await p;
    expect(runner.getState().tasks.has('X')).toBe(false);

    // Import a file containing a row with id X (stale export) — write FAILS.
    bump(300);
    const p2 = runner.upsertImported([
      makeTaskRow({ id: 'X', listId: 'L1', title: 'imported', updatedAt: 40 }),
    ]);
    await flushMicrotasks();
    rec.fail({ code: 'QUOTA_EXCEEDED' });
    await p2;

    // X is tombstoned in the store; it must not reappear in state.
    expect(runner.getState().tasks.has('X')).toBe(false);
  });
});

describe('review repro B: bulk ops broadcast (ADR-003 Decision 8.1 rule 2)', () => {
  it("remove-list disposition must announce 'all'", async () => {
    const rec = new FakeRecorder();
    const committed: ChangeSet[] = [];
    const { runner, tasks } = makeRunner(rec, committed);
    tasks.loaded = { tasks: [X], lists: [L1, L2], settings: makeSettingsRow() };
    await runner.load();
    const p = runner.removeList('L1', { mode: 'move', targetListId: 'L2' });
    await flushMicrotasks();
    rec.succeed(undefined);
    await p;
    expect(committed.at(-1)).toBe('all');
  });

  it("import must announce 'all'", async () => {
    const rec = new FakeRecorder();
    const committed: ChangeSet[] = [];
    const { runner, tasks } = makeRunner(rec, committed);
    tasks.loaded = { tasks: [], lists: [L1], settings: makeSettingsRow() };
    await runner.load();
    const p = runner.upsertImported([
      makeTaskRow({ id: 'A', listId: 'L1' }),
      makeTaskRow({ id: 'B', listId: 'L1' }),
      makeTaskRow({ id: 'C', listId: 'L1' }),
    ]);
    await flushMicrotasks();
    rec.succeed(undefined);
    await p;
    expect(committed.at(-1)).toBe('all');
  });
});

describe('review repro D: pending affordance survives until the LAST in-flight op settles', () => {
  it('settling the first of two queued ops on one record keeps it pending', async () => {
    const rec = new FakeRecorder();
    const { runner, tasks, bump } = makeRunner(rec);
    tasks.loaded = { tasks: [X], lists: [L1], settings: makeSettingsRow() };
    await runner.load();
    const p1 = runner.patchTask('X', { title: 'one' });
    bump(150);
    const p2 = runner.patchTask('X', { title: 'two' });
    await flushMicrotasks();
    rec.succeed(makeTaskRow({ id: 'X', listId: 'L1', title: 'one', updatedAt: 100 }));
    await p1;
    await flushMicrotasks();
    expect(runner.getState().pending.has('X')).toBe(true); // op2 still in flight
    rec.succeed(makeTaskRow({ id: 'X', listId: 'L1', title: 'two', updatedAt: 150 }));
    await p2;
    expect(runner.getState().pending.has('X')).toBe(false);
  });
});

describe('review repro C: watermark sweep must not leapfrog unobserved rows', () => {
  it('a lost-broadcast row written before this tab\'s own commit is still swept', async () => {
    const rec = new FakeRecorder();
    const { runner, tasks, bump } = makeRunner(rec);
    tasks.loaded = { tasks: [], lists: [L1], settings: makeSettingsRow() };
    await runner.load();

    // Fake "store" the sweep reads from. Tab B wrote X at t=110 (broadcast lost).
    const store = [makeTaskRow({ id: 'X', listId: 'L1', title: 'from B', updatedAt: 110 })];
    let now = 100;
    const reads: TabSyncReads = {
      loadAll: () => Promise.resolve(ok({ tasks: [], lists: [], settings: makeSettingsRow() })),
      getSettings: () => Promise.resolve(ok(makeSettingsRow())),
      readRows: () => Promise.resolve(ok({ tasks: new Map(), lists: new Map() })),
      tasksChangedSince: (since: number) =>
        Promise.resolve(ok(store.filter((t) => t.updatedAt > since))),
      listsChangedSince: () => Promise.resolve(ok([])),
    };
    const tabSync = createTabSync({
      runner,
      reads,
      clock: () => now,
      tabId: 'TAB-A',
      channelFactory: () => ({ postMessage: () => {}, onmessage: null, close: () => {} }),
    });
    tabSync.start();

    // Tab A's own commit at t=120 (announce bumps the watermark past 110).
    now = 120;
    bump(120);
    const p = runner.patchTask('A1', { title: 'x' }); // nonexistent -> rejected; announce directly
    void p;
    tabSync.announce({ tasks: ['A1'] });

    // Tab focus sweep at t=130 must converge X even though its broadcast was lost.
    now = 130;
    await tabSync.sweep();
    await flushMicrotasks();
    expect(runner.getState().tasks.has('X')).toBe(true);
    tabSync.stop();
  });

  it('control: without the interleaved announce the sweep DOES converge', async () => {
    const rec = new FakeRecorder();
    const { runner, tasks } = makeRunner(rec);
    tasks.loaded = { tasks: [], lists: [L1], settings: makeSettingsRow() };
    await runner.load();
    const store = [makeTaskRow({ id: 'X', listId: 'L1', title: 'from B', updatedAt: 110 })];
    let now = 100;
    const reads: TabSyncReads = {
      loadAll: () => Promise.resolve(ok({ tasks: [], lists: [], settings: makeSettingsRow() })),
      getSettings: () => Promise.resolve(ok(makeSettingsRow())),
      readRows: () => Promise.resolve(ok({ tasks: new Map(), lists: new Map() })),
      tasksChangedSince: (since: number) =>
        Promise.resolve(ok(store.filter((t) => t.updatedAt > since))),
      listsChangedSince: () => Promise.resolve(ok([])),
    };
    const tabSync = createTabSync({
      runner,
      reads,
      clock: () => now,
      tabId: 'TAB-A',
      channelFactory: () => ({ postMessage: () => {}, onmessage: null, close: () => {} }),
    });
    tabSync.start();
    now = 130; // no own commit in between
    await tabSync.sweep();
    await flushMicrotasks();
    expect(runner.getState().tasks.has('X')).toBe(true);
    tabSync.stop();
  });
});

describe('sanity: failure path plumbing works', () => {
  it('a plain failed patch rolls back and reports write-failed', async () => {
    const rec = new FakeRecorder();
    const { runner, tasks } = makeRunner(rec);
    tasks.loaded = { tasks: [X], lists: [L1], settings: makeSettingsRow() };
    await runner.load();
    const p = runner.patchTask('X', { title: 'new' });
    expect(runner.getState().tasks.get('X')?.title).toBe('new'); // optimistic
    await flushMicrotasks();
    rec.fail({ code: 'QUOTA_EXCEEDED' } as AppError);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(runner.getState().tasks.get('X')?.title).toBe('old');
  });
});
```
