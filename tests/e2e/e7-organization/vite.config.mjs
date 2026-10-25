/**
 * Vite build for the E7 organization QA harness (test card t_ed1fa949).
 *
 * Bundles `harness.ts` (REAL `src/storage` engine — boot, migrations, TaskRepo)
 * into `tests/e2e/.fixtures/e7-organization/` (gitignored, never the shared
 * `dist/`: sibling cards build concurrently in this workspace). Served by
 * `tests/e2e/e7-organization-probe.spec.ts` and loaded into a real Chromium
 * page where the probes run against real IndexedDB.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  base: './',
  build: {
    outDir: resolve(here, '..', '.fixtures', 'e7-organization'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
});
