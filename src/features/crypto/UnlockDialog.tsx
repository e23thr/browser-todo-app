/**
 * The unlock dialog + the lost-passphrase screen (ADR-007 Decision 6.3):
 * exactly three honest paths — recovery key, restore from backup export, or
 * (plainly) unrecoverable. No fake hope, no support contact (there is no
 * support — no telemetry, no server).
 */

import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

import { t } from '../../app/i18n';
import { Dialog } from '../../components/Dialog';
import { vault } from '../../crypto/vault';
import { refreshAfterUnlock } from './wiring';

export type UnlockDialogProps = {
  busy: boolean;
  error: string | null;
  onUnlock: (passphrase: string) => Promise<boolean>;
  onClose: () => void;
  /** Offer the lost-passphrase entry point (unlock screen — not the wizard). */
  showLostPath?: boolean;
};

export function UnlockDialog({
  busy,
  error,
  onUnlock,
  onClose,
  showLostPath = true,
}: UnlockDialogProps): JSX.Element {
  const [passphrase, setPassphrase] = useState('');
  const [mode, setMode] = useState<'passphrase' | 'lost'>('passphrase');
  return (
    <Dialog
      title={mode === 'passphrase' ? t('crypto.unlock.title') : t('crypto.lost.title')}
      onClose={onClose}
      footer={
        mode === 'passphrase' ? (
          <>
            {showLostPath ? (
              <button
                type="button"
                class="button-quiet"
                onClick={() => {
                  setMode('lost');
                }}
              >
                {t('crypto.unlock.lost')}
              </button>
            ) : null}
            <button
              type="button"
              class="button-primary"
              disabled={busy || passphrase.length === 0}
              onClick={() => {
                void onUnlock(passphrase);
              }}
            >
              {t('crypto.unlock.submit')}
            </button>
          </>
        ) : null
      }
    >
      {mode === 'passphrase' ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onUnlock(passphrase);
          }}
        >
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
          {error === null ? null : (
            <p class="field-error" role="alert">
              {error}
            </p>
          )}
        </form>
      ) : (
        <LostPassphrasePanel
          onRecovered={() => {
            refreshAfterUnlock();
            onClose();
          }}
        />
      )}
    </Dialog>
  );
}

/** Decision 6.3's three paths — verbatim intent, no invented hope. */
function LostPassphrasePanel({ onRecovered }: { onRecovered: () => void }): JSX.Element {
  const [recoveryCode, setRecoveryCode] = useState('');
  const [newPassphrase, setNewPassphrase] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [needsPassphrase, setNeedsPassphrase] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  /**
   * Decision 6.3 / §7.4's escape (review F4): data that cannot be recovered
   * can still be CLEARED — the last door out of a brick. Order matters, so
   * never a data-less brick from a partial wipe: the store is wiped FIRST
   * (`deleteAllData` deletes by id — quarantine and lock do not block it),
   * then the crypto state resets and the session key drops. Inline two-step
   * confirm — the locked screen has no DataSafetyHost to queue a dialog on.
   */
  const wipeEverything = async (): Promise<void> => {
    setDeleteBusy(true);
    setError(null);
    const { runDeleteAllWithoutDialog } = await import('../data-safety/actions');
    const wiped = await runDeleteAllWithoutDialog();
    if (!wiped) {
      setDeleteBusy(false);
      setError(t('dataSafety.deleteAll.failed'));
      return;
    }
    const reset = await vault.saveState({
      status: 'off',
      enabledAt: null,
      migration: null,
      keys: [],
      recoveryOfferedAt: null,
    });
    setDeleteBusy(false);
    if (!reset.ok) {
      // Store already empty — retryable from the same button, nothing lost.
      setError(t('dataSafety.deleteAll.failed'));
      return;
    }
    vault.lockNow();
    setStatus(t('dataSafety.deleteAll.done'));
    onRecovered();
  };

  const useCode = async (): Promise<void> => {
    setError(null);
    const unlocked = await vault.unlockWithRecoveryCode(recoveryCode);
    if (!unlocked.ok) {
      setError(t('crypto.lost.invalidCode'));
      return;
    }
    setNeedsPassphrase(true);
  };

  const setPassphraseAfterRecovery = async (): Promise<void> => {
    const changed = await vault.changePassphrase(newPassphrase);
    if (!changed.ok) {
      setError(t('crypto.lost.invalidCode'));
      return;
    }
    setStatus(t('crypto.lost.recovered'));
    onRecovered();
  };

  const useKeyFile = async (file: File): Promise<void> => {
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text()) as unknown;
    } catch {
      setError(t('crypto.lost.invalidCode'));
      return;
    }
    const unlocked = await vault.unlockWithKeyFile(parsed);
    if (!unlocked.ok) {
      setError(t('crypto.lost.invalidCode'));
      return;
    }
    setNeedsPassphrase(true);
  };

  return (
    <div class="crypto-lost">
      <p class="field-note">{t('crypto.warn.lostPassphrase')}</p>
      <section>
        <h3>{t('crypto.lost.keyfile')}</h3>
        <label class="field">
          <span>{t('crypto.lost.recoveryCode')}</span>
          <input
            type="text"
            value={recoveryCode}
            onInput={(e) => {
              setRecoveryCode(e.currentTarget.value);
            }}
          />
        </label>
        <button
          type="button"
          class="button-secondary"
          disabled={recoveryCode.length === 0}
          onClick={() => {
            void useCode();
          }}
        >
          {t('crypto.lost.useCode')}
        </button>
        <label class="field">
          <span>{t('crypto.lost.chooseFile')}</span>
          <input
            type="file"
            accept="application/json"
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              if (file !== undefined) void useKeyFile(file);
            }}
          />
        </label>
      </section>
      {needsPassphrase ? (
        <section>
          <h3>{t('crypto.lost.newPassphrase')}</h3>
          <label class="field">
            <span>{t('crypto.enable.passphrase')}</span>
            <input
              type="password"
              autoComplete="new-password"
              value={newPassphrase}
              onInput={(e) => {
                setNewPassphrase(e.currentTarget.value);
              }}
            />
          </label>
          <button
            type="button"
            class="button-primary"
            disabled={newPassphrase.length < 12}
            onClick={() => {
              void setPassphraseAfterRecovery();
            }}
          >
            {t('crypto.lost.newPassphraseSubmit')}
          </button>
        </section>
      ) : null}
      <section>
        <h3>{t('crypto.lost.backup')}</h3>
        <p class="field-note">{t('crypto.lost.backupNote')}</p>
      </section>
      <section>
        <h3>{t('crypto.lost.none')}</h3>
        <p class="field-note">{t('crypto.lost.noneNote')}</p>
        {deleteConfirm ? (
          <div>
            <p role="alert">{t('crypto.lost.deleteAllCaution')}</p>
            <button
              type="button"
              class="button-primary"
              disabled={deleteBusy}
              data-testid="lost-delete-confirm"
              onClick={() => {
                void wipeEverything();
              }}
            >
              {t('dataSafety.deleteAll.confirm')}
            </button>
            <button
              type="button"
              class="button-quiet"
              disabled={deleteBusy}
              onClick={() => {
                setDeleteConfirm(false);
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
        ) : (
          <button
            type="button"
            class="button-quiet"
            data-testid="lost-delete-all"
            onClick={() => {
              setDeleteConfirm(true);
            }}
          >
            {t('crypto.lost.deleteAll')}
          </button>
        )}
      </section>
      {error === null ? null : (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
      {status === null ? null : <p class="field-note">{status}</p>}
    </div>
  );
}
