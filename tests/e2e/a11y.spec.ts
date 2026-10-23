import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { APP_URL, CORE_ROUTES } from './helpers';

/**
 * Accessibility gate (ADR-001 §6 / §9.5): axe-core scans of the core views.
 *
 * Serious and critical violations fail the build; the full violation list is logged for triage.
 * Both colour schemes are scanned (§8: light AND dark must be compliant) — the boot snippet
 * resolves `system` from the emulated `prefers-color-scheme`, so each pass also proves the
 * theme actually reached the app before scanning.
 */
for (const colorScheme of ['light', 'dark'] as const) {
  test(`core views have no serious or critical axe violations (${colorScheme} theme)`, async ({
    page,
  }) => {
    const reported: string[] = [];

    await page.emulateMedia({ colorScheme });
    await page.goto(APP_URL);
    await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);

    for (const route of CORE_ROUTES) {
      await page.goto(`${APP_URL}${route}`);

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
