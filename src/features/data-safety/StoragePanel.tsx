/**
 * `<StoragePanel>` (design §5.1) — the Settings → Storage & back up card stack (§4).
 *
 * Presentational per §5.1: data and effects arrive as props, the panel renders the six
 * sections in the §4.1 order (explainer → quota → persistence → backup → snapshots → danger
 * zone) with `h3` headings under the settings `h2` (§4.4). The file picker lives here because
 * §5.1's contract hands the caller a `File`, not a path.
 *
 * Mobile (§4.2) is the same content in one column: `.storage-panel` stacks below 768 px, the
 * two backup buttons become full width, and every target keeps 44 px (M8).
 */

import { useEffect, useRef } from 'preact/hooks';
import type { ComponentChildren, JSX, TargetedEvent } from 'preact';

import { t } from '../../i18n';
import { BackupRow } from './BackupRow';
import { PersistenceRow } from './PersistenceRow';
import { QuotaMeter } from './QuotaMeter';
import { SnapshotList } from './SnapshotList';
import type { ExportState, PanelState, SnapshotMeta } from './types';

export interface StoragePanelProps {
  readonly quota: { readonly usedBytes: number; readonly totalBytes: number | null };
  readonly persistence: 'granted' | 'denied' | 'unsupported' | 'not-requested';
  readonly lastBackupAt: number | null;
  readonly snapshots: readonly SnapshotMeta[];
  readonly onRequestPersist: () => void;
  readonly onExport: () => void;
  readonly onImport: (file: File) => void;
  readonly onRestoreSnapshot: (id: string) => void;
  readonly onDeleteAll: () => void;
  /** Injectable clock for age math/tests (§5.1, §9). */
  readonly now?: number | undefined;

  /* --- additive state props (§5.1 "States: idle | export-loading | …") --- */
  readonly state?: PanelState | undefined;
  readonly exportState?: ExportState | undefined;
  readonly persistBusy?: boolean | undefined;
  readonly persistError?: boolean | undefined;
  /** `false` → neutral "never backed up" copy and the "nothing to back up yet" line (§7). */
  readonly dataExists?: boolean | undefined;
  /** Storage API unavailable/failed entirely (§9.4 degrade). */
  readonly unavailable?: boolean | undefined;
  /** Escape-hatch slots (§5.1). */
  readonly explainer?: ComponentChildren;
  readonly footerNote?: ComponentChildren;
  /** §7 inline import error/notice under the picker ("Choose another file" always offered). */
  readonly importNotice?: { readonly tone: 'error' | 'info'; readonly message: string } | undefined;
  readonly onChooseAnother?: (() => void) | undefined;
  /**
   * Picker request counter (§3.4 recovery screen → "Restore from a backup"): the container
   * bumps it and the panel clicks its own hidden input.
   */
  readonly pickTick?: number | undefined;
}

export function StoragePanel({
  quota,
  persistence,
  lastBackupAt,
  snapshots,
  onRequestPersist,
  onExport,
  onImport,
  onRestoreSnapshot,
  onDeleteAll,
  now = Date.now(),
  state = 'idle',
  exportState = 'idle',
  persistBusy = false,
  persistError = false,
  dataExists = true,
  unavailable = false,
  explainer,
  footerNote,
  importNotice,
  onChooseAnother,
  pickTick = 0,
}: StoragePanelProps): JSX.Element {
  const fileRef = useRef<HTMLInputElement | null>(null);

  // External picker requests (recovery screen "Restore from a backup", quota "Free up space"
  // cousin flows): bump the counter and the panel opens its own input.
  useEffect(() => {
    if (pickTick > 0) fileRef.current?.click();
  }, [pickTick]);

  const pickFile = (): void => {
    fileRef.current?.click();
  };

  const handleFile = (event: TargetedEvent<HTMLInputElement>): void => {
    const file = event.currentTarget.files?.[0];
    // Reset so picking the same file twice still fires `change`.
    event.currentTarget.value = '';
    if (file !== undefined) onImport(file);
  };

  return (
    <div class="storage-panel" data-panel-state={state}>
      <div class="storage-section storage-explainer">
        {explainer ?? (
          <p class="storage-explainer-text">
            {t('dataSafety.panel.explainer', { appName: t('app.name') })}
          </p>
        )}
      </div>

      <section class="storage-section" aria-labelledby="storage-quota">
        <h3 class="storage-heading" id="storage-quota">
          {t('dataSafety.panel.storageHeading')}
        </h3>
        {unavailable ? (
          <p class="storage-unavailable">{t('dataSafety.panel.unavailable')}</p>
        ) : (
          <QuotaMeter
            usedBytes={quota.usedBytes}
            totalBytes={quota.totalBytes}
            loading={state === 'idle' && quota.totalBytes === null}
            labels={{
              ok: t('dataSafety.meter.ok'),
              warn: t('dataSafety.meter.warn'),
              crit: t('dataSafety.meter.crit'),
              unknown: t('dataSafety.meter.unknown'),
            }}
          />
        )}
      </section>

      <section class="storage-section" aria-labelledby="storage-persistence">
        <h3 class="storage-heading" id="storage-persistence">
          {t('dataSafety.persistence.heading')}
        </h3>
        <PersistenceRow
          state={persistence}
          busy={persistBusy || state === 'persist-loading'}
          error={persistError}
          onRequest={persistence === 'unsupported' ? undefined : onRequestPersist}
        />
      </section>

      <section class="storage-section" aria-labelledby="storage-backup">
        <h3 class="storage-heading" id="storage-backup">
          {t('dataSafety.backup.heading')}
        </h3>
        <BackupRow
          lastBackupAt={lastBackupAt}
          dataExists={dataExists}
          exportState={exportState}
          now={now}
          onExport={onExport}
          onImport={pickFile}
        />
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          class="visually-hidden"
          data-testid="import-file-input"
          onChange={handleFile}
        />
        {state === 'import-loading' ? (
          <p class="storage-busy" role="status">
            {t('dataSafety.import.validating')}
          </p>
        ) : null}
        {importNotice === undefined ? null : (
          <div class="storage-notice" role="alert" data-tone={importNotice.tone}>
            <p>{importNotice.message}</p>
            {onChooseAnother === undefined ? null : (
              <button type="button" class="button button-secondary" onClick={onChooseAnother}>
                {t('dataSafety.import.chooseAnother')}
              </button>
            )}
          </div>
        )}
      </section>

      <section class="storage-section" aria-labelledby="storage-snapshots">
        <h3 class="storage-heading" id="storage-snapshots">
          {t('dataSafety.snapshots.heading')}
        </h3>
        <SnapshotList snapshots={snapshots} onRestore={onRestoreSnapshot} />
      </section>

      <section class="storage-section storage-danger" aria-labelledby="storage-danger">
        <h3 class="storage-heading" id="storage-danger">
          {t('dataSafety.danger.heading')}
        </h3>
        <p class="storage-danger-body">{t('dataSafety.danger.body')}</p>
        <div class="storage-danger-actions">
          <button type="button" class="button button-danger-outline" onClick={onDeleteAll}>
            {t('dataSafety.danger.action')}
          </button>
        </div>
      </section>

      {footerNote ?? null}
    </div>
  );
}
