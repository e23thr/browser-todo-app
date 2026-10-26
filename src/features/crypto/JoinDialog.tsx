/**
 * Device join (ADR-007 Decision 3.2): adopt another device's key file into the
 * local ring, choosing a LOCAL passphrase over the same DMK — zero record
 * re-encryption, nothing on the store changes. This is the fix for the
 * never-enabled device that pulled encrypted records (Decision 3.3's blocked
 * state) — review F4. The store flips to `status: 'on'` on a fresh join so the
 * device locks and encrypts its writes (review Q3).
 */

import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

import { t } from '../../app/i18n';
import { Dialog } from '../../components/Dialog';
import { parseKeyFile } from '../../crypto/recovery';
import { passphraseIssue } from '../../crypto/passphrase';
import { vault } from '../../crypto/vault';
import { refreshAfterUnlock } from './wiring';

export type JoinDialogProps = {
  onDone: () => void;
  onClose: () => void;
};

export function JoinDialog({ onDone, onClose }: JoinDialogProps): JSX.Element {
  const [fileText, setFileText] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const policyIssue = passphrase === '' ? null : passphraseIssue(passphrase);

  const submit = async (): Promise<void> => {
    if (fileText === null) return;
    let raw: unknown;
    try {
      raw = JSON.parse(fileText);
    } catch {
      setError(t('crypto.lost.invalidCode'));
      return;
    }
    const parsed = parseKeyFile(raw);
    if (!parsed.ok) {
      setError(t('crypto.lost.invalidCode'));
      return;
    }
    setBusy(true);
    setError(null);
    const joined = await vault.joinWithKeyFile(parsed.value, passphrase);
    setBusy(false);
    if (!joined.ok) {
      setError(
        joined.error.code === 'WRONG_KEY_DOMAIN'
          ? t('crypto.lost.invalidCode')
          : joined.error.message,
      );
      return;
    }
    refreshAfterUnlock();
    onDone();
    onClose();
  };

  return (
    <Dialog
      title={t('crypto.join.title')}
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
            disabled={
              busy ||
              fileText === null ||
              policyIssue !== null ||
              passphrase !== confirm ||
              passphrase === ''
            }
            onClick={() => {
              void submit();
            }}
          >
            {t('crypto.join.submit')}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p>{t('crypto.join.desc')}</p>
        <label class="field">
          <span>{t('crypto.join.file')}</span>
          <input
            type="file"
            data-autofocus
            accept="application/json,.json"
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              if (file === undefined) return;
              void file
                .text()
                .then((text: string) => {
                  setFileText(text);
                })
                .catch(() => {
                  setError(t('crypto.lost.invalidCode'));
                });
            }}
          />
        </label>
        <label class="field">
          <span>{t('crypto.enable.passphrase')}</span>
          <input
            type="password"
            autoComplete="new-password"
            value={passphrase}
            onInput={(e) => {
              setPassphrase(e.currentTarget.value);
            }}
          />
        </label>
        <p class="field-note">{t('crypto.enable.passphraseHint')}</p>
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
        {error === null ? null : (
          <p class="field-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
