/**
 * Service-worker boot wiring (ADR-005 Decisions 5, 7, 8).
 *
 * - registration EXACTLY per Decision 8: `${BASE_URL}sw.js`, scope `${BASE_URL}`,
 *   `updateViaCache: 'none'` — `BASE_URL` is Vite's `base` (local `/`, GitHub Pages
 *   `/<repo>/`), which is what makes the scope correct under the configurable base path.
 * - the update state machine is wired to the registration; checks run on load, on
 *   `visibilitychange` -> visible and on `online`, throttled and never while offline
 *   (Decision 5 rule 1). Failed checks are silent (Decision 6).
 * - the update notice mounts into its OWN container (no app-shell coupling), and the
 *   conservative edit guard starts (Decision 7 / E9).
 * - `performance.mark('app:interactive')` is recorded here so the E2E suite can measure
 *   warm/offline start-to-interactive against the §9.1 300 ms budget.
 */

import { render } from 'preact';

import { UpdateNotice } from '../components/UpdateNotice';
import { checkForUpdate, initUpdateFlow, startEditGuard } from './update';

/** Name of the performance mark the §9.1 boot budget is measured against. */
export const INTERACTIVE_MARK = 'app:interactive';

function mountUpdateNotice(): void {
  const container = document.createElement('div');
  container.id = 'update-notice-root';
  document.body.appendChild(container);
  render(<UpdateNotice />, container);
}

function wireCheckTriggers(): () => void {
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') void checkForUpdate();
  };
  const onOnline = (): void => {
    void checkForUpdate({ force: true });
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);
  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', onOnline);
  };
}

/**
 * Register the service worker and start the update flow. Call once, after the app has rendered.
 * Everything degrades silently when service workers are unsupported (§9.4 feature detection) —
 * offline is a bonus, never a requirement for the app to work.
 */
export function bootServiceWorker(): void {
  performance.mark(INTERACTIVE_MARK);
  startEditGuard();
  mountUpdateNotice();

  if (!('serviceWorker' in navigator)) return;
  const container = navigator.serviceWorker;
  const disposeTriggers = wireCheckTriggers();
  void container
    .register(`${import.meta.env.BASE_URL}sw.js`, {
      scope: import.meta.env.BASE_URL,
      updateViaCache: 'none',
    })
    .then((registration) => {
      initUpdateFlow({
        registration,
        controller: container.controller !== null,
      });
      // First check on load; throttled like every other trigger (Decision 5 rule 1).
      void checkForUpdate({ force: true });
    })
    .catch((error: unknown) => {
      // Silent by design (Decision 6): local log only, never telemetry, never UI.
      console.warn('sw: registration failed', error);
      disposeTriggers();
    });
}
