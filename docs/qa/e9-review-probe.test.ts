/**
 * Review probes (t_8f8242cc, h_reviewer) — first-hand reproduction of the two
 * disclosed S12 routing/encoding findings E9-Q1 / E9-Q2 from
 * docs/qa/e9-utilities.md §8.
 *
 * Polarity follows the E8/E9 probe convention: each `it.fails` asserted the
 * DESIRED behaviour and passed only because the defect reproduced.
 *
 * **Flipped to `it()` by fix card t_ef542fa3** (B2/B3 resolved at the routing
 * seam). This file stays where the review produced it, with the reviewer's
 * imports untouched — it is NOT run in place (the vitest include glob is
 * `tests/unit/**` and these relative imports resolve from that directory).
 * The RUNNABLE twin is `tests/unit/portability/e9-review-probe.test.ts`, a
 * verbatim copy of this file that is green at the fix commit; the QA card's
 * own pins live in `tests/unit/portability/e9-qa-probes.test.ts`.
 *
 * Reviewer evidence; attached to the review card, not part of the suite.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { AppDBImpl } from '../../../src/storage/db';
import { detectImportFormat, prepareForeignImport } from '../../../src/portability/foreign';
import { fakeFile, makeDocText, makeList, makeSettings, makeTask } from './helpers';
import { openFixtureDb, uniqueDbName } from '../storage/fixtures';

const opened: AppDBImpl[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

async function openSeeded(): Promise<AppDBImpl> {
  const db = await openFixtureDb(uniqueDbName('revprobe'));
  opened.push(db);
  await db.put('settings', makeSettings({ theme: 'dark' }));
  await db.put('lists', makeList());
  await db.put('tasks', makeTask());
  return db;
}

describe('E9 review: format routing (E9-Q2)', () => {
  it(
    'a valid JSON backup renamed .txt takes the JSON path (pre-fix: todo.txt converter)',
    async () => {
      const db = await openSeeded();
      const doc = makeDocText({ lists: [makeList()], tasks: [makeTask()] });
      const file = fakeFile('my-backup.txt', doc);
      const jsonPlan = await prepareForeignImport(fakeFile('my-backup.json', doc), { db });
      const txtPlan = await prepareForeignImport(file, { db });
      expect(detectImportFormat(file, doc)).toBe('json');
      expect(txtPlan.ok && jsonPlan.ok).toBe(true);
      if (txtPlan.ok && jsonPlan.ok) {
        // Pre-fix: {lists:1, tasks:53, quarantined:0} vs the JSON
        // control's {lists:1, tasks:0, quarantined:1} — 53 garbage tasks.
        expect(txtPlan.value.accepted).toEqual(jsonPlan.value.accepted);
      }
    },
  );

  it('control: extension-less JSON content is sniffed as json', async () => {
    const db = await openSeeded();
    const doc = makeDocText({ lists: [makeList()], tasks: [makeTask()] });
    const withExt = await prepareForeignImport(fakeFile('backup.json', doc), { db });
    const plan = await prepareForeignImport(fakeFile('backup', doc), { db });
    expect(plan.ok && withExt.ok).toBe(true);
    if (plan.ok && withExt.ok) {
      // Same routing as the .json extension → the content sniff itself works.
      expect(plan.value.accepted).toEqual(withExt.value.accepted);
    }
  });
});

describe('E9 review: encoding (E9-Q1)', () => {
  it(
    'a UTF-16LE todo.txt is rejected as an unreadable source (pre-fix: accepted as mojibake)',
    async () => {
      const db = await openSeeded();
      const utf16 = new TextEncoder().encode('x 2026-10-20 2026-10-01 pay rent\n');
      // Real UTF-16LE bytes for the same line, decoded the way File.text() would.
      const bytes = new Uint8Array(utf16.length * 2);
      for (let i = 0; i < utf16.length; i += 1) {
        bytes[i * 2] = utf16[i] ?? 0;
        bytes[i * 2 + 1] = 0;
      }
      const decoded = new TextDecoder('utf-8').decode(bytes);
      const plan = await prepareForeignImport(fakeFile('unicode-notes.txt', decoded), { db });
      // Pre-fix: ok=true with {lists:1, tasks:2} of NUL-interleaved garbage.
      expect(plan.ok).toBe(false);
    },
  );
});
