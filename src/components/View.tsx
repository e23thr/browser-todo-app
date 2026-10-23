import type { JSX } from 'preact';

import { Icon, type IconName } from '../app/icons';

/**
 * View scaffold: the one `<h1>` per screen (design §4.1 heading + focus contract).
 *
 * The heading is `tabindex="-1"` and carries `data-view-title` so the route-change effect can
 * move focus into the view after navigation, then announce its text (§4.1, §11.2).
 */
export interface ViewProps {
  readonly title: string;
  readonly class?: string;
  readonly children?: JSX.Element | JSX.Element[];
}

export function View({ title, class: className, children }: ViewProps): JSX.Element {
  return (
    <section class={['view', className].filter(Boolean).join(' ')}>
      <h1 class="view-title" data-view-title="" tabindex={-1}>
        {title}
      </h1>
      {children}
    </section>
  );
}

/**
 * Empty state (design §6.13): icon + h2 + body + optional primary action.
 * Illustration-free by design (bundle budget §1).
 */
export interface EmptyStateProps {
  readonly icon: IconName;
  readonly title: string;
  readonly body: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}

export function EmptyState({
  icon,
  title,
  body,
  actionLabel,
  onAction,
}: EmptyStateProps): JSX.Element {
  return (
    <div class="empty-state">
      <Icon name={icon} size={32} class="empty-state-icon" />
      <h2 class="empty-state-title">{title}</h2>
      <p class="empty-state-body">{body}</p>
      {actionLabel !== undefined && onAction !== undefined ? (
        <button type="button" class="button button-primary" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}
