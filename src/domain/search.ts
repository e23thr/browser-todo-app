/**
 * In-memory token-prefix search index (ADR-003 Decision 6).
 *
 * Structure: `tokens` (sorted unique normalized tokens) + `postings`
 * (token -> sorted task ordinals) + per-task token arrays. Prefix lookup is a
 * contiguous slice of `tokens` (binary search) — no trie. Query semantics are
 * PINNED by tests: case/NFKC-insensitive, word-prefix, AND across query tokens,
 * over title + notes (`buy mil` matches "Buy milk and eggs"; `der` does NOT
 * match "reorder"). Rank: 0 = title covers every query token, 1 = title covers
 * some, 2 = notes only (title > notes).
 *
 * No full re-scan per keystroke: `search(q, previous)` narrows monotonically
 * (appended-character keystrokes filter the previous result set), and
 * `upsert`/`remove` maintain postings incrementally. `naiveSearch` is the
 * documented fallback and the semantic reference for tests.
 */

export type SearchHit = { id: string; rank: 0 | 1 | 2 };

export type SearchableTask = { id: string; title: string; notes: string | null };

export type PreviousSearch = { query: string; hits: SearchHit[] };

const TOKEN_SPLIT_RE = /[^\p{L}\p{N}]+/u;

/** Lowercase + Unicode NFKC, then split on whitespace/punctuation. */
export function tokenize(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase();
  return normalized.split(TOKEN_SPLIT_RE).filter((t) => t.length > 0);
}

function uniqueSorted(tokens: string[]): string[] {
  return [...new Set(tokens)].sort();
}

function lowerBound(arr: readonly string[], value: string): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((arr[mid] as string) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Every token in the sorted array that has `prefix` as a prefix (contiguous slice). */
function prefixSlice(arr: readonly string[], prefix: string): string[] {
  const out: string[] = [];
  for (let i = lowerBound(arr, prefix); i < arr.length; i += 1) {
    const token = arr[i] as string;
    if (!token.startsWith(prefix)) break;
    out.push(token);
  }
  return out;
}

function someTokenHasPrefix(sortedTokens: readonly string[], prefix: string): boolean {
  return prefixSlice(sortedTokens, prefix).length > 0;
}

type TaskTokens = { title: string[]; notes: string[] };

export class SearchIndex {
  #ids: (string | null)[] = [];
  #ordOf = new Map<string, number>();
  #tokens: string[] = [];
  #postings = new Map<string, number[]>();
  #taskTokens = new Map<string, TaskTokens>();

  get size(): number {
    return this.#taskTokens.size;
  }

  /** Full build from scratch (load path). */
  build(tasks: Iterable<SearchableTask>): void {
    this.#ids = [];
    this.#ordOf.clear();
    this.#postings.clear();
    this.#taskTokens.clear();
    const unique = new Set<string>();
    const entries: [SearchableTask, TaskTokens][] = [];
    for (const task of tasks) {
      const tokens = this.#tokenizeTask(task);
      entries.push([task, tokens]);
      for (const t of tokens.title) unique.add(t);
      for (const t of tokens.notes) unique.add(t);
      const ord = this.#ids.length;
      this.#ids.push(task.id);
      this.#ordOf.set(task.id, ord);
      this.#taskTokens.set(task.id, tokens);
    }
    this.#tokens = [...unique].sort();
    for (const [task] of entries) {
      const ord = this.#ordOf.get(task.id) as number;
      const tokens = this.#taskTokens.get(task.id) as TaskTokens;
      for (const token of new Set([...tokens.title, ...tokens.notes])) {
        this.#addPosting(token, ord);
      }
    }
  }

  /** Incremental maintenance: re-index exactly one task. */
  upsert(task: SearchableTask): void {
    this.#removePostings(task.id);
    const tokens = this.#tokenizeTask(task);
    this.#taskTokens.set(task.id, tokens);
    let ord = this.#ordOf.get(task.id);
    if (ord === undefined) {
      ord = this.#ids.length;
      this.#ids.push(task.id);
      this.#ordOf.set(task.id, ord);
    }
    for (const token of uniqueSorted([...tokens.title, ...tokens.notes])) {
      this.#insertToken(token);
      this.#addPosting(token, ord);
    }
  }

  /** Incremental maintenance: drop one task. */
  remove(id: string): void {
    this.#removePostings(id);
    const ord = this.#ordOf.get(id);
    if (ord !== undefined) {
      this.#ids[ord] = null;
      this.#ordOf.delete(id);
    }
    this.#taskTokens.delete(id);
  }

  /**
   * Word-prefix AND search. Pass `previous` on appended-character keystrokes:
   * only the previous result set is re-examined (monotone narrowing). Deleting
   * characters or editing mid-query falls back to a fresh indexed query —
   * still O(postings), never O(corpus).
   */
  search(query: string, previous?: PreviousSearch): SearchHit[] {
    const qTokens = uniqueSorted(tokenize(query));
    if (qTokens.length === 0) return [];
    const narrowing =
      previous !== undefined &&
      query.length > previous.query.length &&
      query.startsWith(previous.query);
    const candidates: SearchHit[] = narrowing
      ? previous.hits
          .filter((hit) => {
            const tokens = this.#taskTokens.get(hit.id);
            return tokens !== undefined && this.#matches(tokens, qTokens);
          })
          .map((hit) => {
            const tokens = this.#taskTokens.get(hit.id) as TaskTokens;
            // Ranks depend on the query — recompute, never reuse stale ranks.
            return { id: hit.id, rank: SearchIndex.rankOf(tokens, qTokens) };
          })
      : this.#indexedQuery(qTokens);
    return candidates.sort((a, b) =>
      a.rank !== b.rank ? a.rank - b.rank : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
  }

  /** Semantic reference / documented fallback: plain scan with identical semantics. */
  static naive(tasks: readonly SearchableTask[], query: string): SearchHit[] {
    const qTokens = uniqueSorted(tokenize(query));
    if (qTokens.length === 0) return [];
    const hits: SearchHit[] = [];
    for (const task of tasks) {
      const tokens: TaskTokens = {
        title: uniqueSorted(tokenize(task.title)),
        notes: uniqueSorted(tokenize(task.notes ?? '')),
      };
      if (SearchIndex.matchesTokens(tokens, qTokens)) {
        hits.push({ id: task.id, rank: SearchIndex.rankOf(tokens, qTokens) });
      }
    }
    return hits.sort((a, b) =>
      a.rank !== b.rank ? a.rank - b.rank : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
  }

  /** Every query token must prefix-match some task token (title + notes). */
  static matchesTokens(tokens: TaskTokens, qTokens: readonly string[]): boolean {
    return qTokens.every(
      (q) => someTokenHasPrefix(tokens.title, q) || someTokenHasPrefix(tokens.notes, q),
    );
  }

  /** Rank 0: title covers all query tokens; 1: some; 2: notes only. */
  static rankOf(tokens: TaskTokens, qTokens: readonly string[]): 0 | 1 | 2 {
    let covered = 0;
    for (const q of qTokens) {
      if (someTokenHasPrefix(tokens.title, q)) covered += 1;
    }
    return covered === qTokens.length ? 0 : covered > 0 ? 1 : 2;
  }

  #tokenizeTask(task: SearchableTask): TaskTokens {
    return {
      title: uniqueSorted(tokenize(task.title)),
      notes: uniqueSorted(tokenize(task.notes ?? '')),
    };
  }

  #matches(tokens: TaskTokens, qTokens: readonly string[]): boolean {
    return SearchIndex.matchesTokens(tokens, qTokens);
  }

  #indexedQuery(qTokens: readonly string[]): SearchHit[] {
    let candidates: Set<number> | null = null;
    for (const q of qTokens) {
      const ordinals = new Set<number>();
      for (const token of prefixSlice(this.#tokens, q)) {
        for (const ord of this.#postings.get(token) ?? []) ordinals.add(ord);
      }
      if (candidates === null) {
        candidates = ordinals;
      } else {
        for (const ord of [...candidates]) {
          if (!ordinals.has(ord)) candidates.delete(ord);
        }
      }
      if (candidates.size === 0) return [];
    }
    const hits: SearchHit[] = [];
    for (const ord of candidates ?? []) {
      const id = this.#ids[ord];
      if (id === null || id === undefined) continue;
      const tokens = this.#taskTokens.get(id);
      if (tokens === undefined) continue;
      hits.push({ id, rank: SearchIndex.rankOf(tokens, qTokens) });
    }
    return hits;
  }

  #insertToken(token: string): void {
    const i = lowerBound(this.#tokens, token);
    if (this.#tokens[i] !== token) this.#tokens.splice(i, 0, token);
  }

  #addPosting(token: string, ord: number): void {
    const list = this.#postings.get(token);
    if (list === undefined) {
      this.#postings.set(token, [ord]);
      return;
    }
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((list[mid] as number) < ord) lo = mid + 1;
      else hi = mid;
    }
    list.splice(lo, 0, ord);
  }

  #removePostings(id: string): void {
    const tokens = this.#taskTokens.get(id);
    const ord = this.#ordOf.get(id);
    if (tokens === undefined || ord === undefined) return;
    for (const token of new Set([...tokens.title, ...tokens.notes])) {
      const list = this.#postings.get(token);
      if (list === undefined) continue;
      const at = list.indexOf(ord);
      if (at >= 0) list.splice(at, 1);
      if (list.length === 0) this.#postings.delete(token);
    }
  }
}
