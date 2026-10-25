/**
 * Sync panel (E8 S9) — the whole sync UI surface, mounted at Settings'
 * `data-mount-point="sync"`:
 *
 *  - NOT configured → the opt-in setup wizard (nothing leaves the device first);
 *  - configured → the status surface over the engine's four states
 *    (idle / syncing / error / conflicts-pending, verbatim ADR-006 D9.2):
 *    last-synced line, "Sync now", the periodic-when-online toggle, forget
 *    credentials, error copy per Decision 6, conflict copies with their resolve
 *    actions, and the run's notices ("never silent").
 *
 * Announcements go through `announce()` (polite for progress/outcomes,
 * assertive for failures) — the shell owns the live regions.
 *
 * Sync failure never disturbs local use: this panel only ever READS engine
 * state and calls engine/store APIs; it holds no task data of its own.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';

import { announce } from '../../app/announce';
import { t } from '../../app/i18n';
import type { ConflictSummary, SyncState } from '../../sync';
import { absoluteDateTime } from '../data-safety/format';
import { ConflictList } from './ConflictList';
import {
  applyResolveAction,
  markConflictResolved,
  resetResolvedConflicts,
  unresolvedConflicts,
  type ResolveAction,
} from './conflicts';
import { syncErrorCopy, syncErrorTitle } from './errorCopy';
import { SetupWizard } from './SetupWizard';
import { SyncErrorBox } from './SyncErrorBox';
import {
  bootSyncEngine,
  readSyncConfig,
  syncEngine,
  syncEngineEpoch,
  type SyncHostEngine,
} from './syncHost';

function lastSyncLine(at: number | null): string {
  return at === null
    ? t('sync.status.never')
    : t('sync.status.lastSync', { time: absoluteDateTime(at) });
}

function statusLine(state: SyncState): string {
  switch (state.status) {
    case 'syncing':
      return t('sync.status.syncing', { phase: t(`sync.phase.${state.phase}`) });
    case 'idle':
      return lastSyncLine(state.lastSyncAt);
    case 'error':
      return lastSyncLine(state.lastSyncAt);
    case 'conflicts-pending':
      return lastSyncLine(state.lastSyncAt);
  }
}

export function SyncPanel(): JSX.Element {
  const epoch = syncEngineEpoch.value;
  const engine: SyncHostEngine | null = syncEngine();
  const [setupActive, setSetupActive] = useState(false);
  const [prefill, setPrefill] = useState<{ remoteUrl: string; remoteUser: string } | undefined>(
    undefined,
  );
  // The four-state union only carries `autoSync` in `idle`; the toggle keeps
  // the last known value across syncing/error/conflicts renders.
  const [autoSync, setAutoSync] = useState(true);
  const previousStatus = useRef<string | null>(null);

  // Late storage binding: retry once the host has an engine (epoch) or on mount.
  useEffect(() => {
    if (syncEngine() === null) void bootSyncEngine();
  }, [epoch]);

  const state: SyncState | null = engine === null ? null : engine.state().value;

  // Keep the toggle in step with the engine while the state knows the answer.
  useEffect(() => {
    if (state !== null && state.status === 'idle') setAutoSync(state.autoSync);
  }, [state]);

  // Outcome announcements on state transitions (never on first paint).
  useEffect(() => {
    if (engine === null || state === null) return;
    const key = state.status === 'error' ? `error:${state.error.code}` : state.status;
    if (previousStatus.current === null) {
      previousStatus.current = key;
      return;
    }
    if (previousStatus.current === key) return;
    const previous = previousStatus.current;
    previousStatus.current = key;
    if (state.status === 'syncing') {
      announce(t('a11y.sync.started'));
      return;
    }
    if (state.status === 'error') {
      announce(t('a11y.sync.failed', { message: syncErrorTitle(state.error.code) }), 'assertive');
      return;
    }
    if (previous === 'syncing') {
      announce(
        state.status === 'conflicts-pending'
          ? t('a11y.sync.doneConflicts', { count: state.conflicts.length })
          : t('a11y.sync.done'),
      );
    }
  }, [engine, state]);

  if (engine === null || state === null) {
    return (
      <div class="sync-panel" data-testid="sync-panel">
        <p class="sync-intro" data-testid="sync-unavailable">
          {t('sync.unavailable')}
        </p>
      </div>
    );
  }

  const unconfigured = state.status === 'idle' && !state.configured;
  const introLine = unconfigured ? t('sync.intro.off') : t('sync.intro.on');

  if (unconfigured || setupActive) {
    return (
      <div class="sync-panel" data-testid="sync-panel">
        <p class="sync-intro">{introLine}</p>
        <SetupWizard
          engine={engine}
          {...(prefill === undefined ? {} : { initial: prefill })}
          onStart={() => {
            setSetupActive(true);
          }}
          onEnd={() => {
            setSetupActive(false);
          }}
        />
      </div>
    );
  }

  const busy = state.status === 'syncing';
  const errorCopy = state.status === 'error' ? syncErrorCopy(state.error) : null;
  const retryHint =
    state.status === 'error'
      ? state.retryAt === null
        ? t('sync.error.manual')
        : t('sync.error.retryAt', { time: absoluteDateTime(state.retryAt) })
      : null;
  const visibleConflicts =
    state.status === 'conflicts-pending' ? unresolvedConflicts(state.conflicts) : [];
  const notices =
    state.status === 'idle'
      ? (state.lastRun?.notices ?? [])
      : state.status === 'conflicts-pending'
        ? state.lastRun.notices
        : [];

  const openSetup = (): void => {
    void (async () => {
      // Prefill BEFORE forgetting: the wizard mounts the moment the state
      // flips back to unconfigured, and its fields read `initial` on mount.
      const config = await readSyncConfig();
      if (config !== null) setPrefill(config);
      await engine.forgetCredentials();
    })();
  };

  const forget = (): void => {
    void engine.forgetCredentials().then((result) => {
      if (result.ok) {
        setPrefill(undefined);
        announce(t('a11y.sync.forgotten'));
      } else {
        announce(
          t('a11y.sync.failed', { message: syncErrorTitle(result.error.code) }),
          'assertive',
        );
      }
    });
  };

  const onResolve = (summary: ConflictSummary, action: ResolveAction): void => {
    void applyResolveAction(summary, action).then((result) => {
      if (!result.ok) {
        announce(t('a11y.sync.resolveFailed'), 'assertive');
        return;
      }
      announce(t('a11y.sync.resolved', { title: summary.title }));
      markConflictResolved(summary.copyId);
      const remaining =
        state.status === 'conflicts-pending' ? unresolvedConflicts(state.conflicts) : [];
      if (remaining.length === 0) {
        // Every copy handled → clear the engine's sticky state (its only path).
        engine.acknowledgeConflicts();
        resetResolvedConflicts();
      }
    });
  };

  return (
    <div class="sync-panel" data-testid="sync-panel">
      <p class="sync-intro">{introLine}</p>
      <p class="sync-status-line" data-testid="sync-status-line">
        {statusLine(state)}
      </p>

      {errorCopy === null ? null : (
        <SyncErrorBox
          testId="sync-error"
          title={errorCopy.title}
          body={errorCopy.body}
          {...(errorCopy.detail === undefined ? {} : { detail: errorCopy.detail })}
          {...(retryHint === null ? {} : { hint: retryHint })}
        >
          {state.status === 'error' &&
          (state.error.code === 'AUTH' || state.error.code === 'CONFIG') ? (
            <button type="button" class="button button-secondary" onClick={openSetup}>
              {t('sync.enterCredentials')}
            </button>
          ) : null}
        </SyncErrorBox>
      )}

      <div class="sync-actions">
        <button
          type="button"
          class="button button-primary"
          disabled={busy}
          onClick={() => {
            void engine.runSync('manual');
          }}
        >
          {t('sync.now')}
        </button>
        <label class="checkbox-row" for="sync-auto">
          <input
            id="sync-auto"
            type="checkbox"
            checked={autoSync}
            onChange={(event) => {
              const next = event.currentTarget.checked;
              setAutoSync(next);
              engine.setAutoSync(next);
            }}
          />
          <span>{t('sync.autoSync.label')}</span>
        </label>
        <button type="button" class="button button-ghost" disabled={busy} onClick={forget}>
          {t('sync.forget')}
        </button>
      </div>
      <p class="field-hint">{t('sync.autoSync.hint')}</p>
      <p class="field-hint">{t('sync.forget.hint')}</p>

      {state.status === 'conflicts-pending' ? (
        <ConflictList conflicts={visibleConflicts} onResolve={onResolve} />
      ) : null}

      {notices.length === 0 ? null : (
        <section
          class="sync-notices"
          data-testid="sync-notices"
          aria-labelledby="sync-notices-heading"
        >
          <h3 class="sync-notices-heading" id="sync-notices-heading">
            {t('sync.notices.heading')}
          </h3>
          <ul class="sync-notice-list">
            {notices.map((notice) => (
              <li key={`${notice.kind}:${notice.recordId}`}>
                {notice.kind === 'list-conflict'
                  ? t('sync.notices.listConflict', { title: notice.title })
                  : t('sync.notices.deleteLost', { title: notice.title })}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
