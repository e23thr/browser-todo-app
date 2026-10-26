/**
 * The C1 settings section (ADR-007 Decisions 5/6/7/3.2): status + the action
 * row (enable wizard, Lock now / Unlock, turn off via the D6.2 confirmation
 * dialog, device join for a ciphertext-blocked store), live migration progress
 * with a reachable retry (Decision 7.1/7.2), and the idle re-lock interval
 * (5/15/30/60 — "never" is not offered, Decision 5.2). Passphrase change is a
 * LOST-PASSPHRASE flow only (recovery code + new passphrase — Decision 3.1):
 * there is deliberately no signed-in "change passphrase" action here.
 */

import type { JSX } from 'preact';
import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';

import { t } from '../../app/i18n';
import { resolveDataSafetyDb } from '../../portability';
import { downloadTextFile } from '../../portability/download';
import { lockState, LOCK_MINUTES_CHOICES } from '../../crypto/lock';
import { foreignCiphertext } from '../../crypto/foreignData';
import { vault } from '../../crypto/vault';
import { migrationRun } from '../../crypto/service';
import { keyFileName, newRecoveryMaterial, serializeKeyFile } from '../../crypto/recovery';
import type { AppDBImpl } from '../../storage/db';
import { EnableWizard } from './EnableWizard';
import { JoinDialog } from './JoinDialog';
import { TurnOffDialog } from './TurnOffDialog';
import { UnlockDialog } from './UnlockDialog';
import { refreshAfterUnlock, resumeMigrationFlow } from './wiring';

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
  const [turnOffOpen, setTurnOffOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [reissue, setReissue] = useState<{ code: string; keyFileText: string } | null>(null);
  const [issueBusy, setIssueBusy] = useState(false);
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
  const run = migrationRun.value;
  const blocked = foreignCiphertext.value;
  const recoverySaved =
    state !== null && state.keys.some((k) => k.slots.some((s) => s.kind === 'recovery'));

  // Decision 7.1 (review F1): a `migrating` store resumes automatically while
  // unlocked and the wizard is closed — until the sweep completes or pauses
  // (then the paused UI + Retry below own it; the flow is single-flight).
  useEffect(() => {
    if (db === null) return;
    if (wizardOpen || status !== 'migrating' || locked) return;
    void resumeMigrationFlow(db).then(bumpRevision);
  }, [db, wizardOpen, status, locked]);

  if (db === null) return null;

  const statusText =
    status === 'off'
      ? t('crypto.status.disabled')
      : status === 'migrating'
        ? t('crypto.status.migrating')
        : locked
          ? t('crypto.status.locked')
          : t('crypto.status.enabled');

  const issueRecovery = async (): Promise<void> => {
    setIssueBusy(true);
    setError(null);
    const material = await newRecoveryMaterial();
    const issued = await vault.issueRecoveryKey(material.secret, material.code);
    setIssueBusy(false);
    if (!issued.ok) {
      setError(issued.error.message);
      return;
    }
    setReissue({ code: material.code, keyFileText: serializeKeyFile(issued.value) });
    bumpRevision();
  };

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
      {/* Decision 3.3's blocked state (review F4): ciphertext this device's
          ring cannot open, with the join fix right next to it. */}
      {blocked && status !== 'migrating' ? (
        <p role="alert" data-testid="crypto-blocked">
          {t('crypto.blocked.body')}
        </p>
      ) : null}
      {/* Decision 7.1/7.2: live sweep progress + the paused retry (QUOTA keeps
          `migrating` — free space / export via the quota dialog, then retry). */}
      {status === 'migrating' && !locked ? (
        <div>
          {run.phase === 'running' || run.total > 0 ? (
            <p role="status">{t('crypto.enable.progress', { done: run.done, total: run.total })}</p>
          ) : null}
          {run.phase === 'paused' ? (
            <button
              type="button"
              class="button-secondary"
              data-testid="migration-retry"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(null);
                void resumeMigrationFlow(db, { onProgress: () => undefined }).then((r) => {
                  setBusy(false);
                  if (!r.ok) setError(r.error.message);
                  bumpRevision();
                });
              }}
            >
              {t('common.retry')}
            </button>
          ) : null}
        </div>
      ) : null}
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
        {/* Decision 3.2: the join entry point — fresh store, or adding another
            device's key to an unlocked ring (Decision 3.3's fix). */}
        {blocked && !locked && !wizardOpen ? (
          <button
            type="button"
            class="button-secondary"
            data-testid="crypto-join"
            onClick={() => {
              setJoinOpen(true);
            }}
          >
            {status === 'off' ? t('crypto.join.title') : t('crypto.join.addAnother')}
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
            data-testid="crypto-turn-off"
            onClick={() => {
              setTurnOffOpen(true);
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
      {recoverySaved ? <p class="field-note">{t('crypto.status.recoverySaved')}</p> : null}
      {/* Decision 3.1's offer, re-openable: a declined or never-delivered slot
          can always be (re)issued here — the code shows exactly once (review
          F1c's repair path; `issueRecoveryKey`'s production UI). */}
      {status === 'on' && !locked && !recoverySaved && reissue === null ? (
        <button
          type="button"
          class="button-quiet"
          data-testid="recovery-issue"
          disabled={issueBusy}
          onClick={() => {
            void issueRecovery();
          }}
        >
          {t('crypto.recovery.issue')}
        </button>
      ) : null}
      {reissue !== null ? (
        <div>
          <p>{t('crypto.enable.recoveryBody')}</p>
          <p data-testid="recovery-code">{reissue.code}</p>
          <button
            type="button"
            class="button-secondary"
            onClick={() => {
              downloadTextFile(keyFileName(now()), reissue.keyFileText);
            }}
          >
            {t('crypto.enable.downloadKeyFile')}
          </button>
          <button
            type="button"
            class="button-quiet"
            onClick={() => {
              setReissue(null);
            }}
          >
            {t('common.close')}
          </button>
        </div>
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
      {turnOffOpen ? (
        <TurnOffDialog
          db={db}
          now={now}
          onDone={bumpRevision}
          onClose={() => {
            setTurnOffOpen(false);
            bumpRevision();
          }}
        />
      ) : null}
      {joinOpen ? (
        <JoinDialog
          onDone={bumpRevision}
          onClose={() => {
            setJoinOpen(false);
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
