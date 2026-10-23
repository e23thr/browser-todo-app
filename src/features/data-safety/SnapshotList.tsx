/**
 * Snapshot list (design §4.3 "Snapshots") — newest first, capped at the rolling three.
 *
 * Each row shows what kind of snapshot it is, when it was taken and how big it is, with a
 * Restore button that runs the same confirm + undo pattern as import (§8.4). `pre-import`
 * snapshots carry the subtle "can be restored" note of §8.4 — they are the undo of an import.
 */

import type { JSX } from 'preact';

import { Icon } from '../../app/icons';
import { t } from '../../i18n';
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
}

export function SnapshotList({ snapshots, onRestore }: SnapshotListProps): JSX.Element {
  if (snapshots.length === 0) {
    return <p class="snapshots-empty">{t('dataSafety.snapshots.empty')}</p>;
  }

  return (
    <ul class="snapshot-list">
      {snapshots.slice(0, 3).map((snapshot) => (
        <li class="snapshot-row" key={snapshot.id} data-reason={snapshot.reason}>
          <span class="snapshot-kind">{reasonLabel(snapshot.reason)}</span>
          <span class="snapshot-when">{absoluteDateTime(snapshot.takenAt)}</span>
          <span class="snapshot-size">{formatBytes(snapshot.sizeBytes)}</span>
          {snapshot.reason === 'pre-import' ? (
            <span class="snapshot-note">{t('dataSafety.snapshots.protected')}</span>
          ) : null}
          <button
            type="button"
            class="button button-secondary"
            onClick={() => {
              onRestore(snapshot.id);
            }}
          >
            <Icon name="download" size={16} />
            {t('dataSafety.snapshots.restore')}
          </button>
        </li>
      ))}
    </ul>
  );
}
