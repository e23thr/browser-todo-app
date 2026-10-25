/**
 * The C1 settings section (ADR-007 Decisions 5/6): status + the action row
 * (enable wizard, Lock now / Unlock, change passphrase, turn off), and the
 * idle re-lock interval (5/15/30/60 — "never" is not offered, Decision 5.2).
 */

import type { JSX } from 'preact';
import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';

import { t } from '../../app/i18n';
import { resolveDataSafetyDb } from '../../portability';
import { lockState, LOCK_MINUTES_CHOICES } from '../../crypto/lock';
import { vault } from '../../crypto/vault';
import { disableEncryption } from '../../crypto/service';
import type { AppDBImpl } from '../../storage/db';
import { EnableWizard } from './EnableWizard';
import { UnlockDialog } from './UnlockDialog';
import { refreshAfterUnlock } from './wiring';

/** Re-render trigger after vault state mutations (enable/disable complete). */
const revision = signal(0);
function bumpRevision(): void {
  revision.value += 1;
}

export type CryptoSectionProps = {
  /** Resolved from the data-safety binding when omitted (the app default). */
  db?: AppDBImpl;
  now?: () => number;
};

export function CryptoSection({
  db: dbOverride,
  now: nowOverride,
}: CryptoSectionProps = {}): JSX.Element | null {
  // Read the signal to re-render on any crypto state change (house signal
  // subscription pattern) — the epoch also tags the section for QA probes.
  const epoch = revision.value;
  const [wizardOpen, setWizardOpen] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncConfigured, setSyncConfigured] = useState(false);
  const bound = resolveDataSafetyDb();
  const db = dbOverride ?? (bound.ok ? bound.value : null);
  const now = nowOverride ?? Date.now;

  useEffect(() => {
    if (db === null) return;
    void db.get('sync_state', 'sync').then((row) => {
      if (row.ok && row.value !== undefined && row.value.enabled) setSyncConfigured(true);
    });
  }, [db]);

  const state = vault.state;
  const status = vault.status;
  const locked = lockState.value.status === 'locked';
  if (db === null) return null;

  const statusText =
    status === 'off'
      ? t('crypto.status.disabled')
      : status === 'migrating'
        ? t('crypto.status.migrating')
        : locked
          ? t('crypto.status.locked')
          : t('crypto.status.enabled');

  return (
    <section class="settings-section" aria-labelledby="crypto-heading" data-state-epoch={epoch}>
      <h2 id="crypto-heading">{t('crypto.section.title')}</h2>
      <p>{t('crypto.section.desc')}</p>
      <p role="status" data-testid="crypto-status">
        {statusText}
      </p>
      {error === null ? null : (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
      <div class="button-row">
        {status === 'off' ? (
          <button
            type="button"
            class="button-primary"
            onClick={() => {
              setWizardOpen(true);
            }}
          >
            {t('crypto.action.enable')}
          </button>
        ) : null}
        {status !== 'off' && !locked ? (
          <button
            type="button"
            class="button-secondary"
            onClick={() => {
              vault.lockNow();
              bumpRevision();
            }}
          >
            {t('crypto.action.lockNow')}
          </button>
        ) : null}
        {locked ? (
          <button
            type="button"
            class="button-primary"
            onClick={() => {
              setUnlockOpen(true);
            }}
          >
            {t('crypto.action.unlock')}
          </button>
        ) : null}
        {status === 'on' && !locked ? (
          <button
            type="button"
            class="button-quiet"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void disableEncryption({ db, vault, passphrase: '', now }).then((r) => {
                setBusy(false);
                if (!r.ok) setError(r.error.message);
                bumpRevision();
              });
            }}
          >
            {t('crypto.action.turnOff')}
          </button>
        ) : null}
      </div>
      {status !== 'off' ? (
        <label class="field">
          <span>{t('crypto.autoLock.label')}</span>
          <select
            value={String(vault.lockAfterMinutes)}
            onChange={(e) => {
              const minutes = Number(e.currentTarget.value);
              void vault.saveState({ lockAfterMinutes: minutes }).then(bumpRevision);
            }}
          >
            {LOCK_MINUTES_CHOICES.map((m) => (
              <option value={String(m)} key={m}>
                {t('crypto.autoLock.minutes', { minutes: m })}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {state !== null &&
      state.status === 'on' &&
      state.keys.some((k) => k.slots.some((s) => s.kind === 'recovery')) ? (
        <p class="field-note">{t('crypto.status.recoverySaved')}</p>
      ) : null}
      {wizardOpen ? (
        <EnableWizard
          db={db}
          now={now}
          syncConfigured={syncConfigured}
          onDone={bumpRevision}
          onClose={() => {
            setWizardOpen(false);
            bumpRevision();
          }}
        />
      ) : null}
      {unlockOpen ? (
        <UnlockDialog
          busy={busy}
          error={error}
          onUnlock={async (passphrase) => {
            setBusy(true);
            const result = await vault.unlockWithPassphrase(passphrase);
            setBusy(false);
            if (!result.ok) {
              setError(t('crypto.unlock.failed'));
              return false;
            }
            refreshAfterUnlock();
            setUnlockOpen(false);
            bumpRevision();
            return true;
          }}
          onClose={() => {
            setUnlockOpen(false);
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * The 60-second pre-lock toast lives in `./PreLockToast` (a lock-signal-only
 * module) so the app shell never pulls the crypto core into its closure.
 */
export { PreLockToast } from './PreLockToast';
