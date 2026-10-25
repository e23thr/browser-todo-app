/**
 * Install-prompt surface (ADR-008 Decision 3, S13). Two faces, one component:
 *
 *   - `prompt` (Chromium/Android): title + why-copy + [Install] [No thanks]
 *   - `manual` (iOS Safari): the Share-sheet "Add to Home Screen" steps + [Got it]
 *
 * Accessibility (WCAG 2.2 AA, binding): the notice owns a polite live region and announces
 * itself without stealing focus (same contract as the ADR-005 update toast); actions are real
 * buttons with ≥ 44 px targets (install.css); nothing auto-dismisses, so the copy is readable
 * at any pace; dismissal is one explicit action and is remembered forever (Decision 3).
 * Nothing renders at all where install is unsupported — no dead UI (§9.4).
 */

import { render } from 'preact';
import type { JSX } from 'preact';

import { t } from '../../i18n';
import { dismissInstall, installSurface, promptInstall } from './installPrompt';
import '../../styles/install.css';

/** The notice face — exported for component tests; production mounts via `mountInstallNotice`. */
export function InstallNotice(): JSX.Element | null {
  const surface = installSurface.value;
  if (surface === 'none') return null;

  const appName = t('app.name');

  return (
    <div class="install-notice-stack" data-install-notice="">
      <section class="install-notice" role="status" aria-live="polite">
        <p class="install-notice-title">
          {surface === 'prompt'
            ? t('install.title.prompt', { appName })
            : t('install.title.manual', { appName })}
        </p>
        <p class="install-notice-body">
          {surface === 'prompt' ? t('install.body.prompt', { appName }) : t('install.body.manual')}
        </p>
        {surface === 'manual' ? (
          <ol class="install-notice-steps">
            <li>{t('install.manual.step1')}</li>
            <li>{t('install.manual.step2')}</li>
          </ol>
        ) : null}
        <div class="install-notice-actions">
          {surface === 'prompt' ? (
            <>
              <button
                type="button"
                class="install-action install-action-primary"
                onClick={() => {
                  void promptInstall();
                }}
              >
                {t('install.action.install')}
              </button>
              <button type="button" class="install-action" onClick={dismissInstall}>
                {t('install.action.dismiss')}
              </button>
            </>
          ) : (
            <button type="button" class="install-action" onClick={dismissInstall}>
              {t('install.action.gotIt')}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

/**
 * Mount the notice into its own body-level container (no app-shell coupling, like the update
 * toast). Call once at boot, after the first render.
 */
export function mountInstallNotice(): void {
  const container = document.createElement('div');
  container.id = 'install-notice-root';
  document.body.appendChild(container);
  render(<InstallNotice />, container);
}
