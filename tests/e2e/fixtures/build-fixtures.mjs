/**
 * Two-build fixture harness (ADR-005 Decision 9).
 *
 * Builds fully isolated marked versions of the app into `tests/e2e/.fixtures/` — `vA` and `vB`
 * under the configured non-root base path (the GitHub Pages project-page case) plus a root-base
 * `vA` variant. Isolation is deliberate: fixture builds must never write the shared `dist/` or
 * `src/sw/precache-manifest.ts`, because sibling cards build concurrently in this workspace.
 *
 * Each build runs the real production pipeline (client build -> precache generation -> `sw.js`
 * build), so what the offline suite exercises is exactly what ships.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const FIXTURES_DIR = join(REPO_ROOT, 'tests', 'e2e', '.fixtures');

/** Fixture dist directories by name. */
export const FIXTURES = {
  vA: join(FIXTURES_DIR, 'dist-vA'),
  vB: join(FIXTURES_DIR, 'dist-vB'),
  rootA: join(FIXTURES_DIR, 'dist-root-vA'),
};

function run(command, args) {
  execFileSync(command, args, {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: 'pipe',
  });
}

/**
 * Build every fixture (fresh). One call per Playwright worker process is memoised below.
 *
 * @param {{ basePath?: string }} [options] — base path for the non-root fixtures; the root
 *   variant is always built with `/`.
 */
export function buildFixtures(options = {}) {
  const basePath = options.basePath ?? '/browser-todo-app/';
  mkdirSync(FIXTURES_DIR, { recursive: true });

  const builds = [
    { name: 'dist-vA', env: { BASE_PATH: basePath, VITE_BUILD_ID: 'vA' } },
    { name: 'dist-vB', env: { BASE_PATH: basePath, VITE_BUILD_ID: 'vB' } },
    { name: 'dist-root-vA', env: { BASE_PATH: '/', VITE_BUILD_ID: 'vA' } },
  ];

  for (const { name, env } of builds) {
    const outDir = join(FIXTURES_DIR, name);
    rmSync(outDir, { recursive: true, force: true });
    const generated = join(FIXTURES_DIR, `precache-${name}.ts`);
    rmSync(generated, { force: true });

    process.env.BASE_PATH = env.BASE_PATH;
    process.env.VITE_BUILD_ID = env.VITE_BUILD_ID;
    run('npx', ['vite', 'build', '--outDir', outDir]);
    run('node', ['scripts/generate-precache.mjs', '--dist', outDir, '--out', generated]);
    run('node', ['scripts/build-sw.mjs', '--outDir', outDir, '--precache', generated]);
    delete process.env.BASE_PATH;
    delete process.env.VITE_BUILD_ID;
  }

  return FIXTURES;
}

let building = null;

/** Memoised `buildFixtures` — one fresh build set per worker process. */
export function ensureFixtures(options = {}) {
  // Runner process already built them (tests/e2e/fixtures/global-setup.mjs): workers inherit
  // this marker and must not rebuild the shared fixture directories concurrently.
  if (process.env.E2E_FIXTURES_READY === '1') return Promise.resolve(FIXTURES);
  if (building === null) building = Promise.resolve().then(() => buildFixtures(options));
  return building;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const fixtures = buildFixtures({
      basePath: process.env.BASE_PATH ?? '/browser-todo-app/',
    });
    const lines = Object.entries(fixtures).map(([name, dir]) => `fixtures: ${name} -> ${dir}`);
    process.stdout.write(`${lines.join('\n')}\n`);
  } catch (error) {
    process.stderr.write(
      `build-fixtures: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
