import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { evaluateBundleBudget, formatReport } from '../../scripts/check-bundle-budget.mjs';

/**
 * The bundle gate must be able to fail — "a gate that never fails is a defect" (§9.2/§9.5).
 * These fixtures build synthetic `dist/` trees so every FAIL path is proven in CI, not just
 * asserted in a README.
 */

const budgetsPath = join(process.cwd(), 'scripts', 'bundle-budgets.json');
const budgets = JSON.parse(readFileSync(budgetsPath, 'utf8')) as unknown;

const createdDirs: string[] = [];

afterAll(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

const ENTRY_HTML =
  '<!doctype html><html lang="en"><head><meta http-equiv="Content-Security-Policy" ' +
  'content="default-src \'self\'"></head><body><div id="app"></div>' +
  '<script type="module" crossorigin src="/browser-todo-app/assets/index-entry.js"></script></body></html>';

const BASE_MANIFEST = {
  'index.html': {
    file: 'assets/index-entry.js',
    css: ['assets/index-style.css'],
    imports: ['_shared'],
    dynamicImports: ['src/features/settings/SettingsView.tsx'],
    isEntry: true,
  },
  _shared: { file: 'assets/shared-chunk.js' },
  'src/features/settings/SettingsView.tsx': {
    file: 'assets/SettingsView-chunk.js',
    isDynamicEntry: true,
  },
};

function makeDist(
  files: Record<string, string | Buffer>,
  manifest: unknown = BASE_MANIFEST,
): string {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-budget-'));
  createdDirs.push(dir);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(dir, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  mkdirSync(join(dir, '.vite'), { recursive: true });
  writeFileSync(join(dir, '.vite', 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

function baseFiles(
  overrides: Record<string, string | Buffer> = {},
): Record<string, string | Buffer> {
  return {
    'index.html': ENTRY_HTML,
    'assets/index-entry.js': 'export const boot = 1;',
    'assets/shared-chunk.js': 'export const shared = 2;',
    'assets/SettingsView-chunk.js': 'export default function SettingsView() {}',
    'assets/index-style.css': ':root{--color-bg:#fff}',
    'favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    ...overrides,
  };
}

function run(files: Record<string, string | Buffer>, manifest?: unknown) {
  const distDir = makeDist(files, manifest);
  return evaluateBundleBudget({ distDir, budgets });
}

function statusOf(report: ReturnType<typeof evaluateBundleBudget>, name: string): string {
  const gate = report.results.find((result) => result.name === name);
  if (gate === undefined) throw new Error(`no gate named ${name}`);
  return gate.status;
}

describe('bundle budget gate — passing build', () => {
  it('passes a within-budget build and reports every gate', () => {
    const report = run(baseFiles());

    expect(report.ok).toBe(true);
    expect(report.results.map((result) => result.name)).toEqual([
      'initial-js',
      'css',
      'app-shell',
      'locales',
      'locales-lazy',
      'no-external-refs',
      'no-wasm',
    ]);
    expect(report.results.every((result) => result.status === 'PASS')).toBe(true);
    expect(formatReport(report)).toContain('RESULT: PASS');
  });

  it('keeps lazy route chunks out of the initial closure and out of the shell sum', () => {
    const report = run(baseFiles());

    expect(report.context.initialJsFiles).toEqual([
      'assets/index-entry.js',
      'assets/shared-chunk.js',
    ]);
    expect(report.context.lazyFiles).toContain('assets/SettingsView-chunk.js');
    expect(report.context.shellFiles).not.toContain('assets/SettingsView-chunk.js');
  });

  it('excludes icons/, the web manifest and source maps from every measurement', () => {
    const report = run(
      baseFiles({
        'icons/icon-512.png': randomBytes(400 * 1024),
        'manifest.webmanifest': '{"name":"x"}'.padEnd(200 * 1024, ' '),
        'assets/index-entry.js.map': randomBytes(300 * 1024),
      }),
    );

    expect(report.ok).toBe(true);
    expect(statusOf(report, 'app-shell')).toBe('PASS');
  });
});

describe('bundle budget gate — deliberate violations', () => {
  it('FAILS when initial JS exceeds 100 KB gzip', () => {
    const report = run(baseFiles({ 'assets/index-entry.js': randomBytes(120 * 1024) }));

    expect(statusOf(report, 'initial-js')).toBe('FAIL');
    expect(report.ok).toBe(false);
    expect(formatReport(report)).toContain('RESULT: FAIL');
  });

  it('warns (but does not fail) once initial JS reaches the 80 KB target', () => {
    const report = run(baseFiles({ 'assets/index-entry.js': randomBytes(85 * 1024) }));

    expect(statusOf(report, 'initial-js')).toBe('WARN');
    expect(report.ok).toBe(true);
  });

  it('FAILS when CSS exceeds 20 KB gzip', () => {
    const css = `/*${randomBytes(30 * 1024).toString('hex')}*/`;
    const report = run(baseFiles({ 'assets/index-style.css': css }));

    expect(statusOf(report, 'css')).toBe('FAIL');
    expect(report.ok).toBe(false);
  });

  it('FAILS when the app shell exceeds 200 KB gzip', () => {
    const report = run(baseFiles({ 'assets/photo.png': randomBytes(220 * 1024) }));

    expect(statusOf(report, 'app-shell')).toBe('FAIL');
    expect(report.ok).toBe(false);
  });

  it('FAILS on any .wasm asset (MVP rule: a WASM payload needs its own ADR)', () => {
    const report = run(baseFiles({ 'assets/parser.wasm': randomBytes(64) }));

    expect(statusOf(report, 'no-wasm')).toBe('FAIL');
    expect(report.ok).toBe(false);
  });

  it('FAILS on an external-origin reference in shipped code', () => {
    const report = run(
      baseFiles({
        'assets/index-entry.js': 'fetch("https://cdn.example.com/lib.js");',
      }),
    );

    expect(statusOf(report, 'no-external-refs')).toBe('FAIL');
    expect(report.ok).toBe(false);
    expect(report.results.find((result) => result.name === 'no-external-refs')?.detail).toContain(
      'cdn.example.com',
    );
  });

  it('allows XML namespace URLs (they are not network fetches)', () => {
    const report = run(
      baseFiles({
        'assets/index-entry.js': 'document.createElementNS("http://www.w3.org/2000/svg","svg");',
      }),
    );

    expect(statusOf(report, 'no-external-refs')).toBe('PASS');
    expect(report.ok).toBe(true);
  });

  it('FAILS when locale packs exceed 20 KB gzip combined', () => {
    const manifest = {
      ...BASE_MANIFEST,
      'src/i18n/locales/en.ts': { file: 'assets/en-chunk.js', isDynamicEntry: true },
      'src/i18n/locales/th.ts': { file: 'assets/th-chunk.js', isDynamicEntry: true },
    };
    const report = run(
      baseFiles({
        'assets/en-chunk.js': 'export default {}',
        'assets/th-chunk.js': randomBytes(30 * 1024),
      }),
      manifest,
    );

    expect(report.context.locales.length).toBe(2);
    expect(statusOf(report, 'locales')).toBe('FAIL');
    expect(report.ok).toBe(false);
  });

  it('FAILS when a locale pack lands inside the initial JS closure (it must be lazy)', () => {
    const manifest = {
      'index.html': {
        file: 'assets/index-entry.js',
        css: ['assets/index-style.css'],
        imports: ['_locale-en'],
        isEntry: true,
      },
      '_locale-en': { file: 'assets/en-chunk.js' },
      'src/i18n/locales/en.ts': { file: 'assets/en-chunk.js', isDynamicEntry: true },
    };
    const report = run(baseFiles({ 'assets/en-chunk.js': 'export default {}' }), manifest);

    expect(statusOf(report, 'locales-lazy')).toBe('FAIL');
    expect(report.ok).toBe(false);
  });

  it('passes when no locale packs exist yet (scaffold stage) without hiding the gate', () => {
    const report = run(baseFiles());

    const locales = report.results.find((result) => result.name === 'locales');
    expect(locales?.status).toBe('PASS');
    expect(locales?.measuredBytes).toBe(0);
    expect(report.results.find((result) => result.name === 'locales-lazy')?.status).toBe('PASS');
  });
});
