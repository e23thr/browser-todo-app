/**
 * Playwright global setup (ADR-005 Decision 9): build the two-marked-build fixtures ONCE per
 * run, in the runner process. Worker processes inherit `E2E_FIXTURES_READY` and skip the build
 * — parallel workers must never build the same fixture directories concurrently.
 */

import process from 'node:process';

import { ensureFixtures } from './build-fixtures.mjs';

export default async function globalSetup() {
  await ensureFixtures();
  process.env.E2E_FIXTURES_READY = '1';
}
