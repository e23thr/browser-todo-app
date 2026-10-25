/**
 * The shell's reaction to a wholesale data replacement (fix card t_85e19c39,
 * functional QA finding F1): one handler, two refreshes.
 *
 *  - `refreshAfterDataReplace()` — the tasks/lists store re-reads the restored
 *    rows and announces the bulk change so every other tab converges
 *    (ADR-003 Decision 8.1);
 *  - `reloadSettings()` — the settings store re-reads the imported record and
 *    paints its theme immediately (design §8.3 erratum).
 *
 * The engine fires this from its post-commit side effects (ADR-004 Decision 3),
 * so EVERY replacement path is covered — the Settings import flow, the UndoToast
 * restore, direct engine callers and the "Delete all data" wipe. Registered once
 * at composition (`main.tsx`, or the test that plays that role); both refreshes
 * are fire-and-forget and can never fail the replacement that already committed.
 */

import { onDataReplaced } from '../portability/side-effects';
import { refreshAfterDataReplace } from '../features/tasks/store';
import { reloadSettings } from './settings';

/** Register the refresh handler; returns the disposer (tests). */
export function wireDataReplacedRefresh(): () => void {
  return onDataReplaced(() => {
    void refreshAfterDataReplace().catch((error: unknown) => {
      console.warn('data-replaced: store refresh failed', error);
    });
    void reloadSettings().catch((error: unknown) => {
      console.warn('data-replaced: settings refresh failed', error);
    });
  });
}
