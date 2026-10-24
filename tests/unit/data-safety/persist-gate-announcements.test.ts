/**
 * M13-B1 / E2 F-1 — the first-write persistence notice must never swallow the capture
 * confirmation (WCAG 2.2 SC 4.1.3, design §5.5 + §8 "live-region announcements").
 *
 * `store.addTask()` fires E3's `noteFirstMeaningfulWrite()` in the SAME tick that the
 * composer announces `a11y.taskAdded`, so the notice's `announce()` lands inside the 60 ms
 * announce window of the capture message. Under plain `announce()` the newer message
 * supersedes the pending one and the first capture of a session announces nothing at all —
 * exactly the gate's B1 finding (docs/qa/a11y-gate.md §2-B1).
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  ANNOUNCE_DELAY_MS,
  announce,
  DEFERRED_ANNOUNCE_DELAY_MS,
  registerLiveRegions,
} from '../../../src/app/announce';
import { t } from '../../../src/app/i18n';
import {
  noteFirstMeaningfulWrite,
  resetPersistGate,
} from '../../../src/features/data-safety/persistGate';

function mountRegions(): { polite: HTMLElement; dispose: () => void } {
  const polite = document.createElement('div');
  const assertive = document.createElement('div');
  document.body.append(polite, assertive);
  const dispose = registerLiveRegions({ polite, assertive });
  return { polite, dispose };
}

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Whatever the browser reports about `persist()`, the notice is one of these three. */
const persistenceNotices = (): string[] => [
  t('dataSafety.persistence.announcedGranted'),
  t('dataSafety.persistence.announcedDenied'),
  t('dataSafety.persistence.unsupported'),
];

afterEach(() => {
  document.body.replaceChildren();
  registerLiveRegions({ polite: null, assertive: null });
  resetPersistGate();
});

describe('first-write persistence notice vs the capture announcement (§5.5 / §8)', () => {
  it('does not supersede a task-add announcement still inside the 60 ms window', async () => {
    const { polite, dispose } = mountRegions();
    resetPersistGate();

    // 1. Composer: Enter → addTask resolves → `announce(a11y.taskAdded)` is scheduled.
    announce(t('a11y.taskAdded', { title: 'Buy milk' }));
    // 2. store.addTask() → E3's once-per-session gate in the same tick.
    await noteFirstMeaningfulWrite();

    // The capture confirmation survives the notice: it is what the region says first.
    await tick(DEFERRED_ANNOUNCE_DELAY_MS - ANNOUNCE_DELAY_MS);
    expect(polite.textContent).toBe('Task added: Buy milk');

    // …and the persistence notice still reaches the user, afterwards rather than instead.
    await tick(DEFERRED_ANNOUNCE_DELAY_MS + ANNOUNCE_DELAY_MS);
    expect(persistenceNotices()).toContain(polite.textContent);

    dispose();
  });
});
