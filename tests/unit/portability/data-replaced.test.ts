/**
 * Post-commit "data replaced" notification seam (fix card t_85e19c39).
 *
 * `applyImport` / `restoreSnapshot` / `deleteAllData` replace the dataset with ONE
 * storage-layer transaction and bypass `MutationRunner.onCommitted`, so the running UI
 * (tasks/lists store + settings) never learns about it — functional QA finding F1:
 * restored data stayed invisible until a manual page reload. Stage 7 side effects fan
 * out to registered handlers (the shell wires its refresh there), fire-and-forget and
 * never able to fail a replacement that already committed (ADR-004 atomicity untouched).
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { AppDBImpl } from '../../../src/storage/db';
import { applyImport, prepareImport, restoreSnapshot } from '../../../src/portability/import';
import { deleteAllData } from '../../../src/portability/export';
import { takeSnapshot } from '../../../src/portability/snapshots-api';
import { notifyDataReplaced, onDataReplaced } from '../../../src/portability/side-effects';
import { makeList, makeSettings, makeTask, openFixtureDb, uniqueDbName } from '../storage/fixtures';
import { makeDocText, seedCorpus, T0 } from './helpers';

const opened: AppDBImpl[] = [];
const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const db of opened.splice(0)) db.close();
});

async function openSeeded(): Promise<AppDBImpl> {
  const db = await openFixtureDb(uniqueDbName('replaced'));
  opened.push(db);
  // A live corpus so snapshot payloads (restore) and replacements have real rows.
  await db.put('settings', makeSettings({ lastBackupAt: null }));
  await db.put('lists', makeList());
  await db.put('tasks', makeTask());
  return db;
}

function track(): { calls: number[]; handler: () => void } {
  const calls: number[] = [];
  const handler = (): void => {
    calls.push(calls.length);
  };
  disposers.push(onDataReplaced(handler));
  return { calls, handler };
}

describe('onDataReplaced / notifyDataReplaced (the shell refresh seam)', () => {
  it('applyImport notifies registered handlers exactly once, after the commit', async () => {
    const db = await openSeeded();
    const seen = track();
    const prepared = await prepareImport(makeDocText({ ...seedCorpus() }));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const report = await applyImport(prepared.value, { db, now: () => T0 });

    expect(report.ok).toBe(true);
    expect(seen.calls).toHaveLength(1);
  });

  it('engine restoreSnapshot (undo-of-undo path) notifies too', async () => {
    const db = await openSeeded();
    const seen = track();
    const snap = await takeSnapshot('pre-import', { db, now: () => T0 });
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;

    const restored = await restoreSnapshot(snap.value.id, { db, now: () => T0 + 1 });

    expect(restored.ok).toBe(true);
    expect(seen.calls).toHaveLength(1);
  });

  it('deleteAllData notifies — a wipe is a wholesale replacement too', async () => {
    const db = await openSeeded();
    const seen = track();

    const wiped = await deleteAllData({ db });

    expect(wiped.ok).toBe(true);
    expect(seen.calls).toHaveLength(1);
  });

  it('a throwing handler cannot fail the replacement that already committed', async () => {
    const db = await openSeeded();
    const seen = track();
    disposers.push(
      onDataReplaced(() => {
        throw new Error('broken UI refresh');
      }),
    );
    const prepared = await prepareImport(makeDocText({ ...seedCorpus() }));
    if (!prepared.ok) throw new Error('prepare failed');

    const report = await applyImport(prepared.value, { db, now: () => T0 });

    expect(report.ok).toBe(true);
    expect(seen.calls).toHaveLength(1); // later handlers still ran
  });

  it('an unsubscribed handler stops receiving; bare notifyDataReplaced is safe', () => {
    const seen = track();
    const dispose = onDataReplaced(() => seen.calls.push(99));
    dispose();
    notifyDataReplaced();
    expect(seen.calls).toHaveLength(1); // only the tracked handler, once
  });
});
