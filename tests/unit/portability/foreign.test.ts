/**
 * S12 foreign importers — Todo.txt and CSV through the ADR-004 pipeline.
 *
 * Binding property under test: a foreign file gets NO second validation path.
 * Converters emit records; `prepareForeignImport` wraps them in an ADR-004
 * document and rides the SAME `prepareImport` stages, so every reject here must
 * also be a zero-side-effect reject (no DB writes, no snapshot) and every apply
 * must take the automatic pre-import snapshot (the undo).
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { AppDBImpl } from '../../../src/storage/db';
import { applyImport } from '../../../src/portability/import';
import { listSnapshots } from '../../../src/portability/snapshots-api';
import {
  detectImportFormat,
  parseCsvTable,
  prepareForeignImport,
} from '../../../src/portability/foreign';
import { convertCsv } from '../../../src/portability/foreign/csv';
import { convertTodoTxt } from '../../../src/portability/foreign/todotxt';
import type { ConvertContext } from '../../../src/portability/foreign/types';
import { MAX_IMPORT_BYTES } from '../../../src/portability/constants';
import { fakeFile, makeDocText, makeList, makeSettings, makeTask, seedCorpus, T0 } from './helpers';
import { openFixtureDb, uniqueDbName } from '../storage/fixtures';

const opened: AppDBImpl[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

async function openSeeded(): Promise<AppDBImpl> {
  const db = await openFixtureDb(uniqueDbName('foreign'));
  opened.push(db);
  await db.put('settings', makeSettings({ theme: 'dark' }));
  await db.put('lists', makeList());
  await db.put('tasks', makeTask());
  return db;
}

const CTX: ConvertContext = {
  deviceId: '01ARZ3NDEKTSV4RRFFQ6AAAAAA',
  now: T0,
  listName: 'Imported',
};

/** Zero-side-effects assertion for every reject drill. */
async function expectUntouched(db: AppDBImpl): Promise<void> {
  const snaps = await listSnapshots({ db });
  expect(snaps.ok && snaps.value).toEqual([]);
  const lists = await db.getAll('lists');
  expect(lists.ok && lists.value).toHaveLength(1);
  const tasks = await db.getAll('tasks');
  expect(tasks.ok && tasks.value).toHaveLength(1);
}

/* ------------------------------- todo.txt ------------------------------- */

describe('convertTodoTxt', () => {
  it('converts open/done lines with dates, priorities, due dates and tags', () => {
    const text = [
      'todo.txt (v2)',
      '',
      '(A) buy milk +errands @home due:2026-10-30',
      'x 2026-10-20 2026-10-01 pay rent +home',
      'plain task (not a priority marker in the middle)',
    ].join('\n');
    const out = convertTodoTxt(text, CTX);
    expect(out.rejected).toEqual([]);
    expect(out.tasks).toHaveLength(3);
    const [first, done, plain] = out.tasks;

    expect(first?.status).toBe('open');
    expect(first?.priority).toBe('P1'); // (A) = most urgent
    // The +tags stay in the title (documented deviation — lossless for the text itself).
    expect(first?.title).toBe('buy milk +errands @home');
    expect(first?.tags).toEqual(['errands', 'home']);
    expect(first?.dueDate).toBe('2026-10-30');

    expect(done?.status).toBe('done');
    expect(done?.completedAt).toBe(new Date(2026, 9, 20).getTime());
    expect(done?.createdAt).toBe(new Date(2026, 9, 1).getTime());
    expect(done?.priority).toBe('P4');

    expect(plain?.status).toBe('open');
    expect(plain?.title).toBe('plain task (not a priority marker in the middle)');
    expect(out.lists).toHaveLength(1);
    expect(out.lists[0]?.name).toBe('Imported');
  });

  it('maps B/C priorities, strips a UTF-8 BOM, and skips blank lines', () => {
    const out = convertTodoTxt('﻿(B) med +a\n(C) low\n\n', CTX);
    expect(out.rejected).toEqual([]);
    expect(out.tasks.map((t) => t.priority)).toEqual(['P2', 'P3']);
    expect(out.tasks.map((t) => t.title)).toEqual(['med +a', 'low']);
  });

  it('keeps +project/@context tokens in the title (documented deviation)', () => {
    const out = convertTodoTxt('fix +bug @work', CTX);
    expect(out.tasks[0]?.title).toBe('fix +bug @work');
    expect(out.tasks[0]?.tags).toEqual(['bug', 'work']);
  });

  it('rejects a line with a non-calendar date — the line goes to `rejected`, verbatim', () => {
    const out = convertTodoTxt('x 2026-02-30 broken\nok line', CTX);
    expect(out.tasks).toHaveLength(1);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0]).toMatchObject({ line: 1, text: 'x 2026-02-30 broken' });
    expect(out.rejected[0]?.issues[0]).toContain('not a real calendar day');
  });

  it('rejects a malformed due date, an over-cap title and over-cap tags — never truncates', () => {
    const longTitle = 't'.repeat(1001);
    const manyTags = Array.from({ length: 51 }, (_, i) => '+t' + String(i)).join(' ');
    const out = convertTodoTxt(['due:soon broken', longTitle, 'flood ' + manyTags].join('\n'), CTX);
    expect(out.tasks).toEqual([]);
    expect(out.rejected).toHaveLength(3);
    expect(out.rejected[0]?.issues[0]).toContain('due:soon');
    expect(out.rejected[1]?.issues[0]).toContain('longer than 1000');
    expect(out.rejected[2]?.issues[0]).toContain('more than 50 tags');
  });

  it('rejects a 101-character tag', () => {
    const out = convertTodoTxt(`x +${'a'.repeat(101)}`, CTX);
    expect(out.tasks).toEqual([]);
    expect(out.rejected[0]?.issues[0]).toContain('tag longer than 100');
  });

  it('handles CRLF line endings', () => {
    const out = convertTodoTxt('one\r\ntwo\r\n', CTX);
    expect(out.tasks.map((t) => t.title)).toEqual(['one', 'two']);
  });
});

/* ---------------------------------- CSV ---------------------------------- */

describe('parseCsvTable (RFC 4180)', () => {
  it('handles quotes, "" escapes, CRLF and newlines inside quoted fields', () => {
    const table = parseCsvTable('title,notes\r\n"say ""hi""","line1\nline2"\r\n');
    expect(table.ok).toBe(true);
    if (!table.ok) return;
    expect(table.value.header.cells).toEqual(['title', 'notes']);
    expect(table.value.rows[0]?.cells).toEqual(['say "hi"', 'line1\nline2']);
  });

  it('rejects an unterminated quote as a whole-file PARSE_ERROR', () => {
    const table = parseCsvTable('title\n"never closed');
    expect(table.ok).toBe(false);
    if (!table.ok) expect(table.error.code).toBe('PARSE_ERROR');
  });

  it('rejects empty input', () => {
    const table = parseCsvTable('   \n  ');
    expect(table.ok).toBe(false);
    if (!table.ok) expect(table.error.code).toBe('PARSE_ERROR');
  });
});

describe('convertCsv', () => {
  it('maps header aliases and converts rows with dialect priorities/statuses', () => {
    const text = [
      'Task,Status,Priority,Due Date,Completed,Labels,List,Notes',
      'ship it,done,high,2026-10-01,2026-10-02,a|b,Work,notes here',
      'later,pending,low,,,,,',
      'archived one,archived,medium,,,,Personal,',
      'date-only-done,,,,2026-10-05,,,', // empty status + completion date => done, no priority
      'numeric legacy,,1,,,,,', // legacy numeric: 1 = medium => P2
    ].join('\r\n');
    const out = convertCsv(text, CTX);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const { tasks, rejected, lists } = out.value;
    expect(rejected).toEqual([]);
    expect(tasks).toHaveLength(5);
    expect(lists.map((l) => l.name).sort()).toEqual(['Imported', 'Personal', 'Work']);
    expect(tasks[0]).toMatchObject({
      title: 'ship it',
      status: 'done',
      priority: 'P1',
      dueDate: '2026-10-01',
      completedAt: new Date(2026, 9, 2).getTime(),
      tags: ['a', 'b'],
      notes: 'notes here',
    });
    expect(tasks[1]).toMatchObject({ title: 'later', status: 'open', priority: 'P3' });
    expect(tasks[2]).toMatchObject({ title: 'archived one', status: 'archived', priority: 'P2' });
    expect(tasks[3]).toMatchObject({ title: 'date-only-done', status: 'done', priority: 'P4' });
    expect(tasks[4]).toMatchObject({ title: 'numeric legacy', priority: 'P2' });
  });

  it('rejects a file whose header has no title column (whole file)', () => {
    const out = convertCsv('foo,bar\n1,2\n', CTX);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('NOT_A_BACKUP');
  });

  it('quarantines individual bad rows with their verbatim source text', () => {
    const text = [
      'title,status,due',
      'good one,open,',
      'bad date,open,2026-99-99',
      'bad status,sortof,',
      ',open,',
      'wrong columns,open,,extra',
    ].join('\n');
    const out = convertCsv(text, CTX);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.tasks.map((t) => t.title)).toEqual(['good one']);
    expect(out.value.rejected).toHaveLength(4);
    expect(out.value.rejected[0]).toMatchObject({ line: 3, text: 'bad date,open,2026-99-99' });
    expect(out.value.rejected[1]?.issues[0]).toContain('not open|done|archived');
    expect(out.value.rejected[2]?.issues[0]).toContain('title: empty');
    expect(out.value.rejected[3]?.issues[0]).toContain('columns');
  });

  it('rejects an explicit "open" that contradicts a completion date', () => {
    const out = convertCsv('title,status,completed\ncontradiction,open,2026-10-01\n', CTX);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.tasks).toEqual([]);
    expect(out.value.rejected[0]?.issues[0]).toContain('contradicts');
  });
});

/* ------------------------- detection + pipeline ------------------------- */

describe('detectImportFormat', () => {
  it('prefers the file extension, then sniffs content', () => {
    expect(detectImportFormat(fakeFile('a.json', 'x'), 'x')).toBe('json');
    expect(detectImportFormat(fakeFile('a.csv', 'x'), 'x')).toBe('csv');
    expect(detectImportFormat(fakeFile('todo.txt', 'x'), 'x')).toBe('todotxt');
    expect(detectImportFormat(fakeFile('list.TODO', 'x'), 'x')).toBe('todotxt');
    expect(detectImportFormat(fakeFile('noext', ''), '{"format":')).toBe('json');
    expect(detectImportFormat(fakeFile('noext', ''), 'title,notes')).toBe('csv');
    expect(detectImportFormat(fakeFile('noext', ''), 'plain line')).toBe('todotxt');
  });
});

describe('prepareForeignImport — the SAME validated pipeline', () => {
  it('routes a JSON file straight to prepareImport', async () => {
    const db = await openSeeded();
    const corpus = seedCorpus();
    const prepared = await prepareForeignImport(
      fakeFile('backup.json', makeDocText({ ...corpus })),
      { db },
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.accepted).toEqual({ lists: 2, tasks: 3, settings: true });
  });

  it('CSV happy path → plan, then apply lands rows AND takes the pre-import snapshot', async () => {
    const db = await openSeeded();
    const text = 'title,priority\nfirst task,high\nsecond task,low\n';
    const prepared = await prepareForeignImport(fakeFile('my-tasks.csv', text), {
      db,
      now: () => T0,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const plan = prepared.value;
    expect(plan.accepted).toEqual({ lists: 1, tasks: 2, settings: true });
    expect(plan.quarantined).toEqual([]);
    expect(plan.fileSummary.fileName).toBe('my-tasks.csv');
    // Settings ride through verbatim — the foreign file must not reset theme/locale.
    expect(plan.records.settings?.theme).toBe('dark');

    const applied = await applyImport(plan, { db });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.outcome).toBe('applied');
    expect(applied.value.undoSnapshot).not.toBeNull();
    const tasks = await db.getAll('tasks');
    expect(tasks.ok && tasks.value).toHaveLength(2);
    const snaps = await listSnapshots({ db });
    expect(snaps.ok && snaps.value).toHaveLength(1);
  });

  it('Todo.txt happy path: the fallback list is the file stem', async () => {
    const db = await openSeeded();
    const prepared = await prepareForeignImport(
      fakeFile('chores.txt', '(A) wash +home\nx 2026-10-10 done thing\n'),
      { db, now: () => T0 },
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.accepted).toEqual({ lists: 1, tasks: 2, settings: true });
    expect(prepared.value.records.lists[0]?.name).toBe('chores');
  });

  it('a wholly malformed CSV rejects with NOTHING_TO_IMPORT + recovery file, zero side effects', async () => {
    const db = await openSeeded();
    const bad = 'title,status\nbad status row,mystery\nanother,sortof\n';
    const prepared = await prepareForeignImport(fakeFile('bad.csv', bad), { db });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.code).toBe('NOTHING_TO_IMPORT');
    if (prepared.error.code !== 'NOTHING_TO_IMPORT') return;
    expect(prepared.error.quarantined).toBe(2);
    expect(prepared.error.recoveryFile?.json).toContain('bad status row,mystery');
    await expectUntouched(db);
  });

  it('a wholly malformed Todo.txt rejects with NOTHING_TO_IMPORT + recovery file, zero side effects', async () => {
    const db = await openSeeded();
    const bad = ['due:not-a-date one', 'x 2026-99-99 two'].join('\n');
    const prepared = await prepareForeignImport(fakeFile('bad.txt', bad), { db });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.code).toBe('NOTHING_TO_IMPORT');
    if (prepared.error.code !== 'NOTHING_TO_IMPORT') return;
    expect(prepared.error.recoveryFile?.json).toContain('due:not-a-date one');
    await expectUntouched(db);
  });

  it('an unterminated CSV quote rejects the WHOLE file with zero side effects (never a half import)', async () => {
    const db = await openSeeded();
    const prepared = await prepareForeignImport(
      // The quote OPENS a field and never closes — a truncated file must never half-import.
      fakeFile('truncated.csv', 'title,notes\n"never closed,fin'),
      { db },
    );
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.code).toBe('PARSE_ERROR');
    await expectUntouched(db);
  });

  it('mixed good/bad rows import the good ones and carry both reject sets in one recovery file', async () => {
    const db = await openSeeded();
    const text = ['title,status', 'keep me,open', 'drop me,mystery'].join('\n');
    const prepared = await prepareForeignImport(fakeFile('mixed.csv', text), { db, now: () => T0 });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.accepted.tasks).toBe(1);
    expect(prepared.value.quarantined).toHaveLength(1);
    expect(prepared.value.quarantined[0]?.raw).toBe('drop me,mystery');
    expect(prepared.value.recovery?.json).toContain('drop me,mystery');

    const applied = await applyImport(prepared.value, { db });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.outcome).toBe('partial');
    expect(applied.value.recoveryFile).not.toBeNull();
  });

  it('enforces the size cap before reading the file', async () => {
    const db = await openSeeded();
    const prepared = await prepareForeignImport(
      fakeFile('huge.csv', 'title\n', MAX_IMPORT_BYTES + 1),
      { db },
    );
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.code).toBe('FILE_TOO_LARGE');
    await expectUntouched(db);
  });
});
