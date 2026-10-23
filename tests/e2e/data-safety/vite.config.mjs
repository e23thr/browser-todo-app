/**
 * Vite build for the E3 data-engine drill harness (test card t_f0702c05).
 *
 * Bundles `harness.ts` — which imports the REAL `src/portability` + `src/storage`
 * engine — into `tests/e2e/.fixtures/data-safety/` (gitignored, never the shared
 * `dist/`: sibling cards build concurrently in this workspace). Served statically
 * by `tests/e2e/data-safety-journey.spec.ts` and loaded into a real browser page
 * where the drills run with real IndexedDB, offline.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  base: './',
  build: {
    outDir: resolve(here, '..', '.fixtures', 'data-safety'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
});
