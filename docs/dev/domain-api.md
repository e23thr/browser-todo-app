# Domain core API summary (handoff from t_aee34500)

Implementation of **ADR-003** (`docs/adr/ADR-003-domain-layer.md`, BINDING) over the **ADR-002**
storage contract (`docs/dev/storage-api.md`). This is the normative surface for the UI impl cards
(`t_a2c647e1` core UI, `t_b5078638` org features) and the E2 test/review cards.

**Boundaries (ESLint-enforced):** `src/domain/` is pure — no DOM, no IDB, no Preact, no imports
outside `domain/`. `src/storage/repos/` adapts `AppDB` to the ports (may import `domain/`).
`src/features/*/store.ts` is the ONLY place domain state meets Preact signals. `src/app/` composes.

## 1. Record types & kernel

- `src/domain/model.ts` — canonical `Task`/`List`/`Settings`/`TaskStatus`/`Priority`/`Recurrence`
  (byte-identical to ADR-002 §3; `src/storage/types.ts` re-exports them), plus `TaskDraft`,
  `TaskPatch`, `StoreName`, `DEFAULT_SETTINGS`.
- `src/domain/kernel.ts` — `Result<T, E>` (`ok`/`err` helpers), `StorageError` (exact ADR-002
  §10.1 union, re-exported by `src/storage/errors.ts`), `RuleError`, `AppError = StorageError |
  RuleError`, `isRuleError`.
- **Error contract: nothing throws across a seam.** Every port/runner method returns
  `Promise<Result<T, AppError>>`. `QUOTA_EXCEEDED` is typed end-to-end — never swallowed; wire it
  to the §5.5 export/cleanup dialog. `UNAVAILABLE`/`BLOCKED`/`NEWER_SCHEMA` map to the §5.5 honest
  states. Rule errors:

  | rule | when |
  |---|---|
  | `TASK_MISSING` | mutation on an absent/tombstoned record (stale UI; also used for absent lists) |
  | `PARENT_DEPTH_EXCEEDED` | subtask of a subtask (V1 is one level) |
  | `REORDER_TARGET_NOT_IN_GROUP` | move reference id outside the declared sibling group |
  | `LIST_DELETE_TARGET_MISSING` | delete-list disposition target missing or identical |

## 2. Ports (`src/domain/ports.ts`) — what the repos implement

```ts
type Clock = () => number;            // epoch ms UTC (injected)
type IdFactory = () => string;        // ULID (injected)
type OrderKeyOps = { between(a, b): string; first(): string };  // storage/orderKey.ts shape

type MoveTarget = {
  group: { listId: string; parentTaskId: string | null };  // sibling group
  position: 'first' | 'last' | { afterId: string } | { beforeId: string };
};

interface TaskPort {
  loadAll(): Promise<Result<{ tasks: Task[]; lists: List[]; settings: Settings }, AppError>>;
  create(draft: TaskDraft): Promise<Result<Task, AppError>>;
  patch(id: string, patch: TaskPatch): Promise<Result<Task, AppError>>;
  setDone(id: string, done: boolean): Promise<Result<Task, AppError>>;
  move(id: string, target: MoveTarget): Promise<Result<Task, AppError>>;   // one put
  remove(id: string): Promise<Result<void, AppError>>;                     // + subtask cascade
  upsertImported(rows: Task[]): Promise<Result<void, AppError>>;           // stamps kept
}
interface ListPort {
  loadAll(): Promise<Result<List[], AppError>>;                            // (sortOrder, id)
  create(input: { name: string; color: string; id?: string }): Promise<Result<List, AppError>>;
  rename(id, name) / recolor(id, color): Promise<Result<List, AppError>>;
  move(id, position): Promise<Result<List, AppError>>;                     // one put
  remove(id, { mode: 'move', targetListId } | { mode: 'tombstone' }): Promise<Result<void, AppError>>;
}
interface SettingsPort { get() / update(patch) }
```

Write semantics (normative): **field-scoped patches**, applied read-modify-write inside ONE
`readwrite` transaction (a reorder in tab A cannot clobber a title edit from tab B). Repos stamp
`updatedAt`/`deviceId` (and `createdAt`/`completedAt`/`deletedAt`) — the wrapper `put` never does.
`completedAt` is set on done and **cleared** on uncomplete. `remove(task)` tombstones the task and
its direct subtasks in one transaction (the only cascade). `remove(list, disposition)` moves or
tombstones its tasks in one transaction (ADR-002 Decision 6 verbatim) — never a silent cascade.
Tasks whose list is missing/tombstoned are excluded from every view.

`TaskDraft.id` / `ListPort.create.input.id` carry the runner's **pre-minted final ULID** (ADR-003
Decision 3.2: no id churn between paint and write); repos mint one when absent.

Extra adapter methods (not ports — for `app/tabSync.ts`): `TaskRepo.changedSince(ts)` /
`ListRepo.changedSince(ts)` (rows with `updatedAt > ts`, **tombstones included**) and
`readRows(db, taskIds, listIds)` (primary-key reads, tombstones mapped to `null`).

## 3. MutationRunner (`src/domain/pipeline.ts`) — the UI's write API

```ts
new MutationRunner({
  tasks: TaskPort; lists: ListPort; settings: SettingsPort;
  clock: Clock; ids: IdFactory; orderKeys: OrderKeyOps; deviceId: string;
  onCommitted?: (change: ChangeSet) => void;       // app/tabSync wiring, fires AFTER commit only
  onError?: (info: { op; opId; error: AppError; rolledBack: string[] }) => void;  // error log
});

runner.load(): Promise<Result<void, AppError>>          // initial state from the repos
runner.getState(): State                                 // {version, tasks, lists, settings, pending}
runner.subscribe(fn: (ev: ChangeEvent) => void): () => void

// optimistic mutations (state updates SYNCHRONOUSLY — before the returned promise resolves):
createTask(draft) patchTask(id, patch) setDone(id, done) moveTask(id, target) removeTask(id)
upsertImported(rows) createList(input) renameList/recolorList/moveList removeList(id, disposition)
updateSettings(patch)
runner.applyExternal(update: RecordUpdate): void         // tab-sync refresh; never writes/broadcasts
```

**Normative write order** (every mutation): pure optimistic apply → synchronous notify (this is
the <100 ms perceived path — UI paints before any I/O) → serialized write → on success the
repo's authoritative record **replaces** the provisional one (stamps/order keys are repo-truth) →
`records` + `settled`; on failure the committed baseline is restored (never a provisional image),
queued ops sharing the failed ids are cancelled and rolled back (reverse order), `write-failed`
fires per rolled-back op and the caller's promise resolves `err`.

**Events** (the only three that exist):

| event | meaning |
|---|---|
| `{kind:'records', taskIds, listIds, settings}` | state batch applied (optimistic, settle swap, rollback, external) |
| `{kind:'settled', opId}` | write confirmed (authoritative swap landed / is landing) |
| `{kind:'write-failed', opId, error: AppError, rolledBack: string[]}` | op rolled back — surface a toast/dialog; `QUOTA_EXCEEDED` → §5.5 dialog |

UI adaptation (`src/features/*/store.ts`): subscribe → signal writes; expose `selectView` results
as computed signals; localize `GroupLabel`s; own toasts for `write-failed` and subtask
collapse/expand state. Reorder UI must pass ONE `MoveTarget` (single-record write); aggregate
views disable manual reorder (design D1) and use move-to-list instead.

## 4. Views (`src/domain/views.ts`)

```ts
selectView(state, view: ViewId, ctx: { today: string; index?: SearchIndex }): ViewResult
// ViewId: {kind:'today'|'week'|'allOpen'|'list',listId?|'completed'|'search',query?}
// ViewRow: {type:'group', key, label: GroupLabel, count} | {type:'task', task, depth: 0|1, flags:{overdue}}
// ViewResult: { rows: ViewRow[]; counts: { open: number; overdue: number } }
```

Membership/order (ux-foundation §4.3–4.8, pinned by golden tests): Today = Overdue + Today groups,
`(dueDate asc, createdAt asc, id)`; Week = per-day groups `[today, today+6]`, empty groups omitted,
`(createdAt asc, id)`; AllOpen = grouped by list (list `(sortOrder, id)` order, empty groups
omitted), manual `(sortOrder, id)`; List = flat manual order of one list's open tasks; Completed =
flat `completedAt desc, id desc`; Search = one `results` group, `(rank, updatedAt desc, id desc)`.
`counts` feeds headers (Today: "N open · M overdue"). Subtask rule (uniform): a task whose parent
is a member of the same group renders at depth 1 directly under its parent (view order among
siblings); otherwise depth 0. Domain returns FULL rows — collapse is UI filtering.

`today` comes from `todayStr(clock)` (`src/domain/dates.ts`, local components — never
`toISOString`); the app layer owns the day-rollover signal (`visibilitychange` +
`msUntilNextLocalMidnight(clock)` timer). `dueDate` is an all-day local label compared
lexicographically; `reminderAt` is the only real instant.

## 5. Search (`src/domain/search.ts`)

```ts
const index = new SearchIndex();
index.build(tasks) / upsert(task) / remove(id) / size
index.search(query, previous?: { query, hits }): SearchHit[]   // {id, rank: 0|1|2}
SearchIndex.naive(tasks, query)                                 // documented fallback = reference
tokenize(text)                                                  // lowercase + NFKC + split
```

Semantics (pinned): case/NFKC-insensitive, **word-prefix AND** over `title + notes` (`buy mil`
matches "Buy milk and eggs"; `der` does NOT match "reorder"). Rank: 0 = title covers every query
token, 1 = title covers some, 2 = notes only. Keystroke narrowing: pass the previous result when
the query GROWS (`previous.query` must be a strict prefix of `query`) — monotone filtering, no
postings re-walk; deleting characters auto-falls back to a fresh indexed query. Incremental
`upsert`/`remove` are proven equivalent to full rebuild.

Measured (10k fixtures, Node 22 / jsdom on the dev host, 2026-10-23; CI gate is query ≤ 50 ms):
`build 39.9 ms | cold(1 token) 2.27 ms | cold(2 tokens) 1.23 ms | narrowed 4.07 ms | naive scan
14.2 ms`. Build is off the first-paint path (idle-slice or lazy on first search open — UI card).

## 6. Virtualization (`src/domain/windowing.ts`)

```ts
computeWindow({ count, heightAt, uniformPx?, viewportPx, scrollTop, overscan? = 8, pin? })
  : { start, end, padTop, padBottom, pins }
// window = rows [start, end) + its spacers; pins = pinned rows OUTSIDE the window
```

Uniform fast path when `uniformPx` is set (`--row-height-task`); prefix-sum + binary search for
variable heights. The window is the **scroll-viewport window only** (§9.1 / defect V1): a `pin`
(the roving cursor) never widens it toward the scroll position — a cursor parked at the top of a
1 200-row list with the scroll at the bottom used to render all 1 200 rows. A pinned index
outside `[start, end)` comes back in `pins` as `{ index, padBefore }` and the UI renders, in list
order:

```text
[above-window pin segments] padTop [window rows] [below-window pin segments] padBottom
```

Each segment's `padBefore` is the gap since the previously rendered element; `padTop` absorbs the
gap between the last above-segment (or the list start) and the window, `padBottom` the tail after
the last below-segment — pads + segments tile the exact list height, so the cursor row keeps its
real offset and `aria-posinset` while total DOM rows stay ~25–35 + 1 at any scroll position
(> 200 must never render). A pin already inside the window is not listed in `pins`. The UI owns
`requestAnimationFrame` coalescing (one call per frame), keying rows by task id (cross-tab
refreshes must not reset `scrollTop`), and re-focuses the cursor row with `preventScroll` when
the keyed boundary move drops focus (Chromium blurs a moved node).

## 7. Concurrent tabs (`src/domain/sync.ts` + `src/app/tabSync.ts`)

Channel `local-first-todo:tabs:v1`, one message type:

```ts
type BroadcastMessage = { v: 1; type: 'data-changed'; origin: TabId; at: number;
                          change: { tasks?: string[]; lists?: string[]; settings?: boolean } | 'all' };
```

Sent **after** the IDB commit (`MutationRunner.onCommitted` → `tabSync.announce(change)`); typical
edit = 1–2 ids; bulk ops (list disposition, import, purge, rebalance) send `'all'`. Receivers:
ignore own `origin`, re-read the affected rows from IDB (message is a hint, IDB is the truth),
`reconcile(state, msg, rows)` (pure) → `runner.applyExternal(update)` — **never write on receipt,
never rebroadcast**. Records with an in-flight optimistic op are skipped (their baseline is
invalid). Backstop: `by_updatedAt` watermark sweep on `visibilitychange → visible`
(`tabSync.sweep()`), so tabs converge even when every broadcast is lost.

Wiring (composition root):

```ts
const runner = new MutationRunner({ ..., onCommitted: (c) => tabSync.announce(c) });
const tabSync = createTabSync({ runner, reads: {
  loadAll, getSettings, readRows, tasksChangedSince, listsChangedSince },
  clock, tabId, channelFactory? });
tabSync.start();
```

## 8. LWW + conflict copies (`src/domain/merge.ts`)

`compareLww(a, b)` — greater `updatedAt` wins; tie → greater `deviceId` (lexicographic);
antisymmetric; tested as a total order. `conflictCopyTitle(title)` = `'Conflict copy of ' + title`
(1000-char cap). These are the primitives M11 import and ADR-006 sync call — the §6.2 policy is
PRE-DECIDED and unchanged.

## 9. Test evidence (t_aee34500)

`tests/unit/domain/` + `tests/unit/storage/repos.test.ts` + `tests/unit/storage/errorLog.test.ts`
+ `tests/unit/app/tabSync.test.ts` — **257 tests green**. Coverage (v8): `src/domain/**`
94.36% stmts / 82.18% branches / 93.22% funcs / 95.65% lines (gate ≥ 80 passes). Acceptance drills
covered explicitly: LWW tie-breaks (`merge.test.ts`), tombstone purge policy incl. 24h throttle
and explicit clean-up (`repos.test.ts`), single-write reorder (put-counting `AppDB` — exactly 1
put per move, neighbors untouched), optimistic rollback + queued-op cancellation + last-committed
re-anchoring (`pipeline.test.ts`), two-tab concurrency scenario end-to-end incl. lost-message
sweep (`tabSync.test.ts`), search-index perf at 10k with measured numbers (`search.test.ts`).

## 10. Interpretation notes (reviewers: these are the deliberate calls)

1. **`TaskDraft.id` / `ListPort.create.id` (optional)** — the ADR sketch has no id on the draft
   but Decision 3.2 requires final ULIDs minted up front ("no id churn"). The optional pre-minted
   id reconciles both; repos mint when absent. Persisted shapes unchanged. **The runner is the
   minter of record** *[E2 review N3 note 1]*: `createTask`/`createList` always mint from the
   injected `IdFactory` and pass that id to the port, so a caller-supplied `draft.id` /
   `input.id` is silently overridden at the runner seam (direct port callers keep the honor path).
2. **Reorder is strictly one `put`** (Decision 4). `moveTask` may change group membership
   (move-to-list clears `parentTaskId` per Decision 2.2.4) as that same single write. Its direct
   subtasks are NOT rewritten (the single-write invariant wins); moving a subtask to another list
   clears its `parentTaskId` (it becomes top-level there). **Corollary pinned *[E2 review N3
   note 2]*: moving a PARENT to another list orphans its direct subtasks in the old list**, where
   they render at depth 0 — pinned by `pipeline.test.ts` + `views.test.ts` and recorded as an
   ADR-003 Decision 4 amendment.
3. **Subtask nesting** — one uniform rule (see §4) instead of per-view special cases.
4. **Search rank** — 0/1/2 by how much of the query the TITLE covers (all/some/none); the ADR's
   "title word-prefix / title word / notes only" triad is degenerate for exact-word matches.
5. **Rollback re-anchoring** — after undoing rolled-back ops, affected records snap to the last
   COMMITTED image (`applyOptimistic`'s `undo` alone could restore a provisional image when an
   earlier op on the same record settled while a later one was live).
6. **Write serialization** — one FIFO write queue (a strict superset of the ADR's per-record
   serialization); correctness: submissions complete in order per record and multi-record ops
   stay ordered against single-record ones.
7. **Error log** — `src/storage/errorLog.ts` (JSON ring buffer, downloadable, no telemetry,
   ADR-002 §10.4) records every failure branch incl. the reorder rebalance hatch; wire it into
   the S11 storage dashboard.

## 11. E7 additions (t_b5078638 — tags, subtasks, priority; schemaVersion 3)

- **`Priority` is now `'P1' | 'P2' | 'P3' | 'P4'`** (`P1` most urgent, `P4` = no priority =
  default; `PRIORITY_LEVELS`, `compareByPriority(a, b)` in `model.ts`). The MVP `0|1|2` values
  are gone — the schemaVersion 3 migration mapped them by preserved meaning (2/High→P1,
  1/Medium→P2, 0/Low→P3, unset→P4; ADR-002 amendment).
- **`Recurrence` is the RESERVED format**: `{ freq, interval: number >= 1, until?: 'YYYY-MM-DD' }`
  — **no `count`** (R4: end-count is out of V1). The recurrence card (t_354a153f) implements
  semantics ONLY against this shape; `validateTask` rejects any other recurrence field.
- **`TaskPort.remove(id, disposition)`** — `{ mode: 'cascade' } | { mode: 'promote' }`, one
  transaction, resolves `TaskRemoveOutcome { tombstoned, promoted }` (rows the tx wrote).
  `MutationRunner.removeTask(id, disposition)` matches. `TaskRemoveDisposition` =
  "what happens to the direct subtasks" (S2; consistent with the list-deletion UX).
- **`TaskPort.sweepTag(from, to)`** — ONE-transaction rename (`to: string`) / delete
  (`to: null`) sweep over the denormalized `tags: string[]` (tombstoned rows included; rename
  de-duplicates; changed rows restamped). `MutationRunner.renameTag(from, to)` /
  `deleteTag(name)` wrap it: bulk optimistic rewrite (announces `'all'`), committed-baseline
  rollback on failure, `RULE: TAG_INVALID` for names outside 1..100 chars. **Measured: 10,000
  tagged tasks rename in 31.2 ms** through the real repo code (emulated-IDB 2k data point
  7.2 s — fake-indexeddb quadratic update artifact). No Tag store (ADR-002 amendment §3).
- **`ViewCtx`** gains `tag?: string` (exact-name filter on members; a matching subtask whose
  parent is filtered out renders at depth 0 — never dropped) and `sortBy?: 'priority'`
  (`P1` first … `P4` last as the PRIMARY key inside every group; absent = pinned per-view
  order, golden tests untouched).
- **Store additions** (`features/tasks/store.ts`): `tagFilter` / `sortMode` session signals,
  `allTags()` usage counts, `renameTag`/`deleteTag` guards, `deleteTask(id, disposition)`,
  `TaskInput.tags` (required) + `TaskInput.parentTaskId` (subtask create).
- **UI**: `TagsField` (chips editor), `TagsManageDialog` (rename/delete with sweep),
  `TaskDeleteDialog` (subtask disposition radio — default `promote`), the view toolbar
  (tag filter + sort + manage tags), and the task editor's subtask list (create/navigate/
  complete; depth guard hides the section on a subtask). i18n keys `priority.p1..p4`,
  `tags.*`, `subtasks.*`, `sort.*`, `confirm.deleteTag.*`, `confirm.deleteTask.{subtaskBody,
  promoteSubtasks,deleteSubtasks}`, `a11y.{subtaskAdded,tagRenamed,tagDeleted}` (en+th).
