/**
 * Vite build for the E10 encryption drill harness (test card t_0a8e0c42).
 *
 * Bundles `harness.ts` — which imports the REAL `src/crypto` + `src/storage` +
 * `src/portability` engine — into `tests/e2e/.fixtures/encryption-<pid>/` (never
 * the shared `dist/`: sibling cards build concurrently in this workspace).
 * Served by `tests/e2e/e10-encryption.spec.ts` and loaded into a REAL Chromium
 * page with REAL IndexedDB + REAL WebCrypto, because the ADR-007 claims under
 * test are browser claims (IndexedDB transaction lifetime, PBKDF2/AES-GCM).
 *
 * The `inlineDynamicImports` rule mirrors `data-safety/vite.config.mjs`: the
 * engine's lazy crypto chunks must be inlined so the offline page never has to
 * fetch a chunk mid-drill.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  base: './',
  build: {
    outDir: resolve(here, '..', '.fixtures', 'encryption'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
