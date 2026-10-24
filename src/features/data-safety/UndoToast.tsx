/**
 * `<UndoToast>` (design §5.8) — the T4 confirmation after an import, with its undo action.
 *
 * Persistence rule (§5.8/§8.4): while the pre-import snapshot still exists the toast does NOT
 * auto-dismiss — only after the user's first interaction with it does the normal 8 s timer
 * start. `role="status"` keeps the announcement polite and non-disruptive (§4.4).
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';

import { Icon } from '../../app/icons';
import { t } from '../../i18n';
import { TOAST_LIFETIME_MS } from './constants';

export interface UndoToastProps {
  readonly message: string;
  readonly actionLabel: string;
  readonly onAction: () => void;
  readonly onDismiss: () => void;
  readonly variant: 'success';
  /** `true` → no auto-dismiss until the first interaction (§5.8 pending-unseen state). */
  readonly pendingUnseen?: boolean;
  /** ADR-004 Decision 5.5 (b): the durable `downloadSnapshot` escape hatch. */
  readonly secondaryLabel?: string | undefined;
  readonly onSecondary?: (() => void) | undefined;
}

export function UndoToast({
  message,
  actionLabel,
  onAction,
  onDismiss,
  variant,
  pendingUnseen = true,
  secondaryLabel,
  onSecondary,
}: UndoToastProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [interacted, setInteracted] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 8 s auto-dismiss only once the user has seen AND touched the toast (§5.8).
  useEffect(() => {
    if (!interacted) return undefined;
    timer.current = setTimeout(onDismiss, TOAST_LIFETIME_MS);
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [interacted, onDismiss]);

  const interact = (): void => {
    if (!interacted) setInteracted(true);
  };

  return (
    <div
      class="undo-toast"
      data-variant={variant}
      data-pending={pendingUnseen && !interacted ? 'true' : undefined}
      role="status"
      onMouseEnter={interact}
      onFocus={interact}
    >
      <Icon name="check-circle" size={18} />
      <span class="undo-toast-message">{message}</span>
      <button
        type="button"
        class="button button-secondary"
        aria-busy={busy ? 'true' : undefined}
        disabled={busy}
        onClick={() => {
          interact();
          setBusy(true);
          onAction();
        }}
      >
        {busy ? t('dataSafety.undo.restoring') : actionLabel}
      </button>
      {secondaryLabel !== undefined && onSecondary !== undefined ? (
        <button
          type="button"
          class="button button-secondary"
          onClick={() => {
            interact();
            onSecondary();
          }}
        >
          <Icon name="download" size={16} />
          {secondaryLabel}
        </button>
      ) : null}
      <button
        type="button"
        class="icon-button"
        aria-label={t('common.dismiss')}
        onClick={() => {
          interact();
          onDismiss();
        }}
      >
        <Icon name="x" size={18} />
      </button>
    </div>
  );
}
