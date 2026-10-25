/**
 * Openers seam for the command palette and the shortcuts help dialog (S8).
 *
 * Same shape as `src/app/quickAdd.ts`: the shell's nav buttons and the shortcut
 * layer call `openCommandPalette()` / `openShortcutsHelp()`; `App` registers the
 * real handlers when the shell is mounted. Without a handler the calls are
 * harmless no-ops (the shell is the only caller, and it lives inside App).
 */

type Handler = () => void;

let paletteHandler: Handler | null = null;
let helpHandler: Handler | null = null;

export function registerCommandOpeners(handlers: {
  readonly palette: Handler;
  readonly help: Handler;
}): () => void {
  paletteHandler = handlers.palette;
  helpHandler = handlers.help;
  return () => {
    paletteHandler = null;
    helpHandler = null;
  };
}

export function openCommandPalette(): void {
  paletteHandler?.();
}

export function openShortcutsHelp(): void {
  helpHandler?.();
}
