/**
 * Vite build for the E3 data-safety UX real-storage harness (test card t_b1595f03).
 *
 * Bundles `harness.tsx` — the REAL Preact surface (`DataSafetyHost` +
 * `StoragePanelContainer`) over the REAL engine — into `tests/e2e/.fixtures/`
 * (gitignored, never the shared `dist/`: sibling cards build concurrently in this
 * workspace). Served statically by `tests/e2e/data-safety-ux.spec.ts` and loaded into a
 * real Chromium page where `navigator.storage` is a REAL StorageManager.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  base: './',
  build: {
    outDir: resolve(here, '..', '.fixtures', 'data-safety-ux'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
});
