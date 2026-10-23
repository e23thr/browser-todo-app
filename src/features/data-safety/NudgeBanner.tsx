/**
 * `<NudgeBanner>` (design §5.5) — every T1/T2 banner in the §2 hierarchy.
 *
 * One component, six kinds: backup reminder, quota pressure, pending (unsaved) writes,
 * persistence denied, long absence and shrunken data. Colour is never the only signal — each
 * banner carries a tier label ("Worth a look") plus an icon (§2, WCAG 1.4.1), and the whole
 * banner is a `role="status"` region so assistive tech hears it without a focus jump.
 *
 * Deviation, documented for review: §5.5's `BannerKind` union omits `'quota-pending'`, which
 * §6.4 requires as the persistent banner left behind after the quota dialog is dismissed —
 * the union here is the superset the copy sections need.
 */

import type { JSX } from 'preact';

import { Icon } from '../../app/icons';
import { t } from '../../i18n';
import { SNOOZE_DAYS } from './constants';

export type BannerKind =
  | 'backup-reminder'
  | 'quota-warn'
  | 'quota-pending'
  | 'persist-denied'
  | 'long-absence'
  | 'shrunken';

export interface BannerAction {
  readonly id: string;
  readonly label: string;
  readonly variant: 'primary' | 'secondary' | 'link';
}

export interface NudgeBannerProps {
  readonly kind: BannerKind;
  readonly tier: 1 | 2;
  readonly title: string;
  readonly body: string;
  readonly actions: readonly BannerAction[];
  readonly onAction: (id: string) => void;
  /** Banner close = snooze(7) (§5.5). */
  readonly onSnooze: (days: number) => void;
  /** §2 overflow: hidden notices behind the "N more notices" control. */
  readonly moreCount?: number | undefined;
  readonly onShowAll?: (() => void) | undefined;
  /** Accessible name for the close button (a plain "Close" hides the 7-day consequence). */
  readonly closeLabel?: string | undefined;
}

const ICONS: Readonly<Record<BannerKind, 'info' | 'alert-triangle' | 'alert-circle'>> = {
  'backup-reminder': 'info',
  'quota-warn': 'alert-triangle',
  'quota-pending': 'alert-circle',
  'persist-denied': 'alert-triangle',
  'long-absence': 'info',
  shrunken: 'alert-triangle',
};

export function NudgeBanner({
  kind,
  tier,
  title,
  body,
  actions,
  onAction,
  onSnooze,
  moreCount = 0,
  onShowAll,
  closeLabel,
}: NudgeBannerProps): JSX.Element {
  return (
    <section class="nudge-banner" data-kind={kind} data-tier={tier} role="status">
      <span class="nudge-tier">
        <Icon name={ICONS[kind]} size={16} />
        {t('dataSafety.tier.nudge')}
      </span>
      <div class="nudge-content">
        <p class="nudge-title">{title}</p>
        <p class="nudge-body">{body}</p>
        <div class="nudge-actions">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              class={`button button-${action.variant === 'primary' ? 'primary' : 'secondary'}`}
              onClick={() => {
                onAction(action.id);
              }}
            >
              {action.label}
            </button>
          ))}
          {moreCount > 0 && onShowAll !== undefined ? (
            <button type="button" class="button button-link" onClick={onShowAll}>
              {t('dataSafety.banner.more', { N: moreCount })}
            </button>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        class="icon-button nudge-close"
        aria-label={closeLabel ?? t('dataSafety.banner.close')}
        onClick={() => {
          onSnooze(SNOOZE_DAYS);
        }}
      >
        <Icon name="x" size={18} />
      </button>
    </section>
  );
}
