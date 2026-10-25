/**
 * View-model selectors (ADR-003 Decision 5; shapes pinned to ux-foundation
 * §4.3–4.8). Pure functions over `State` returning a flat `ViewRow[]` (group
 * headers and task rows interleaved) so virtualization windows one homogeneous
 * row list. Group labels are STRUCTURED data — the UI localizes them; the domain
 * never formats user-facing strings except the conflict-copy title.
 *
 * Subtask rule (uniform across views, "domain always returns the full tree
 * rows"): a task whose parent is a member of the SAME group renders at depth 1
 * directly under its parent (in view order among its siblings); otherwise at
 * depth 0. Collapse/expand is UI state that filters rows.
 *
 * NEVER-DROPPED invariant (QA-D1): every live member row renders exactly once.
 * Chains deeper than one level (only reachable via import — `upsertImported`
 * validates format, not depth) flatten to depth 1; no live row is ever
 * silently invisible in a tree-grouped view.
 */

import { addDays, isOverdue } from './dates';
import { compareByPriority, type Task } from './model';
import { SearchIndex, type SearchHit } from './search';
import type { State } from './state';

export type ViewId =
  | { kind: 'today' }
  | { kind: 'week' }
  | { kind: 'allOpen' }
  | { kind: 'list'; listId: string }
  | { kind: 'completed' }
  | { kind: 'search'; query: string };

export type GroupLabel =
  | { kind: 'overdue' }
  | { kind: 'day'; date: string }
  | { kind: 'list'; listId: string }
  | { kind: 'results' };

export type ViewRow =
  | { type: 'group'; key: string; label: GroupLabel; count: number }
  | { type: 'task'; task: Task; depth: 0 | 1; flags: { overdue: boolean } };

export type ViewResult = { rows: ViewRow[]; counts: { open: number; overdue: number } };

export type ViewCtx = {
  today: string;
  /** Search view: the maintained index; absent falls back to `SearchIndex.naive`. */
  index?: SearchIndex;
  /**
   * S1 tag filter: only tasks whose `tags` carry this exact name are members
   * (subtask rule unchanged — a filtered-in subtask renders at depth 0 when its
   * parent is filtered out, never dropped).
   */
  tag?: string;
  /**
   * S3 "sorting per level": `'priority'` makes the priority level (`P1` first,
   * `P4` last) the PRIMARY sort key inside every group, with the view's own
   * order as tie-break. Absent = the pinned per-view order (golden tests).
   */
  sortBy?: 'priority';
};

type TaskCompare = (a: Task, b: Task) => number;

/** Lift a view comparator under the ctx's sort mode. */
function orderOf(ctx: ViewCtx, base: TaskCompare): TaskCompare {
  if (ctx.sortBy !== 'priority') return base;
  return (a, b) => compareByPriority(a.priority, b.priority) || base(a, b);
}

/** Live tasks whose list is live (ADR-002 Decision 6: missing/tombstoned lists hide their tasks). */
function visibleTasks(state: State): Task[] {
  const out: Task[] = [];
  for (const task of state.tasks.values()) {
    if (task.deletedAt !== null) continue;
    if (!state.lists.has(task.listId)) continue;
    out.push(task);
  }
  return out;
}

function byOrder(
  a: { sortOrder: string; id: string },
  b: { sortOrder: string; id: string },
): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder < b.sortOrder ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function byCreatedThenId(a: Task, b: Task): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function byDueThenCreated(a: Task, b: Task): number {
  const da = a.dueDate ?? '';
  const db = b.dueDate ?? '';
  if (da !== db) return da < db ? -1 : 1;
  return byCreatedThenId(a, b);
}

/**
 * Flat rows with one level of nesting: members sorted by `compare`, a member
 * whose parent is also in this member set renders at depth 1 right after its
 * parent; everyone else at depth 0.
 *
 * NEVER-DROPPED invariant (QA-D1): every member renders exactly once. Chains
 * deeper than one level (import-reachable — `upsertImported` checks format,
 * not depth) flatten to depth 1, and members no root reaches (a parent chain
 * closing a cycle) render as their own depth-0 rows with their subtrees.
 */
function treeRows(
  members: Task[],
  compare: (a: Task, b: Task) => number,
  today: string,
): ViewRow[] {
  const sorted = [...members].sort(compare);
  const inGroup = new Map(sorted.map((t) => [t.id, t]));
  const childrenOf = new Map<string, Task[]>();
  const roots: Task[] = [];
  for (const task of sorted) {
    const parentId = task.parentTaskId;
    if (parentId !== undefined && parentId !== task.id && inGroup.has(parentId)) {
      const bucket = childrenOf.get(parentId);
      if (bucket === undefined) childrenOf.set(parentId, [task]);
      else bucket.push(task);
    } else {
      roots.push(task);
    }
  }
  const rows: ViewRow[] = [];
  const emitted = new Set<string>();
  // Pre-order DFS over the child buckets — iterative on purpose: an imported
  // chain may be arbitrarily deep. Children render at depth 1 directly under
  // their parent; anything deeper FLATTENS to depth 1 (rendered, never dropped).
  const emitTree = (root: Task): void => {
    if (emitted.has(root.id)) return;
    emitted.add(root.id);
    rows.push(taskRow(root, 0, today));
    const stack: Task[] = [...(childrenOf.get(root.id) ?? [])].reverse();
    while (stack.length > 0) {
      const task = stack.pop();
      if (task === undefined || emitted.has(task.id)) continue;
      emitted.add(task.id);
      rows.push(taskRow(task, 1, today));
      const children = childrenOf.get(task.id);
      if (children !== undefined) {
        for (const child of [...children].reverse()) stack.push(child);
      }
    }
  };
  for (const root of roots) emitTree(root);
  // Second pass: members whose parent chain closes a cycle reach no root
  // (ADR-004 quarantines cycles on import, but a cross-device merge can still
  // land one) — emit each as a depth-0 row with its subtree so no live row is
  // ever silently invisible.
  for (const task of sorted) emitTree(task);
  return rows;
}

function taskRow(task: Task, depth: 0 | 1, today: string): ViewRow {
  return { type: 'task', task, depth, flags: { overdue: isOverdue(task, today) } };
}

function groupRow(label: GroupLabel, key: string, count: number): ViewRow {
  return { type: 'group', key, label, count };
}

function countsOf(members: readonly Task[], today: string): ViewResult['counts'] {
  let open = 0;
  let overdue = 0;
  for (const t of members) {
    if (t.status === 'open') {
      open += 1;
      if (t.dueDate !== undefined && t.dueDate < today) overdue += 1;
    }
  }
  return { open, overdue };
}

export function selectView(state: State, view: ViewId, ctx: ViewCtx): ViewResult {
  const { today } = ctx;
  const all = filterByTag(visibleTasks(state), ctx.tag);
  switch (view.kind) {
    case 'today':
      return todayView(all, today, orderOf(ctx, byDueThenCreated));
    case 'week':
      return weekView(all, today, orderOf(ctx, byCreatedThenId));
    case 'allOpen':
      return allOpenView(state, all, today, orderOf(ctx, byOrder));
    case 'list':
      return listView(all, view.listId, today, orderOf(ctx, byOrder));
    case 'completed':
      return completedView(all, today, orderOf(ctx, byCompletedThenId));
    case 'search':
      // S5 keystroke path: resolve only the HITS against the store (O(hits)) —
      // the O(n) visible-task scan runs solely for the documented naive
      // fallback, never per keystroke with a maintained index (review R1 N2).
      return searchView(state, view.query, ctx, today);
  }
}

/** S1 tag filter (exact name match) applied to the member set of every view. */
function filterByTag(all: Task[], tag: string | undefined): Task[] {
  if (tag === undefined) return all;
  return all.filter((t) => t.tags.includes(tag));
}

/** Completed view order: `completedAt` desc, then `id` desc. */
function byCompletedThenId(a: Task, b: Task): number {
  const ca = a.completedAt ?? 0;
  const cb = b.completedAt ?? 0;
  if (ca !== cb) return cb - ca;
  return a.id > b.id ? -1 : a.id < b.id ? 1 : 0;
}

function todayView(all: Task[], today: string, compare: TaskCompare): ViewResult {
  const open = all.filter((t) => t.status === 'open' && t.dueDate !== undefined);
  const overdue = open.filter((t) => (t.dueDate as string) < today);
  const dueToday = open.filter((t) => t.dueDate === today);
  const rows: ViewRow[] = [];
  if (overdue.length > 0) {
    rows.push(groupRow({ kind: 'overdue' }, 'group:overdue', overdue.length));
    rows.push(...treeRows(overdue, compare, today));
  }
  if (dueToday.length > 0) {
    rows.push(groupRow({ kind: 'day', date: today }, `group:day:${today}`, dueToday.length));
    rows.push(...treeRows(dueToday, compare, today));
  }
  return { rows, counts: countsOf([...overdue, ...dueToday], today) };
}

function weekView(all: Task[], today: string, compare: TaskCompare): ViewResult {
  const open = all.filter((t) => t.status === 'open' && t.dueDate !== undefined);
  const rows: ViewRow[] = [];
  const members: Task[] = [];
  for (let i = 0; i < 7; i += 1) {
    const date = addDays(today, i);
    const dayMembers = open.filter((t) => t.dueDate === date);
    if (dayMembers.length === 0) continue; // empty groups omitted (ux-foundation §4.4)
    members.push(...dayMembers);
    rows.push(groupRow({ kind: 'day', date }, `group:day:${date}`, dayMembers.length));
    rows.push(...treeRows(dayMembers, compare, today));
  }
  return { rows, counts: countsOf(members, today) };
}

function allOpenView(state: State, all: Task[], today: string, compare: TaskCompare): ViewResult {
  const open = all.filter((t) => t.status === 'open');
  const listOrder = [...state.lists.values()].filter((l) => l.deletedAt === null).sort(byOrder);
  const rows: ViewRow[] = [];
  const members: Task[] = [];
  for (const list of listOrder) {
    const inList = open.filter((t) => t.listId === list.id);
    if (inList.length === 0) continue;
    members.push(...inList);
    rows.push(groupRow({ kind: 'list', listId: list.id }, `group:list:${list.id}`, inList.length));
    rows.push(...treeRows(inList, compare, today));
  }
  return { rows, counts: countsOf(members, today) };
}

function listView(all: Task[], listId: string, today: string, compare: TaskCompare): ViewResult {
  const members = all.filter((t) => t.listId === listId && t.status === 'open');
  return { rows: treeRows(members, compare, today), counts: countsOf(members, today) };
}

function completedView(all: Task[], today: string, compare: TaskCompare): ViewResult {
  const members = all.filter((t) => t.status === 'done');
  const sorted = [...members].sort(compare);
  return {
    rows: sorted.map((t) => taskRow(t, 0, today)),
    counts: countsOf(members, today),
  };
}

/**
 * Search results (S5): rank → updatedAt desc → id desc. Hit ids resolve against
 * the STORE one `Map.get` each (plus the ADR-002 D6 liveness predicate) — no
 * per-query id-Map build over the whole corpus (review R1 N2). The naive
 * fallback (ADR-003 D6.3) is the only path that scans the visible corpus.
 */
function searchView(state: State, query: string, ctx: ViewCtx, today: string): ViewResult {
  const hits: SearchHit[] =
    ctx.index !== undefined
      ? ctx.index.search(query)
      : SearchIndex.naive(visibleTasks(state), query); // documented fallback (Decision 6.3)
  const rankOf = new Map(hits.map((h) => [h.id, h.rank]));
  const members: Task[] = [];
  for (const hit of hits) {
    const task = state.tasks.get(hit.id);
    if (task === undefined) continue;
    if (task.deletedAt !== null) continue;
    if (!state.lists.has(task.listId)) continue; // ADR-002 D6: hidden-list tasks stay hidden
    if (ctx.tag !== undefined && !task.tags.includes(ctx.tag)) continue; // S1 filter
    members.push(task);
  }
  const sorted = [...members].sort((a, b) => {
    const ra = rankOf.get(a.id) ?? 2;
    const rb = rankOf.get(b.id) ?? 2;
    if (ra !== rb) return ra - rb;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    return a.id > b.id ? -1 : a.id < b.id ? 1 : 0;
  });
  const rows: ViewRow[] = [];
  if (sorted.length > 0) {
    rows.push(groupRow({ kind: 'results' }, 'group:results', sorted.length));
    rows.push(...sorted.map((t) => taskRow(t, 0, today)));
  }
  return { rows, counts: countsOf(sorted, today) };
}
