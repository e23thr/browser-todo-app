/**
 * Shared record construction for the foreign importers (S12).
 *
 * Caps and formats are the ADR-004 §6.2 binding table — the SAME numbers
 * `src/storage/validate.ts` enforces, so a record built here cannot pass the
 * converter and then fail Stage B (or vice versa) by accident. When a converter
 * cannot honour a cap it REJECTS the line (with the reason) rather than
 * truncating: no silent loss.
 */

import { newUlid } from '../../storage/id';
import { orderKeyFirst } from '../../storage/orderKey';
import { isLocalDateString } from '../../storage/validate';
import type { List, Task } from '../../storage/types';
import type { Priority } from '../../domain/model';
import type { ConvertContext, ForeignFormat } from './types';

/** ADR-004 §6.2 / `storage/validate.ts` limits, restated at the parse edge. */
export const MAX_TITLE = 1000;
export const MAX_NOTES = 20_000;
export const MAX_NAME = 200;
export const MAX_TAGS = 50;
export const MAX_TAG_LEN = 100;

/**
 * Colour for lists an importer creates — the same `#2e6fd9` preset the list
 * dialog calls `DEFAULT_LIST_COLOR`, re-declared instead of imported so this
 * framework-layer module never reaches into `src/features`.
 */
export const IMPORT_LIST_COLOR = '#2e6fd9';

/** `YYYY-MM-DD` on the real calendar (same predicate Stage B validates with). */
export function isDate(value: string): boolean {
  return isLocalDateString(value);
}

/** Local-midnight epoch ms for a `YYYY-MM-DD` label (call after `isDate`). */
export function dateToEpochMs(value: string): number {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  return new Date(year, month - 1, day).getTime();
}

/**
 * Fallback list name from the source file: stem without its extension,
 * else the format's own name. User data, never UI copy — locale-independent
 * on purpose (it is a file name, not a label we translate).
 */
export function defaultListName(fileName: string, format: ForeignFormat): string {
  const stem = fileName.replace(/\.[^.]+$/u, '').trim();
  const fallback = format === 'csv' ? 'CSV' : 'Todo.txt';
  const name = stem === '' ? fallback : stem;
  return name.slice(0, MAX_NAME);
}

/** One target list. Every imported record references an accepted list (Stage B). */
export function makeList(name: string, ctx: ConvertContext): List {
  return {
    id: newUlid(ctx.now),
    name,
    color: IMPORT_LIST_COLOR,
    sortOrder: orderKeyFirst(),
    createdAt: ctx.now,
    updatedAt: ctx.now,
    deletedAt: null,
    deviceId: ctx.deviceId,
  };
}

export type TaskSeed = {
  readonly listId: string;
  readonly title: string;
  readonly status: 'open' | 'done' | 'archived';
  readonly priority: Priority;
  readonly tags: readonly string[];
  readonly createdAt: number;
  readonly notes?: string | null;
  readonly dueDate?: string;
  readonly completedAt?: number;
};

/** One task record in canonical ADR-002 field order (whitelist-rebuilt later anyway). */
export function makeTask(seed: TaskSeed, ctx: ConvertContext): Task {
  return {
    id: newUlid(ctx.now),
    listId: seed.listId,
    title: seed.title,
    notes: seed.notes ?? null,
    status: seed.status,
    priority: seed.priority,
    ...(seed.dueDate === undefined ? {} : { dueDate: seed.dueDate }),
    tags: [...seed.tags],
    sortOrder: orderKeyFirst(),
    createdAt: seed.createdAt,
    updatedAt: ctx.now,
    ...(seed.completedAt === undefined ? {} : { completedAt: seed.completedAt }),
    deletedAt: null,
    deviceId: ctx.deviceId,
  };
}

/** Title check shared by both formats: trimmed 1..MAX_TITLE (validate's rule). */
export function titleIssue(title: string): string | null {
  if (title.trim().length < 1) return 'title: empty (1..1000 chars required)';
  if (title.length > MAX_TITLE) return `title: longer than ${String(MAX_TITLE)} characters`;
  return null;
}

/**
 * Split a tag cell into tags. Rejects (never truncates) when the record would
 * exceed the schema caps, so the line reaches the recovery file with a reason.
 */
export function splitTags(raw: string, separators: RegExp): { tags: string[] } | { issue: string } {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(separators)) {
    const tag = part.trim();
    if (tag === '') continue;
    if (tag.length > MAX_TAG_LEN) {
      return { issue: `tags: tag longer than ${String(MAX_TAG_LEN)} characters` };
    }
    if (seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  if (tags.length > MAX_TAGS) {
    return { issue: `tags: more than ${String(MAX_TAGS)} tags` };
  }
  return { tags };
}
