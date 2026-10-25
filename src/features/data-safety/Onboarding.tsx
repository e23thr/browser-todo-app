/**
 * First-run onboarding (design §6.1, S1, T0) — "Your data lives in this browser".
 *
 * Honesty rules (§1.2): the copy names the iOS Safari 7-day eviction rule outright and does not
 * soften the risk. Since V1 (ADR-008, S13) it presents HOME-SCREEN INSTALL as the durable
 * storage option — installed apps are exempt from that 7-day rule — while the backup discipline
 * and `persist()` story stay (belt and braces, PROJECT_ANALYSIS §5.5). The screen replaces the
 * shell entirely ("before any task UI"), so there is no background content to trap focus away
 * from.
 *
 * `navigator.storage.persist()` is deliberately NOT requested here (§3.1 step 4): the first
 * meaningful use — the first task created — is what triggers it.
 */

import type { JSX } from 'preact';

import { t } from '../../i18n';

export interface OnboardingProps {
  readonly onDone: () => void;
}

export function Onboarding({ onDone }: OnboardingProps): JSX.Element {
  return (
    <main class="onboarding" data-surface="onboarding">
      <p class="onboarding-eyebrow">{t('dataSafety.onboarding.eyebrow')}</p>
      <h1 class="onboarding-title" data-view-title="" tabIndex={-1}>
        {t('dataSafety.onboarding.h1')}
      </h1>
      <p class="onboarding-body">{t('dataSafety.onboarding.body1', { appName: t('app.name') })}</p>
      <p class="onboarding-body onboarding-fact">{t('dataSafety.onboarding.body2')}</p>
      <p class="onboarding-body">{t('dataSafety.onboarding.body3', { appName: t('app.name') })}</p>
      <p class="onboarding-body">{t('dataSafety.onboarding.body4')}</p>

      <details class="onboarding-details">
        <summary>{t('dataSafety.onboarding.howTitle')}</summary>
        <p>{t('dataSafety.onboarding.howBody')}</p>
      </details>

      <div class="onboarding-actions">
        <button type="button" class="button button-primary" onClick={onDone}>
          {t('dataSafety.onboarding.cta')}
        </button>
      </div>

      <p class="onboarding-footer">{t('dataSafety.onboarding.footer')}</p>
    </main>
  );
}
