/**
 * Modal dialog shell (design core-domain §5.2, §7 S7 shared shell, §9.6).
 *
 * Owns the contract every dialog in the core UI shares:
 *   - `role="dialog" aria-modal="true"` labelled by its `h2` title and described by its body,
 *   - focus trap (Tab / Shift+Tab cycle inside the topmost dialog only),
 *   - `Escape` closes the TOPMOST dialog (a module-level stack keeps nested dialogs —
 *     discard-confirm over the task editor — from closing together),
 *   - initial focus lands inside (the element carrying `data-autofocus`, else the first
 *     focusable, else the dialog itself),
 *   - on close, focus returns to the exact trigger element that opened the dialog.
 *
 * The scrim is decorative: clicking it runs the same close path as `Escape` (Cancel).
 */

import { useEffect, useRef } from 'preact/hooks';
import type { ComponentChildren, JSX } from 'preact';

/** Elements that can hold focus, in DOM order. */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Stack of open dialog roots — only the last one is "topmost". */
const dialogStack: HTMLElement[] = [];

function focusablesIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (el) => el.offsetParent !== null || el === document.activeElement || el.tabIndex >= 0,
  );
}

export interface DialogProps {
  /** Heading text (rendered as the dialog's `h2`/`h3`). Omit when `label` is given. */
  readonly title?: string;
  /** Accessible NAME for label-less dialogs (the mobile composer sheet). */
  readonly label?: string;
  /** Element id for the body/description node, wired to `aria-describedby`. */
  readonly describedById?: string;
  readonly children: ComponentChildren;
  /** Right-aligned action row (stacked full-width on mobile). */
  readonly footer?: ComponentChildren;
  readonly onClose: () => void;
  readonly class?: string;
  /** Extra class on the dialog panel itself (sheet vs. centered modal). */
  readonly panelClass?: string;
  /** Rendered as the dialog's heading level (S7 uses `h2`). */
  readonly headingLevel?: 2 | 3;
}

export function Dialog({
  title,
  label,
  describedById,
  children,
  footer,
  onClose,
  class: className,
  panelClass,
  headingLevel = 2,
}: DialogProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useRef(`dialog-title-${String(Math.random()).slice(2, 10)}`).current;

  // Capture the trigger before focus moves, then move focus into the dialog.
  useEffect(() => {
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    if (panel === null) return;
    dialogStack.push(panel);
    const autofocus = panel.querySelector<HTMLElement>('[data-autofocus]');
    const target = autofocus ?? focusablesIn(panel)[0] ?? panel;
    target.focus();
    return () => {
      const at = dialogStack.indexOf(panel);
      if (at >= 0) dialogStack.splice(at, 1);
      const opener = openerRef.current;
      // Focus returns to the exact trigger — unless it left the document (its row
      // was deleted): then the browser keeps focus wherever the view moved it.
      if (opener !== null && document.contains(opener)) opener.focus();
    };
  }, []);

  // Escape + Tab trap, active only while this dialog is topmost (§9.6).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const panel = panelRef.current;
      if (panel === null || dialogStack[dialogStack.length - 1] !== panel) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = focusablesIn(panel);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onClose]);

  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const labelledBy = title !== undefined ? titleId : undefined;

  return (
    <div class={['dialog-layer', className].filter(Boolean).join(' ')}>
      <button
        type="button"
        class="dialog-scrim"
        tabIndex={-1}
        aria-hidden="true"
        onClick={() => {
          onClose();
        }}
      />
      <div
        class={['dialog', panelClass].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        {...(labelledBy !== undefined ? { 'aria-labelledby': labelledBy } : {})}
        {...(label !== undefined ? { 'aria-label': label } : {})}
        {...(describedById !== undefined ? { 'aria-describedby': describedById } : {})}
        ref={panelRef}
        tabIndex={-1}
      >
        {title !== undefined ? (
          <div class="dialog-head">
            <Heading class="dialog-title" id={titleId}>
              {title}
            </Heading>
          </div>
        ) : null}
        <div class="dialog-body">{children}</div>
        {footer !== undefined && footer !== null ? (
          <div class="dialog-foot">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}
