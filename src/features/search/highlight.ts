/**
 * Search-result highlighting (design §7 S5, checklist item 25).
 *
 * The RESULT SET comes from the domain `SearchIndex` (word-prefix AND, D5) —
 * this module only decides where to paint `<mark>` in the already-matched rows.
 * Highlighting scans each query token as a case-insensitive SUBSTRING of the
 * visible text (a word-prefix match always contains its prefix substring, so
 * every hit visibly highlights). Overlapping token matches merge into one
 * segment run; the scan works on the lowercased copy, so Thai (no case) and
 * mixed scripts behave identically.
 *
 * The "match came from the notes" predicate drives the S5 notes excerpt: the
 * excerpt is shown only when NO query token appears in the title — i.e. the
 * task matched through its notes ("query that matches only notes").
 */

/** One run of the rendered text; `hit` runs wrap in `<mark>`. */
export interface HighlightSegment {
  readonly text: string;
  readonly hit: boolean;
}

/** Split `query` into tokens the same way the domain index does (whitespace/punctuation). */
export function queryTokens(query: string): string[] {
  return [
    ...new Set(
      query
        .normalize('NFKC')
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u),
    ),
  ].filter((token) => token.length > 0);
}

/** Merge overlap/adjacency-duplicate ranges into one ascending list. */
function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [sorted[0] as [number, number]];
  for (const range of sorted.slice(1)) {
    const last = out[out.length - 1] as [number, number];
    if (range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else out.push(range);
  }
  return out;
}

/**
 * Segment `text` so every occurrence of any query token is a `hit` segment.
 * Returns `[{ text, hit: false }]` when nothing matches (the whole string).
 */
export function highlightSegments(text: string, tokens: readonly string[]): HighlightSegment[] {
  if (text === '' || tokens.length === 0) return [{ text, hit: false }];
  const haystack = text.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const token of tokens) {
    let at = haystack.indexOf(token);
    while (at >= 0) {
      ranges.push([at, at + token.length]);
      at = haystack.indexOf(token, at + token.length);
    }
  }
  if (ranges.length === 0) return [{ text, hit: false }];
  const merged = mergeRanges(ranges);
  const out: HighlightSegment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) out.push({ text: text.slice(cursor, start), hit: false });
    out.push({ text: text.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false });
  return out;
}

/** Does any query token appear as a substring of `text`? (case-insensitive) */
export function textMatches(text: string, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return false;
  const haystack = text.toLowerCase();
  return tokens.some((token) => haystack.includes(token));
}

/**
 * S5 edge case: show the notes excerpt only when the task matched through its
 * notes — no query token appears in the title itself.
 */
export function notesExcerptNeeded(
  title: string,
  notes: string | null | undefined,
  tokens: readonly string[],
): boolean {
  if (notes === null || notes === undefined || notes === '' || tokens.length === 0) return false;
  if (textMatches(title, tokens)) return false;
  return textMatches(notes, tokens);
}
