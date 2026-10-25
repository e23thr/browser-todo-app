/**
 * Fuzzy ranking for the command palette (V1 S8) — pure, no DOM.
 *
 * Subsequence matching with word-start / consecutive bonuses: typing `gt`
 * matches "Go to Today", `mk` matches "Mark complete". Empty query keeps the
 * curated order (actions first, then tasks).
 *
 * Performance (§9.1 INP < 200 ms at 10k tasks): one linear scan over the entry
 * haystack per keystroke, early bail on non-matches, and the sort runs only over
 * matched entries. `tests/unit/commands/paletteIndex.test.ts` pins a 10k-entry
 * query budget with a wide margin.
 */

export interface PaletteEntry {
  readonly id: string;
  readonly kind: 'action' | 'task';
  /** Display text (already localized, or the task title). */
  readonly label: string;
  /** Extra searchable text (group names, synonyms) appended to `label`. */
  readonly haystack: string;
}

/** Score a query against one text; `null` = not a subsequence match. */
export function fuzzyScore(query: string, text: string): number | null {
  if (query === '') return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let score = 0;
  let cursor = 0;
  let previous = -2;
  for (const char of q) {
    if (char === ' ') {
      // A space in the query matches any boundary-ish gap (cheap "gt" → "go to").
      previous = -2;
      continue;
    }
    const at = t.indexOf(char, cursor);
    if (at < 0) return null;
    score += 1;
    if (at === previous + 1) score += 3; // consecutive run
    if (at === 0 || t[at - 1] === ' ' || t[at - 1] === '-') score += 2; // word start
    score -= Math.min(at - cursor, 8); // proximity penalty, bounded
    previous = at;
    cursor = at + 1;
  }
  return score;
}

/**
 * Top `limit` entries for `query`, best first. Unmatched entries are dropped;
 * an empty query returns the curated order capped at `limit`.
 */
export function rankEntries(
  query: string,
  entries: readonly PaletteEntry[],
  limit: number,
): PaletteEntry[] {
  const trimmed = query.trim();
  if (trimmed === '') return entries.slice(0, limit);
  const matched: { entry: PaletteEntry; score: number }[] = [];
  for (const entry of entries) {
    const score = fuzzyScore(trimmed, `${entry.label} ${entry.haystack}`);
    if (score !== null) matched.push({ entry, score });
  }
  matched.sort((a, b) => (b.score !== a.score ? b.score - a.score : 0));
  return matched.slice(0, limit).map((m) => m.entry);
}
