/**
 * Turn-off confirmation (ADR-007 Decision 6.2): encryption can only be turned
 * off after this warning AND a passphrase confirmation — CryptoSection's action
 * opens this dialog instead of a one-click disable (review F2: the button fired
 * `disableEncryption` with an empty passphrase and no gate or explanation).
 *
 * D6.2 also offers a plaintext export first (the forced §7.3 backup gate does
 * not apply to opt-out, but the escape hatch is offered anyway).
 */

import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

import { t } from '../../app/i18n';
import { Dialog } from '../../components/Dialog';
import type { AppDBImpl } from '../../storage/db';
import { disableEncryption } from '../../crypto/service';
import { vault } from '../../crypto/vault';
import { exportBackup } from '../../portability/export';
import { refreshAfterUnlock } from './wiring';

export type TurnOffDialogProps = {
  db: AppDBImpl;
  now: () => number;
  onDone: () => void;
  onClose: () => void;
};

export function TurnOffDialog({ db, now, onDone, onClose }: TurnOffDialogProps): JSX.Element {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const confirmOff = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await disableEncryption({ db, vault, passphrase, now, onProgress: setProgress });
    setBusy(false);
    if (!result.ok) {
      setError(
        result.error.code === 'UNLOCK_FAILED' ? t('crypto.unlock.failed') : result.error.message,
      );
      return;
    }
    refreshAfterUnlock();
    onDone();
    onClose();
  };

  return (
    <Dialog
      title={t('crypto.turnOff.title')}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <button type="button" class="button-quiet" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            class="button-primary"
            disabled={busy || passphrase === ''}
            onClick={() => {
              void confirmOff();
            }}
          >
            {t('crypto.action.turnOff')}
          </button>
        </>
      }
    >
      <div>
        <p role="alert">{t('crypto.turnOff.warning')}</p>
        <label class="field">
          <span>{t('crypto.unlock.passphrase')}</span>
          <input
            type="password"
            data-autofocus
            autoComplete="current-password"
            value={passphrase}
            onInput={(e) => {
              setPassphrase(e.currentTarget.value);
            }}
          />
        </label>
        <button
          type="button"
          class="button-secondary"
          disabled={busy}
          onClick={() => {
            void exportBackup({ db, now, download: true });
          }}
        >
          {t('crypto.enable.exportNow')}
        </button>
        {progress === null ? null : (
          <p role="status">
            {t('crypto.turnOff.progress', { done: progress.done, total: progress.total })}
          </p>
        )}
        {error === null ? null : (
          <p class="field-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
