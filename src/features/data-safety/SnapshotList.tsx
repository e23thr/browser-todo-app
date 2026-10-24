/**
 * Snapshot list (design §4.3 "Snapshots") — newest first, capped at the rolling three.
 *
 * Each row shows what kind of snapshot it is, when it was taken and how big it is, with a
 * Restore button that runs the same confirm + undo pattern as import (§8.4). `pre-import`
 * snapshots carry the §8.4 retention note while they are protected, plus the binding
 * `downloadSnapshot` escape hatch (ADR-004 Decision 5.5 (b)) — retention can only promise
 * seven days, a downloaded file is kept forever.
 */

import type { JSX } from 'preact';

import { Icon } from '../../app/icons';
import { t } from '../../i18n';
import { PRE_IMPORT_PROTECTION_MS } from '../../portability';
import { absoluteDateTime, formatBytes } from './format';
import type { SnapshotMeta } from './types';

/** §4.3 kind label per snapshot reason. */
function reasonLabel(reason: SnapshotMeta['reason']): string {
  switch (reason) {
    case 'scheduled':
      return t('dataSafety.snapshots.reason.scheduled');
    case 'pre-migration':
      return t('dataSafety.snapshots.reason.preMigration');
    case 'pre-import':
      return t('dataSafety.snapshots.reason.preImport');
    case 'manual':
      return t('dataSafety.snapshots.reason.manual');
  }
}

export interface SnapshotListProps {
  readonly snapshots: readonly SnapshotMeta[];
  readonly onRestore: (id: string) => void;
  /** ADR-004 Decision 5.5 (b): download a `pre-import` undo as a file. */
  readonly onDownload: (snapshot: SnapshotMeta) => void;
  /** Injectable clock (§9) — the §8.4 retention note ages out after seven days. */
  readonly now?: number | undefined;
}

export function SnapshotList({
  snapshots,
  onRestore,
  onDownload,
  now = Date.now(),
}: SnapshotListProps): JSX.Element {
  if (snapshots.length === 0) {
    return <p class="snapshots-empty">{t('dataSafety.snapshots.empty')}</p>;
  }

  return (
    <ul class="snapshot-list">
      {snapshots.slice(0, 3).map((snapshot) => {
        // §8.4: the note tells the TRUTH about retention — protected for seven days, and the
        // download is how the user keeps it beyond that (or beyond the rolling three).
        const protectedForNow =
          snapshot.reason === 'pre-import' && now - snapshot.takenAt < PRE_IMPORT_PROTECTION_MS;
        return (
          <li class="snapshot-row" key={snapshot.id} data-reason={snapshot.reason}>
            <span class="snapshot-kind">{reasonLabel(snapshot.reason)}</span>
            <span class="snapshot-when">{absoluteDateTime(snapshot.takenAt)}</span>
            <span class="snapshot-size">{formatBytes(snapshot.sizeBytes)}</span>
            {protectedForNow ? (
              <span class="snapshot-note">{t('dataSafety.snapshots.protected')}</span>
            ) : null}
            <button
              type="button"
              class="button button-secondary"
              onClick={() => {
                onRestore(snapshot.id);
              }}
            >
              <Icon name="upload" size={16} />
              {t('dataSafety.snapshots.restore')}
            </button>
            {snapshot.reason === 'pre-import' ? (
              <button
                type="button"
                class="button button-secondary"
                data-testid="download-snapshot"
                onClick={() => {
                  onDownload(snapshot);
                }}
              >
                <Icon name="download" size={16} />
                {t('dataSafety.snapshots.download')}
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
