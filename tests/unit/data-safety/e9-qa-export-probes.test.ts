/**
 * E9 QA probes — S10 export delivery (File System Access vs universal download),
 * independent verification by the QA gate (h_reviewer, card t_adbd2e36) at 9ee9669.
 *
 * What the impl's own suite does NOT pin, this file does:
 *   1. the §9.4 GESTURE rule — `showSaveFilePicker` must be entered synchronously
 *      inside the `runExport()` call (before any await), because Chromium only
 *      opens the system dialog from a user gesture;
 *   2. copy HONESTY — the success toast must name where the bytes actually went
 *      (`dataSafety.backup.doneFsa` for a picker write, the downloads copy for the
 *      anchor path), and the dashboard's `lastBackupAt` must be fed by either path;
 *   3. a cancel produces NO toast at all (silence, not a lie);
 *   4. the S12 copy keys exist in BOTH locale packs with identical placeholders.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { bindDataSafetyDb } from '../../../src/portability';
import type { AppDBImpl } from '../../../src/storage/db';
import { runExport } from '../../../src/features/data-safety/actions';
import { toasts, resetToasts } from '../../../src/features/data-safety/notices';
import { resetFlags } from '../../../src/features/data-safety/flags';
import { dataSafetyState, patchState, resetState } from '../../../src/features/data-safety/state';
import { resetStorageInfo } from '../../../src/features/data-safety/storageInfo';
import { resetPendingWrites } from '../../../src/features/data-safety/pendingWrites';
import { setLocale, t } from '../../../src/i18n';
import { makeList, makeSettings, makeTask, openFixtureDb, uniqueDbName } from '../storage/fixtures';

type Globals = { showSaveFilePicker?: unknown };
const g = globalThis as Globals;

const opened: AppDBImpl[] = [];
let anchorClicks = 0;
let originalClick: unknown;

function abortError(): Error {
  const e = new Error('The user aborted a request.');
  e.name = 'AbortError';
  return e;
}

let written: string[] = [];

function fakeHandle(failWrite = false): Record<string, unknown> {
  return {
    name: 'backup.json',
    createWritable: async () => ({
      write: async (data: string): Promise<void> => {
        if (failWrite) throw new Error('disk full');
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
  resetToasts();
  written = [];
  await setLocale('en');
  anchorClicks = 0;

  const db = await openFixtureDb(uniqueDbName('e9qa-export'));
  opened.push(db);
  await db.put('settings', makeSettings());
  await db.put('lists', makeList());
  await db.put('tasks', makeTask());
  bindDataSafetyDb(db);

  originalClick = Reflect.get(HTMLAnchorElement.prototype, 'click');
  Reflect.set(HTMLAnchorElement.prototype, 'click', function click() {
    anchorClicks += 1;
  });
});

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  Reflect.set(HTMLAnchorElement.prototype, 'click', originalClick);
  delete g.showSaveFilePicker;
  vi.restoreAllMocks();
});

describe('Q8 — the §9.4 gesture rule (pick BEFORE the first await)', () => {
  it('enters showSaveFilePicker synchronously inside the runExport() call', () => {
    let enteredSync = false;
    g.showSaveFilePicker = vi.fn(() => {
      enteredSync = true;
      return Promise.resolve(fakeHandle());
    });

    const pending = runExport();
    // No `await` has happened yet on this tick — the picker was entered inside the
    // click handler's synchronous body, which is the only place Chromium allows it.
    expect(enteredSync).toBe(true);
    expect(g.showSaveFilePicker).toHaveBeenCalledTimes(1);
    expect(dataSafetyState.value.exportState).toBe('saving');
    return pending.then((delivered) => {
      expect(delivered).toBe(true);
    });
  });
});

describe('Q9 — copy honesty: the toast names where the file went', () => {
  it('a picker write announces doneFsa (never "your downloads") and feeds lastBackupAt', async () => {
    g.showSaveFilePicker = vi.fn(async () => fakeHandle());
    const delivered = await runExport();
    expect(delivered).toBe(true);
    expect(anchorClicks).toBe(0);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('"format": "local-first-todo-backup"');

    const last = toasts.value.at(-1);
    expect(last?.message).toBe(t('dataSafety.backup.doneFsa'));
    expect(last?.message).toContain('the file you chose');
    expect(dataSafetyState.value.lastBackupAt).not.toBeNull();
  });

  it('the download fallback (first-ever backup) announces the safe-keeping copy', async () => {
    g.showSaveFilePicker = vi.fn(async () => Promise.reject(new Error('blocked')));
    const delivered = await runExport();
    expect(delivered).toBe(true);
    expect(anchorClicks).toBe(1);
    const last = toasts.value.at(-1);
    expect(last?.message).toBe(t('dataSafety.backup.doneSafe'));
    expect(last?.message).not.toBe(t('dataSafety.backup.doneFsa'));
    expect(dataSafetyState.value.lastBackupAt).not.toBeNull();
  });

  it('a repeated download backup uses the short copy', async () => {
    // Seed a previous backup so firstEver is false.
    patchState({ lastBackupAt: 1 });
    g.showSaveFilePicker = undefined;
    const delivered = await runExport();
    expect(delivered).toBe(true);
    const last = toasts.value.at(-1);
    expect(last?.message).toBe(t('dataSafety.backup.doneShort'));
  });

  it('closing the save dialog is silent — no toast, no error state', async () => {
    g.showSaveFilePicker = vi.fn(async () => Promise.reject(abortError()));
    const delivered = await runExport();
    expect(delivered).toBe(false);
    expect(anchorClicks).toBe(0);
    expect(toasts.value).toEqual([]);
    expect(dataSafetyState.value.exportState).toBe('idle');
  });
});

describe('Q10 — S12/S10 copy is in BOTH locale packs (en + th)', () => {
  const keys = [
    'dataSafety.backup.doneFsa',
    'dataSafety.import.error.foreignParse',
    'dataSafety.format.json',
    'dataSafety.format.csv',
    'dataSafety.format.todotxt',
  ];

  it('every new S10/S12 key exists in en.json and th.json with the same placeholders', () => {
    const read = (name: string): Record<string, string> =>
      JSON.parse(readFileSync(resolve(process.cwd(), 'src/i18n', name), 'utf8')) as Record<
        string,
        string
      >;
    const en = read('en.json');
    const th = read('th.json');
    for (const key of keys) {
      expect(en[key], `${key} in en`).toBeTruthy();
      expect(th[key], `${key} in th`).toBeTruthy();
      const placeholders = (value: string): string[] =>
        [...value.matchAll(/\{(\w+)\}/gu)].map((m) => m[1] ?? '').sort();
      expect(placeholders(th[key] ?? ''), `${key} placeholders th`).toEqual(
        placeholders(en[key] ?? ''),
      );
    }
  });
});
