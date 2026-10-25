/**
 * CSV → records (S12, Q8 "Todo.txt/CSV = V1 importers").
 *
 * The CSV reader is a small RFC 4180 state machine (quotes, `""` escapes, CR/LF
 * and CRLF row endings, UTF-8 BOM) — no dependency, no regex- over-splitting,
 * and an unterminated quote rejects the WHOLE file (a truncated file must never
 * half-import).
 *
 * The first record is the header. Column roles are matched on a normalised
 * header name (case/underscore/space insensitive), and the title role must be
 * present or the file is rejected as "not a CSV we understand". Row-level
 * problems (wrong column count, bad date, unknown status/priority, empty or
 * over-long title) REJECT THAT ROW into the recovery file — the row's original
 * text rides along so the file can be repaired by hand.
 *
 * Ambiguities pinned here (documented, not guessed at runtime):
 *   - priority words/letters/numerics map onto the P1..P4 model levels
 *     (`P1` most urgent … `P4` none) — see the `PRIORITY_WORDS` table.
 *   - status words: open/pending/todo/in-progress → open; done/completed/closed
 *     /x/1/true → done; archived → archived; anything else rejects the row.
 *   - a completion date with an empty status implies `done`; with an explicit
 *     `open` it CONTRADICTS and the row is rejected (never silently overridden).
 */

import { err, ok } from '../../storage/errors';
import type { Result } from '../../storage/errors';
import type { List, Task } from '../../storage/types';
import type { Priority } from '../../domain/model';
import type { ImportError } from '../types';
import {
  dateToEpochMs,
  isDate,
  makeList,
  makeTask,
  splitTags,
  titleIssue,
  MAX_NAME,
  MAX_NOTES,
} from './record';
import type { Conversion, ConvertContext, RejectedRow } from './types';

type CsvRow = {
  /** 1-based source line the record started on. */
  readonly line: number;
  readonly cells: readonly string[];
  /** Source text of the whole record (for recovery entries). */
  readonly raw: string;
};

type Table = { readonly header: CsvRow; readonly rows: readonly CsvRow[] };

/** Header aliases per role — normalised first (lowercase, non-alphanumerics dropped). */
const ROLE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  title: ['title', 'task', 'summary', 'name', 'description', 'item'],
  notes: ['notes', 'note', 'details', 'comment'],
  list: ['list', 'project', 'category', 'group', 'area'],
  status: ['status', 'state'],
  done: ['done'],
  completed: ['completedat', 'completiondate', 'completedon', 'donedate', 'completed'],
  due: ['duedate', 'due', 'deadline'],
  priority: ['priority', 'prio', 'importance'],
  tags: ['tags', 'labels', 'label'],
};

type Role = keyof typeof ROLE_ALIASES;

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, '');
}

/**
 * RFC 4180 parse. Rows are located by source offset so a rejected row can carry
 * its ORIGINAL text into the recovery document.
 */
export function parseCsvTable(text: string): Result<Table, ImportError> {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (source.trim() === '') {
    return err({ code: 'PARSE_ERROR', message: 'CSV file is empty' });
  }

  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;
  let rowStart = 0;
  let rowHasContent = false;

  const pushField = (): void => {
    cells.push(field);
    field = '';
  };
  const pushRow = (end: number): void => {
    pushField();
    // Blank records (a stray newline, a whitespace-only line) are separators,
    // not data — never reported as malformed rows.
    if (!cells.every((cellValue) => cellValue.trim() === '')) {
      // The recovery entry carries the row WITHOUT its line terminator: the
      // newline is a separator, not record content.
      const slice = source.slice(rowStart, end);
      const raw = slice.endsWith('\r\n')
        ? slice.slice(0, -2)
        : slice.endsWith('\n') || slice.endsWith('\r')
          ? slice.slice(0, -1)
          : slice;
      rows.push({ line: rowLine, cells, raw });
    }
    cells = [];
    rowHasContent = false;
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i] ?? '';
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
        continue;
      }
      if (ch === '\r') {
        if (source[i + 1] === '\n') i += 1;
        field += '\n';
        line += 1;
        continue;
      }
      if (ch === '\n') {
        field += '\n';
        line += 1;
        continue;
      }
      field += ch;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      rowHasContent = true;
      continue;
    }
    if (ch === ',') {
      pushField();
      rowHasContent = true;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      const end = i + 1;
      pushRow(end);
      line += 1;
      rowLine = line;
      rowStart = end;
      continue;
    }
    field += ch;
    rowHasContent = true;
  }

  if (inQuotes) {
    return err({ code: 'PARSE_ERROR', message: 'CSV file has an unterminated quoted field' });
  }
  if (rowHasContent || field !== '' || cells.length > 0) pushRow(source.length);

  const header = rows[0];
  const body = rows.slice(1);
  if (header === undefined) {
    return err({ code: 'PARSE_ERROR', message: 'CSV file has no header row' });
  }
  return ok({ header, rows: body });
}

/** Column roles in declaration order — the first matching column wins a role. */
const ROLE_KEYS = Object.keys(ROLE_ALIASES) as readonly (keyof typeof ROLE_ALIASES)[];

/** Map header cells to roles; the first matching column wins a role. */
function mapRoles(header: CsvRow): { roles: Partial<Record<Role, number>> } {
  const roles: Partial<Record<Role, number>> = {};
  const used = new Set<number>();
  header.cells.forEach((cell, index) => {
    const name = normalizeHeader(cell);
    if (name === '') return;
    for (const key of ROLE_KEYS) {
      if (used.has(index)) return;
      if (roles[key] !== undefined) continue;
      const aliases = ROLE_ALIASES[key];
      if (aliases === undefined || !aliases.includes(name)) continue;
      roles[key] = index;
      used.add(index);
    }
  });
  return { roles };
}

const DONE_WORDS = new Set([
  'done',
  'complete',
  'completed',
  'closed',
  'finished',
  'x',
  '1',
  'true',
  'yes',
]);
const OPEN_WORDS = new Set([
  '',
  'open',
  'pending',
  'todo',
  'inprogress',
  'active',
  'new',
  '0',
  'false',
  'no',
]);
const ARCHIVED_WORDS = new Set(['archived', 'archive']);

/**
 * Priority words → model levels (`P1` most urgent … `P4` none), covering four
 * source dialects: this app's own `P1..P4` literals; words low/medium/high;
 * todo.txt letters A (most urgent) … C; and this app's LEGACY numeric encoding
 * (`0` = low … `2` = high, the pre-schemaVersion-2 MVP encoding — mapped by the
 * same intent as `legacyPriorityToLevel` in `storage/migrations.ts`).
 */
const PRIORITY_WORDS: Readonly<Record<string, Priority>> = {
  '': 'P4',
  none: 'P4',
  no: 'P4',
  p1: 'P1',
  p2: 'P2',
  p3: 'P3',
  p4: 'P4',
  low: 'P3',
  l: 'P3',
  c: 'P3',
  '0': 'P3',
  medium: 'P2',
  med: 'P2',
  m: 'P2',
  b: 'P2',
  '1': 'P2',
  high: 'P1',
  h: 'P1',
  a: 'P1',
  '2': 'P1',
};

function word(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/gu, '');
}

/** Conversion for a CSV source; whole-file problems come back as typed errors. */
export function convertCsv(text: string, ctx: ConvertContext): Result<Conversion, ImportError> {
  const table = parseCsvTable(text);
  if (!table.ok) return err(table.error);

  const sourceTable = table.value;
  const { roles } = mapRoles(sourceTable.header);
  const titleCol = roles['title'];
  if (titleCol === undefined) {
    return err({
      code: 'NOT_A_BACKUP',
      message:
        'CSV header has no title column — expected one of: title, task, summary, name, description',
    });
  }

  const cell = (row: CsvRow, role: Role): string => {
    const index = roles[role];
    if (index === undefined) return '';
    return row.cells[index] ?? '';
  };

  const tasks: Task[] = [];
  const rejected: RejectedRow[] = [];
  const notes: string[] = [];
  const listByName = new Map<string, List>();

  const reject = (row: CsvRow, issue: string): void => {
    rejected.push({ line: row.line, text: row.raw, issues: [issue] });
  };

  for (const row of sourceTable.rows) {
    if (row.cells.length !== sourceTable.header.cells.length) {
      reject(
        row,
        `row: has ${String(row.cells.length)} columns, the header declares ${String(sourceTable.header.cells.length)}`,
      );
      continue;
    }

    const title = cell(row, 'title').trim();
    const titleProblem = titleIssue(title);
    if (titleProblem !== null) {
      reject(row, titleProblem);
      continue;
    }

    const notesValue = cell(row, 'notes');
    if (notesValue.length > MAX_NOTES) {
      reject(row, `notes: longer than ${String(MAX_NOTES)} characters`);
      continue;
    }

    const listValue = cell(row, 'list').trim();
    if (listValue.length > MAX_NAME) {
      reject(row, `list: longer than ${String(MAX_NAME)} characters`);
      continue;
    }
    const listName = listValue === '' ? ctx.listName : listValue;

    const dueValue = cell(row, 'due').trim();
    if (dueValue !== '' && !isDate(dueValue)) {
      reject(row, `due date "${dueValue}" is not YYYY-MM-DD`);
      continue;
    }

    const completedValue = cell(row, 'completed').trim();
    if (completedValue !== '' && !isDate(completedValue)) {
      reject(row, `completion date "${completedValue}" is not YYYY-MM-DD`);
      continue;
    }

    const statusValue = word(cell(row, 'status'));
    const doneCell = word(cell(row, 'done'));
    let status: 'open' | 'done' | 'archived';
    if (ARCHIVED_WORDS.has(statusValue)) {
      status = 'archived';
    } else if (DONE_WORDS.has(statusValue) || DONE_WORDS.has(doneCell) || doneCell === 'true') {
      status = 'done';
    } else if (OPEN_WORDS.has(statusValue) && (doneCell === '' || OPEN_WORDS.has(doneCell))) {
      if (completedValue !== '' && statusValue !== '') {
        // An EXPLICIT open status with a completion date contradicts itself —
        // the row is rejected (never silently overridden); an EMPTY status
        // with a completion date instead implies done (documented intent).
        reject(
          row,
          `status: "${cell(row, 'status').trim()}" contradicts completion date "${completedValue}"`,
        );
        continue;
      }
      status = completedValue !== '' ? 'done' : 'open';
    } else {
      reject(row, `status "${cell(row, 'status').trim()}" is not open|done|archived`);
      continue;
    }
    if (status === 'open' && completedValue !== '') {
      reject(row, `status: "open" contradicts completion date "${completedValue}"`);
      continue;
    }
    if (status !== 'open' && completedValue === '' && status === 'archived') {
      // An archived row without a completion date is legal (records imported
      // from elsewhere can lose it); nothing to decide here.
      notes.push(`line ${String(row.line)}: archived without a completion date`);
    }

    const priorityValue = word(cell(row, 'priority'));
    const priority = PRIORITY_WORDS[priorityValue];
    if (priority === undefined) {
      reject(row, `priority "${cell(row, 'priority').trim()}" is not 0|1|2 (low|medium|high)`);
      continue;
    }

    const tagsValue = cell(row, 'tags').trim();
    let tags: string[] = [];
    if (tagsValue !== '') {
      const parsedTags = splitTags(tagsValue, /[;|,]/u);
      if ('issue' in parsedTags) {
        reject(row, parsedTags.issue);
        continue;
      }
      tags = parsedTags.tags;
    }

    let list = listByName.get(listName);
    if (list === undefined) {
      list = makeList(listName, ctx);
      listByName.set(listName, list);
    }

    const completedAt = completedValue === '' ? undefined : dateToEpochMs(completedValue);
    tasks.push(
      makeTask(
        {
          listId: list.id,
          title,
          status,
          priority,
          tags,
          createdAt: ctx.now,
          notes: notesValue === '' ? null : notesValue,
          ...(dueValue === '' ? {} : { dueDate: dueValue }),
          ...(completedAt === undefined ? {} : { completedAt }),
        },
        ctx,
      ),
    );
  }

  return ok({
    lists: [...listByName.values()],
    tasks,
    rejected,
    notes,
  });
}
