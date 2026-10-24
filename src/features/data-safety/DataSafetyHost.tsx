/**
 * `<DataSafetyHost>` — the runtime half of the surface: banners (T1/T2), the T3 dialog queue
 * and the T4 toasts (§2, §5.5/§5.6/§5.8).
 *
 * It renders inside the shell's `<main>`, so banners land in the §2 slot (under the app
 * header, above content) and the fixed-position dialogs/toasts cover the viewport. One
 * `useEffect` re-derives the banner candidates whenever any input signal changes (boot
 * classification, quota, persistence grant, pending writes); visibility still applies the
 * durable snoozes and the two-banner cap.
 *
 * Dialog verdicts resolve promises created in `notices.openDialog`, which is what lets the
 * import flow await "Replace and import" without the dialog knowing anything about imports.
 */

import { useEffect } from 'preact/hooks';
import type { JSX } from 'preact';

import { t } from '../../i18n';
import { deriveBanners } from './derive';
import { absoluteDate, percentOf } from './format';
import type { BannerParams } from './notices';
import {
  answerDialog,
  currentDialog,
  dismissToast,
  snoozeBanner,
  toasts,
  visibleBanners,
  type QueuedDialog,
  type Toast,
} from './notices';
import { pendingWrites, retryPendingWrites } from './pendingWrites';
import { NudgeBanner, type BannerAction, type BannerKind } from './NudgeBanner';
import { runRequestPersist } from './persistGate';
import { SafetyDialog } from './SafetyDialog';
import { dataSafetyState } from './state';
import { persistenceState, quotaState } from './storageInfo';
import { TOAST_LIFETIME_MS } from './constants';
import { UndoToast } from './UndoToast';

/**
 * The export/delete actions live in `actions.ts`, which imports the ADR-004 engine. Loading it
 * on demand keeps that engine OUT of the initial JS closure (§9.2) — these are click handlers,
 * so the chunk fetch is invisible to the user.
 */
function exportNow(): void {
  void import('./actions')
    .then((module) => module.runExport())
    .catch((error: unknown) => {
      console.warn('data-safety: export action failed to load', error);
    });
}

type BannerSpec = {
  readonly kind: BannerKind;
  readonly tier: 1 | 2;
  readonly title: string;
  readonly body: string;
  readonly actions: readonly BannerAction[];
  readonly closeLabel?: string;
};

/** §2 copy per banner kind — every string is an i18n key, no inline English (§11). */
function bannerSpec(kind: BannerKind, params: BannerParams, closeLabel: string): BannerSpec {
  const appName = t('app.name');
  const backUp: BannerAction = {
    id: 'back-up-now',
    label: t('dataSafety.banner.backUpNow'),
    variant: 'primary',
  };
  const openStorage: BannerAction = {
    id: 'open-storage',
    label: t('dataSafety.banner.openStorage'),
    variant: 'secondary',
  };

  switch (kind) {
    case 'backup-reminder': {
      const never = Number(params['never'] ?? 0) === 1;
      return {
        kind,
        tier: 1,
        title: never
          ? t('dataSafety.banner.backup.titleNever')
          : t('dataSafety.banner.backup.titleDays', { N: Number(params['N'] ?? 0) }),
        body: t('dataSafety.banner.backup.body'),
        actions: [
          backUp,
          { id: 'later', label: t('dataSafety.banner.backup.later'), variant: 'secondary' },
        ],
        closeLabel,
      };
    }

    case 'long-absence': {
      const lastBackupAt = Number(params['lastBackupAt'] ?? 0);
      const lastBackupLine =
        lastBackupAt > 0
          ? t('dataSafety.banner.longAbsence.lastBackup', { date: absoluteDate(lastBackupAt) })
          : t('dataSafety.banner.longAbsence.neverBackup');
      return {
        kind,
        tier: 1,
        title: t('dataSafety.banner.longAbsence.title', { N: Number(params['N'] ?? 0) }),
        body: t('dataSafety.banner.longAbsence.body', { lastBackupLine }),
        actions: [backUp],
        closeLabel,
      };
    }

    case 'shrunken':
      return {
        kind,
        tier: 2,
        title: t('dataSafety.banner.shrunken.title'),
        body: t('dataSafety.banner.shrunken.body', { pct: Number(params['pct'] ?? 0) }),
        actions: [backUp, openStorage],
        closeLabel,
      };

    case 'quota-warn': {
      const pct = Number(params['pct'] ?? 0);
      return {
        kind,
        tier: 2,
        title: t('dataSafety.banner.quotaWarn.title'),
        body: t('dataSafety.banner.quotaWarn.body', { appName, pct }),
        actions: [openStorage],
        closeLabel,
      };
    }

    case 'persist-denied':
      return {
        kind,
        tier: 2,
        title: t('dataSafety.banner.persistDenied.title'),
        body: t('dataSafety.banner.persistDenied.body', { appName }),
        actions: [
          { id: 'ask-again', label: t('dataSafety.banner.askAgain'), variant: 'primary' },
          backUp,
        ],
        closeLabel,
      };

    case 'quota-pending': {
      const count = Number(params['N'] ?? 0);
      return {
        kind,
        tier: 2,
        title:
          count === 1
            ? t('dataSafety.banner.quotaPending.titleOne', { N: count })
            : t('dataSafety.banner.quotaPending.titleMany', { N: count }),
        body: t('dataSafety.banner.quotaPending.body'),
        actions: [
          { id: 'free-space', label: t('dataSafety.quota.freeSpace'), variant: 'primary' },
          { id: 'export', label: t('dataSafety.quota.export'), variant: 'secondary' },
          { id: 'retry', label: t('common.retry'), variant: 'secondary' },
        ],
        closeLabel,
      };
    }
  }
}

function goStorage(): void {
  window.location.hash = '#/settings';
}

export function DataSafetyHost(): JSX.Element {
  const state = dataSafetyState.value;
  const quota = quotaState.value;
  const persistence = persistenceState.value;
  // Render-time read SUBSCRIBES the host to the pending-write queue: when the queue changes the
  // host re-renders and the derive effect below re-runs (its deps include `pending`).
  const pending = pendingWrites.value;

  // Re-derive candidates whenever any input changes (boot classification, quota, persistence
  // grant, pending writes). A plain `useEffect` keyed on the render-time reads is deliberate —
  // NOT `useSignalEffect`: `deriveBanners` transitively reads AND writes the `candidates` signal
  // via `setBanner`, so a signal effect would resubscribe to its own write and loop forever.
  // Keying on `pending` fixes D1 — a write queued after mount (quota dialog → Escape) now
  // surfaces its persistent T2 "N changes waiting" banner immediately, not on an unrelated trigger.
  useEffect(() => {
    deriveBanners();
  }, [state, quota, persistence, pending]);

  const { visible, overflow } = visibleBanners();
  const dialog = currentDialog();
  const toastList = toasts.value;

  const onBannerAction = (id: string): void => {
    switch (id) {
      case 'back-up-now':
        exportNow();
        return;
      case 'open-storage':
      case 'free-space':
        goStorage();
        return;
      case 'ask-again':
        void runRequestPersist();
        return;
      case 'export':
        exportNow();
        return;
      case 'retry':
        void retryPendingWrites();
        return;
      case 'later':
        snoozeBanner('backup-reminder');
        return;
    }
  };

  return (
    <div
      class="data-safety-host"
      data-quota-percent={String(percentOf(quota.usedBytes, quota.totalBytes) ?? '')}
    >
      <div class="banner-stack">
        {visible.map((banner, index) => {
          const spec = bannerSpec(banner.id, banner.params, t('dataSafety.banner.hide7'));
          return (
            <NudgeBanner
              key={banner.id}
              kind={spec.kind}
              tier={spec.tier}
              title={spec.title}
              body={spec.body}
              actions={spec.actions}
              closeLabel={spec.closeLabel}
              // §2: the overflow control belongs to the TOP banner only, once.
              moreCount={index === 0 ? overflow : 0}
              onShowAll={goStorage}
              onAction={onBannerAction}
              onSnooze={(days) => {
                snoozeBanner(banner.id, days);
              }}
            />
          );
        })}
      </div>

      {dialog === null ? null : <DialogHost queued={dialog} />}

      <div class="toast-stack">
        {toastList.map((toast) => (
          <ToastItem key={toast.id} toast={toast} />
        ))}
      </div>
    </div>
  );
}

/* --------------------------------- dialogs -------------------------------- */

function DialogHost({ queued }: { readonly queued: QueuedDialog }): JSX.Element {
  const request = queued.request;
  switch (request.kind) {
    case 'quota-exceeded':
      return (
        <SafetyDialog
          kind="quota-exceeded"
          pendingCount={request.pendingCount}
          onCancel={() => {
            answerDialog(false);
          }}
          onFreeSpace={() => {
            answerDialog(false);
            goStorage();
          }}
          onExport={() => {
            answerDialog(false);
            exportNow();
          }}
          onRetry={() => {
            answerDialog(false);
            void retryPendingWrites();
          }}
        />
      );

    case 'import-confirm':
      return (
        <SafetyDialog
          kind="import-confirm"
          file={request.preview}
          currentCounts={request.currentCounts}
          quarantined={request.quarantined}
          busy={queued.busy}
          onConfirm={() => {
            answerDialog(true);
          }}
          onCancel={() => {
            answerDialog(false);
          }}
        />
      );

    case 'delete-all-confirm':
      return (
        <SafetyDialog
          kind="delete-all-confirm"
          dataCounts={request.dataCounts}
          busy={queued.busy}
          onConfirm={() => {
            answerDialog(true);
          }}
          onCancel={() => {
            answerDialog(false);
          }}
          onExport={() => {
            answerDialog(false);
            exportNow();
          }}
        />
      );

    case 'private-browsing':
      return (
        <SafetyDialog
          kind="private-browsing"
          onExport={() => {
            answerDialog(false);
            exportNow();
          }}
          onDismiss={() => {
            answerDialog(false);
          }}
        />
      );

    case 'restore-confirm':
      return (
        <SafetyDialog
          kind="restore-confirm"
          snapshot={request.snapshot}
          currentCounts={request.currentCounts}
          busy={queued.busy}
          onConfirm={() => {
            answerDialog(true);
          }}
          onCancel={() => {
            answerDialog(false);
          }}
        />
      );
  }
}

/* --------------------------------- toasts --------------------------------- */

function ToastItem({ toast }: { readonly toast: Toast }): JSX.Element {
  useEffect(() => {
    if (toast.persistent) return undefined;
    const timer = setTimeout(() => {
      dismissToast(toast.id);
    }, TOAST_LIFETIME_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [toast.id, toast.persistent]);

  if (toast.action !== undefined) {
    const secondary = toast.secondaryAction;
    return (
      <UndoToast
        variant="success"
        message={toast.message}
        actionLabel={toast.action.label}
        onAction={() => {
          dismissToast(toast.id);
          toast.action?.run();
        }}
        secondaryLabel={secondary?.label}
        onSecondary={
          secondary === undefined
            ? undefined
            : (): void => {
                secondary.run();
              }
        }
        onDismiss={() => {
          dismissToast(toast.id);
        }}
      />
    );
  }

  return (
    <div class="toast" data-variant={toast.variant} role="status">
      <span class="toast-message">{toast.message}</span>
      <button
        type="button"
        class="icon-button"
        aria-label={t('common.dismiss')}
        onClick={() => {
          dismissToast(toast.id);
        }}
      >
        ×
      </button>
    </div>
  );
}
