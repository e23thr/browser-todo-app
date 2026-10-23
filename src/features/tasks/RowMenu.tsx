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

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusablesIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
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

  /** §9.2: Tab closes and lands on the next control after the trigger. */
  const focusAfterTrigger = (): void => {
    setOpen(false);
    const trigger = triggerRef.current;
    if (trigger === null) return;
    const scope = trigger.closest('li, section, div');
    const candidates = focusablesIn(
      scope instanceof HTMLElement ? scope.parentElement ?? document.body : document.body,
    );
    const at = candidates.indexOf(trigger);
    const next = at >= 0 ? candidates[at + 1] : undefined;
    if (next !== undefined && next !== trigger) next.focus();
    else trigger.focus();
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
        focusAfterTrigger();
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
