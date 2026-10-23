/**
 * `<StoragePanelContainer>` — the wired half of §5.1: it reads the data-safety store and hands
 * the presentational panel its props and callbacks.
 *
 * Mounted inside SettingsView's documented `data-mount-point="storage-backup"` section (E5
 * mount point, M14). Every callback is fire-and-forget (`void`) — the actions report their own
 * outcomes through state, toasts and the live region (§4.4).
 */

import type { JSX } from 'preact';

import { runDeleteAll, runExport } from './actions';
import { importPickTick, importState, chooseImportFile, requestImportPick } from './importFlow';
import { runRequestPersist } from './persistGate';
import { StoragePanel } from './StoragePanel';
import { dataSafetyState } from './state';
import { persistenceError, persistenceState, quotaState } from './storageInfo';
import { restoreSnapshot } from './importFlow';

export function StoragePanelContainer(): JSX.Element {
  const state = dataSafetyState.value;
  const quota = quotaState.value;
  const persistence = persistenceState.value;
  const persistErrored = persistenceError.value;
  const flow = importState.value;
  const pickTick = importPickTick.value;

  const importNotice =
    flow.step === 'invalid'
      ? { tone: 'error' as const, message: flow.message }
      : flow.step === 'failed'
        ? { tone: 'error' as const, message: flow.message }
        : undefined;

  return (
    <StoragePanel
      quota={{ usedBytes: quota.usedBytes, totalBytes: quota.totalBytes }}
      persistence={persistence}
      lastBackupAt={state.lastBackupAt}
      snapshots={state.snapshots}
      state={state.panelState}
      exportState={state.exportState}
      persistBusy={state.panelState === 'persist-loading'}
      persistError={persistErrored}
      dataExists={state.hasData}
      unavailable={state.status === 'failed'}
      importNotice={importNotice}
      pickTick={pickTick}
      onChooseAnother={() => {
        requestImportPick();
      }}
      onRequestPersist={() => {
        void runRequestPersist();
      }}
      onExport={() => {
        void runExport();
      }}
      onImport={(file) => {
        void chooseImportFile(file);
      }}
      onRestoreSnapshot={(id) => {
        void restoreSnapshot(id);
      }}
      onDeleteAll={() => {
        void runDeleteAll();
      }}
    />
  );
}
