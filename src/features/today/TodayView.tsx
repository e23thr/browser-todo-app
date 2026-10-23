import type { JSX } from 'preact';

/**
 * Core loop view — scaffold placeholder.
 *
 * Epic 2 (core domain) replaces this with the real Today list, capture field and completion
 * interactions; the design spec from h_designer owns the markup and component API. Keeping this
 * route statically imported is deliberate: it is the "always-loaded UI" the §9.2 initial-JS
 * budget is measured against.
 */
export function TodayView(): JSX.Element {
  return (
    <section>
      <h2>Today</h2>
      <p class="empty-state">Nothing scheduled for today.</p>
    </section>
  );
}
