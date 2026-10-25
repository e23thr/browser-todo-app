/**
 * Todo.txt → records (S12, Q8 "Todo.txt/CSV = V1 importers").
 *
 * Follows the todo.txt v2 grammar where it is unambiguous:
 *   `x <completion-date> <creation-date> (P) text due:YYYY-MM-DD +project @context`
 *
 * Deviations, all deliberate and documented:
 *   - `+project` / `@context` become TAGS (the model has no project entity in
 *     V1 and S1 filtering is tags-based); the tokens stay in the title, so the
 *     import is lossless for the text itself.
 *   - Whitespace inside a line collapses to single spaces (the line is the unit
 *     of meaning; runs of spaces are not user data).
 *   - A done line with no completion date keeps `completedAt` unset instead of
 *     inventing one — the row shows no "completed on" line rather than a false date.
 *   - Anything that would violate the ADR-004 §6.2 caps (title, tags, real
 *     calendar dates) REJECTS the line into the recovery file — never truncation.
 *
 * Blank lines and the `todo.txt (v2)` header are skipped, not rejected.
 */

import {
  dateToEpochMs,
  isDate,
  makeList,
  makeTask,
  titleIssue,
  MAX_TAG_LEN,
  MAX_TAGS,
} from './record';
import type { Conversion, ConvertContext, RejectedRow } from './types';
import type { Priority } from '../../domain/model';
import type { List, Task } from '../../storage/types';

/** `x ` marks the task complete (todo.txt v2 §2.1). */
const DONE_RE = /^x\s+/u;
/** A date-shaped leading token — validated against the real calendar before use. */
const DATE_TOKEN_RE = /^(\d{4}-\d{2}-\d{2})(?:\s+|$)/u;
/** `(A)`..`(C)` are priorities; anything else stays literal title text. */
const PRIORITY_RE = /^\(([A-C])\)\s+/u;
/** The optional format header: `todo.txt (v2)`. */
const HEADER_RE = /^todo\.txt\s*\(v\d+\)$/iu;

/**
 * todo.txt priorities are `A` (most urgent) … `C`; the model's `P1` (most
 * urgent) … `P3` match them one-to-one, `P4` = no priority (todo.txt: no `(P)`).
 */
const PRIORITY_BY_LETTER: Readonly<Record<string, Priority>> = { A: 'P1', B: 'P2', C: 'P3' };

export function convertTodoTxt(text: string, ctx: ConvertContext): Conversion {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = source.split(/\r\n|\n|\r/u);

  const tasks: Task[] = [];
  const rejected: RejectedRow[] = [];
  const notes: string[] = [];
  const lists: List[] = [];
  let list: List | null = null;
  let sawHeader = false;

  const reject = (line: number, raw: string, issue: string): void => {
    rejected.push({ line, text: raw, issues: [issue] });
  };

  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    const trimmed = raw.trim();
    if (trimmed === '') return;
    if (!sawHeader && HEADER_RE.test(trimmed)) {
      sawHeader = true;
      notes.push(`todo.txt version header on line ${String(lineNo)} ignored`);
      return;
    }

    let rest = trimmed;
    let status: 'open' | 'done' = 'open';
    let completedAt: number | undefined;
    let createdAt = ctx.now;

    if (DONE_RE.test(rest)) {
      status = 'done';
      rest = rest.replace(DONE_RE, '');
      // Leading dates after `x `: completion first, creation second (v2 §3.2).
      const dates: string[] = [];
      while (dates.length < 2) {
        const match = DATE_TOKEN_RE.exec(rest);
        if (match === null) break;
        const token = match[1];
        if (token === undefined) break;
        if (!isDate(token)) {
          reject(lineNo, raw, `date "${token}" is not a real calendar day`);
          return;
        }
        dates.push(token);
        rest = rest.slice(match[0].length);
      }
      const completion = dates[0];
      const creation = dates[1];
      if (completion !== undefined) completedAt = dateToEpochMs(completion);
      if (creation !== undefined) createdAt = dateToEpochMs(creation);
    }

    const priorityMatch = PRIORITY_RE.exec(rest);
    let priority: Priority = 'P4';
    if (priorityMatch !== null) {
      const letter = priorityMatch[1];
      const mapped = letter === undefined ? undefined : PRIORITY_BY_LETTER[letter];
      if (mapped !== undefined) {
        priority = mapped;
        rest = rest.slice(priorityMatch[0].length);
      }
    }

    const dueValues: string[] = [];
    const plainWords: string[] = [];
    const tagWords: string[] = [];
    for (const word of rest.split(/\s+/u)) {
      if (word === '') continue;
      if (word.startsWith('due:')) {
        dueValues.push(word.slice(4));
        continue;
      }
      plainWords.push(word);
      if ((word.startsWith('+') || word.startsWith('@')) && word.length > 1)
        tagWords.push(word.slice(1));
    }

    let dueDate: string | undefined;
    for (const value of dueValues) {
      if (value === '') continue; // a bare `due:` is just text we dropped — nothing to parse
      if (!isDate(value)) {
        reject(lineNo, raw, `due date "due:${value}" is not YYYY-MM-DD`);
        return;
      }
      dueDate ??= value;
    }

    const tags: string[] = [];
    const seen = new Set<string>();
    for (const tag of tagWords) {
      if (tag.length > MAX_TAG_LEN) {
        reject(lineNo, raw, `tags: tag longer than ${String(MAX_TAG_LEN)} characters`);
        return;
      }
      if (seen.has(tag)) continue;
      seen.add(tag);
      tags.push(tag);
    }
    if (tags.length > MAX_TAGS) {
      reject(lineNo, raw, `tags: more than ${String(MAX_TAGS)} tags`);
      return;
    }

    const title = plainWords.join(' ');
    const issue = titleIssue(title);
    if (issue !== null) {
      reject(lineNo, raw, issue);
      return;
    }

    if (list === null) {
      list = makeList(ctx.listName, ctx);
      lists.push(list);
    }
    tasks.push(
      makeTask(
        {
          listId: list.id,
          title,
          status,
          priority,
          tags,
          createdAt,
          ...(dueDate === undefined ? {} : { dueDate }),
          ...(completedAt === undefined ? {} : { completedAt }),
        },
        ctx,
      ),
    );
  });

  return {
    lists,
    tasks,
    rejected,
    notes,
  };
}
