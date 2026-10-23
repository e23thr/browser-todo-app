/**
 * Quick-add seam (design §4.1 FAB, §6.8 TaskComposer).
 *
 * The FAB ships with the shell, but the composer belongs to the core-UI card (M1), which
 * registers its handler here. Until a handler exists the FAB falls back to taking the user to
 * the capture view (Today), so it is never a dead control.
 */

type Handler = () => void;

let handler: Handler | null = null;

/** Register (or with `null`, clear) the quick-add handler. Returns a disposer. */
export function registerQuickAddHandler(next: Handler | null): () => void {
  handler = next;
  return () => {
    handler = null;
  };
}

/** Ask the registered handler to open the composer. `false` = nothing handled it. */
export function requestQuickAdd(): boolean {
  if (handler === null) return false;
  handler();
  return true;
}

/**
 * Entry point for every "Add task" control in the shell: open the composer when one is
 * registered, otherwise take the user to the capture view (Today). Never a dead control.
 */
export function startQuickAdd(): void {
  if (!requestQuickAdd()) window.location.hash = '#/today';
}
