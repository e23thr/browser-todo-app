/**
 * E3 data-safety UX real-storage harness (test card t_b1595f03, epic E3).
 *
 * Mounts the REAL Preact surface — `<DataSafetyHost>` + `<StoragePanelContainer>` — into a
 * REAL Chromium page backed by a REAL `StorageManager` and REAL IndexedDB. This is the
 * "real storage states" half of the QA card; the scripted `navigator.storage` mocks live
 * in `tests/component/data-safety-ux-qa.test.tsx` (jsdom).
 *
 * The harness drives the production modules exactly as the composition root wires them
 * (`openForTests` + `bindDataSafetyDb` + the feature's own state/notices modules) — no
 * reimplementation. The only test seam is the `window.__qa` handle below; `src/` is
 * untouched.
 */
import { render } from 'preact';

import { DataSafetyHost } from '../../../src/features/data-safety/DataSafetyHost';
import { StoragePanelContainer } from '../../../src/features/data-safety/StoragePanelContainer';
import { noteFirstMeaningfulWrite } from '../../../src/features/data-safety/persistGate';
import { openDialog } from '../../../src/features/data-safety/notices';
import { initFirstRunFlag, patchState } from '../../../src/features/data-safety/state';
import {
  refreshPersistence,
  refreshQuota,
  requestPersist,
} from '../../../src/features/data-safety/storageInfo';
import { setLocale } from '../../../src/i18n';
import { bindDataSafetyDb } from '../../../src/portability/index';
import { openForTests } from '../../../src/storage/db';
import type { List, Settings, Task } from '../../../src/storage/types';

import '../../../src/styles/global.css';
import '../../../src/styles/data-safety.css';

const DAY = 86_400_000;
/** Fixed stamps so the page is deterministic; the clock the spec probes is the REAL one. */
const T0 = 1_700_000_000_000;
const fid = (n: number): string => `01ARZ3NDEKTSV4RRFFQ6${String(n).padStart(6, '0')}`;

function makeSettings(): Settings {
  return {
    id: 'settings',
    theme: 'system',
    locale: 'en',
    weekStart: 1,
    defaultListId: null,
    notificationsEnabled: false,
    lastBackupAt: null,
  };
}

function makeList(deviceId: string): List {
  return {
    id: fid(10),
    name: 'Personal',
    color: '#336699',
    sortOrder: 'h',
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    deviceId,
  };
}

function makeTask(deviceId: string): Task {
  return {
    id: fid(20),
    listId: fid(10),
    title: 'Buy milk',
    notes: null,
    status: 'open',
    priority: 0,
    tags: [],
    sortOrder: 'h',
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    deviceId,
  };
}

export interface QaApi {
  readonly ready: boolean;
  /** How many times the REAL `navigator.storage.persist()` was invoked. */
  persistCalls(): number;
  /** Verdict of the quota dialog opened via `openQuotaDialog`, once it resolves. */
  verdict(): 'confirmed' | 'cancelled' | null;
  /** Patch `lastBackupAt` to `days` ago (null = never backed up) and re-derive. */
  setBackupAge(days: number | null): void;
  /** Run the production first-meaningful-write gate (which requests persist()). */
  noteFirstWrite(): Promise<unknown>;
  /** Ask for persistence again through the production gate (panel row path). */
  requestPersist(): Promise<string>;
  /** Open the REAL quota-exceeded dialog through the production dialog queue. */
  openQuotaDialog(pendingCount: number): void;
}

declare global {
  var __qa: QaApi | undefined;
}

let verdict: 'confirmed' | 'cancelled' | null = null;
let persistCalls = 0;

/**
 * Count REAL persist() invocations without changing the answer the browser gives:
 * delegate to the original method and only tally the round trip.
 */
function instrumentPersist(): void {
  const storage = navigator.storage;
  const original = storage.persist.bind(storage);
  Object.defineProperty(storage, 'persist', {
    configurable: true,
    value: (): Promise<boolean> => {
      persistCalls += 1;
      return original();
    },
  });
}

async function main(): Promise<void> {
  await setLocale('en');
  instrumentPersist();
  initFirstRunFlag();

  const opened = await openForTests({ dbName: `qa-ux-real-${String(Date.now())}` });
  if (!opened.ok) throw new Error(`openForTests failed: ${opened.error.code}`);
  const db = opened.value;
  bindDataSafetyDb(db);
  for (const [store, row] of [
    ['settings', makeSettings()],
    ['lists', makeList(db.deviceId)],
    ['tasks', makeTask(db.deviceId)],
  ] as const) {
    const put = await db.put(store, row);
    if (!put.ok) throw new Error(`seeding ${store} failed: ${put.error.code}`);
  }

  patchState({
    status: 'ready',
    classification: { kind: 'normal' },
    hasData: true,
    lastBackupAt: Date.now(),
    priorUse: true,
    onboarding: false,
  } as never);
  await refreshQuota();
  await refreshPersistence();

  render(
    <>
      <DataSafetyHost />
      <StoragePanelContainer />
    </>,
    document.getElementById('surface') as HTMLElement,
  );

  const api: QaApi = {
    ready: true,
    persistCalls: () => persistCalls,
    verdict: () => verdict,
    setBackupAge: (days) => {
      patchState({
        lastBackupAt: days === null ? null : Date.now() - days * DAY,
      });
    },
    noteFirstWrite: () => noteFirstMeaningfulWrite(),
    requestPersist: () => requestPersist(),
    openQuotaDialog: (pendingCount) => {
      verdict = null;
      void openDialog({ kind: 'quota-exceeded', pendingCount }).then((confirmed) => {
        verdict = confirmed ? 'confirmed' : 'cancelled';
      });
    },
  };
  globalThis.__qa = api;
}

void main().catch((error: unknown) => {
  const status = document.getElementById('surface');
  if (status !== null) status.textContent = `harness failed: ${String(error)}`;
  throw error;
});
