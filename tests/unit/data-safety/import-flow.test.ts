/**
 * Import / restore / wipe flows against the REAL engine (fake-indexeddb), asserting the
 * review's no-silent-loss findings end-to-end:
 *
 *  - B3: a whole-file `NOTHING_TO_IMPORT` reject still offers the recovery document
 *    (docs/dev/data-safety-api.md: "offer it in the UX").
 *  - B2: the post-import undo toast carries the binding `downloadSnapshot(undo.id)`
 *    escape hatch (ADR-004 Decision 5.5 (b)).
 *  - N4: restoring a snapshot that no longer exists says so instead of falling through.
 *  - N5: the confirm dialog stays mounted in its `busy` state for the whole write and a
 *    second delete-all click can never start a second wipe.
 *  - N6: the first-ever export gets the long §7 toast, later ones the short §9 line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bindDataSafetyDb } from '../../../src/portability';
import { listSnapshots } from '../../../src/portability';
import { snapshotFileName, takeSnapshot } from '../../../src/portability';
import type { AppDBImpl } from '../../../src/storage/db';
import {
  answerDialog,
  currentDialog,
  resetDialogs,
  resetToasts,
  toasts,
} from '../../../src/features/data-safety/notices';
import { resetFlags } from '../../../src/features/data-safety/flags';
import { invalidateCounts } from '../../../src/features/data-safety/dbAccess';
import {
  chooseImportFile,
  importState,
  resetImportState,
  restoreSnapshot,
} from '../../../src/features/data-safety/importFlow';
import { runDeleteAll, runExport } from '../../../src/features/data-safety/actions';
import { invalidateSnapshots } from '../../../src/features/data-safety/snapshots';
import { patchState, resetState } from '../../../src/features/data-safety/state';
import { resetStorageInfo } from '../../../src/features/data-safety/storageInfo';
import { resetPendingWrites } from '../../../src/features/data-safety/pendingWrites';
import { makeList, makeSettings, makeTask, openFixtureDb, uniqueDbName } from '../storage/fixtures';
import { fakeFile, fixture, makeDocText, seedCorpus } from '../portability/helpers';

const opened: AppDBImpl[] = [];
let downloaded: { name: string; blob: Blob }[] = [];

/**
 * The URL/anchor members the download helpers use are captured through helpers and put
 * back in afterEach: jsdom defines none of them (`downloadTextFile` feature-detects
 * exactly that), and a bare member expression trips the unbound-method lint.
 */
function captured(target: object, key: string): unknown {
  return Reflect.get(target, key);
}

/** Put a captured member back, or delete it when the environment never had it. */
function restored(target: object, key: string, value: unknown): void {
  if (value === undefined) {
    Reflect.deleteProperty(target, key);
    return;
  }
  Reflect.set(target, key, value);
}

const originalCreate = captured(URL, 'createObjectURL');
const originalRevoke = captured(URL, 'revokeObjectURL');
const originalClick = captured(HTMLAnchorElement.prototype, 'click');

beforeEach(() => {
  window.localStorage.clear();
  resetFlags();
  resetDialogs();
  resetToasts();
  resetImportState();
  resetPendingWrites();
  resetStorageInfo();
  resetState();
  invalidateCounts();
  invalidateSnapshots();
  downloaded = [];

  // jsdom has no object-URL / download plumbing; capture what `downloadTextFile` hands
  // the browser so the escape-hatch assertions look at real filenames + payloads.
  URL.createObjectURL = (blob: Blob): string => {
    downloaded.push({ name: '', blob });
    return `blob:mock-${String(downloaded.length)}`;
  };
  URL.revokeObjectURL = (): void => undefined;
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement): void {
    const last = downloaded[downloaded.length - 1];
    if (last !== undefined) last.name = this.download;
  };
});

afterEach(() => {
  // jsdom defines none of these, so "restore" means put the member back or delete it.
  restored(URL, 'createObjectURL', originalCreate);
  restored(URL, 'revokeObjectURL', originalRevoke);
  restored(HTMLAnchorElement.prototype, 'click', originalClick);
  bindDataSafetyDb(null);
  for (const db of opened.splice(0)) db.close();
});

/** A bound, seeded database so `resolveDb()` inside the flows resolves. */
async function openBound(): Promise<AppDBImpl> {
  const db = await openFixtureDb(uniqueDbName('flow'));
  opened.push(db);
  await db.put('settings', makeSettings());
  await db.put('lists', makeList());
  await db.put('tasks', makeTask());
  bindDataSafetyDb(db);
  return db;
}

/** Wait until the flow has queued its confirm dialog, then answer it. */
async function answerWhenQueued(confirmed: boolean): Promise<void> {
  await vi.waitFor(() => {
    expect(currentDialog()).not.toBeNull();
  });
  answerDialog(confirmed);
}

describe('B3 — a whole-file reject still offers the recovery document', () => {
  it('surfaces the recovery download on NOTHING_TO_IMPORT and writes the quarantined bytes', async () => {
    await openBound();
    const raw = fixture('drill7-all-records-corrupt.json');

    await chooseImportFile(fakeFile('drill7-all-records-corrupt.json', raw));

    expect(importState.value.step).toBe('invalid');
    if (importState.value.step !== 'invalid') return;
    // The extended copy tells the user the damaged records can be saved.
    expect(importState.value.message).toContain('The damaged records can be saved');

    // The reject path pushes the SAME "Download recovery file" action the partial-apply
    // path does — the quarantine is never silent (Decision 5.1).
    const offer = toasts.value.find((toast) => toast.message.includes('recovery file'));
    expect(offer).toBeDefined();
    expect(offer?.action?.label).toBe('Download recovery file');

    offer?.action?.run();
    expect(downloaded).toHaveLength(1);
    expect(downloaded[0]?.name).toMatch(/^local-first-todo-recovery-/u);
    const text = await downloaded[0]?.blob.text();
    expect(text).toContain('"format": "local-first-todo-recovery"');
  });

  it('does NOT offer a recovery download when the engine attached no recovery file', async () => {
    await openBound();
    // Not-a-backup rejects carry no recoveryFile — no phantom download action.
    await chooseImportFile(fakeFile('nope.json', '{"format":"something-else"}'));

    expect(importState.value.step).toBe('invalid');
    expect(toasts.value.some((toast) => toast.action?.label === 'Download recovery file')).toBe(
      false,
    );
  });
});

describe('B2 — the import undo toast carries the downloadSnapshot escape hatch', () => {
  it('keeps the undo downloadable and the dialog busy until the write finishes', async () => {
    const db = await openBound();
    const flow = chooseImportFile(fakeFile('backup.json', makeDocText({ ...seedCorpus() })));
    await answerWhenQueued(true);

    // §5.6: while the destructive write runs the dialog stays mounted and busy.
    expect(currentDialog()?.busy).toBe(true);

    await flow;
    // …and the flow releases it once the write is over.
    expect(currentDialog()).toBeNull();
    expect(importState.value.step).toBe('done');

    // The undo snapshot exists and the toast offers BOTH restore and download.
    const snaps = await listSnapshots({ db });
    expect(snaps.ok).toBe(true);
    if (!snaps.ok) return;
    const undo = snaps.value.find((row) => row.reason === 'pre-import');
    expect(undo).toBeDefined();

    const done = toasts.value.find((toast) => toast.message.includes('Import complete'));
    expect(done?.action?.label).toBe('Restore previous data');
    expect(done?.secondaryAction?.label).toBe('Download snapshot');
    expect(done?.persistent).toBe(true);

    // Clicking it downloads THAT undo snapshot — the durable escape hatch.
    done?.secondaryAction?.run();
    await vi.waitFor(() => {
      expect(downloaded).toHaveLength(1);
    });
    expect(downloaded[0]?.name).toBe(snapshotFileName(undo?.takenAt ?? 0));
    const text = await downloaded[0]?.blob.text();
    expect(text).toContain('"kind": "snapshot"');
  });

  it('cancelling the confirm leaves the data untouched and closes the dialog', async () => {
    const db = await openBound();
    const flow = chooseImportFile(fakeFile('backup.json', makeDocText({ ...seedCorpus() })));
    await answerWhenQueued(false);

    await flow;
    expect(currentDialog()).toBeNull();
    expect(importState.value.step).toBe('pick');
    const snaps = await listSnapshots({ db });
    expect(snaps.ok && snaps.value).toEqual([]);
  });
});

describe('N4 — restoring a snapshot that no longer exists says so', () => {
  it('reports the missing payload instead of silently doing nothing', async () => {
    await openBound();
    await restoreSnapshot('01ARZ3NDEKTSV4RRFFQ60099999');

    expect(importState.value.step).toBe('failed');
    const toast = toasts.value.at(-1);
    expect(toast?.variant).toBe('error');
    expect(toast?.message).toBe('That snapshot is no longer available. Nothing was changed.');
    // Nothing was changed: the dialog never opened.
    expect(currentDialog()).toBeNull();
  });

  it('reports the same when the payload exists but the metadata row is gone', async () => {
    const db = await openBound();
    // The engine still holds the payload, but the panel's snapshot list no longer knows
    // the row (a cache desync) — there is nothing to confirm against, so say so.
    const taken = await takeSnapshot('manual', { db });
    expect(taken.ok).toBe(true);
    if (!taken.ok) return;

    await restoreSnapshot(taken.value.id);

    expect(importState.value.step).toBe('failed');
    expect(toasts.value.at(-1)?.message).toBe(
      'That snapshot is no longer available. Nothing was changed.',
    );
    expect(currentDialog()).toBeNull();
  });
});

describe('partial import — the recovery offer the reject path now mirrors', () => {
  it('downloads the quarantine when some records were left out', async () => {
    const db = await openBound();
    // One valid list + one structurally invalid task: the import applies the list and
    // quarantines the task, so the report carries a recoveryFile (Decision 7).
    const corpus = seedCorpus();
    const text = makeDocText({
      settings: corpus.settings,
      lists: [corpus.lists[0] as never],
      // A corrupt `status` quarantines this one task (Stage B), leaving the list to apply.
      tasks: [{ ...corpus.tasks[0], status: 'not-a-status' }],
    });

    // NOT awaited: the flow parks on the confirm dialog until we answer it below.
    const flow = chooseImportFile(fakeFile('partial.json', text));
    await answerWhenQueued(true);

    await vi.waitFor(() => {
      expect(importState.value.step).toBe('done');
    });
    await flow;
    const offer = toasts.value.find((toast) => toast.message.includes('left out'));
    expect(offer?.action?.label).toBe('Download recovery file');
    offer?.action?.run();
    expect(downloaded).toHaveLength(1);
    expect(downloaded[0]?.name).toMatch(/^local-first-todo-recovery-/u);

    // The valid list DID land (this was a partial apply, not a reject).
    const lists = await db.getAll('lists');
    expect(lists.ok && lists.value.length).toBeGreaterThan(0);
  });
});

describe('N5 — delete-all double-submit guard', () => {
  it('a second click while the confirm is up cannot start a second wipe', async () => {
    await openBound();
    const first = runDeleteAll();
    await vi.waitFor(() => {
      expect(currentDialog()?.request.kind).toBe('delete-all-confirm');
    });

    // The second call is refused outright — no second dialog, no second wipe.
    await expect(runDeleteAll()).resolves.toBe(false);

    answerDialog(false);
    await expect(first).resolves.toBe(false);
    expect(currentDialog()).toBeNull();
  });
});

describe('N6 — export toast copy: long on the first-ever backup, short after', () => {
  it('switches to the short §9 line once a backup already exists', async () => {
    await openBound();
    patchState({ lastBackupAt: null });

    await expect(runExport()).resolves.toBe(true);
    expect(toasts.value.at(-1)?.message).toBe(
      'Backup saved to your downloads. Keep it somewhere safe.',
    );

    await expect(runExport()).resolves.toBe(true);
    expect(toasts.value.at(-1)?.message).toBe('Backup saved to your downloads.');
  });
});
