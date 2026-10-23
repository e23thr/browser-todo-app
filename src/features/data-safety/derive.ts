/**
 * Notice derivation (§2 escalation, §3.2–§3.5) — pure "state → banner candidates" mapping.
 *
 * The host calls this inside a `useEffect` keyed on every signal it reads, so the banner set
 * always tracks: the boot classification, the quota estimate, the persistence grant and the
 * pending-write queue. Candidate presence ≠ visibility: `visibleBanners()` still applies the
 * durable snoozes and the two-banner cap.
 */

import { backupAgeDays, percentOf } from './format';
import { setBanner } from './notices';
import { pendingWrites } from './pendingWrites';
import { dataSafetyState } from './state';
import { BACKUP_NUDGE_DAYS, QUOTA_WARN_RATIO } from './constants';
import { persistenceState, quotaState } from './storageInfo';

/** Recompute every banner candidate for `now` (epoch ms). Idempotent. */
export function deriveBanners(now: number = Date.now()): void {
  const state = dataSafetyState.value;
  const ready = state.status === 'ready';
  const classification = state.classification;

  // S5 — long absence (T1) carries the lastBackupAt the §6.6 copy promises.
  setBanner(
    'long-absence',
    ready && classification.kind === 'long-absence'
      ? {
          N: classification.absentDays,
          lastBackupAt: classification.lastBackupAt ?? 0,
        }
      : null,
  );

  // S5 — shrunken (T2).
  setBanner(
    'shrunken',
    ready && classification.kind === 'shrunken'
      ? { pct: Math.round(classification.dropped * 100) }
      : null,
  );

  // S3 — backup discipline (T1): data exists and the last backup is >= 14 days old or never.
  const age = backupAgeDays(state.lastBackupAt, now);
  const backupDue = ready && state.hasData && (age === null || age >= BACKUP_NUDGE_DAYS);
  setBanner('backup-reminder', backupDue ? { N: age ?? 0, never: age === null ? 1 : 0 } : null);

  // Quota pressure (T2): >= 80% of a reported total (§4.3 tier threshold).
  const quota = quotaState.value;
  const used = percentOf(quota.usedBytes, quota.totalBytes);
  const quotaFull = quota.supported && used !== null && used >= QUOTA_WARN_RATIO * 100;
  setBanner('quota-warn', quotaFull ? { pct: used } : null);

  // Persistence denied (T2).
  setBanner('persist-denied', ready && persistenceState.value === 'denied' ? {} : null);

  // S4 context (T2): writes are queued, not dropped (§6.4 Escape → persistent banner).
  const pending = pendingWrites.value.length;
  setBanner('quota-pending', pending > 0 ? { N: pending } : null);
}
