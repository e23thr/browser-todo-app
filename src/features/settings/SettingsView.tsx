import type { JSX } from 'preact';

/**
 * Settings view — scaffold placeholder, loaded as a lazy chunk.
 *
 * Deliberately behind a dynamic `import()` in the route table so the bundle-budget gate has a
 * real lazy route to exclude from the initial-JS closure (§9.2 route-level code splitting).
 * Epic 2/5 replaces this with the settings feature spec.
 */
export default function SettingsView(): JSX.Element {
  return (
    <section>
      <h2>Settings</h2>
      <p class="empty-state">Settings are coming soon.</p>
    </section>
  );
}
