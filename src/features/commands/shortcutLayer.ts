/**
 * Global shortcut layer (V1 S8) — one document-level `keydown` listener that maps
 * `keymap.ts` bindings to app actions.
 *
 * Suppression rules (all pinned in `tests/component/commands.test.tsx`):
 *  - an IME composition in progress (Thai input) suppresses everything,
 *  - an event already handled (`defaultPrevented`) is left alone,
 *  - auto-repeat is ignored (a held key must not spam quick-add),
 *  - while a modal dialog is open (`.dialog-layer` in the document) the global
 *    layer is silent — dialogs own their own keys (Escape/Tab trap, `?` types),
 *  - the unmodified-family binding `?` additionally never fires while a form
 *    control or contenteditable has focus (typing must always win),
 *  - the Ctrl/⌘ bindings are safe to keep live while typing: they produce no
 *    text and no browser default we rely on.
 */

import { isEditableTarget, matchShortcut, type ShortcutBinding, type ShortcutId } from './keymap';

export type ShortcutHandlers = { readonly [K in ShortcutId]?: () => void };

/** True when a modal dialog currently owns the keyboard. */
function dialogOpen(): boolean {
  return document.querySelector('.dialog-layer') !== null;
}

/** IME in flight — `isComposing` plus the legacy keyCode 229 signal. */
function composing(event: KeyboardEvent): boolean {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- legacy Safari/Android IME signal (keyCode 229), not replaceable
  return event.isComposing || event.keyCode === 229;
}

function shouldRun(binding: ShortcutBinding, event: KeyboardEvent): boolean {
  if (composing(event)) return false;
  if (event.defaultPrevented) return false;
  if (event.repeat) return false;
  if (dialogOpen()) return false;
  if (!binding.combo.mod && isEditableTarget(event.target)) return false;
  return true;
}

/**
 * Install the layer on `document`. Returns the disposer. Handlers that are not
 * provided simply do nothing — the binding is still documented in the help
 * dialog, and `preventDefault` only runs when a handler actually fires.
 */
export function installShortcutLayer(handlers: ShortcutHandlers): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    const binding = matchShortcut(event);
    if (binding === null) return;
    const handler = handlers[binding.id];
    if (handler === undefined || !shouldRun(binding, event)) return;
    event.preventDefault();
    handler();
  };
  document.addEventListener('keydown', onKeyDown);
  return () => {
    document.removeEventListener('keydown', onKeyDown);
  };
}
