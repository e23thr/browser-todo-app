import { createHash } from 'node:crypto';

import preact from '@preact/preset-vite';
import { defineConfig, type Plugin } from 'vitest/config';

import { renderWebManifest } from './scripts/webmanifest.mjs';

/**
 * Configurable base path (ADR-001 §3, PROJECT_ANALYSIS §9.5).
 *
 * GitHub Pages *project* pages serve under `/<repo>/`, so every emitted asset URL must be
 * prefixed with that base. Local dev defaults to `/`. CI sets:
 *
 *   BASE_PATH=/<repo>/ npm run build
 */
function normalizeBase(raw: string | undefined): string {
  if (raw === undefined || raw === '') return '/';
  const trimmed = raw.trim();
  if (trimmed === '/' || trimmed === './') return trimmed;
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}

const BASE = normalizeBase(process.env['BASE_PATH']);

/**
 * Web app manifest emission (ADR-008 Decision 1): `scripts/webmanifest.mjs` builds the manifest
 * from the SAME normalized base as Vite `base` — `start_url`/`scope`/icon URLs must match the
 * ADR-005 Decision 8 service-worker scope exactly. Emitted as `manifest.webmanifest` at the
 * dist root (unhashed: it is a stable install endpoint), and never precached (ADR-005
 * Decision 2's `*.webmanifest` exclusion). Every build gets it for free — including the E2E
 * fixture builds, which run through this same config.
 */
function webmanifestPlugin(base: string): Plugin {
  return {
    name: 'app:webmanifest',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.webmanifest',
        source: renderWebManifest(base),
      });
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        // Pin the manifest href to the configured base regardless of how the HTML asset
        // pipeline treated the root-absolute reference (idempotent: the regex matches any
        // prefix, so running twice cannot double-prefix).
        return html.replace(
          /href="[^"]*manifest\.webmanifest"/u,
          `href="${base}manifest.webmanifest"`,
        );
      },
    },
  };
}

/**
 * Placeholder replaced at HTML-transform time with the real SHA-256 of the inline theme-boot
 * snippet, so the CSP `script-src` hash always matches the shipped markup (ADR-001 §3).
 */
const THEME_BOOT_HASH_PLACEHOLDER = '__THEME_BOOT_SHA256__';
const THEME_BOOT_SCRIPT_RE = /<script id="theme-boot">([\s\S]*?)<\/script>/u;

/**
 * `vite dev` injects styles and the HMR client as inline DOM nodes, which the strict production
 * CSP (`style-src 'self'`, `script-src 'self'`) would block. Dev therefore relaxes exactly those
 * two directives; the artifact that ships to GitHub Pages keeps the §7.2 policy untouched.
 */
function relaxCspForDev(html: string): string {
  return html
    .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
    .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'");
}

function themeBootCspPlugin(): Plugin {
  return {
    name: 'app:theme-boot-csp',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const match = THEME_BOOT_SCRIPT_RE.exec(html);
        if (match === null || match[1] === undefined) {
          throw new Error(
            'index.html is missing the inline <script id="theme-boot"> snippet required by ADR-001 §3',
          );
        }
        const digest = createHash('sha256').update(match[1], 'utf8').digest('base64');
        const withHash = html.replaceAll(THEME_BOOT_HASH_PLACEHOLDER, digest);
        return ctx.server === undefined ? withHash : relaxCspForDev(withHash);
      },
    },
  };
}

export default defineConfig({
  base: BASE,
  plugins: [preact(), themeBootCspPlugin(), webmanifestPlugin(BASE)],
  build: {
    target: 'es2022',
    // Never publish source maps (ADR-001 §3): smaller artifact, no source disclosure.
    sourcemap: false,
    // .vite/manifest.json is the input for scripts/check-bundle-budget.mjs (entry closure,
    // lazy chunks, locale packs). It is build metadata, excluded from the app-shell sum there.
    manifest: true,
    assetsInlineLimit: 4096,
    emptyOutDir: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.ts', 'tests/component/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts'],
      thresholds: {
        // PROJECT_ANALYSIS §9.5: >= 80% on domain / migrations / merge modules.
        './src/domain/**/*.ts': { lines: 80, branches: 80, functions: 80, statements: 80 },
        './src/storage/**/*.ts': { lines: 80, branches: 80, functions: 80, statements: 80 },
        // E3 (ADR-004): export/import/snapshot engine — same per-file gate.
        './src/portability/**/*.ts': { lines: 80, branches: 80, functions: 80, statements: 80 },
        // E8 (ADR-006 §9.5 + this card's acceptance): the merge/conflict
        // modules carry the PRE-DECIDED policy — the >=80% gate is strict on
        // them. The rest of the engine gets regression floors (error-injection
        // and API suites keep them well above).
        './src/sync/{merge,shadow,batchCodec}.ts': {
          lines: 80,
          branches: 80,
          functions: 80,
          statements: 80,
        },
        './src/sync/**/*.ts': { lines: 80, branches: 70, functions: 80, statements: 80 },
      },
    },
  },
});
