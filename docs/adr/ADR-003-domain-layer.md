# ADR-003: Domain layer, state & search-index design

**Status**: Accepted
**Date**: 2026-10-23
**Author**: h_senior_coder (sole decider per task t_e0245a8c — single-decider rule)
**Scope**: Local-First Todo Web App. Epic E2 Core Domain — Task & List Management.
**Refs**: PROJECT_ANALYSIS.md §5.3 (data model), §6.1 (optimistic parity), §6.2 (conflict policy),
§9.1 (performance budgets), §9.3 (reliability), §10 E5 (concurrent tabs) / E6 (clock skew) /
E7 (data growth); docs/adr/ADR-001-ui-framework.md (binding); docs/adr/ADR-002-storage-schema.md
(binding); docs/design/ux-foundation.md §2, §4.3–4.8 (view semantics, binding for view shapes).

---

## Context

The core loop (capture → today view → complete, plus reorder, search, and multi-view browsing)
needs a domain layer that owns the rules and stays testable, fast at 10k tasks, and honest under
failure. Two ADRs already bind this one:

- **ADR-002** fixes the persistence contract: record shapes (`Task`, `List`, `Settings`), ULID
  ids, base-36 fractional `sortOrder` keys with `(sortOrder, id)` ordering and sibling groups,
  `deletedAt` tombstones with 90-day/explicit purge, epoch-ms-UTC timestamps, `YYYY-MM-DD`
  `dueDate`, `deviceId` stamping in repos, the typed `AppDB` wrapper (`boot/tx/get/getAll/put/
  query/delete`, `Result<T, StorageError>`), and per-record LWW on `(updatedAt, deviceId)`.
- **ADR-001** fixes the substrate: Preact 10 + `@preact/signals`, TSX strict, Vite, and the repo
  layout with import boundaries — `domain/` imports **nothing** from `app/`, `features/`,
  `storage/`, or the DOM; `domain/` is the primary unit-test target (≥ 80% coverage gate).

PROJECT_ANALYSIS budgets this layer must serve (§9.1): task add → visible **< 100 ms perceived**
(optimistic), search over **10,000 tasks < 50 ms**, boot with 10k tasks to first data paint
< 500 ms, scroll **60 fps with virtualization beyond ~200 DOM rows**, INP < 200 ms on a Moto-G
class device (4× CPU throttle). §9.3/E5: concurrent tabs coordinate via IDB transactions +
BroadcastChannel "data changed" refresh. E6: `dueDate` is a local date string — no timezone math.
E7: 10–100× growth must not collapse the loop (100k tasks is the revisit trigger).

The UX foundation (h_designer) already fixes view semantics: Today = Overdue + Today groups;
Next 7 days = day groups incl. today, empty groups hidden; All open = grouped by list; List view
= flat manual order; Completed = `completedAt` desc; Search = instant filter over title + notes
with 150 ms debounce and virtualized results.

**Binding decisions recorded, not re-litigated**: per-record LWW on `(updatedAt, deviceId)`
(§6.2); deletions propagate via `deletedAt` tombstones; unmergeable conflicts materialize as
visible `"Conflict copy of <task>"` rows; tags stay denormalized `string[]` on tasks for MVP;
domain logic stays framework-free.

---

## Decision summary (the short version)

| Question | Decision |
|---|---|
| Module boundaries | `src/domain/` = pure framework-free core (model, ports, pipeline, views, search, windowing, merge); `src/storage/repos/` = adapters over `AppDB`; `src/features/*` = signals adaptation; `src/app/` = composition root. Dependency direction: adapters → domain, never the reverse |
| Record types | Canonical TS types for `Task`/`List`/`Settings` live in `src/domain/model.ts` (byte-identical to ADR-002 shapes); storage modules import them |
| Error contract | `Result<T, AppError>` everywhere; `AppError = StorageError \| RuleError`; `Result` + `StorageError` physically declared in `src/domain/kernel.ts`, re-exported by `src/storage/db.ts` (ADR-002 shape unchanged) |
| Writes | Field-scoped **patches** applied read-modify-write inside one `readwrite` transaction; repos stamp `updatedAt`/`deviceId`/`completedAt`/`deletedAt` (ADR-002 Decision 5); the wrapper `put` stays raw |
| Optimistic pipeline | `MutationRunner`: apply pure optimistic state change → notify synchronously (paint) → write through → on success swap in the authoritative record, on failure roll back to the committed baseline, cancel queued ops for that record, emit `write-failed` |
| Reorder | **Single-record write**: `orderKeyBetween(prev, next)` per ADR-002 fractional keys; one `put` of the moved row (patch `{sortOrder}` + stamps); neighbors are reads only |
| Search | In-memory token-prefix inverted index (sorted token array + posting lists) + keystroke narrowing (query results filter the next keystroke); incremental upsert/remove per task; no full re-scan per keystroke |
| Virtualization | Pure `computeWindow()` (uniform row fast-path + prefix-sum variable heights) over a flat `ViewRow[]`; overscan 8; pinned focused row (rendered set = window slice or its own segment — the pin never widens the window); a11y row-index contract |
| State | One immutable `State` snapshot (maps + version) in a single signal; views are pure selectors returning flat `ViewRow[]`; per-record signals rejected (premature) |
| Concurrent tabs | BroadcastChannel `local-first-todo:tabs:v1`, one message type `data-changed` (id lists or `'all'`), sent **after** IDB commit; advisory only — correctness comes from IDB re-read + `by_updatedAt` watermark sweep on tab focus |
| dueDate | All-day local-date strings compared lexicographically; `today` from local `Date` components (never `toISOString`); day rollover via visibility + next-midnight timer |
| LWW | `compareLww()` lives in `src/domain/merge.ts` (pure, tested) for import (M11) and future sync (ADR-006) |

---

## Decision 1 — Module boundaries and dependency direction

### 1.1 Layout (extends ADR-001 §9)

```
src/domain/            PURE. No DOM, no IDB, no preact/@preact/signals imports (ESLint-enforced).
  kernel.ts            Result<T,E>, StorageError (ADR-002 §10.1 shape), RuleError, AppError
  model.ts             Task, List, Settings, TaskStatus, Priority, Recurrence, TaskDraft/TaskPatch
  dates.ts             all-day dueDate helpers (todayStr, addDays, diffDays, isOverdue, …)
  merge.ts             compareLww(a,b), conflictCopyTitle(title)
  ports.ts             TaskPort, ListPort, SettingsPort, Clock, IdFactory
  state.ts             State, applyOptimistic(), ChangeEvent
  pipeline.ts          MutationRunner (optimistic write-through + rollback)
  views.ts             ViewId, ViewRow, selectView()
  search.ts            SearchIndex (token-prefix inverted index)
  windowing.ts         computeWindow()
  sync.ts              BroadcastMessage types + reconcile()
src/storage/repos/     ADAPTERS over AppDB (ADR-002): TaskRepo, ListRepo, SettingsRepo.
                       May import domain/ types + ports; own stamping, tombstoning,
                       order-key math, validation (ADR-002 Decisions 4/5/6/11).
src/features/*/store.ts  signals adaptation: subscribe(domain events) → signal writes;
                       view selectors exposed as computed signals. The ONLY place domain
                       state meets Preact.
src/app/               composition root (wires repos + MutationRunner + tab sync + day rollover);
  tabSync.ts           BroadcastChannel transport + watermark sweep (uses domain/sync.ts contract)
src/storage/           db.ts, id.ts, orderKey.ts, validate.ts, migrations (ADR-002 — unchanged)
```

**Import rules (ESLint `no-restricted-imports`, extended from ADR-001):**

1. `domain/` imports only `domain/`.
2. `storage/` may import `domain/` (types, ports, kernel) — dependency inversion: adapters depend
   on the port interfaces they implement.
3. `features/`, `components/` import `domain/` and `storage/` public surfaces only.
4. `app/` wires everything; nothing imports `app/`.

### 1.2 Why the record types move to `domain/model.ts`

ADR-002 defines the record shapes; this ADR makes `src/domain/model.ts` their **canonical TS
home** (byte-identical fields — nothing about the schema changes) because `domain/` cannot import
`storage/` (ADR-001 boundary) yet needs `Task`/`List`/`Settings` everywhere. `src/storage/`
modules import the types from `domain/model.ts`; ADR-002's `validate.ts` validates exactly these
shapes. Same for `Result<T,E>` and `StorageError`: physically declared in `src/domain/kernel.ts`
and **re-exported** from `src/storage/db.ts`, so every ADR-002 import site keeps compiling and the
wrapper API surface is unchanged.

```ts
// src/domain/kernel.ts — zero runtime code, pure types
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };   // == ADR-002 §10.1
type StorageError = /* exactly the ADR-002 §10.1 union */;
type RuleError = { code: 'RULE'; rule: RuleId; message: string };
type RuleId =
  | 'PARENT_DEPTH_EXCEEDED'      // subtask of a subtask (V1 is one level)
  | 'REORDER_TARGET_NOT_IN_GROUP'// move target ids must belong to the declared group
  | 'LIST_DELETE_TARGET_MISSING' // move-disposition target list missing or identical
  | 'TASK_MISSING';              // mutation on a record absent from state (stale UI)
type AppError = StorageError | RuleError;
```

`INVALID_RECORD` (ADR-002) is the validation error; `RULE` is a domain-rule violation. Nothing
throws across the boundary — every port returns `Promise<Result<T, AppError>>` (team baseline).

---

## Decision 2 — Repository ports and write semantics

### 2.1 Ports (`src/domain/ports.ts`)

```ts
type Clock = () => number;        // epoch ms UTC — injectable (ADR-002 Decision 5)
type IdFactory = () => string;    // ULID via storage/id.ts, injected (keeps domain pure)
type OrderKeyOps = {              // == storage/orderKey.ts (ADR-002 Decision 4), injected —
  between(a: string | null, b: string | null): string;   // used for provisional keys on
  first(): string;                                       // optimistic moves (Decision 4)
};

type TaskDraft = { listId: string; title: string; notes: string | null; priority: Priority;
                   dueDate?: string; tags: string[]; parentTaskId?: string };
type TaskPatch  = Partial<Pick<Task, 'title' | 'notes' | 'priority' | 'dueDate' | 'tags'
                                 | 'reminderAt' | 'recurrence'>> & { dueDateUnset?: true };

type MoveTarget = {
  group: { listId: string; parentTaskId: string | null };   // sibling group (ADR-002 Decision 4)
  position: 'first' | 'last' | { afterId: string } | { beforeId: string };
};

interface TaskPort {
  loadAll(): Promise<Result<{ tasks: Task[]; lists: List[]; settings: Settings }, AppError>>;
  create(draft: TaskDraft): Promise<Result<Task, AppError>>;
  patch(id: string, patch: TaskPatch): Promise<Result<Task, AppError>>;
  setDone(id: string, done: boolean): Promise<Result<Task, AppError>>;   // completedAt stamping
  move(id: string, target: MoveTarget): Promise<Result<Task, AppError>>; // SINGLE-record write
  remove(id: string): Promise<Result<void, AppError>>;      // tombstone (+ child cascade, one tx)
  upsertImported(rows: Task[]): Promise<Result<void, AppError>>;  // M11 import path (stamps kept)
}
interface ListPort {
  loadAll(): Promise<Result<List[], AppError>>;             // sorted (sortOrder, id)
  create(input: { name: string; color: string }): Promise<Result<List, AppError>>;
  rename(id: string, name: string): Promise<Result<List, AppError>>;
  recolor(id: string, color: string): Promise<Result<List, AppError>>;
  move(id: string, position: 'first' | 'last' | { afterId: string } | { beforeId: string }):
       Promise<Result<List, AppError>>;                     // single-record write, global group
  remove(id: string, disposition:
       { mode: 'move'; targetListId: string } | { mode: 'tombstone' }):
       Promise<Result<void, AppError>>;                     // ONE transaction either way
}
interface SettingsPort {
  get(): Promise<Result<Settings, AppError>>;
  update(patch: Partial<Omit<Settings, 'id'>>): Promise<Result<Settings, AppError>>;
}
```

### 2.2 Write semantics (normative)

1. **Patches, not blind puts.** Every mutation is a field-scoped patch. The repo applies it via
   **read-modify-write inside one `readwrite` transaction**: read the row, merge patch, stamp,
   `put`. A reorder in tab A therefore cannot clobber a title edit that tab B committed a moment
   earlier (E5). Between devices, conflicts remain **whole-record LWW** (pre-decided §6.2) — the
   patch model is a local-concurrency courtesy, not a change to the sync policy.
2. **Stamping (ADR-002 Decision 5, unchanged):** repos stamp `updatedAt = clock()`,
   `deviceId = meta.deviceId` on every mutation; `createdAt` on create; `completedAt` when status
   becomes `done` and **cleared** on uncomplete; `deletedAt` on tombstoning. The wrapper `put`
   never stamps.
3. **Validation** on every write via ADR-002 `validate.ts` (title 1..1000, notes ≤ 20k,
   `dueDate` real calendar day, …) → `INVALID_RECORD` on failure.
4. **Deletion:** `remove()` tombstones the task **and its direct subtasks in the same
   transaction** (V1 subtasks are one level, so the cascade is a single bounded sweep — this is
   the one cascade that exists, and it is atomic). Moving a subtask to another list clears
   `parentTaskId` (it becomes top-level there). `remove(list, disposition)` follows ADR-002
   Decision 6 verbatim: move tasks (rewrite `listId`, stamp) or tombstone them — one tx, never a
   silent cascade. Tasks whose list is tombstoned/missing are excluded from every view.
5. **Tombstone purge** stays where ADR-002 put it (repos + boot throttle + "Clean up storage").
   The domain layer only ever sees live rows (`deletedAt === null`).

---

## Decision 3 — Optimistic write pipeline (`src/domain/pipeline.ts`)

### 3.1 In-memory state (`src/domain/state.ts`)

```ts
type State = {
  version: number;                          // bumps on every applied change batch
  tasks: ReadonlyMap<string, Task>;
  lists: ReadonlyMap<string, List>;
  settings: Settings | null;
  pending: ReadonlyMap<string, PendingOp>;  // recordId -> in-flight op (UI affordances)
};
type ChangeEvent =
  | { kind: 'records'; taskIds: string[]; listIds: string[]; settings: boolean }
  | { kind: 'settled'; opId: string }
  | { kind: 'write-failed'; opId: string; error: AppError; rolledBack: string[] };
// State transitions are pure functions: applyOptimistic(state, op) -> { next, undo }
```

### 3.2 Flow (normative order for every mutation: add / complete / reorder / edit / delete)

```
1. APPLY   pure applyOptimistic() computes next State + undo info
2. NOTIFY  state committed + listeners notified SYNCHRONOUSLY (no await before this point)
           → Preact signal update → paint. This is the <100ms perceived path.
3. WRITE   repo call (async), serialized per affected record id (promise chain)
4a. OK     authoritative record returned by the repo REPLACES the provisional entry
           (stamps are authoritative from the repo — the UI never persists provisional stamps);
           notify 'settled'
4b. FAIL   cancel queued ops for the affected ids → restore undo (last committed baseline)
           → notify 'write-failed' with the AppError → UI surfaces an error/toast (UX §4)
           → the local error log entry (ADR-002 Decision 10.4) is written by the adapter
```

- **Provisional records**: `create()` mints the id and provisional stamps from the injected
  `IdFactory`/`Clock`/`deviceId` so the row is renderable before the write resolves; the repo
  re-stamps authoritatively (ADR-002 Decision 5 is not violated — stamping on *persisted* data
  happens only in repos, and the returned record overwrites the provisional one).
- **Per-record serialization** makes completions arrive in submission order per record, so
  rollback can never resurrect stale data under a newer optimistic edit. A failure cancels the
  record's queued ops *because their baseline is now invalid* — deterministic and testable.
- **Multi-record ops** (list-delete disposition) capture full before-images and roll back
  together; they are single-IDB-transaction ops (Decision 2.2.4) so partial writes cannot occur
  even on crash (§9.3).

### 3.3 The <100 ms budget (§9.1), decomposed

| Step | Budget (Moto-G class, 4× throttle) |
|---|---|
| `applyOptimistic` (map clone at ≤ 10k tasks) | ≤ 2 ms |
| signal write + Preact patch of ≤ ~30 virtualized rows | ≤ 16 ms (one frame) |
| total → visible | **≤ 50 ms measured target, 100 ms hard budget** |
| IDB write + authoritative swap | off the perceived path; failure only affects error UI |

Measured on this design's reference corpus (10k tasks): a full view selection is ~0.06 ms
desktop (see Decision 6.4 evidence) — the state copy + selector work is noise; rendering is the
dominant cost and is bounded by virtualization (Decision 7). The impl card records measured
numbers in its tests.

---

## Decision 4 — Reorder writes exactly one record (explicit answer)

`TaskPort.move()` / `ListPort.move()` (and drag-reorder, and "Move up/Down") resolve to **one
row write**, by construction:

1. Inside one `readwrite` transaction (reads + one put), the repo fetches the neighbor rows of
   the target position in the declared sibling group — top-level tasks via the `by_list_sort`
   index (`['listId','sortOrder']`), subtasks via `by_parent` (in-memory `(sortOrder, id)` sort;
   subtask groups are bounded at V1 scale), lists via `getAll('lists')` (bounded).
2. `m = orderKeyBetween(prev.sortOrder ?? null, next.sortOrder ?? null)` from ADR-002's pure
   `orderKey.ts` (base-36 fractional keys, canonical, 32-char cap).
3. One `put` of the moved row with patch `{ sortOrder: m }` + stamps. **No other record is
   touched** — no renumbering, no sibling rewrite, ever (this is what ADR-002 Decision 4 bought).
4. **Optimistic side**: `MutationRunner` gets the ADR-002 `orderKey.ts` functions injected as an
   `OrderKeyOps` port (see 2.1) and mints a **provisional key** with the same algorithm so the
   row visibly moves before the write resolves (view order derives from `(sortOrder, id)`, so a
   provisional key is required — not optional). The repo recomputes the authoritative key from
   the actual neighbors inside the transaction (they may have moved in another tab); on settle
   (pipeline step 4a) the authoritative `sortOrder` replaces the provisional one. If they differ
   the row may settle by one position — acceptable and silent; correctness lives in the repo's
   computation.

**Pathological adjacency**: if `orderKeyBetween` cannot produce a ≤ 32-char midpoint it throws
`OrderKeyError` (programmer-visible); the repo then runs ADR-002's rebalance hatch — fresh
evenly-spaced keys for the whole sibling group in **one** transaction (the only exception to
one-record reorder, vanishingly rare, and observable in the local error log).

**Consequence pinned *[E2 review N3 note 2]*:** because only the moved row is written, moving a
**parent** task to another list does NOT rewrite its direct subtasks — they stay in the old list
with their `parentTaskId`, where the uniform view rule (Decision 5) renders them at **depth 0**
(their parent is not a member of that list). UI cards must not assume children follow the
parent. Pinned by `tests/unit/domain/pipeline.test.ts` and `tests/unit/domain/views.test.ts`.
The same hatch runs for lists (`ListRepo.move`) and logs `reorder-rebalance` with detail
`lists (global group)` *[E2 review N2]*.

---

## Decision 5 — View-model layer (`src/domain/views.ts`)

Pure selectors over `State`. They return a **flat `ViewRow[]`** (group headers and task rows
interleaved) so virtualization (Decision 7) windows one homogeneous row list.

```ts
type ViewId =
  | { kind: 'today' } | { kind: 'week' } | { kind: 'allOpen' }
  | { kind: 'list'; listId: string } | { kind: 'completed' }
  | { kind: 'search'; query: string };

type GroupLabel = { kind: 'overdue' } | { kind: 'day'; date: string /* 'YYYY-MM-DD' */ }
               | { kind: 'list'; listId: string } | { kind: 'results' };
type ViewRow =
  | { type: 'group'; key: string; label: GroupLabel; count: number }
  | { type: 'task'; task: Task; depth: 0 | 1; flags: { overdue: boolean } };
type ViewResult = { rows: ViewRow[]; counts: { open: number; overdue: number } };

selectView(state: State, view: ViewId, ctx: { today: string }): ViewResult
```

| View | Membership (per ux-foundation §4) | Order |
|---|---|---|
| Today | open, `dueDate < today` (group **Overdue**) + `dueDate === today` (group **Today**) | within group: `(dueDate asc, createdAt asc, id)` |
| Next 7 days | open, `today ≤ dueDate ≤ addDays(today, 6)` (incl. today), grouped per day; **empty groups omitted** | day groups in date order; within group `(createdAt asc, id)` |
| All open | all open, **grouped by list** (lists in their `(sortOrder, id)` order) | within list group: manual order `(sortOrder, id)` |
| List | open tasks of one list, flat, manual order; subtasks at depth 1 under their parent | `(sortOrder, id)` per sibling group |
| Completed | `status === 'done'` | `completedAt desc, id desc` |
| Search | SearchIndex matches (Decision 6) | `(rank, updatedAt desc, id)` — rank 0 title word-prefix, 1 title word, 2 notes only |

- Group labels are **structured data** (`GroupLabel`); the UI localizes them (`Intl.DateTimeFormat`
  for day labels — ux-foundation §4.4). Domain never formats user-facing strings except the
  conflict-copy title (§6.2 contract).
- Subtasks render at `depth: 1` under their parent row; collapse/expand is UI state that filters
  rows — domain always returns the full tree rows.
- `counts` feeds the view headers ("N open · M overdue").

### dueDate all-day semantics (E6 — no timezone math)

- `dueDate` is the `'YYYY-MM-DD'` **local calendar-day label** from ADR-002 Decision 5. It is
  compared **lexicographically** (== chronological) and never converted to a UTC instant.
- `todayStr(clock)` builds `'YYYY-MM-DD'` from the local date components
  (`getFullYear/getMonth/getDate`) — **never `toISOString()`**, which would make "today" flip at
  UTC midnight (the E6 bug this rule exists to prevent).
- The only `Date` usage is `addDays(dateStr, n)` / `diffDays(a, b)` via local-component
  parse/format — calendar arithmetic on labels, DST-safe by construction.
- **Day rollover**: the app layer wires a `today` signal refreshed on `visibilitychange` **and**
  a timer set to the next local midnight (`msUntilNextLocalMidnight(clock)` is the pure helper in
  `dates.ts`). Views derive `today` from that signal, so an idle tab wakes up correct.
- `isOverdue(task, today)` = `status === 'open' && dueDate < today`. `reminderAt` remains a real
  instant (epoch ms UTC) — the only time-based field that is not all-day.

---

## Decision 6 — Search index (`src/domain/search.ts`)

### 6.1 Match semantics (pinned by tests)

Case-insensitive, **word-prefix, AND across query tokens** over `title + notes`: every
whitespace/punctuation-separated query token must be a prefix of at least one token in the task's
title or notes. `buy mil` matches "Buy milk and eggs"; `der` does **not** match "reorder"
(predictable type-ahead; mid-word hits are surprises). Normalization: lowercase + Unicode NFKC.
If design ever requires true substring semantics, the change is confined to the pure
`matches()` function and the refinement pass below — one module, one test file.

### 6.2 Structure — token-prefix inverted index

```
tokens:   sorted string[] of unique normalized tokens (title + notes)
postings: Map<token, number[]>  — sorted task ordinals (index into a stable task array)
```

- **Prefix lookup is a contiguous slice** of the sorted `tokens` array (binary search for the
  lower/upper bound of the prefix) — no trie needed.
- **Query**: for each query token, union the postings of all tokens with that prefix, then
  intersect across query tokens (Set-filter against the previous result when narrowing).
  Cost is **O(matching postings)**, independent of corpus size and of notes length.
- **Ranking** (Decision 5 table) happens over matches only.

### 6.3 No full re-scans per keystroke (explicit answer)

Two mechanisms, both pure and testable:

1. **Keystroke narrowing**: search-as-you-type is monotone — matches(q + one more char) ⊆
   matches(q). The query API accepts the previous result set and only re-examines it for
   appended-character keystrokes. A typical 4-keystroke query does **one** postings walk (first
   keystroke) and three set-filter passes over a shrinking candidate list. Deleting characters or
   editing mid-query falls back to a fresh indexed query (still O(postings), never O(corpus)).
2. **Incremental maintenance**: `upsert(task)`/`remove(id)` touch only that task's tokens
   (remove its ordinals from old posting lists, add under new) — a task edit never rebuilds the
   index. Full rebuild happens only at load.

The naive substring scan is kept as the **documented fallback** (also the semantic reference for
tests): measured below, it is fine at 10k but scales with total text volume, which is exactly the
E7 wall.

### 6.4 Budget justification — measured (evidence per docs/adr/README.md convention)

Method: synthetic corpus of 10,000 tasks (titles 3–5 words, 60% with 3–20-word notes; ≈ 1.1 MB
text; 5,797 unique tokens; 104,468 posting entries), Node v22.22.1 on the dev host (Intel
i5-12500T, Linux 7.0.0-38-generic), 2026-10-23. The §9.1 reference device is 4× CPU-throttled,
so apply ≈ 4× to desktop numbers for the pessimistic bound.

| Measurement (10k tasks) | Desktop | ×4 (Moto-G bound) | Budget |
|---|---|---|---|
| Index build (full tokenize + sort) | 25 ms | ~100 ms | off the first-paint path (below) |
| Cold indexed query, 1 char (worst: broad prefix) | 0.5 ms | ~2 ms | < 50 ms ✔ |
| Cold indexed query, 2 tokens | 0.1 ms | ~0.4 ms | < 50 ms ✔ |
| Narrowed keystroke (postings already walked) | ≤ 0.3 ms | ~1 ms | < 50 ms ✔ |
| Naive substring scan per keystroke (fallback) | 0.15–1.1 ms | ~0.6–4.4 ms | < 50 ms ✔ (at 10k) |
| Full view selection (Decision 5) | 0.06 ms | ~0.2 ms | within a frame ✔ |
| Index memory (est.: tokens + postings + map overhead) | ~1.2 MB | — | acceptable at 10k |

Scan-cost constant (measured): naive `includes()` scan ≈ **0.16 ms/MB** desktop
(≈ 0.65 ms/MB ×4) — e.g. a 20 MB corpus costs ~3 ms desktop / ~13 ms ×4 **per keystroke**.
At E7 scale (100k tasks, richer notes ≈ 20–100 MB text) that crosses the 50 ms budget, while the
indexed query cost stays proportional to matches. 100k-task probe (20k-word vocabulary):
build 225 ms, typical indexed queries ≤ 10 ms, worst measured pathological cold query
(shared-prefix 2-token) 31 ms desktop — within budget but no longer comfortable.

**Consequences drawn from the evidence:**
- **Build timing**: 25 ms desktop / ~100 ms ×4 is real work; it must NOT sit on the
  first-data-paint path (§9.1 boot budget is < 500 ms). The index is built **after first paint**
  in idle-sliced chunks (≤ 5 ms per slice) or lazily on the first search open, whichever comes
  first; queries issued against a not-yet-built index await the build (worst case ≈ one build,
  still < 50 ms ×4 only marginally — the impl card measures and, if the slice approach misses the
  budget, defers to lazy-on-first-search which is user-initiated and acceptable).
- **Revisit triggers** (recorded, not speculative work): if any indexed query measures > 50 ms at
  10k on the ×4 bound, or 100k tasks become a real target (E7), upgrade intersection to
  sorted-array intersection with early termination / length-prefetched posting lists before
  considering a worker or a dependency. If naive scan is ever chosen instead, it must pass the
  same gate.
- Dependency alternative (MiniSearch-class library, ~7 KB gz) rejected for now: the index is
  ~200 LOC of pure code we fully test; §7.2's minimal-dependency policy makes a library the
  *escalation*, not the default. The escape hatch stays open via an ADR amendment.

---

## Decision 7 — Virtualization (`src/domain/windowing.ts` + `src/features/tasks/`)

**Strategy: windowed rendering over the flat `ViewRow[]`, driven by one pure function.**

```ts
type WindowSpec = {
  count: number;
  heightAt: (i: number) => number;   // uniform fast-path when height is constant
  viewportPx: number; scrollTop: number;
  overscan?: number;                 // default 8 rows
  pin?: number[];                    // indices that must stay mounted (roving cursor)
};
type PinnedSegment = {              // a pinned row rendered OUTSIDE [start, end) (V1)
  index: number;                    //   row index — outside [start, end) (inside pins render in-window)
  padBefore: number;                //   spacer before the row: gap since the previously rendered element
};
type WindowResult = {
  start: number; end: number;        // [start, end) scroll-viewport window ± overscan
  padTop: number; padBottom: number; // spacer heights; pads + segments tile sum(heightAt)
  pins: readonly PinnedSegment[];    // out-of-window pins, ascending — pad+row segments in list order
};
computeWindow(spec: WindowSpec): WindowResult
```

- **Uniform-height fast path** for task rows (one CSS custom property
  `--row-height-task`, co-designed with h_designer; title clamped to one line in list rows, per
  ux-foundation TaskRow). Variable heights (group headers, future row kinds) go through an
  O(n) prefix-sum + binary-search path — 10k rows sum in < 0.1 ms, negligible next to a frame.
- **> 200 DOM rows → never render them**: the window renders `viewport/rowHeight + 2×overscan`
  rows (≈ 25–35 rows on phone/desktop), keeping a 60 fps scroll a small keyed diff per frame.
  The window is the **scroll-viewport window only** — a `pin` never widens it toward the scroll
  position (§9.1 V1 seam contract; see the amendment below).
  Scroll handling is `requestAnimationFrame`-coalesced (one `computeWindow` per frame max).
- **Row model is flat**: group headers are rows too, so one windowing path serves every view
  (Today's two groups, per-day groups, list groups, search results).
- **a11y contract** (implemented by the UI card, verified in Playwright): the list exposes
  `aria-rowcount` / `aria-rowindex` (or `role="listbox"` + `aria-setsize/posinset` semantics per
  the TaskRow spec); keyboard Up/Down moves focus, and the focused row is **pinned** into the
  RENDERED SET (`pin`) — the window slice, or its own `{ index, padBefore }` segment when it
  falls outside the window (`pins`) — so focus never dies when the window scrolls; a
  layout-effect focus restore (`focus({ preventScroll: true })`) re-focuses the row after the
  keyed boundary move (Chromium blurs a moved node). Screen-reader row counts stay correct
  while only a window is in the DOM.
- **Scroll preservation**: cross-tab refreshes (Decision 8) and optimistic updates replace state
  but never reset `scrollTop`; rows are keyed by task id so Preact patches in place.
- Rejected: render-all (breaks the 60 fps/200-row budget), `content-visibility` heuristics
  (uneven browser behavior, weak a11y story), and a virtualization dependency (the pure math is
  ~80 LOC; the a11y/scroll glue is ours either way). Revisit only if dynamic row heights become a
  design requirement (prefix-sum path already covers the math).

> **Amendment (2026-10-25, V1 seam-contract sync — fix card t_805282a3, this card t_82de779b).**
> Wording/snippet sync to the PM's binding V1 design decision; **the decision itself is
> unchanged** — windowed rendering over a flat `ViewRow[]` driven by one pure `computeWindow()`
> stays exactly as recorded above. What the seam contract now says (landed in t_805282a3,
> commit c652340; measured 33 DOM rows at the bottom of a 1 200-row list vs 1 200 before):
>
> 1. **A pin no longer widens the window (§9.1 "< 200 DOM rows").** `computeWindow`'s window is
>    the SCROLL-VIEWPORT window only (± overscan) — it never spans cursor→scroll (a cursor
>    parked at the top with the scroll at the bottom used to materialise O(distance) rows, up to
>    the entire list). An out-of-window pin comes back in `WindowResult.pins` as its own
>    `{ index, padBefore }` segment; the UI renders, in list order,
>    `[above segments] padTop [window rows] [below segments] padBottom`, pads + segments tiling
>    the exact list height. A pin inside the window renders with it and is absent from `pins`.
> 2. **The a11y pin targets the RENDERED SET, not the window**: the focused row stays mounted as
>    the window slice or its own segment, and a layout-effect focus restore
>    (`focus({ preventScroll: true })`) re-focuses it after the keyed boundary move — Chromium
>    blurs any node moved by `insertBefore`.
>
> The type snippet, the a11y bullet, the "> 200 DOM rows" bullet and the testing bullet above
> are rewritten to match. The authoritative seam surface is `docs/dev/domain-api.md` §6 (updated
> in the fix card); implementation: `src/domain/windowing.ts` + `src/features/tasks/TaskList.tsx`.

---

## Decision 8 — Concurrent-tab protocol (E5)

### 8.1 Transport and message contract (`src/domain/sync.ts` + `src/app/tabSync.ts`)

Channel: **`local-first-todo:tabs:v1`** (BroadcastChannel). One message type in V1; the `v`
field versions the envelope:

```ts
type TabId = string;                     // ULID minted per tab session
type ChangeSet = { tasks?: string[]; lists?: string[]; settings?: boolean };
type BroadcastMessage =
  | { v: 1; type: 'data-changed'; origin: TabId; at: number; change: ChangeSet | 'all' };
// reserved for later versions (not sent in V1): 'hello' | 'bye' presence hints
```

**Sender rules (normative):**
1. Broadcast **after** the IDB transaction commits — never before. Receivers re-read from IDB;
   IndexedDB is the single source of truth, the message is only a hint ("data changed").
2. `change` lists the affected record ids (typical edit = 1–2 ids); ops that touched many rows
   (list-delete disposition, import, purge, rebalance) send `'all'`.
   *[E2 rework]* The rebalance hatch has a signal path: `move()` resolves
   `MoveOutcome<T> = { row, rebalanced }`, and the runner announces `'all'` whenever
   `rebalanced` is true — receivers must re-read the whole group, not just the moved row.
3. `settings: true` when the settings record changed (theme mirror is localStorage — per-tab,
   refreshed on next boot; live theme propagation across tabs is cosmetic and out of scope).

**Receiver rules (normative):**
1. Ignore `origin === self` (BroadcastChannel does not echo, but tag anyway).
2. For each id in `ChangeSet`: re-read the record from the repo; live row → upsert into `State`
   and `SearchIndex`; tombstoned/missing → evict from both. `'all'` / `settings: true` →
   targeted reload (`loadAll()` for `'all'`). Reconcile is pure (`reconcile(state, msg, rows)`),
   unit-tested without a real channel.
3. Never write on receipt — receiving tabs only refresh their reads (writes stay user-initiated
   in their own tab).

### 8.2 Correctness without BroadcastChannel (required backstop)

BroadcastChannel is advisory: messages can be dropped and older browsers may lack it (the §9.4
floor supports it, but feature-detect anyway). The **watermark sweep** guarantees eventual
consistency: on `visibilitychange → visible` (and on app focus), query `tasks`/`lists` via the
`by_updatedAt` index with `updatedAt > lastSeenAt` (in-memory watermark) and upsert/evict as
above. Two tabs left open overnight reconcile on first focus even if every broadcast was lost.

*[E2 review rework D4 — binding erratum.]* The watermark advances **only after a full sweep**,
to the max `updatedAt` that sweep actually observed. Own commits (`announce`) and targeted
receives (`refresh`) must NOT advance it: a `max(watermark, clock())` bump on those paths
leapfrogs rows another tab wrote with an older `updatedAt` and hides them from
`changedSince(> watermark)` forever, which breaks this eventual-consistency guarantee under
interleaved activity. (This corrects the earlier "updated on every commit/receive" wording.)

### 8.3 Concurrency semantics

- **Write/write on one record** (two tabs): IDB serializes the transactions; each write is a
  patch applied read-modify-write (Decision 2.2.1), so disjoint-field edits merge and same-field
  edits resolve as the later commit (per-record LWW — pre-decided §6.2). `compareLww` in
  `merge.ts` is the pure rule (`greater updatedAt wins; tie → greater deviceId lexicographic`)
  and is what M11 import and ADR-006 sync will call.
- **Reorder vs edit** across tabs: reorder writes only `{sortOrder}`; an edit writes only its
  fields; RMW merge preserves both. This is the concrete payoff of patch-scoped writes.
- **Stale UI writes**: if a patch targets a record that was tombstoned by another tab meanwhile,
  the RMW read sees the tombstone and the write fails `RULE: TASK_MISSING` (or is dropped for
  `remove`, which is idempotent) → optimistic rollback + error toast.

---

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Domain logic in `features/*/store.ts` (signals-native) | less mapping code | domain becomes Preact-coupled; the 80% unit-test target (§9.5) drags in the framework; violates ADR-001 boundary | Framework-free core is the mandate and the testing story |
| Repos return full records, blind `put` of optimistic copies | simplest | clobbers concurrent tab edits (E5); provisional stamps could be persisted | Patch + RMW is one `get` in the tx and kills a whole bug class |
| Temporary ids then re-key on write | avoids provisional ULID | id churn breaks keys/scroll/selection between paint and write | Injected `IdFactory` mints final ULIDs up front (ADR-002 ids are client-side by design) |
| State as per-record signals | fine-grained updates | 10k signal objects at load; selector logic splits across signals; measured selectors are already sub-ms | One immutable `State` + pure selectors; revisit only if profiling disagrees |
| Naive substring scan as THE search (keep it simple) | zero index code | per-keystroke O(corpus) re-scans (the explicit acceptance criterion forbids it); E7 wall at 100k; ranking ad hoc | Keystroke criterion + E7; scan kept only as fallback/reference |
| Trie / suffix-automaton search index | faster prefix queries | far more code/complexity; sorted array + binary search is O(log n) already | Boring wins; measured queries are ≤ 0.5 ms |
| MiniSearch/FlexSearch dependency | maintained matching engine | +5–20 KB gz, new runtime dep (ADR-001 allow-list + §7.2 review), black-box semantics | In-house ~200 LOC with pinned semantics; library is the documented escalation |
| Per-row measured dynamic virtualization (TanStack-style) | arbitrary row heights | measurement loops, layout thrash, more code | Uniform rows + prefix-sum fallback covers the design; simpler and faster |
| BroadcastChannel as the correctness mechanism | fast refresh | message loss = divergent tabs; not in every context | BC as hint + `by_updatedAt` watermark sweep as truth (IDB is the source of truth) |
| CRDT / field-level merge across devices | automatic merges | explicitly out of scope (§6.2, C8) | LWW + conflict copies (pre-decided) |

---

## Consequences

**Positive**
- The core loop is instant (optimistic apply before any I/O) and honest (every failure rolls
  back visibly; no silent drops — §5.5/E3 contract preserved end-to-end).
- All rules live in pure, dependency-free modules with a ≥ 80% coverage gate; UI cards are thin
  signal adapters and TSX; reorder is provably a single-record write.
- Search stays under budget at 10k with measured headroom and a documented E7 escalation path;
  virtualization makes 10k-row views render ~30 DOM rows.
- Concurrent tabs converge without a sync feature: patches + one broadcast + a watermark sweep.
- The layer is sync-ready in exactly the way ADR-002 planned: `merge.ts` LWW + conflict-copy
  naming are the primitives ADR-006 (WebDAV) and M11 (import) will call.

**Negative / accepted costs**
- Patch-RMW adds one read per write inside the transaction — invisible at this scale, accepted.
- Provisional-then-authoritative record swap means one extra state notification per write —
  accepted; it is what keeps stamps authoritative (ADR-002 Decision 5).
- Uniform row heights constrain list-row design (one-line title clamp) — negotiated with
  h_designer via the `--row-height-task` token; the prefix-sum path is the escape hatch.
- The inverted index is bespoke (~200 LOC + tests) — accepted per the minimal-dependency policy,
  with MiniSearch recorded as the escalation if measurements regress.

**Risks & mitigations**
| Risk | Mitigation |
|---|---|
| Index build misses the post-paint budget on low-end devices | idle-sliced build ≤ 5 ms/slice; lazy-on-first-search fallback; measured in impl tests at the ×4 bound |
| Rollback races with queued ops | per-record serialization; failure cancels that record's queue (deterministic, tested) |
| Broadcast storms from chatty tabs | one message per committed transaction, batched per frame at most; `'all'` only for bulk ops |
| View semantics drift from design specs | `selectView` golden tests mirror ux-foundation §4.3–4.8 rows 1:1; structured `GroupLabel` keeps i18n in the UI |
| Row-height uniformity fights future design | `heightAt` + prefix sums already support variable heights; only the CSS contract would change |

**Migration path**: schema changes ride ADR-002's chain (untouched here). Domain additions are
additive modules (`recurrence` evaluation S4, reminders S5 land as pure `domain/` functions);
`upsertImported` is the reserved hook for M11 import; `merge.ts` grows the WebDAV merge entry
points under ADR-006.

---

## API handoff (normative summary for downstream impl/test/UI cards)

1. **Pure core** (`src/domain/`): `kernel.ts` (`Result`, `AppError`), `model.ts` (record types),
   `dates.ts`, `merge.ts` (`compareLww`, `conflictCopyTitle`), `state.ts`, `pipeline.ts`
   (`MutationRunner`), `views.ts` (`selectView`), `search.ts` (`SearchIndex`), `windowing.ts`
   (`computeWindow`), `sync.ts` (`BroadcastMessage`, `reconcile`), `ports.ts`
   (`TaskPort`, `ListPort`, `SettingsPort`, `Clock`, `IdFactory`). **No imports outside
   `domain/`.**
2. **Adapters** (`src/storage/repos/`): implement the ports over `AppDB`; own stamping,
   tombstoning + purge, validation, order-key math, list-delete disposition, RMW patch merge.
   Return `Result<T, AppError>`; write the ADR-002 structured error log on failure paths.
3. **UI adaptation** (`src/features/*/store.ts`): subscribe to `MutationRunner` change events;
   expose one `State` signal + computed view selectors; localize `GroupLabel`s; own toast/error
   presentation for `write-failed` and collapsed/expanded subtask state.
4. **App wiring** (`src/app/`): construct repos (from `boot()`), `MutationRunner` with injected
   `Clock`/`IdFactory`/`OrderKeyOps`/`deviceId`; `tabSync.ts` (BroadcastChannel + watermark
   sweep); day-rollover signal (`visibilitychange` + next-midnight timer).
5. **Events** every consumer can rely on: `records` (ids changed), `settled` (write confirmed),
   `write-failed` (rolled back, carries `AppError`). No other events exist.
6. **Error contract**: `AppError = StorageError | RuleError`; `QUOTA_EXCEEDED` and `UNAVAILABLE`
   flow to the §5.5 dialogs/states; nothing throws across module seams.

## Testing contract (impl/test cards)

- `merge.ts`: `compareLww` unit tests — equal `updatedAt` tie-breaks on `deviceId`
  lexicographically, deterministic under either argument order; conflict-copy naming.
- `pipeline.ts`: optimistic apply → visible state before write resolves (fake repo with deferred
  promises); failure rollback restores the committed baseline exactly; queued-op cancellation;
  provisional→authoritative swap (records and provisional order keys); multi-record rollback
  (list disposition).
- Repos: **single-write reorder** (fake `AppDB` counting `put`s — assert exactly 1 per move;
  order-key property tests reusing the ADR-002 contract); patch-RMW merge (tab B's title survives
  tab A's reorder); stamping rules (incl. `completedAt` cleared on uncomplete); tombstone +
  child cascade atomicity; purge policy (> 90 d, 24 h throttle, explicit).
- `search.ts`: semantics pinning tests (word-prefix AND, case/NFKC, title-vs-notes rank);
  incremental upsert/remove equivalence to full rebuild; **perf at 10k fixtures** — record
  measured build/cold/narrowed numbers; CI gate: query ≤ 50 ms on the CI host (numbers recorded
  in the test output per §9.1).
- `views.ts`: golden tests per view mirroring ux-foundation §4.3–4.8 (overdue grouping, empty
  day groups hidden, week/day boundaries, `completedAt desc`, manual order, subtask nesting),
  incl. the midnight-rollover case (dueDate === yesterday's today).
- `windowing.ts`: property tests — rendered rows cover the visible range, bounds/clamping,
  overscan, `pin` always rendered (inside the window or as its own `pins` segment), uniform and
  prefix-sum modes agree, pads + segments tile the exact list height.
- `sync.ts`/`tabSync.ts`: reconcile upsert/evict (tombstone), `'all'`, self-origin ignore,
  watermark sweep catches missed messages, no writes on receipt.
- Coverage ≥ 80% lines/branches on `src/domain/` and `src/storage/` (§9.5 gate).

## Links

- PROJECT_ANALYSIS.md §5.3, §6.1–6.2, §9.1, §9.3, §10 (E5/E6/E7), §9.5 (coverage gate)
- docs/adr/ADR-001-ui-framework.md (substrate, import boundaries, coverage gate)
- docs/adr/ADR-002-storage-schema.md (record shapes, order keys, tombstones, AppDB, stamping)
- docs/design/ux-foundation.md §2, §4.3–4.8 (view semantics), §6 TaskRow
- Kanban: epic E2 decomposition t_1b9ee0e6; this card t_e0245a8c (sole decider); downstream
  impl card t_aee34500
- Measurement evidence: bench-search.mjs / bench-scan-scale.mjs / bench-search-100k.mjs run
  2026-10-23 on Node v22.22.1 (Intel i5-12500T, Linux 7.0.0-38-generic); method and numbers in
  Decision 6.4. Synthetic corpora — the impl card replaces these with fixture-based measurements
  recorded in test output.
