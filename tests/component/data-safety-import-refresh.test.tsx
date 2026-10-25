/**
 * Post-import UI staleness regression (functional QA finding F1, fix card t_85e19c39).
 *
 * The database restore was always correct (100% fidelity), but the RUNNING UI kept
 * showing the pre-import state until a manual reload: `applyImport()` writes through the
 * storage layer, bypassing `MutationRunner.onCommitted`, and nothing reloaded the
 * tasks/lists/settings stores afterwards. This suite runs the REAL production wiring
 * (booted store + IDB settings persistence + `wireDataReplacedRefresh()`) against the
 * REAL import engine (fake IndexedDB) and asserts — without any reload:
 *
 *  1. after `chooseImportFile` → confirm, the store state contains the imported rows
 *     and the replaced rows are evicted; the rendered UI follows;
 *  2. the settings screen values come from the imported record and the imported theme
 *     applies immediately (data-safety §8.3 erratum);
 *  3. the imported locale does NOT switch the session — it drives `html lang` on next
 *     boot, its documented timing;
 *  4. the UndoToast "Restore previous data" path (`restoreSnapshot`) restores the
 *     previous corpus just as live.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { render, screen } from '@testing-library/preact';
import type { JSX } from 'preact';

import { wireDataReplacedRefresh } from '../../src/app/dataReplace';
import { getSettings, loadSettings, registerSettingsPersistence } from '../../src/app/settings';
import { createIdbSettingsPersistence } from '../../src/app/settingsPersistence';
import { THEME_PREF_KEY } from '../../src/app/theme';
import {
  chooseImportFile,
  importState,
  resetImportState,
  restoreSnapshot,
} from '../../src/features/data-safety/importFlow';
import {
  answerDialog,
  currentDialog,
  resetDialogs,
  resetToasts,
} from '../../src/features/data-safety/notices';
import { resetFlags } from '../../src/features/data-safety/flags';
import { invalidateCounts } from '../../src/features/data-safety/dbAccess';
import { invalidateSnapshots } from '../../src/features/data-safety/snapshots';
import { resetState } from '../../src/features/data-safety/state';
import { resetStorageInfo } from '../../src/features/data-safety/storageInfo';
import { resetPendingWrites } from '../../src/features/data-safety/pendingWrites';
import { resetTaskStore, startTaskStore, state } from '../../src/features/tasks/store';
import { bindDataSafetyDb } from '../../src/portability';
import { boot, resetBootSingleton } from '../../src/storage/boot';
import type { AppDBImpl } from '../../src/storage/db';
import { makeList, makeSettings, makeTask } from '../unit/storage/fixtures';
import { fakeFile, fixtureId, makeDocText, T0 } from '../unit/portability/helpers';

const DB_NAME = 'local-first-todo';

/* ------------------------- pre-import fixture corpus ------------------------- */

const PRE_LIST = fixtureId(10);
const PRE_OPEN = fixtureId(20);
const PRE_DONE = fixtureId(21);

const importedListId = fixtureId(40);
const importedOpenId = fixtureId(41);
const importedDoneId = fixtureId(42);

/** The backup file: one list, one open + one done task, theme=dark, locale=th. */
function importDocText(): string {
  return makeDocText({
    kind: 'export',
    exportedAt: T0,
    settings: makeSettings({
      theme: 'dark',
      weekStart: 0,
      defaultListId: importedListId,
      locale: 'th',
    }),
    lists: [makeList({ id: importedListId, name: 'Imported list', sortOrder: 'h' })],
    tasks: [
      makeTask({
        id: importedOpenId,
        listId: importedListId,
        title: 'IMPORTED ONE',
        sortOrder: 'h',
      }),
      makeTask({
        id: importedDoneId,
        listId: importedListId,
        title: 'IMPORTED DONE',
        status: 'done',
        completedAt: T0,
        sortOrder: 'i',
      }),
    ],
  });
}

/** The store's rendered view over the same signals the real rows read from. */
function Titles(): JSX.Element {
  const current = state.value;
  const titles = [...current.tasks.values()].map((task) => task.title).sort();
  return (
    <ul>
      {titles.map((title) => (
        <li key={title}>{title}</li>
      ))}
    </ul>
  );
}

/* --------------------------------- world --------------------------------- */

let wired: (() => void) | null = null;

async function resetWorld(): Promise<void> {
  wired?.();
  wired = null;
  resetTaskStore();
  resetImportState();
  resetDialogs();
  resetToasts();
  resetFlags();
  resetState();
  resetStorageInfo();
  resetPendingWrites();
  invalidateCounts();
  invalidateSnapshots();
  registerSettingsPersistence(null);
  bindDataSafetyDb(null);
  resetBootSingleton();
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.lang = 'en';
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => {
      resolve();
    };
    request.onerror = () => {
      resolve();
    };
    request.onblocked = () => {
      resolve();
    };
  });
}

/** Boot the real store + settings persistence over the seeded fake IndexedDB. */
async function bootWorld(): Promise<void> {
  const booted = await boot();
  if (!booted.ok) throw new Error('boot failed');
  const db = booted.value as AppDBImpl;
  await db.put('settings', makeSettings({ theme: 'light', weekStart: 1, locale: 'en' }));
  await db.put('lists', makeList({ id: PRE_LIST, name: 'Pre list', sortOrder: 'h' }));
  await db.put(
    'tasks',
    makeTask({ id: PRE_OPEN, listId: PRE_LIST, title: 'PRE ONE', sortOrder: 'h' }),
  );
  await db.put(
    'tasks',
    makeTask({
      id: PRE_DONE,
      listId: PRE_LIST,
      title: 'PRE TWO',
      status: 'done',
      completedAt: T0,
      sortOrder: 'i',
    }),
  );
  bindDataSafetyDb(db);
  registerSettingsPersistence(createIdbSettingsPersistence());
  await loadSettings();
  await startTaskStore();
  wired = wireDataReplacedRefresh();
}

/** Wait until the flow has queued its confirm dialog, then answer it. */
async function answerWhenQueued(confirmed: boolean): Promise<void> {
  await vi.waitFor(() => {
    expect(currentDialog()).not.toBeNull();
  });
  answerDialog(confirmed);
}

beforeEach(async () => {
  await resetWorld();
});

afterEach(async () => {
  await resetWorld();
});

describe('post-import UI refresh (finding F1 — no page reload required)', () => {
  it('import: store rows, rendered UI and settings follow the restored data immediately', async () => {
    await bootWorld();
    render(<Titles />);
    expect(screen.getByText('PRE ONE', { exact: true })).toBeTruthy();

    const flow = chooseImportFile(fakeFile('backup.json', importDocText()));
    await answerWhenQueued(true);
    await flow;

    // 1. the running store reflects the imported rows WITHOUT a reload — and the
    //    replaced rows are gone (the import hard-deleted them).
    await vi.waitFor(() => {
      expect(state.value.tasks.has(importedOpenId)).toBe(true);
    });
    expect(state.value.tasks.size).toBe(2);
    expect(state.value.tasks.has(PRE_OPEN)).toBe(false);
    expect(state.value.tasks.has(PRE_DONE)).toBe(false);
    expect([...state.value.lists.keys()]).toEqual([importedListId]);
    expect(importState.value.step).toBe('done');

    // 2. the rendered UI (same signals) shows the restored corpus immediately.
    expect(screen.getByText('IMPORTED ONE', { exact: true })).toBeTruthy();
    expect(screen.getByText('IMPORTED DONE', { exact: true })).toBeTruthy();
    expect(screen.queryByText('PRE ONE', { exact: true })).toBeNull();

    // 3. Settings show the imported record; the imported theme applies immediately
    //    (design §8.3 erratum), mirror included.
    await vi.waitFor(() => {
      expect(getSettings().theme).toBe('dark');
    });
    expect(getSettings()).toEqual({ theme: 'dark', weekStart: 0, defaultListId: importedListId });
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(window.localStorage.getItem(THEME_PREF_KEY)).toBe('dark');

    // 4. the imported locale does NOT switch the running session: it drives
    //    `html lang` on next boot (its documented timing) — untouched here.
    expect(document.documentElement.lang).toBe('en');
  });

  it('undo restore (restoreSnapshot) brings the previous corpus back without a reload', async () => {
    await bootWorld();
    render(<Titles />);

    const flow = chooseImportFile(fakeFile('backup.json', importDocText()));
    await answerWhenQueued(true);
    await flow;
    await vi.waitFor(() => {
      expect(state.value.tasks.has(importedOpenId)).toBe(true);
    });

    const step = importState.value;
    if (step.step !== 'done' || step.undoSnapshotId === null) {
      throw new Error('import did not report an undo snapshot');
    }

    const undo = restoreSnapshot(step.undoSnapshotId);
    await answerWhenQueued(true);
    await undo;

    await vi.waitFor(() => {
      expect(state.value.tasks.has(PRE_OPEN)).toBe(true);
    });
    expect(state.value.tasks.size).toBe(2);
    expect(state.value.tasks.has(importedOpenId)).toBe(false);
    expect([...state.value.lists.keys()]).toEqual([PRE_LIST]);
    expect(getSettings().theme).toBe('light');
    expect(document.documentElement.dataset['theme']).toBe('light');
    expect(screen.getByText('PRE ONE', { exact: true })).toBeTruthy();
    expect(screen.queryByText('IMPORTED ONE', { exact: true })).toBeNull();
  });
});
