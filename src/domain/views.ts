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
 */

import { addDays, isOverdue } from './dates';
import type { Task } from './model';
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
};

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
  for (const task of roots) {
    rows.push(taskRow(task, 0, today));
    for (const child of childrenOf.get(task.id) ?? []) rows.push(taskRow(child, 1, today));
  }
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
  switch (view.kind) {
    case 'today':
      return todayView(visibleTasks(state), today);
    case 'week':
      return weekView(visibleTasks(state), today);
    case 'allOpen':
      return allOpenView(state, visibleTasks(state), today);
    case 'list':
      return listView(visibleTasks(state), view.listId, today);
    case 'completed':
      return completedView(visibleTasks(state), today);
    case 'search':
      // S5 keystroke path: resolve only the HITS against the store (O(hits)) —
      // the O(n) visible-task scan runs solely for the documented naive
      // fallback, never per keystroke with a maintained index (review R1 N2).
      return searchView(state, view.query, ctx, today);
  }
}

function todayView(all: Task[], today: string): ViewResult {
  const open = all.filter((t) => t.status === 'open' && t.dueDate !== undefined);
  const overdue = open.filter((t) => (t.dueDate as string) < today);
  const dueToday = open.filter((t) => t.dueDate === today);
  const rows: ViewRow[] = [];
  if (overdue.length > 0) {
    rows.push(groupRow({ kind: 'overdue' }, 'group:overdue', overdue.length));
    rows.push(...treeRows(overdue, byDueThenCreated, today));
  }
  if (dueToday.length > 0) {
    rows.push(groupRow({ kind: 'day', date: today }, `group:day:${today}`, dueToday.length));
    rows.push(...treeRows(dueToday, byDueThenCreated, today));
  }
  return { rows, counts: countsOf([...overdue, ...dueToday], today) };
}

function weekView(all: Task[], today: string): ViewResult {
  const open = all.filter((t) => t.status === 'open' && t.dueDate !== undefined);
  const rows: ViewRow[] = [];
  const members: Task[] = [];
  for (let i = 0; i < 7; i += 1) {
    const date = addDays(today, i);
    const dayMembers = open.filter((t) => t.dueDate === date);
    if (dayMembers.length === 0) continue; // empty groups omitted (ux-foundation §4.4)
    members.push(...dayMembers);
    rows.push(groupRow({ kind: 'day', date }, `group:day:${date}`, dayMembers.length));
    rows.push(...treeRows(dayMembers, byCreatedThenId, today));
  }
  return { rows, counts: countsOf(members, today) };
}

function allOpenView(state: State, all: Task[], today: string): ViewResult {
  const open = all.filter((t) => t.status === 'open');
  const listOrder = [...state.lists.values()].filter((l) => l.deletedAt === null).sort(byOrder);
  const rows: ViewRow[] = [];
  const members: Task[] = [];
  for (const list of listOrder) {
    const inList = open.filter((t) => t.listId === list.id);
    if (inList.length === 0) continue;
    members.push(...inList);
    rows.push(groupRow({ kind: 'list', listId: list.id }, `group:list:${list.id}`, inList.length));
    rows.push(...treeRows(inList, byOrder, today));
  }
  return { rows, counts: countsOf(members, today) };
}

function listView(all: Task[], listId: string, today: string): ViewResult {
  const members = all.filter((t) => t.listId === listId && t.status === 'open');
  return { rows: treeRows(members, byOrder, today), counts: countsOf(members, today) };
}

function completedView(all: Task[], today: string): ViewResult {
  const members = all.filter((t) => t.status === 'done');
  const sorted = [...members].sort((a, b) => {
    const ca = a.completedAt ?? 0;
    const cb = b.completedAt ?? 0;
    if (ca !== cb) return cb - ca;
    return a.id > b.id ? -1 : a.id < b.id ? 1 : 0;
  });
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
