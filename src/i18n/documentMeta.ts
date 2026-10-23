/**
 * Localized document metadata — QA defect D1 (docs/qa/e5-i18n.md).
 *
 * `index.html` ships a static English `<title>` and `meta name="description"` so pre-boot
 * paint has something to show; both are catalog strings (`app.documentTitle` /
 * `app.metaDescription`) and this module keeps the live document in step with the active
 * locale — the only remaining M15 exception was that nothing ever updated them (the tab
 * stayed English in Thai mode).
 *
 * Wiring (src/app/main.tsx): installed immediately AFTER `initLocale()` resolves —
 * - normal boot: the first run applies the active locale right away;
 * - bounded-boot timeout (main.tsx `timeoutMs: 2000`): no pack has landed, so `t()` falls
 *   back to the raw key. That value is deliberately NOT written — the static English in
 *   index.html survives — and because the effect reads the catalog signal, it re-runs the
 *   moment the background `setLocale()` inside `initLocale()` lands the pack. Same
 *   self-heal contract as the rendered UI (§5 boot semantics).
 * - locale switch: `setLocale()` swaps the catalog signal → the effect re-runs.
 * The runtime itself (src/i18n/index.ts, fixed contract t_1b9ee0e6) is untouched.
 *
 * Sinks are text-only: `document.title = …` and `setAttribute('content', …)` never parse
 * HTML, so this is safe against the §7.2 XSS rules. It is the single deliberate
 * `document.title` write under `src/**` (the QA grep counts it) — accounted for in
 * docs/i18n/README.md §4. Note it writes the <head> elements only; it never re-creates
 * them, so a document without a description tag is a no-op, not a throw.
 */

import { effect } from '@preact/signals';

import { t } from './index';

const TITLE_KEY = 'app.documentTitle';
const DESCRIPTION_KEY = 'app.metaDescription';

/** Text-only sink: update the description element's content, or do nothing if it is absent. */
function applyDescription(content: string): void {
  const meta = document.querySelector('meta[name="description"]');
  if (meta !== null) meta.setAttribute('content', content);
}

/**
 * Apply the active catalog's title and description to the document right now.
 *
 * Exported for tests and for any caller that needs a one-shot sync; the boot path uses
 * `installDocumentMeta()`, which calls this on every signal change.
 */
export function applyDocumentMeta(): void {
  const title = t(TITLE_KEY);
  // Before any pack lands t() resolves to the key itself — keep index.html's static English
  // rather than flashing a raw key into the browser tab (§5: fallback paint stays valid).
  if (title !== TITLE_KEY) document.title = title;

  const description = t(DESCRIPTION_KEY);
  if (description !== DESCRIPTION_KEY) applyDescription(description);
}

/**
 * Subscribe document metadata to the i18n catalog: runs once immediately (boot) and re-runs
 * whenever `setLocale()` applies a new catalog — including a pack that lands after the
 * bounded-boot timeout. Returns the disposer (used by tests; the app keeps it for the
 * document's lifetime).
 */
export function installDocumentMeta(): () => void {
  // Reading `t()` here reads the catalog signal, which is what subscribes this effect —
  // no hooks, no context, mirroring how components re-render on a locale switch.
  return effect(applyDocumentMeta);
}
