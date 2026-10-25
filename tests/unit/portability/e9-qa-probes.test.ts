/**
 * E9 QA probes — S12 foreign importers (Todo.txt/CSV), INDEPENDENT hostile-input
 * verification written by the QA gate (h_reviewer, card t_adbd2e36) against commit
 * 9ee9669. These fixtures were NOT written by the impl card: every probe here asks
 * "what does the ADR-004 pipeline actually do when handed a file a hostile or
 * careless user could really produce?" — size floods, prototype-pollution headers,
 * markup/formula payloads, wrong extensions, UTF-16 sources, and the undo round
 * trip after a foreign REPLACE apply.
 *
 * Contract under test (PROJECT_ANALYSIS §7.4 + §10 E8 + the epic's binding decision):
 *   foreign formats ride the SAME `prepareImport` stages, so
 *     (a) a whole-file reject means ZERO side effects (no write, no snapshot),
 *     (b) caps are enforced (size before read, document limits in Stage A),
 *     (c) accepted hostile content stays inert DATA (never evaluated, byte-exact),
 *     (d) a confirmed foreign apply takes the automatic pre-import snapshot, and
 *     (e) settings of the target profile ride through verbatim.
 *
 * Fixture note: the seeded task MUST reference the seeded list's id — Stage B's
 * referential pass quarantines orphans (probed explicitly in Q7), so an orphan-seeded
 * corpus makes the undo round trip fail for fixture reasons, not product reasons.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { AppDBImpl } from '../../../src/storage/db';
import type { List } from '../../../src/storage/types';
import { applyImport, prepareSnapshotRestore, takeSnapshot } from '../../../src/portability';
import { listSnapshots } from '../../../src/portability/snapshots-api';
import { prepareForeignImport } from '../../../src/portability/foreign';
import { convertTodoTxt } from '../../../src/portability/foreign/todotxt';
import { MAX_IMPORT_BYTES } from '../../../src/portability/constants';
import type { ConvertContext } from '../../../src/portability/foreign/types';
import { fakeFile, makeDocText, makeList, makeSettings, makeTask, T0 } from './helpers';
import { openFixtureDb, uniqueDbName } from '../storage/fixtures';

const opened: AppDBImpl[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

/** Seeded profile: 1 list, 1 task referencing THAT list, dark theme. */
async function openSeeded(): Promise<{ db: AppDBImpl; list: List }> {
  const db = await openFixtureDb(uniqueDbName('e9qa'));
  opened.push(db);
  await db.put('settings', makeSettings({ theme: 'dark' }));
  const list = makeList();
  await db.put('lists', list);
  await db.put('tasks', makeTask({ listId: list.id }));
  return { db, list };
}

/** Zero-side-effects assertion — snapshots empty, exactly the seeded 1 list / 1 task. */
async function expectUntouched(db: AppDBImpl): Promise<void> {
  const snaps = await listSnapshots({ db });
  expect(snaps.ok && snaps.value).toEqual([]);
  const lists = await db.getAll('lists');
  expect(lists.ok && lists.value).toHaveLength(1);
  const tasks = await db.getAll('tasks');
  expect(tasks.ok && tasks.value).toHaveLength(1);
}

const CTX: ConvertContext = {
  deviceId: '01ARZ3NDEKTSV4RRFFQ6AAAAAA',
  now: T0,
  listName: 'Imported',
};

/* ------------------------------ size & caps ------------------------------ */

describe('Q1 — size cap before the read (ADR-002 Decision 11, §10 E8)', () => {
  it('rejects a source over 50 MiB with FILE_TOO_LARGE and touches nothing', async () => {
    const { db } = await openSeeded();
    const prepared = await prepareForeignImport(
      fakeFile('flood.txt', 'title\n', MAX_IMPORT_BYTES + 1),
      { db },
    );
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.code).toBe('FILE_TOO_LARGE');
    await expectUntouched(db);
  });
});

describe('Q2 — Stage A document caps ride the synthetic foreign document', () => {
  it('rejects a CSV whose converted lists exceed MAX_LISTS (1000)', async () => {
    const { db } = await openSeeded();
    const rows = Array.from({ length: 1001 }, (_u, i) => `task ${String(i)},List ${String(i)}`);
    const text = ['title,list', ...rows].join('\n');
    const prepared = await prepareForeignImport(fakeFile('many-lists.csv', text), { db });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.code).toBe('LIMIT_EXCEEDED');
    if (prepared.error.code !== 'LIMIT_EXCEEDED') return;
    expect(prepared.error).toMatchObject({ limit: 'data.lists', found: 1001, cap: 1000 });
    await expectUntouched(db);
  });

  it('rejects a CSV whose converted tasks exceed MAX_TASKS (100 000) — the E7 ceiling', async () => {
    const { db } = await openSeeded();
    const rows = Array.from({ length: 100_001 }, (_u, i) => `flood task ${String(i)},open`);
    const text = ['title,status', ...rows].join('\n');
    const prepared = await prepareForeignImport(fakeFile('flood.csv', text), { db });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.code).toBe('LIMIT_EXCEEDED');
    if (prepared.error.code !== 'LIMIT_EXCEEDED') return;
    expect(prepared.error).toMatchObject({ limit: 'data.tasks', cap: 100_000 });
    await expectUntouched(db);
  }, 120_000);
});

/* --------------------------- prototype safety --------------------------- */

describe('Q3 — prototype pollution', () => {
  it('CSV columns named __proto__/constructor/prototype pollute nothing', async () => {
    const { db } = await openSeeded();
    const text = [
      'title,__proto__,constructor,prototype',
      'innocent,polluted,polluted,polluted',
    ].join('\n');
    const prepared = await prepareForeignImport(fakeFile('pollute.csv', text), { db });
    // The hostile column names are simply not roles — the row still imports as data.
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.accepted.tasks).toBe(1);
    expect((Object.prototype as unknown as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(({} as unknown as Record<string, unknown>)['polluted']).toBeUndefined();
    await expectUntouched(db); // prepare stays pure even for the accepted plan
  });

  it('a JSON backup smuggling __proto__ into a task is rejected as malicious', async () => {
    const { db } = await openSeeded();
    const doc = makeDocText({
      settings: makeSettings(),
      lists: [makeList()],
      tasks: [makeTask()],
    });
    // serializeBackupDoc pretty-prints; inject the hostile key INTO the first task.
    const text = doc.replace(
      '"tasks": [\n      {',
      '"tasks": [\n      {\n        "__proto__": {"polluted": true},',
    );
    expect(text).toContain('__proto__');
    const prepared = await prepareForeignImport(fakeFile('evil.json', text), { db });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.code).toBe('MALICIOUS_SHAPE');
    expect((Object.prototype as unknown as Record<string, unknown>)['polluted']).toBeUndefined();
    await expectUntouched(db);
  });
});

/* ------------------------- hostile content ------------------------------ */

describe('Q4 — markup / formula payloads stay inert data', () => {
  it('script/img/formula/URL payloads round-trip byte-exact and never execute', async () => {
    const { db } = await openSeeded();
    const hostile = [
      '<img src=x onerror="window.__pwned=1">',
      '<script>window.__pwned=1</script>',
      "=cmd|'/C calc'!A0",
      'javascript:window.__pwned=1',
      "onload='window.__pwned=1'",
    ];
    const text = ['title', ...hostile].join('\n');
    const prepared = await prepareForeignImport(fakeFile('hostile.csv', text), {
      db,
      now: () => T0,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.accepted.tasks).toBe(hostile.length);

    const applied = await applyImport(prepared.value, { db });
    expect(applied.ok).toBe(true);
    const tasks = await db.getAll('tasks');
    expect(tasks.ok).toBe(true);
    if (!tasks.ok) return;
    expect(tasks.value.map((t) => t.title)).toEqual(hostile);
    // Nothing was evaluated anywhere — no global side effect from the import itself.
    expect((globalThis as unknown as Record<string, unknown>)['__pwned']).toBeUndefined();
  });

  it('a row opening with an unescaped quote fails the WHOLE file closed (never a half import)', async () => {
    const { db } = await openSeeded();
    // RFC4180: a field opening with " and never closing = unterminated quote. From the
    // parser's seat this is indistinguishable from a truncated file → whole-file reject.
    const text = ['title,notes', 'good row,ok', '"><svg onload=x>,rest'].join('\n');
    const prepared = await prepareForeignImport(fakeFile('quote.csv', text), { db });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.code).toBe('PARSE_ERROR');
    await expectUntouched(db);
  });
});

describe('Q5 — control characters and encodings', () => {
  it('NUL and RTL-override characters survive as literal data (documented behaviour)', () => {
    const out = convertTodoTxt('name\u0000with\u0000nuls\nright\u202Eto-left\n', CTX);
    // The converter treats them as ordinary title text — no crash, no stripping.
    expect(out.rejected).toEqual([]);
    expect(out.tasks.map((t) => t.title)).toEqual([
      'name\u0000with\u0000nuls',
      'right\u202Eto-left',
    ]);
  });

  /**
   * DEFECT E9-Q1 (non-blocking): `File.text()` UTF-8-decodes a UTF-16LE source into
   * NUL-interleaved mojibake, and the todo.txt converter accepts those lines as
   * ordinary titles — observed: the file IMPORTS (prepared.ok === true) instead of
   * being rejected as an unreadable source (§10 E8: corrupt import file → clean
   * reject). No data is lost (preview gate + pre-import snapshot + source untouched),
   * which is why this is non-blocking; the fix is an encoding/BOM sniff before routing.
   */
  it.fails(
    'DEFECT E9-Q1: a UTF-16LE todo.txt is rejected as unreadable, not imported as mojibake (§10 E8)',
    async () => {
      const { db } = await openSeeded();
      // What `File.text()` yields for a UTF-16LE file: UTF-8 decoding of those bytes.
      const utf16Bytes = Buffer.from('(A) buy milk\ndue:2026-10-30 call home\n', 'utf16le');
      const decoded = utf16Bytes.toString('utf8');
      const prepared = await prepareForeignImport(fakeFile('notepad-utf16.txt', decoded), { db });
      expect(prepared.ok).toBe(false);
      await expectUntouched(db);
    },
  );
});

/* --------------------------- format detection --------------------------- */

describe('Q6 — extension vs content', () => {
  it('CSV bytes named .json reject as bad JSON with zero side effects', async () => {
    const { db } = await openSeeded();
    const text = 'title,priority\nfrom a csv named json,high\n';
    const prepared = await prepareForeignImport(fakeFile('actually-a.csv.json', text), { db });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.code).toBe('PARSE_ERROR');
    await expectUntouched(db);
  });

  /**
   * DEFECT E9-Q2 (non-blocking): format routing is extension-FIRST, so a valid JSON
   * backup renamed to `.txt` (a common way to pass files past mail filters) is run
   * through the todo.txt converter line-by-line: observed = 53 garbage tasks (one per
   * pretty-printed JSON line) instead of the backup's 1 list / 1 task. Confirming
   * would REPLACE the profile with garbage — undoable via the pre-import snapshot,
   * and the preview shows counts but not the detected format. Content sniffing
   * already exists (`formatFromContent`); it is just tried AFTER the extension.
   */
  it.fails(
    'DEFECT E9-Q2: a JSON backup renamed .txt imports as a real backup, not as 53 garbage todo.txt lines',
    async () => {
      const { db } = await openSeeded();
      const corpus = makeDocText({
        settings: makeSettings(),
        lists: [makeList()],
        tasks: [makeTask()],
      });
      const prepared = await prepareForeignImport(fakeFile('my-backup.txt', corpus), { db });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      expect(prepared.value.accepted.tasks).toBe(1);
    },
  );
});

/* ------------------------ snapshot & settings --------------------------- */

describe('Q7 — pre-import snapshot, undo round trip, settings', () => {
  it('a confirmed foreign REPLACE apply takes the pre-import snapshot and undo restores the original rows', async () => {
    const { db } = await openSeeded();
    const seeded = await db.getAll('tasks');
    const originalTitle = seeded.ok ? seeded.value[0]?.title : undefined;
    expect(originalTitle).toBeDefined();

    const text = 'title\nimported one\nimported two\n';
    const prepared = await prepareForeignImport(fakeFile('undo.csv', text), { db, now: () => T0 });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const applied = await applyImport(prepared.value, { db });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const undoId = applied.value.undoSnapshot?.id;
    expect(undoId).toBeDefined();
    if (undoId === undefined) return;

    // REPLACE really replaced: seeded row gone, imported rows present.
    const replaced = await db.getAll('tasks');
    expect(replaced.ok && replaced.value.map((t) => t.title).sort()).toEqual([
      'imported one',
      'imported two',
    ]);

    // The undo snapshot restores the exact pre-import state through the same pipeline.
    const undoPlan = await prepareSnapshotRestore(undoId, { db });
    expect(undoPlan.ok).toBe(true);
    if (!undoPlan.ok) return;
    expect(undoPlan.value.quarantined).toEqual([]); // own snapshot round-trips clean
    const restored = await applyImport(undoPlan.value, { db });
    expect(restored.ok).toBe(true);
    const back = await db.getAll('tasks');
    expect(back.ok && back.value.map((t) => t.title)).toEqual([originalTitle]);
  });

  it('the target profile settings ride through a foreign apply verbatim (theme never resets)', async () => {
    const { db } = await openSeeded();
    const before = await db.get('settings', 'settings');
    expect(before.ok && before.value?.theme).toBe('dark');

    const text = 'title\none more task\n';
    const prepared = await prepareForeignImport(fakeFile('settings.csv', text), {
      db,
      now: () => T0,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const applied = await applyImport(prepared.value, { db });
    expect(applied.ok).toBe(true);

    const after = await db.get('settings', 'settings');
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value?.theme).toBe('dark');
    expect(after.value?.locale).toBe(before.ok ? before.value?.locale : undefined);
  });

  it('a whitespace-only todo.txt rejects with NOTHING_TO_IMPORT and no recovery file', async () => {
    const { db } = await openSeeded();
    const prepared = await prepareForeignImport(fakeFile('blank.txt', '   \n\n\t\n'), { db });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.code).toBe('NOTHING_TO_IMPORT');
    if (prepared.error.code !== 'NOTHING_TO_IMPORT') return;
    expect(prepared.error.recoveryFile).toBeNull();
    await expectUntouched(db);
  });

  it('an orphan-seeded snapshot restore quarantines the orphan with a recovery file (no silent drop)', async () => {
    // The referential pass protects RESTORE too: a snapshot row whose listId is not in
    // the payload is quarantined + reported (outcome "partial"), never silently applied.
    const { db } = await openSeeded();
    const orphan = makeTask({ title: 'orphan row' }); // default listId ≠ the seeded list
    await db.put('tasks', orphan);
    const snap = await takeSnapshot('manual', { db });
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    await db.put('tasks', { ...orphan, title: 'changed' });

    const plan = await prepareSnapshotRestore(snap.value.id, { db });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.quarantined).toHaveLength(1);
    const report = await applyImport(plan.value, { db });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.outcome).toBe('partial');
    expect(report.value.recoveryFile).not.toBeNull();
  });
});
