#!/usr/bin/env node
/**
 * Service-worker build — ADR-005 Decision 1.
 *
 * `npm run build` = client build -> precache manifest generation -> THIS script: a second Vite
 * build that bundles `src/sw/sw.ts` into a single classic worker at `dist/sw.js`, emitted
 * UNHASHED (the browser needs a stable URL for update checks) and minified (ES2022, the §9.4
 * browser floor). `dist/sw.js` is included in the `app-shell` budget sum (ADR-001 §8).
 *
 * `emptyOutDir: false` is load-bearing: the client build's output must survive, and the client
 * `.vite/manifest.json` (input to the budget gate) must not be clobbered (`manifest: false`).
 *
 * Usage:
 *   node scripts/build-sw.mjs [--root <dir>] [--outDir <dir>]
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import process from 'node:process';
import { build } from 'vite';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Build the classic service-worker bundle.
 *
 * @param {{ root?: string, outDir?: string }} [options]
 */
export async function buildServiceWorker(options = {}) {
  const root = resolve(options.root ?? REPO_ROOT);
  await build({
    configFile: false,
    root,
    logLevel: 'warn',
    build: {
      target: 'es2022',
      outDir: resolve(options.outDir ?? join(root, 'dist')),
      emptyOutDir: false,
      sourcemap: false,
      // Minified with Vite 8's default minifier (oxc). `minify: 'esbuild'` would require the
      // esbuild package, which Vite 8 no longer bundles (ADR-005 Decision 1: "minified").
      // The client build's manifest must stay intact for the budget gate.
      manifest: false,
      lib: {
        entry: join(root, 'src', 'sw', 'sw.ts'),
        formats: ['iife'],
        name: 'TodoServiceWorker',
        fileName: () => 'sw.js',
      },
    },
  });
}

function parseArgs(argv) {
  /** @type {{root?: string, outDir?: string}} */
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      options.root = argv[i + 1];
      i += 1;
    } else if (arg === '--outDir') {
      options.outDir = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    await buildServiceWorker(parseArgs(process.argv.slice(2)));
    console.log('build-sw: dist/sw.js written (classic worker, unhashed, minified)');
  } catch (error) {
    console.error(`build-sw: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
