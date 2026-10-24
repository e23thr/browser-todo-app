/**
 * First-meaningful-use gate (§5.5, §3.1 step 4, §3.5 Flow E).
 *
 * PROJECT_ANALYSIS §5.5: "`navigator.storage.persist()` after first meaningful use (first task
 * created)". Onboarding deliberately does NOT request it — the request happens once, the first
 * time the user actually creates data, and the granted/denied result is what the persistence
 * row and the T2 banner report.
 *
 * The same moment runs the §3.5 ephemeral-storage heuristic and, when the profile looks like
 * private/incognito storage, opens the one-time T3 warning (`localStorage`-equivalent flag:
 * a `dismissedBanners` sentinel, ADR-002 Decision 7).
 *
 * INTEGRATION SEAM: the composer (E2/M1) calls `noteFirstMeaningfulWrite()` after every
 * successful task write. The gate inside is once-per-session and idempotent, so any write path
 * can call it without accounting for who ran first.
 *
 * That same seam is where the §3.4 prior-data mark (`markPriorData()`) is written: the first
 * successful task write is the earliest moment the profile has rows worth remembering, and this
 * is the only cross-feature entry point E3 owns for "a write happened" (every call re-arms the
 * mark, so a failed localStorage write self-heals on the next one).
 */

import { announce } from '../../app/announce';
import { t } from '../../i18n';
import { deriveBanners } from './derive';
import { markPriorData, markPrivateWarned, wasPrivateWarned } from './flags';
import { openDialog } from './notices';
import { dataSafetyState, patchState } from './state';
import { looksEphemeral, persistenceState, requestPersist } from './storageInfo';

let gateOpen = false;

/** Has this session already run the gate? (Tests read it; the gate itself is once-only.) */
export function isPersistGateOpen(): boolean {
  return gateOpen;
}

/** Test seam. */
export function resetPersistGate(): void {
  gateOpen = false;
}

/**
 * Run the first-use gate exactly once: request persistence, publish the result, then warn
 * once per profile when storage looks ephemeral. Never throws and never blocks the write that
 * triggered it.
 */
export async function noteFirstMeaningfulWrite(): Promise<void> {
  // The first task written IS the moment this profile demonstrably holds rows: record it in the
  // durable ADR-002 flags before anything else, so the §3.4 classifier can still tell "these rows
  // were lost" from "there never were any" if IndexedDB — the usual eviction victim — is what
  // disappears before the next boot. (Idempotent and try-guarded; never blocks the write.)
  markPriorData();

  if (gateOpen) return;
  gateOpen = true;

  try {
    const state = await requestPersist();
    announce(
      state === 'granted'
        ? t('dataSafety.persistence.announcedGranted')
        : state === 'unsupported'
          ? t('dataSafety.persistence.unsupported')
          : t('dataSafety.persistence.announcedDenied'),
    );
    deriveBanners();

    if (wasPrivateWarned() || state === 'granted' || state === 'unsupported') return;
    const ephemeral = await looksEphemeral();
    if (!ephemeral) return;

    markPrivateWarned();
    void openDialog({ kind: 'private-browsing' });
  } catch (error: unknown) {
    // The gate is best-effort: a broken StorageManager must never break the write path.
    console.warn('data-safety: first-use gate failed', error);
  } finally {
    deriveBanners();
  }
}

/** Diagnostic used by tests: has the profile been warned about private browsing? */
export function privateWarningState(): { warned: boolean; state: string } {
  return { warned: wasPrivateWarned(), state: persistenceState.value };
}

/**
 * "Ask again" / "Request protection" (§4.3) — announced politely (§4.4) and published so the
 * T2 "Keeping your data is limited" banner derives on or off.
 *
 * Lives here rather than in `actions.ts` on purpose: this module never imports the ADR-004
 * engine, so the banner host can call it without dragging the export/import code into the
 * initial JS closure (§9.2).
 */
export async function runRequestPersist(): Promise<void> {
  if (dataSafetyState.value.panelState !== 'idle') return;
  patchState({ panelState: 'persist-loading' });
  try {
    const state = await requestPersist();
    announce(
      state === 'granted'
        ? t('dataSafety.persistence.announcedGranted')
        : state === 'unsupported'
          ? t('dataSafety.persistence.unsupported')
          : t('dataSafety.persistence.announcedDenied'),
    );
    deriveBanners();
  } finally {
    patchState({ panelState: 'idle' });
  }
}
