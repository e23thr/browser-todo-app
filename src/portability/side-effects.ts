/**
 * Post-commit side effects of a data replacement (ADR-004 Decision 3):
 *
 * - the localStorage theme mirror is rewritten from the imported
 *   `settings.theme` (ADR-002 §3.4 mirror rule — `settings` is the durable
 *   source of truth);
 * - `BroadcastChannel("local-first-todo")` posts `{type: "data-replaced"}` so
 *   other tabs refresh (E5).
 *
 * Both are fire-and-forget and feature-detected: a hardened/private browser
 * where localStorage or BroadcastChannel throws must not fail an import that
 * already committed.
 */

import { writeThemePref } from '../app/theme';
import type { Settings } from '../storage/types';
import { DATA_REPLACED_CHANNEL } from './constants';

/** Mirror the imported theme for pre-paint boot. Never throws. */
export function mirrorTheme(settings: Settings | null): void {
  if (settings === null) return;
  writeThemePref(settings.theme);
}

/** Tell other tabs the data was replaced. Never throws. */
export function broadcastDataReplaced(): void {
  try {
    const Channel = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
    if (typeof Channel !== 'function') return;
    const channel = new Channel(DATA_REPLACED_CHANNEL);
    channel.postMessage({ type: 'data-replaced' });
    channel.close();
  } catch {
    // Cross-tab notice is best-effort; the replacement itself already committed.
  }
}
