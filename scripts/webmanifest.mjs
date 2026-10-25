#!/usr/bin/env node
/**
 * Web app manifest generation — ADR-008 Decision 1 (E6, S13).
 *
 * The manifest is BUILD-TIME GENERATED, never a static file: `start_url`, `scope` and every
 * icon URL must carry the configured base path (`/<repo>/` for GitHub Pages project pages), and
 * they must agree exactly with the ADR-005 Decision 8 service-worker scope
 * (`${BASE_URL}sw.js`, scope `${BASE_URL}`). A static `public/manifest.webmanifest` cannot
 * know the base; this module is the single source of truth for the manifest's shape, and the
 * `app:webmanifest` Vite plugin (vite.config.ts) emits it into every build output as
 * `manifest.webmanifest` — including the E2E fixture builds, which exercise the same pipeline.
 *
 * The file is NOT precached (ADR-005 Decision 2 keeps its `*.webmanifest` exclusion): it is
 * install-time metadata, fetched by the browser when the user installs, not an app-shell
 * artifact needed for offline boot.
 *
 * Usage:
 *   node scripts/webmanifest.mjs [--base /repo-name/] [--check <distDir>]
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import process from 'node:process';

/**
 * Normalize a base path exactly like `vite.config.ts` does, so manifest URLs and Vite `base`
 * can never disagree: `'/'` for dev, `/<repo>/` for GitHub Pages project pages.
 *
 * @param {string | undefined} raw
 * @returns {string} slash-terminated base
 */
export function normalizeBase(raw) {
  if (raw === undefined || raw === '') return '/';
  const trimmed = raw.trim();
  if (trimmed === '/' || trimmed === './') return trimmed;
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}

/**
 * Build the manifest object for a base path (ADR-008 Decision 1: `id`/`start_url`/`scope` all
 * equal the base, mirroring the service-worker scope; icons are self-hosted under `icons/`).
 *
 * @param {string} base slash-terminated base path
 * @returns {Record<string, unknown>}
 */
export function buildWebManifest(base) {
  const normalized = normalizeBase(base);
  return {
    // `id` is the stable install identity; pinning it to the scope keeps one installed app per
    // base path (a root install and a project-page install never collide).
    id: normalized,
    name: 'Todo — local-first',
    short_name: 'Todo',
    description: 'A local-first, privacy-preserving todo app that runs entirely in your browser.',
    start_url: normalized,
    scope: normalized,
    display: 'standalone',
    background_color: '#fcfcfd',
    theme_color: '#fcfcfd',
    icons: [
      {
        src: `${normalized}icons/icon-192.png`,
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: `${normalized}icons/icon-512.png`,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: `${normalized}icons/maskable-192.png`,
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: `${normalized}icons/maskable-512.png`,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}

/**
 * Render the manifest as its shipped text form (2-space JSON + trailing newline).
 *
 * @param {string} base
 * @returns {string}
 */
export function renderWebManifest(base) {
  return `${JSON.stringify(buildWebManifest(base), null, 2)}\n`;
}

function parseArgs(argv) {
  /** @type {{base?: string, check?: string}} */
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base') {
      options.base = argv[i + 1];
      i += 1;
    } else if (arg === '--check') {
      options.check = argv[i + 1];
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
    const base = normalizeBase(options.base ?? process.env['BASE_PATH']);
    if (options.check !== undefined) {
      const file = join(resolve(options.check), 'manifest.webmanifest');
      const actual = readFileSync(file, 'utf8');
      const expected = renderWebManifest(base);
      if (actual !== expected) {
        console.error(`webmanifest: ${file} does not match the generator for base ${base}`);
        process.exitCode = 1;
      } else {
        console.log(`webmanifest: ${file} ok (base ${base})`);
      }
    } else {
      process.stdout.write(renderWebManifest(base));
    }
  } catch (error) {
    console.error(`webmanifest: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
