/**
 * The enable wizard (ADR-007 Decision 6.1 — §7.3's order is NORMATIVE and is
 * now STRUCTURAL, not copy):
 *
 *   1. Forced backup export (hard gate — `backupGate` is mechanical: a stale
 *      `lastBackupAt` does NOT pass; enabling without a fresh export is
 *      impossible).
 *   2. Explicit lost-passphrase warning + ticked confirmation (the primary
 *      button stays disabled until it is ticked).
 *   3. Passphrase entry (min 12 chars, confirm, advisory strength hint).
 *      Submitting runs the gate/policy checks and writes the key ring
 *      (`status: 'migrating'`) — nothing is encrypted yet.
 *   4. Recovery-key offer BEFORE the sweep (review F1c): the generated code is
 *      on screen while no row is encrypted yet, and the slot is persisted only
 *      after "I saved it" — a slot can never strand whose code was never
 *      shown. Declining (step-3 checkbox off) re-shows the step-2 warning
 *      verbatim and records the decline (review F3 / D6.1).
 *   5. The sweep runs with progress; the wizard closes at `status: 'on'`. A
 *      resumable pause (QUOTA) keeps `migrating` with a reachable Retry (the
 *      store is a legal mixed state — Decision 7.2).
 *
 * Failure anywhere before step 5 commits leaves the store plaintext: closing
 * at step 4 cancels the offer and rolls back (the service does it — Decision
 * 6.1). Closing mid-sweep is refused; a paused step 5 may close — Crypto
 * Section owns the resume + retry from there (Decision 7.1).
 */

import type { JSX } from 'preact';
import { useRef, useState } from 'preact/hooks';

import { t } from '../../app/i18n';
import { Dialog } from '../../components/Dialog';
import { downloadTextFile } from '../../portability/download';
import { exportBackup } from '../../portability/export';
import { vault } from '../../crypto/vault';
import { enableEncryption, backupGate } from '../../crypto/service';
import type { AppDBImpl } from '../../storage/db';
import { keyFileName, serializeKeyFile } from '../../crypto/recovery';
import { passphraseIssue, strengthHint } from '../../crypto/passphrase';
import { refreshAfterUnlock, resumeMigrationFlow } from './wiring';

export type EnableWizardProps = {
  db: AppDBImpl;
  now: () => number;
  /** Decision 3.3: warned at step 1 when sync is configured. */
  syncConfigured: boolean;
  onDone: () => void;
  onClose: () => void;
};

type Step = 1 | 2 | 3 | 4 | 5;
/** Step 4's two faces: the generated code, or the decline re-warning (D6.1). */
type Offer = { code: string; keyFileText: string } | 'decline' | null;
type OfferVerdict = 'saved' | 'skipped' | 'cancelled';

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
  const [offer, setOffer] = useState<Offer>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The pending step-4 resolution — closing there resolves `'cancelled'`. */
  const offerRef = useRef<((verdict: OfferVerdict) => void) | null>(null);
  const closedRef = useRef(false);
  /**
   * Fresh-for-close-guards mirror of `busy`: a dialog keydown effect can still
   * hold the PREVIOUS render's closure for a tick (effects flush after the
   * DOM), and a close guard must never act on stale state.
   */
  const busyRef = useRef(false);
  busyRef.current = busy;

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

  const finish = (): void => {
    refreshAfterUnlock();
    onDone();
    onClose();
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
      // Decision 6.1 step 4: the offer runs BEFORE the sweep; the slot is
      // persisted only when the code has been acknowledged on screen.
      onRecoveryOffer: (revealed) =>
        new Promise<OfferVerdict>((resolve) => {
          offerRef.current = resolve;
          setOffer(
            revealed === null
              ? 'decline'
              : {
                  code: revealed.code,
                  keyFileText: serializeKeyFile(revealed.keyFile),
                },
          );
          setStep(4);
          setBusy(false); // waiting on the user's decision
        }),
    });
    if (closedRef.current) return; // closed at step 4 — already rolled back
    setBusy(false);
    if (result.ok) {
      finish();
      return;
    }
    setError(result.error.message);
    const status = (await vault.refreshState())?.status ?? 'off';
    if (status === 'migrating') {
      setStep(5); // resumable pause — visible progress + reachable Retry
    } else {
      setStep(3); // rolled back to plaintext — fix the input and resubmit
    }
  };

  /** Step 5's reachable retry (Decision 7.1 — the UI resume flow). */
  const retryResume = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const resumed = await resumeMigrationFlow(db, { onProgress: setProgress });
    setBusy(false);
    if (!resumed.ok) {
      setError(resumed.error.message);
      return;
    }
    const status = (await vault.refreshState())?.status ?? 'off';
    if (status === 'on') {
      finish();
      return;
    }
    setError(t('crypto.error.migration'));
  };

  const resolveOffer = (verdict: 'saved' | 'skipped'): void => {
    const resolve = offerRef.current;
    offerRef.current = null;
    setStep(5);
    setBusy(true); // the sweep runs from here
    resolve?.(verdict);
  };

  /** Esc / scrim: cancelled at step 4 (rolls back), refused mid-sweep. */
  const requestClose = (): void => {
    if (busyRef.current) return;
    if (offerRef.current !== null) {
      closedRef.current = true;
      const resolve = offerRef.current;
      offerRef.current = null;
      resolve('cancelled');
    }
    onClose();
  };

  const strength = strengthHint(passphrase);
  const policyIssue = passphrase === '' ? null : passphraseIssue(passphrase);

  return (
    <Dialog
      title={t('crypto.enable.title')}
      onClose={requestClose}
      footer={
        step === 1 ? (
          <>
            <button type="button" class="button-quiet" onClick={requestClose}>
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
                void submitEnable();
              }}
            >
              {t('crypto.enable.submit')}
            </button>
          </>
        ) : step === 4 ? (
          offer === 'decline' ? (
            <button
              type="button"
              class="button-primary"
              data-autofocus
              onClick={() => {
                resolveOffer('skipped');
              }}
            >
              {t('crypto.enable.skipRecovery')}
            </button>
          ) : (
            <button
              type="button"
              class="button-primary"
              data-autofocus
              onClick={() => {
                resolveOffer('saved');
              }}
            >
              {t('crypto.enable.recoverySaved')}
            </button>
          )
        ) : (
          <>
            {error === null ? null : (
              <button
                type="button"
                class="button-primary"
                disabled={busy}
                onClick={() => {
                  void retryResume();
                }}
              >
                {t('common.retry')}
              </button>
            )}
            <button type="button" class="button-quiet" disabled={busy} onClick={requestClose}>
              {t('crypto.enable.cancel')}
            </button>
          </>
        )
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
        </form>
      ) : step === 4 && offer !== 'decline' && offer !== null ? (
        <div>
          <p>{t('crypto.enable.recoveryBody')}</p>
          <p data-testid="recovery-code">{offer.code}</p>
          <button
            type="button"
            class="button-secondary"
            onClick={() => {
              downloadTextFile(keyFileName(now()), offer.keyFileText);
            }}
          >
            {t('crypto.enable.downloadKeyFile')}
          </button>
        </div>
      ) : step === 4 ? (
        // Decision 6.1: a decline RE-SHOWS the step-2 warning verbatim and
        // records the decline (review F3) — it is not silently skipped.
        <div>
          <p role="alert">{t('crypto.warn.lostPassphrase')}</p>
          <p class="field-note">{t('crypto.warn.declineRecovery')}</p>
        </div>
      ) : (
        <div>
          {progress === null ? null : (
            <p role="status">
              {t('crypto.enable.progress', { done: progress.done, total: progress.total })}
            </p>
          )}
          {error === null ? null : (
            <p class="field-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
