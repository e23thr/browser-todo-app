import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { APP_URL, CORE_ROUTES, seedOnboardingDone } from './helpers';

/**
 * Accessibility gate (ADR-001 §6 / §9.5): axe-core scans of the core views.
 *
 * Serious and critical violations fail the build; the full violation list is logged for triage.
 * Both colour schemes are scanned (§8: light AND dark must be compliant) — the boot snippet
 * resolves `system` from the emulated `prefers-color-scheme`, so each pass also proves the
 * theme actually reached the app before scanning.
 *
 * M13-B2 (docs/qa/a11y-gate.md §2-B2): a fresh CI profile paints E3's first-run onboarding
 * INSTEAD of the shell regardless of hash route, so this suite must take the first-run
 * handshake before scanning — otherwise every route scan silently inspects the onboarding
 * screen and the gate reports a vacuous green (it did: 48 blocking violations went CI-green).
 * `seedOnboardingDone()` — the same shared helper the theme-boot suite uses for shell-bound
 * scenarios — seeds the durable dismissal marker before any page script runs, and the
 * per-route landmark guard below makes any regression to onboarding-interception fail loudly
 * instead of silently scanning the wrong surface.
 */
for (const colorScheme of ['light', 'dark'] as const) {
  test(`core views have no serious or critical axe violations (${colorScheme} theme)`, async ({
    page,
  }) => {
    const reported: string[] = [];

    await page.emulateMedia({ colorScheme });
    await seedOnboardingDone(page);
    await page.goto(APP_URL);
    await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);

    for (const route of CORE_ROUTES) {
      await page.goto(`${APP_URL}${route}`);

      // M13-B2 vacuous-green guard: the scan below must see the app shell — exactly one
      // labelled nav landmark (design §4.1, wide AND compact patterns) — never the
      // onboarding surface, which replaces the shell and renders no nav at all. The Today
      // view additionally pins the real view behind the landmark via its h1.
      await expect(page.locator('nav[aria-label]')).toHaveCount(1);
      if (route === '' || route === '#/today') {
        await expect(
          page.getByRole('heading', { level: 1, name: 'Today', exact: true }),
        ).toBeVisible();
      }

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();

      for (const violation of results.violations) {
        reported.push(
          `${route === '' ? '/' : route} → ${violation.impact ?? 'unknown'}: ${violation.id} — ${violation.help} (${String(violation.nodes.length)} node(s))`,
        );
      }
      const blocking = results.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      );
      expect(blocking.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
    }

    if (reported.length > 0) {
      console.warn(
        `axe violations below the failure threshold (${colorScheme}):\n  ${reported.join('\n  ')}`,
      );
    }
  });
}
