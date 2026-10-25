/**
 * Post-commit side effects of a data replacement (ADR-004 Decision 3):
 *
 * - the localStorage theme mirror is rewritten from the imported
 *   `settings.theme` (ADR-002 §3.4 mirror rule — `settings` is the durable
 *   source of truth);
 * - `BroadcastChannel("local-first-todo")` posts `{type: "data-replaced"}` so
 *   other tabs refresh (E5);
 * - registered handlers run (`onDataReplaced`) so the acting tab's OWN running UI
 *   refreshes too (fix card t_85e19c39 — functional QA finding F1: a replace
 *   bypasses `MutationRunner.onCommitted`, so without this seam the restored data
 *   stayed invisible until a manual page reload). The shell wires its store +
 *   settings refresh through `wireDataReplacedRefresh()` (`src/app/dataReplace.ts`).
 *
 * All are fire-and-forget and feature-detected: a hardened/private browser
 * where localStorage or BroadcastChannel throws must not fail an import that
 * already committed, and neither must a broken UI handler — every one of these
 * runs AFTER the atomic replace (ADR-004) is over.
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

/** A UI-side reaction to a wholesale data replacement (runs after the commit). */
export type DataReplacedHandler = () => void;

const dataReplacedHandlers = new Set<DataReplacedHandler>();

/**
 * Register a handler for wholesale data replacements (import / snapshot restore /
 * wipe). Returns the disposer. Handlers are fanned out synchronously by
 * `notifyDataReplaced()` and must stay fire-and-forget.
 */
export function onDataReplaced(handler: DataReplacedHandler): () => void {
  dataReplacedHandlers.add(handler);
  return () => {
    dataReplacedHandlers.delete(handler);
  };
}

/**
 * Fan out to every registered handler. One handler throwing never blocks the
 * others (or the replacement that already committed) — a UI refresh is not part
 * of the transaction.
 */
export function notifyDataReplaced(): void {
  for (const handler of [...dataReplacedHandlers]) {
    try {
      handler();
    } catch (error: unknown) {
      console.warn('data-replaced handler failed', error);
    }
  }
}
