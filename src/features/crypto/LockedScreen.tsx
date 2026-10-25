/**
 * The dedicated locked screen (ADR-007 Decision 4.3) — NOT blurred lists:
 * partial rendering of structural fields invites inference and complicates
 * a11y. Unlock action + storage/sync status only.
 */

import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

import { t } from '../../app/i18n';
import { vault } from '../../crypto/vault';
import { refreshAfterUnlock } from './wiring';
import { UnlockDialog } from './UnlockDialog';

export function LockedScreen(): JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const unlock = async (passphrase: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    const result = await vault.unlockWithPassphrase(passphrase);
    setBusy(false);
    if (!result.ok) {
      setError(t('crypto.unlock.failed'));
      return false;
    }
    refreshAfterUnlock();
    setDialogOpen(false);
    return true;
  };

  return (
    <main class="locked-screen" data-testid="locked-screen">
      <h1>{t('crypto.locked.title')}</h1>
      <p>{t('crypto.locked.body')}</p>
      <button
        type="button"
        class="button-primary"
        data-autofocus
        onClick={() => {
          setDialogOpen(true);
        }}
      >
        {t('crypto.action.unlock')}
      </button>
      {dialogOpen ? (
        <UnlockDialog
          busy={busy}
          error={error}
          onUnlock={unlock}
          onClose={() => {
            setDialogOpen(false);
          }}
        />
      ) : null}
    </main>
  );
}
