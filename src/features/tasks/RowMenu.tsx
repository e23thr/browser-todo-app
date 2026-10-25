/**
 * Row actions menu (design §7 S2 row menu, §9.2 menu keyboard map).
 *
 * One kebab button per row, always visible (never hover-only — §5.1). Keyboard map
 * (§9.2): `Enter`/`Space`/`↓` opens and focuses the first item, `↑`/`↓` cycle,
 * `Home`/`End` jump, `Enter` activates, `Escape` closes and returns focus to the
 * trigger, `Tab` closes and moves to the control AFTER the trigger. `aria-disabled`
 * items stay focusable and announce their disabled state; activating one is a no-op
 * (the boundary announcement belongs to the keyboard path, §8.2).
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX, TargetedEvent } from 'preact';

import { Icon } from '../../app/icons';

export interface MenuItem {
  readonly key: string;
  readonly label: string;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly onSelect: () => void;
}

export interface RowMenuProps {
  /** Accessible name of the trigger, e.g. `Actions for "Buy milk"`. */
  readonly label: string;
  readonly items: readonly MenuItem[];
  readonly class?: string;
  /** Roving-tabindex support: `-1` on rows the cursor is not on (§9.1). */
  readonly tabIndex?: number;
}

/** Everything a Tab press could land on, in DOM order (tab stops AND roving rows). */
const FOCUS_TARGETS =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]';

/**
 * Where `Tab`/`Shift+Tab` must land after the menu closes: every focusable in the
 * document that sits AFTER (or BEFORE, for `Shift+Tab`) the whole `.row-menu` container,
 * never one inside it — NEAREST FIRST in document order, across both real tab stops
 * (`tabIndex >= 0`) and roving-programmatically-focusable neighbours (`tabindex="-1"`,
 * e.g. the next row's `li`, which promotes its own row when it receives focus).
 *
 * Nearest-first is the binding part (E7 fix, pinned by core-ui-rows B3): an earlier
 * two-tier ordering ("real tab stops first") made `Shift+Tab` out of a row menu leap
 * PAST the row's own controls to distant page furniture (the E7 view toolbar) as soon
 * as anything focusable preceded the list — the adjacent control of the same row is
 * where every keyboard user expects focus to land.
 */
function candidatesBeyond(anchor: HTMLElement, backward: boolean): HTMLElement[] {
  const bit = backward ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
  const relative = [...document.body.querySelectorAll<HTMLElement>(FOCUS_TARGETS)].filter(
    (el) =>
      el !== anchor && !anchor.contains(el) && (anchor.compareDocumentPosition(el) & bit) !== 0,
  );
  return backward ? relative.reverse() : relative;
}

export function RowMenu({ label, items, class: className, tabIndex }: RowMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Focus the first item on open (§9.2).
  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
  }, [open]);

  // Outside pointer / any click on an item closes the menu.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) === true) return;
      if (triggerRef.current?.contains(target) === true) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  const close = (returnFocus: boolean): void => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  /**
   * §9.2: `Tab` closes the menu and lands on the next control AFTER the trigger — i.e.
   * after the whole `.row-menu` container, never on one of the open menu's own items
   * (they unmount in the same tick, which used to drop focus on `document.body`). When
   * nothing follows in the document (last row), the trigger keeps focus: focus is never
   * dropped on the body, so the next `Tab` does not restart from the top of the page.
   */
  const focusAfterStep = (backward: boolean): void => {
    const trigger = triggerRef.current;
    setOpen(false);
    if (trigger === null) return;
    const container = trigger.closest('.row-menu');
    const anchor = container instanceof HTMLElement ? container : trigger;
    for (const candidate of candidatesBeyond(anchor, backward)) {
      candidate.focus();
      // A candidate the browser refuses (display:none) cannot take focus: keep walking.
      if (document.activeElement === candidate) return;
    }
    trigger.focus();
  };

  const onTriggerKeyDown = (event: TargetedEvent<HTMLButtonElement, KeyboardEvent>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
    }
  };

  const onMenuKeyDown = (event: TargetedEvent<HTMLDivElement, KeyboardEvent>): void => {
    const menu = menuRef.current;
    if (menu === null) return;
    const entries = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const at = entries.indexOf(document.activeElement as HTMLElement);

    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      case 'Tab':
        event.preventDefault();
        focusAfterStep(event.shiftKey);
        return;
      case 'ArrowDown':
        event.preventDefault();
        entries[at + 1 === entries.length ? 0 : at + 1]?.focus();
        return;
      case 'ArrowUp':
        event.preventDefault();
        entries[at <= 0 ? entries.length - 1 : at - 1]?.focus();
        return;
      case 'Home':
        event.preventDefault();
        entries[0]?.focus();
        return;
      case 'End':
        event.preventDefault();
        entries[entries.length - 1]?.focus();
        return;
      default:
    }
  };

  return (
    <div class={['row-menu', className].filter(Boolean).join(' ')}>
      <button
        type="button"
        class="icon-button row-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        tabIndex={tabIndex ?? 0}
        ref={triggerRef}
        onKeyDown={onTriggerKeyDown}
        onClick={() => {
          setOpen((was) => !was);
        }}
      >
        <Icon name="more-vertical" size={20} />
      </button>
      {open ? (
        <div
          class="menu"
          role="menu"
          tabIndex={-1}
          ref={menuRef}
          onKeyDown={onMenuKeyDown}
          // The menu contains only buttons; focus management above is exhaustive, so
          // jsdom/AT both see one menu per open trigger.
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              class={`menu-item${item.danger === true ? ' menu-item-danger' : ''}`}
              {...(item.disabled === true ? { 'aria-disabled': 'true' } : {})}
              onClick={() => {
                if (item.disabled === true) return;
                close(true);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
