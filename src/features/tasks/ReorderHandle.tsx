/**
 * Reorder handle (design §8.1, §10 `ReorderHandleProps`) — the grip button a
 * drag starts from. Dragging starts ONLY from the handle so row clicks keep
 * opening the editor (§8.1).
 *
 * Semantics: a real `<button>` (24 px grip glyph, 44 px hit area) named
 * `reorder.handle {title}` ("Reorder \"Buy milk\""). Visible on hover/focus on
 * pointer devices, ALWAYS visible on touch (`@media (hover: none)`), and it is
 * part of the row's tab sequence (§9.1): `Alt+↑`/`Alt+↓` on the handle perform
 * the identical move commands as on the row (routed by `TaskRow`). The pointer
 * drag itself is owned by the list (`reorderDrag.ts`): this component emits
 * `onDragStart` with the pointer event.
 */

import type { JSX, TargetedEvent } from 'preact';

import { t } from '../../app/i18n';
import { Icon } from '../../app/icons';

export interface ReorderHandleProps {
  readonly taskId: string;
  /** Task title — the handle's accessible name embeds it (label-in-name). */
  readonly title: string;
  /** Roving tabindex: only the cursor row's inner controls are tabbable (§9.1). */
  readonly tabIndex: number;
  readonly onDragStart: (event: TargetedEvent<HTMLButtonElement, PointerEvent>) => void;
  /** `Alt+↑`/`Alt+↓` pressed while this handle has focus (§9.1 inner-control map). */
  readonly onMoveKey: (event: TargetedEvent<HTMLButtonElement, KeyboardEvent>) => void;
}

export function ReorderHandle({
  taskId,
  title,
  tabIndex,
  onDragStart,
  onMoveKey,
}: ReorderHandleProps): JSX.Element {
  return (
    <button
      type="button"
      class="reorder-handle"
      data-reorder-handle={taskId}
      aria-label={t('reorder.handle', { title })}
      tabIndex={tabIndex}
      // The handle is the drag entry point; touch scrolling must not fight the drag
      // (§8.1 "touch-action rules on the handle only").
      style={{ 'touch-action': 'none' }}
      onPointerDown={onDragStart}
      onKeyDown={(event) => {
        if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
          event.preventDefault();
          event.stopPropagation();
          onMoveKey(event);
          return;
        }
        // §9.1: Escape from any inner control returns focus to the row container.
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          const row = event.currentTarget.closest('li[data-task-id]');
          if (row instanceof HTMLElement) row.focus();
        }
      }}
    >
      <Icon name="grip" size={24} />
    </button>
  );
}
