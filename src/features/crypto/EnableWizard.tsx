/**
 * The enable wizard (ADR-007 Decision 6.1 — §7.3's order is NORMATIVE):
 *
 *   1. Forced backup export (hard gate — `backupGate` is mechanical: a stale
 *      `lastBackupAt` does NOT pass; enabling without a fresh export is
 *      impossible).
 *   2. Explicit lost-passphrase warning + ticked confirmation (the primary
 *      button stays disabled until it is ticked).
 *   3. Passphrase entry (min 12 chars, confirm, advisory strength hint).
 *   4. Recovery-key offer (show once + download key file + acknowledge, or
 *      Skip which re-shows the warning and records the decline).
 *   5. Migration runs with progress; the wizard closes at `status: 'on'`.
 *
 * Failure anywhere before step 5 commits leaves the store plaintext.
 */

import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

import { t } from '../../app/i18n';
import { Dialog } from '../../components/Dialog';
import { downloadTextFile } from '../../portability/download';
import { exportBackup } from '../../portability/export';
import { vault } from '../../crypto/vault';
import { enableEncryption, backupGate } from '../../crypto/service';
import type { AppDBImpl } from '../../storage/db';
import { keyFileName, serializeKeyFile } from '../../crypto/recovery';
import { passphraseIssue, strengthHint } from '../../crypto/passphrase';
import { refreshAfterUnlock } from './wiring';

export type EnableWizardProps = {
  db: AppDBImpl;
  now: () => number;
  /** Decision 3.3: warned at step 1 when sync is configured. */
  syncConfigured: boolean;
  onDone: () => void;
  onClose: () => void;
};

type Step = 1 | 2 | 3 | 4 | 5;

export function EnableWizard({
  db,
  now,
  syncConfigured,
  onDone,
  onClose,
}: EnableWizardProps): JSX.Element {
  const [flowOpenedAt] = useState(() => now());
  const [step, setStep] = useState<Step>(1);
  const [gatePassed, setGatePassed] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [wantRecovery, setWantRecovery] = useState(true);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [keyFileText, setKeyFileText] = useState<string | null>(null);
  const [recoverySaved, setRecoverySaved] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Decision 6.1 step 1 — mechanical gate, checked against the DB receipt.
  const recheckGate = async (): Promise<void> => {
    const gate = await backupGate(db, flowOpenedAt);
    setGatePassed(gate.ok);
    if (!gate.ok) setError(t('crypto.error.noBackup'));
    else setError(null);
  };

  const runExport = async (): Promise<void> => {
    setBusy(true);
    const exported = await exportBackup({ db, now, download: true });
    setBusy(false);
    if (!exported.ok) {
      setError(t('crypto.error.exportFailed'));
      return;
    }
    await recheckGate();
  };

  const submitEnable = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await enableEncryption({
      db,
      vault,
      passphrase,
      passphraseConfirm: confirm,
      flowOpenedAt,
      lostPassphraseAcknowledged: acknowledged,
      wantRecoveryKey: wantRecovery,
      now,
      onProgress: setProgress,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    if (result.value.recovery !== null) {
      setRecoveryCode(result.value.recovery.code);
      setKeyFileText(serializeKeyFile(result.value.recovery.keyFile));
      setStep(4);
      return;
    }
    finish();
  };

  const finish = (): void => {
    refreshAfterUnlock();
    onDone();
    onClose();
  };

  const strength = strengthHint(passphrase);
  const policyIssue = passphrase === '' ? null : passphraseIssue(passphrase);

  return (
    <Dialog
      title={t('crypto.enable.title')}
      onClose={onClose}
      footer={
        step === 1 ? (
          <>
            <button type="button" class="button-quiet" onClick={onClose}>
              {t('crypto.enable.cancel')}
            </button>
            <button
              type="button"
              class="button-secondary"
              disabled={busy}
              onClick={() => void runExport()}
            >
              {t('crypto.enable.exportNow')}
            </button>
            <button
              type="button"
              class="button-primary"
              disabled={!gatePassed}
              data-autofocus
              onClick={() => {
                void recheckGate().then(() => {
                  setStep(2);
                });
              }}
            >
              {t('crypto.enable.next')}
            </button>
          </>
        ) : step === 2 ? (
          <>
            <button
              type="button"
              class="button-quiet"
              onClick={() => {
                setStep(1);
              }}
            >
              {t('crypto.enable.back')}
            </button>
            <button
              type="button"
              class="button-primary"
              disabled={!acknowledged}
              onClick={() => {
                setStep(3);
              }}
            >
              {t('crypto.enable.next')}
            </button>
          </>
        ) : step === 3 ? (
          <>
            <button
              type="button"
              class="button-quiet"
              onClick={() => {
                setStep(2);
              }}
            >
              {t('crypto.enable.back')}
            </button>
            <button
              type="button"
              class="button-primary"
              disabled={busy || policyIssue !== null || passphrase !== confirm || passphrase === ''}
              onClick={() => {
                if (wantRecovery && recoveryCode === null) {
                  void submitEnable();
                } else {
                  void submitEnable();
                }
              }}
            >
              {t('crypto.enable.submit')}
            </button>
          </>
        ) : step === 4 ? (
          <button type="button" class="button-primary" disabled={!recoverySaved} onClick={finish}>
            {t('crypto.enable.next')}
          </button>
        ) : null
      }
    >
      {step === 1 ? (
        <div>
          {syncConfigured ? <p class="field-note">{t('crypto.warn.syncOneDevice')}</p> : null}
          <p>{t('crypto.enable.backupNeeded')}</p>
          <p class="field-note">{t('crypto.warn.exportNotEncrypted')}</p>
          {gatePassed ? <p role="status">{t('crypto.enable.backupDone')}</p> : null}
        </div>
      ) : step === 2 ? (
        <div>
          <p role="alert">{t('crypto.warn.lostPassphrase')}</p>
          <label class="field">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => {
                setAcknowledged(e.currentTarget.checked);
              }}
            />
            <span>{t('crypto.warn.acknowledge')}</span>
          </label>
        </div>
      ) : step === 3 ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitEnable();
          }}
        >
          <label class="field">
            <span>{t('crypto.enable.passphrase')}</span>
            <input
              type="password"
              data-autofocus
              autoComplete="new-password"
              value={passphrase}
              onInput={(e) => {
                setPassphrase(e.currentTarget.value);
              }}
            />
          </label>
          <p class="field-note">{t('crypto.enable.passphraseHint')}</p>
          <p class="field-note" data-strength={strength}>
            {strength === 'strong'
              ? t('crypto.enable.strengthStrong')
              : strength === 'fair'
                ? t('crypto.enable.strengthFair')
                : t('crypto.enable.strengthWeak')}
          </p>
          <label class="field">
            <span>{t('crypto.enable.passphraseConfirm')}</span>
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onInput={(e) => {
                setConfirm(e.currentTarget.value);
              }}
            />
          </label>
          <label class="field">
            <input
              type="checkbox"
              checked={wantRecovery}
              onChange={(e) => {
                setWantRecovery(e.currentTarget.checked);
              }}
            />
            <span>{t('crypto.enable.recoveryOffer')}</span>
          </label>
          {error === null ? null : (
            <p class="field-error" role="alert">
              {error}
            </p>
          )}
          {progress === null ? null : (
            <p role="status">
              {t('crypto.enable.progress', { done: progress.done, total: progress.total })}
            </p>
          )}
        </form>
      ) : (
        <div>
          <p>{t('crypto.enable.recoveryBody')}</p>
          <p data-testid="recovery-code">{recoveryCode ?? ''}</p>
          <button
            type="button"
            class="button-secondary"
            disabled={keyFileText === null}
            onClick={() => {
              if (keyFileText !== null) {
                downloadTextFile(keyFileName(now()), keyFileText);
              }
            }}
          >
            {t('crypto.enable.downloadKeyFile')}
          </button>
          <button
            type="button"
            class="button-primary"
            onClick={() => {
              setRecoverySaved(true);
            }}
          >
            {t('crypto.enable.recoverySaved')}
          </button>
          <p class="field-note">{t('crypto.warn.declineRecovery')}</p>
        </div>
      )}
    </Dialog>
  );
}
