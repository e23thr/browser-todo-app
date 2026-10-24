/**
 * Recovery screen (design §6.5, S5) — "We couldn't find your tasks".
 *
 * Shown when boot classified the profile as WIPED: the store is empty but this profile has
 * demonstrably used the app before (§3.4). It names what happened (including the iOS 7-day
 * rule), surfaces `lastBackupAt` — mandatory per §6.5 — and offers exactly two paths, with
 * NOTHING created behind the user's back (§3.4 "Nothing is auto-created before the user
 * chooses").
 *
 * "Start fresh" confirms inline (one line, §6.5) and then acknowledges the wipe so the same
 * store instance does not re-nag on every later boot (`flags.markRecoveryStarted`).
 */

import { useState } from 'preact/hooks';
import type { JSX } from 'preact';

import { t } from '../../i18n';
import { absoluteDate, backupAgeDays } from './format';

export interface RecoveryScreenProps {
  readonly lastBackupAt: number | null;
  readonly onRestore: () => void;
  readonly onStartFresh: () => void;
  readonly now?: number;
}

export function RecoveryScreen({
  lastBackupAt,
  onRestore,
  onStartFresh,
  now = Date.now(),
}: RecoveryScreenProps): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const age = backupAgeDays(lastBackupAt, now);

  return (
    <main class="recovery" data-state={age === null ? 'never-backup' : 'has-backup'}>
      <p class="recovery-eyebrow">{t('dataSafety.recovery.eyebrow')}</p>
      <h1 class="recovery-title" data-view-title="" tabIndex={-1}>
        {t('dataSafety.recovery.h1')}
      </h1>
      <p class="recovery-body">{t('dataSafety.recovery.body', { appName: t('app.name') })}</p>
      <p class="recovery-backup">
        {lastBackupAt === null
          ? t('dataSafety.recovery.neverBackup')
          : // N3: the N-day line must not render "1 days ago" (or "0 days ago") — the
            // Today/Yesterday family of §11 has its own entries for those.
            age === 0
            ? t('dataSafety.recovery.lastBackupToday', { date: absoluteDate(lastBackupAt) })
            : age === 1
              ? t('dataSafety.recovery.lastBackupOne', { date: absoluteDate(lastBackupAt) })
              : t('dataSafety.recovery.lastBackup', {
                  N: age ?? 0,
                  date: absoluteDate(lastBackupAt),
                })}
      </p>

      <div class="recovery-actions">
        <button type="button" class="button button-primary" onClick={onRestore}>
          {t('dataSafety.recovery.restore')}
        </button>
        {confirming ? (
          <div
            class="recovery-confirm"
            role="group"
            aria-label={t('dataSafety.recovery.startFresh')}
          >
            <p class="recovery-confirm-body">{t('dataSafety.recovery.startFreshConfirm')}</p>
            <button type="button" class="button button-secondary" onClick={onStartFresh}>
              {t('dataSafety.recovery.startFresh')}
            </button>
            <button
              type="button"
              class="button button-secondary"
              onClick={() => {
                setConfirming(false);
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
        ) : (
          <button
            type="button"
            class="button button-secondary"
            onClick={() => {
              setConfirming(true);
            }}
          >
            {t('dataSafety.recovery.startFresh')}
          </button>
        )}
      </div>
    </main>
  );
}
