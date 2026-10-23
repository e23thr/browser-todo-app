#!/usr/bin/env node
/**
 * Precache manifest generation — ADR-005 Decision 2.
 *
 * Walks the production build output (`dist/`) and emits `src/sw/precache-manifest.ts`: a sorted
 * list of `{ url, sha256 }` entries (URLs relative to the configured base) plus `shellVersion`,
 * the first 16 hex chars of the SHA-256 over the serialized manifest. Any content change
 * anywhere -> new `shellVersion` -> new cache name AND new `sw.js` bytes -> the browser's
 * byte-diff update check fires (the only versioning channel).
 *
 * Explicitly NOT precached (ADR-005 Decision 2): `*.map` (never published), `sw.js` (managed by
 * the browser's update mechanism), `*.webmanifest` (PO Q12: no manifest in MVP), and `.vite/`
 * build metadata (not an app artifact — it is excluded from the budget gate's measurement for
 * the same reason).
 *
 * The generated module is written only when its content actually changes, so repeated builds of
 * the same sources never dirty the working tree.
 *
 * Usage:
 *   node scripts/generate-precache.mjs [--dist <dir>] [--out <file>]
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import process from 'node:process';

const DEFAULT_DIST = 'dist';
const DEFAULT_OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'sw',
  'precache-manifest.ts',
);

/** Base names never precached. */
const EXCLUDED_BASENAMES = new Set(['sw.js']);
/** Suffixes never precached. */
const EXCLUDED_SUFFIXES = ['.map', '.webmanifest'];

/**
 * Decide whether a dist-relative file belongs in the precache set.
 *
 * @param {string} relPath posix-style path relative to the dist root
 */
export function shouldPrecache(relPath) {
  const segments = relPath.split('/');
  const base = segments[segments.length - 1] ?? '';
  if (EXCLUDED_BASENAMES.has(base)) return false;
  if (EXCLUDED_SUFFIXES.some((suffix) => base.endsWith(suffix))) return false;
  if (segments.includes('.vite')) return false;
  return true;
}

/** Recursively list every file under `dir`, as sorted posix-style relative paths. */
export function walkDist(dir, prefix = '') {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : posix.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...walkDist(dir, rel));
    else out.push(rel);
  }
  out.sort();
  return out;
}

/**
 * Build the precache entries for a dist directory.
 *
 * @param {string} distDir
 * @returns {{ entries: {url: string, sha256: string}[], shellVersion: string }}
 */
export function buildPrecacheEntries(distDir) {
  if (!existsSync(distDir)) {
    throw new Error(`dist directory not found: ${distDir} (run \`npm run build\` first)`);
  }
  const entries = walkDist(distDir)
    .filter(shouldPrecache)
    .map((rel) => ({
      url: rel,
      sha256: createHash('sha256')
        .update(readFileSync(join(distDir, rel)))
        .digest('hex'),
    }));
  entries.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  const shellVersion = createHash('sha256')
    .update(JSON.stringify(entries))
    .digest('hex')
    .slice(0, 16);
  return { entries, shellVersion };
}

/**
 * Render the generated TypeScript module.
 *
 * @param {{ entries: {url: string, sha256: string}[], shellVersion: string }} manifest
 */
export function renderPrecacheModule(manifest) {
  const lines = [
    '/**',
    ' * GENERATED FILE — created by scripts/generate-precache.mjs during `npm run build`.',
    ' * Do not edit by hand: the precache set is derived from the build output (ADR-005 Decision 2).',
    ' * Commit the refreshed file whenever a build changes it.',
    ' */',
    '',
    'export interface PrecacheEntry {',
    '  readonly url: string;',
    '  readonly sha256: string;',
    '}',
    '',
    '/** Whole-artifact precache set, URLs relative to the service worker scope. */',
    'export const PRECACHE_ENTRIES: readonly PrecacheEntry[] = [',
    ...manifest.entries.map((entry) => `  { url: '${entry.url}', sha256: '${entry.sha256}' },`),
    '];',
    '',
    '/** Content-addressed shell version (first 16 hex chars of the manifest hash). */',
    `export const SHELL_VERSION = '${manifest.shellVersion}';`,
    '',
  ];
  return lines.join('\n');
}

/**
 * Generate `src/sw/precache-manifest.ts` from a dist directory.
 *
 * @param {{ distDir: string, outFile: string }} input
 */
export function generatePrecache({ distDir, outFile }) {
  const manifest = buildPrecacheEntries(distDir);
  const source = renderPrecacheModule(manifest);
  const current = existsSync(outFile) ? readFileSync(outFile, 'utf8') : null;
  const changed = current !== source;
  if (changed) writeFileSync(outFile, source, 'utf8');
  return { changed, outFile, count: manifest.entries.length, shellVersion: manifest.shellVersion };
}

function parseArgs(argv) {
  /** @type {{distDir?: string, outFile?: string}} */
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dist') {
      options.distDir = argv[i + 1];
      i += 1;
    } else if (arg === '--out') {
      options.outFile = argv[i + 1];
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
    const options = parseArgs(process.argv.slice(2));
    const result = generatePrecache({
      distDir: resolve(options.distDir ?? DEFAULT_DIST),
      outFile: resolve(options.outFile ?? DEFAULT_OUT),
    });
    console.log(
      `precache: ${result.count} entr${result.count === 1 ? 'y' : 'ies'} ` +
        `(shellVersion ${result.shellVersion}) -> ${result.outFile}` +
        (result.changed ? '' : ' [unchanged]'),
    );
  } catch (error) {
    console.error(`generate-precache: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
