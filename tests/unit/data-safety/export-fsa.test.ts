/**
 * S10 export routing: the FSA save path vs the universal download path.
 *
 * jsdom has no File System Access globals and no real download, so both paths
 * are exercised head-on: install `showSaveFilePicker` (picked / dismissed /
 * write-failure / error) and assert which delivery actually happened; remove it
 * and assert the anchor download fires. This is the §9.4 "no dead UI" contract
 * from the action's side — every outcome delivers or cancels honestly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bindDataSafetyDb } from '../../../src/portability';
import type { AppDBImpl } from '../../../src/storage/db';
import { runExport } from '../../../src/features/data-safety/actions';
import { resetFlags } from '../../../src/features/data-safety/flags';
import { dataSafetyState, resetState } from '../../../src/features/data-safety/state';
import { resetStorageInfo } from '../../../src/features/data-safety/storageInfo';
import { resetPendingWrites } from '../../../src/features/data-safety/pendingWrites';
import { makeList, makeSettings, makeTask, openFixtureDb, uniqueDbName } from '../storage/fixtures';

type Globals = { showSaveFilePicker?: unknown };
const g = globalThis as Globals;

const opened: AppDBImpl[] = [];
let anchorClicks = 0;
let written: string[] = [];
let originalClick: unknown;

function captured(target: object, key: string): unknown {
  return Reflect.get(target, key);
}

function abortError(): Error {
  const e = new Error('The user aborted a request.');
  e.name = 'AbortError';
  return e;
}

/** A Chromium-style handle capturing everything written to it. */
function fakeHandle(options: { failWrite?: boolean } = {}): Record<string, unknown> {
  return {
    name: 'backup.json',
    createWritable: async () => ({
      write: async (data: string): Promise<void> => {
        if (options.failWrite === true) throw new Error('disk full');
        written.push(data);
      },
      close: async (): Promise<void> => undefined,
    }),
  };
}

beforeEach(async () => {
  window.localStorage.clear();
  resetFlags();
  resetState();
  resetStorageInfo();
  resetPendingWrites();
  anchorClicks = 0;
  written = [];

  const db = await openFixtureDb(uniqueDbName('fsa-export'));
  opened.push(db);
  await db.put('settings', makeSettings());
  await db.put('lists', makeList());
  await db.put('tasks', makeTask());
  bindDataSafetyDb(db);

  // Count anchor downloads: jsdom's anchor.click() is a no-op, so the counter
  // only moves when `downloadTextFile` actually reaches for the anchor.
  originalClick = captured(HTMLAnchorElement.prototype, 'click');
  Reflect.set(HTMLAnchorElement.prototype, 'click', function click(this: unknown) {
    anchorClicks += 1;
  });
});

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  Reflect.set(HTMLAnchorElement.prototype, 'click', originalClick);
  delete g.showSaveFilePicker;
  vi.restoreAllMocks();
});

describe('runExport — FSA save path (Chromium)', () => {
  it('writes the document to the picked handle WITHOUT an anchor download', async () => {
    g.showSaveFilePicker = vi.fn(async () => fakeHandle());
    const delivered = await runExport();
    expect(delivered).toBe(true);
    expect(anchorClicks).toBe(0);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('"format": "local-first-todo-backup"');
  });

  it('a cancelled save dialog returns false with no error state and no fallback download', async () => {
    g.showSaveFilePicker = vi.fn(async () => Promise.reject(abortError()));
    const delivered = await runExport();
    expect(delivered).toBe(false);
    expect(anchorClicks).toBe(0);
    expect(written).toEqual([]);
    // A cancel is not an error: the panel settles back to idle, not 'error'.
    expect(dataSafetyState.value.exportState).toBe('idle');
    expect(dataSafetyState.value.panelState).toBe('idle');
  });

  it('falls back to the anchor download when writing the handle fails', async () => {
    g.showSaveFilePicker = vi.fn(async () => fakeHandle({ failWrite: true }));
    const delivered = await runExport();
    expect(delivered).toBe(true);
    expect(anchorClicks).toBe(1);
    expect(written).toEqual([]);
  });

  it('falls back to the anchor download when the picker errors (not cancels)', async () => {
    g.showSaveFilePicker = vi.fn(async () => Promise.reject(new Error('not allowed')));
    const delivered = await runExport();
    expect(delivered).toBe(true);
    expect(anchorClicks).toBe(1);
  });
});

describe('runExport — universal download path (no FSA globals: Safari/Firefox)', () => {
  it('delivers via the anchor download', async () => {
    const delivered = await runExport();
    expect(delivered).toBe(true);
    expect(anchorClicks).toBe(1);
    expect(written).toEqual([]);
  });
});
