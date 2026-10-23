/**
 * `<BackupRow>` (design §5.4) — "Backup": last-backup age + the two always-reachable actions.
 *
 * "Back up now" is the primary action of the whole surface and is never disabled except while
 * an export is running (§4.3). `dataExists: false` switches the row to the neutral never-
 * backed-up copy of §7 (no danger styling — there is nothing at risk yet) and shows the
 * "Nothing to back up yet" explainer.
 */

import type { JSX } from 'preact';

import { t } from '../../i18n';
import { absoluteDate, relativeAge } from './format';
import type { ExportState } from './types';

export interface BackupRowProps {
  readonly lastBackupAt: number | null;
  readonly dataExists: boolean;
  readonly onExport: () => void;
  readonly onImport: () => void;
  readonly exportState: ExportState;
  /** Injectable clock (§9). */
  readonly now?: number;
}

export function BackupRow({
  lastBackupAt,
  dataExists,
  onExport,
  onImport,
  exportState,
  now = Date.now(),
}: BackupRowProps): JSX.Element {
  const never = lastBackupAt === null;
  const relative = relativeAge(lastBackupAt, now);
  const saving = exportState === 'saving';
  /** Absolute date for the value line; only ever rendered when a backup exists. */
  const stamp = lastBackupAt ?? now;

  return (
    <div class="backup-row" data-state={exportState}>
      {dataExists && !never ? (
        <p class="backup-age">
          {t('dataSafety.backup.last', {
            relative,
            absolute: absoluteDate(stamp),
          })}
        </p>
      ) : (
        <p
          class="backup-age"
          data-never={never ? 'true' : undefined}
          data-danger={never && dataExists ? 'true' : undefined}
        >
          {never
            ? t('dataSafety.backup.never')
            : t('dataSafety.backup.last', {
                relative,
                absolute: absoluteDate(stamp),
              })}
        </p>
      )}

      {!dataExists ? <p class="backup-empty">{t('dataSafety.backup.empty')}</p> : null}
      {exportState === 'error' ? (
        <p class="backup-error" role="alert">
          {t('dataSafety.backup.error')}
        </p>
      ) : null}

      <div class="backup-actions">
        <button
          type="button"
          class="button button-primary"
          aria-busy={saving ? 'true' : undefined}
          disabled={saving}
          onClick={onExport}
        >
          {saving ? t('dataSafety.backup.saving') : t('dataSafety.backup.action')}
        </button>
        <button type="button" class="button button-secondary" onClick={onImport}>
          {t('dataSafety.backup.import')}
        </button>
      </div>
    </div>
  );
}
