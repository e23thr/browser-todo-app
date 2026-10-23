/**
 * Import-picker request counter (§3.4 recovery screen → "Restore from a backup").
 *
 * Lives in its own leaf module so `App.tsx` can bump it WITHOUT pulling the ADR-004 import
 * pipeline into the initial JS closure (§9.2): the panel's container watches the tick and
 * clicks its own hidden file input — one-way, no shared DOM refs, no engine code up front.
 */

import { signal } from '@preact/signals';

export const importPickTick = signal(0);

/** Ask the settings panel to open its file picker (as if the user pressed "Import…"). */
export function requestImportPick(): void {
  importPickTick.value += 1;
}
