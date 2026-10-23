/**
 * `<SafetyDialog>` (design §5.6) — one dialog component with typed payloads, so focus
 * management is implemented exactly once for every T3 surface.
 *
 * A11y contract (§5.6, WCAG 2.2 AA):
 *   - `role="alertdialog"` + `aria-labelledby` / `aria-describedby`,
 *   - initial focus on the SAFEST action (never a destructive confirm) via `data-autofocus`,
 *   - Tab is trapped inside the dialog, Escape takes the safe path, backdrop click = Escape,
 *   - focus returns to whatever opened the dialog on close (captured here, on mount).
 *
 * Escape semantics per kind (§6.4/§10.6): import/delete/restore cancel, private-browsing
 * dismisses, quota keeps the pending write and just closes — there is no path that discards a
 * failed write.
 */

import { useEffect, useRef } from 'preact/hooks';
import type { JSX } from 'preact';

import { Icon } from '../../app/icons';
import { t } from '../../i18n';
import { absoluteDate } from './format';
import type { DataCounts, ImportPreview, SnapshotMeta } from './types';

export type SafetyDialogProps =
  | {
      readonly kind: 'quota-exceeded';
      readonly pendingCount: number;
      readonly onFreeSpace: () => void;
      readonly onExport: () => void;
      readonly onRetry: () => void;
      /** Additive (§6.4): Escape/close keeps the pending write and just closes. */
      readonly onCancel: () => void;
    }
  | {
      readonly kind: 'import-confirm';
      readonly file: ImportPreview;
      readonly currentCounts: DataCounts;
      readonly onConfirm: () => void;
      readonly onCancel: () => void;
      /** Additive: how many records the validator quarantined (ADR-004 Decision 5.5). */
      readonly quarantined?: number | undefined;
    }
  | {
      readonly kind: 'delete-all-confirm';
      readonly dataCounts: DataCounts;
      readonly onConfirm: () => void;
      readonly onCancel: () => void;
      /** Additive (§6.8): "Export a backup first" closes the dialog and runs the export. */
      readonly onExport: () => void;
    }
  | {
      readonly kind: 'private-browsing';
      readonly onExport: () => void;
      readonly onDismiss: () => void;
    }
  | {
      readonly kind: 'restore-confirm';
      readonly snapshot: SnapshotMeta;
      readonly currentCounts: DataCounts;
      readonly onConfirm: () => void;
      readonly onCancel: () => void;
    }
  | {
      /** Additive: the flows show "busy" while the confirming write runs (§10.6). */
      readonly kind: 'import-busy';
      readonly title: string;
      readonly body: string;
    };

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function SafetyDialog(props: SafetyDialogProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // Capture the trigger before this layer covers the page, give initial focus inside.
  useEffect(() => {
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const autofocus = rootRef.current?.querySelector<HTMLElement>('[data-autofocus]');
    (autofocus ?? rootRef.current)?.focus();
    return () => {
      openerRef.current?.focus();
    };
  }, []);

  // Focus trap + Escape (§5.6). Listened on the document because the dialog is modal.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        safeClose(props);
        return;
      }
      if (event.key !== 'Tab') return;
      const root = rootRef.current;
      if (root === null) return;
      const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === root)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [props]);

  const ids = {
    title: `safety-dialog-title-${props.kind}`,
    body: `safety-dialog-body-${props.kind}`,
  };

  return (
    <div class="safety-layer">
      <button
        type="button"
        class="safety-scrim"
        tabIndex={-1}
        aria-label={t('common.close')}
        onClick={() => {
          safeClose(props);
        }}
      />
      <div
        class="safety-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={ids.title}
        aria-describedby={ids.body}
        tabIndex={-1}
        ref={rootRef}
        data-kind={props.kind}
      >
        <p class="safety-tier">
          <Icon name="alert-triangle" size={16} />
          {t('dataSafety.tier.action')}
        </p>
        <h2 class="safety-title" id={ids.title}>
          {titleOf(props)}
        </h2>
        <div class="safety-body" id={ids.body}>
          {bodyOf(props)}
        </div>
        <div class="safety-actions">{actionsOf(props)}</div>
      </div>
    </div>
  );
}

/** Escape / backdrop / the safe button of each kind — never a destructive confirm. */
function safeClose(props: SafetyDialogProps): void {
  switch (props.kind) {
    case 'quota-exceeded':
      props.onCancel();
      return;
    case 'private-browsing':
      props.onDismiss();
      return;
    case 'import-busy':
      return;
    case 'import-confirm':
    case 'delete-all-confirm':
    case 'restore-confirm':
      props.onCancel();
  }
}

function titleOf(props: SafetyDialogProps): string {
  switch (props.kind) {
    case 'quota-exceeded':
      return t('dataSafety.quota.title');
    case 'import-confirm':
      return t('dataSafety.import.confirm.title');
    case 'delete-all-confirm':
      return t('dataSafety.deleteAll.title');
    case 'private-browsing':
      return t('dataSafety.private.title');
    case 'restore-confirm':
      return t('dataSafety.restore.title', {
        date: absoluteDate(props.snapshot.takenAt),
      });
    case 'import-busy':
      return props.title;
  }
}

function bodyOf(props: SafetyDialogProps): JSX.Element {
  const appName = t('app.name');
  switch (props.kind) {
    case 'quota-exceeded':
      return (
        <>
          <p>{t('dataSafety.quota.body', { appName })}</p>
          <p>{t('dataSafety.quota.body2')}</p>
          {props.pendingCount > 1 ? (
            <p class="safety-note">
              {t('dataSafety.banner.quotaPending.titleMany', { N: props.pendingCount })}
            </p>
          ) : null}
        </>
      );

    case 'import-confirm': {
      const exported = props.file.exportedAt === null ? null : absoluteDate(props.file.exportedAt);
      return (
        <>
          <p>
            {exported === null
              ? t('dataSafety.import.confirm.bodyNoDate', {
                  tasks: props.file.counts.tasks,
                  lists: props.file.counts.lists,
                })
              : t('dataSafety.import.confirm.body', {
                  tasks: props.file.counts.tasks,
                  lists: props.file.counts.lists,
                  date: exported,
                })}
          </p>
          <p>
            {t('dataSafety.import.confirm.body2', {
              currentTasks: props.currentCounts.tasks,
              currentLists: props.currentCounts.lists,
            })}
          </p>
          <p>{t('dataSafety.import.confirm.body3', { appName })}</p>
          {props.quarantined !== undefined && props.quarantined > 0 ? (
            <p class="safety-note">
              {t('dataSafety.import.confirm.quarantined', { N: props.quarantined })}
            </p>
          ) : null}
        </>
      );
    }

    case 'delete-all-confirm':
      return (
        <>
          <p>
            {t('dataSafety.deleteAll.body', {
              tasks: props.dataCounts.tasks,
              lists: props.dataCounts.lists,
            })}
          </p>
          <p>{t('dataSafety.deleteAll.body2')}</p>
        </>
      );

    case 'private-browsing':
      return (
        <>
          <p>{t('dataSafety.private.body', { appName })}</p>
          <p>{t('dataSafety.private.body2')}</p>
        </>
      );

    case 'restore-confirm':
      return (
        <>
          <p>{t('dataSafety.restore.body', { date: absoluteDate(props.snapshot.takenAt) })}</p>
          <p>
            {t('dataSafety.restore.body2', {
              currentTasks: props.currentCounts.tasks,
              currentLists: props.currentCounts.lists,
            })}
          </p>
        </>
      );

    case 'import-busy':
      return <p>{props.body}</p>;
  }
}

function actionsOf(props: SafetyDialogProps): JSX.Element {
  switch (props.kind) {
    case 'quota-exceeded':
      return (
        <>
          <button
            type="button"
            class="button button-primary"
            data-autofocus=""
            onClick={props.onFreeSpace}
          >
            {t('dataSafety.quota.freeSpace')}
          </button>
          <button type="button" class="button button-secondary" onClick={props.onExport}>
            {t('dataSafety.quota.export')}
          </button>
          <button type="button" class="button button-secondary" onClick={props.onRetry}>
            {t('common.retry')}
          </button>
        </>
      );

    case 'import-confirm':
      return (
        <>
          <button
            type="button"
            class="button button-secondary"
            data-autofocus=""
            onClick={props.onCancel}
          >
            {t('common.cancel')}
          </button>
          <button type="button" class="button button-primary" onClick={props.onConfirm}>
            {t('dataSafety.import.confirm.go')}
          </button>
        </>
      );

    case 'delete-all-confirm':
      return (
        <>
          <button
            type="button"
            class="button button-secondary"
            data-autofocus=""
            onClick={props.onExport}
          >
            {t('dataSafety.deleteAll.exportFirst')}
          </button>
          <button type="button" class="button button-secondary" onClick={props.onCancel}>
            {t('common.cancel')}
          </button>
          <button type="button" class="button button-danger-filled" onClick={props.onConfirm}>
            {t('dataSafety.deleteAll.confirm')}
          </button>
        </>
      );

    case 'private-browsing':
      return (
        <>
          <button type="button" class="button button-primary" onClick={props.onExport}>
            {t('dataSafety.private.export')}
          </button>
          <button
            type="button"
            class="button button-secondary"
            data-autofocus=""
            onClick={props.onDismiss}
          >
            {t('dataSafety.private.gotIt')}
          </button>
        </>
      );

    case 'restore-confirm':
      return (
        <>
          <button
            type="button"
            class="button button-secondary"
            data-autofocus=""
            onClick={props.onCancel}
          >
            {t('common.cancel')}
          </button>
          <button type="button" class="button button-primary" onClick={props.onConfirm}>
            {t('dataSafety.restore.confirm')}
          </button>
        </>
      );

    case 'import-busy':
      return <span class="safety-busy">{t('dataSafety.import.importing')}</span>;
  }
}
