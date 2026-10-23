import { gzipSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { evaluateBundleBudget } from '../../scripts/check-bundle-budget.mjs';

/**
 * ADR-001 §8 / ADR-005 Decision 1: the service worker (`dist/sw.js`) is part of the `app-shell`
 * budget sum. The scaffold's gate classified every non-entry JS file as a lazy chunk, which
 * silently excluded the worker — these fixtures pin the corrected accounting.
 */

const budgetsPath = join(process.cwd(), 'scripts', 'bundle-budgets.json');
const budgets = JSON.parse(readFileSync(budgetsPath, 'utf8')) as unknown;

const createdDirs: string[] = [];

afterAll(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

const MANIFEST = {
  'index.html': {
    file: 'assets/index-entry.js',
    css: ['assets/index-style.css'],
    dynamicImports: ['src/features/settings/SettingsView.tsx'],
    isEntry: true,
  },
  'src/features/settings/SettingsView.tsx': { file: 'assets/SettingsView-chunk.js' },
};

function fixtureDist(withServiceWorker: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'budget-sw-'));
  createdDirs.push(dir);
  const files: Record<string, string> = {
    'index.html': '<!doctype html><html></html>',
    'assets/index-entry.js': 'console.log("entry")',
    'assets/index-style.css': 'body{}',
    'assets/SettingsView-chunk.js': 'export default 1',
    '.vite/manifest.json': JSON.stringify(MANIFEST),
  };
  if (withServiceWorker) files['sw.js'] = 'self.addEventListener("install",()=>{});';
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content, 'utf8');
  }
  return dir;
}

function gzipOf(dir: string, file: string): number {
  return gzipSync(readFileSync(join(dir, file)), { level: 9 }).byteLength;
}

describe('bundle budget — service worker accounting (ADR-001 §8 / ADR-005 Decision 1)', () => {
  it('counts sw.js in the app-shell sum and never as a lazy chunk', () => {
    const dir = fixtureDist(true);
    const report = evaluateBundleBudget({ distDir: dir, budgets });

    expect(report.context.shellFiles).toContain('sw.js');
    expect(report.context.lazyFiles).toEqual(['assets/SettingsView-chunk.js']);
    expect(report.context.serviceWorkerFiles).toEqual(['sw.js']);

    const expectedShellBytes =
      gzipOf(dir, 'index.html') +
      gzipOf(dir, 'assets/index-entry.js') +
      gzipOf(dir, 'assets/index-style.css') +
      gzipOf(dir, 'sw.js');
    expect(report.context.measured['app-shell']).toBe(expectedShellBytes);
  });

  it('keeps the same accounting when no worker is shipped yet (pre-SW builds)', () => {
    const dir = fixtureDist(false);
    const report = evaluateBundleBudget({ distDir: dir, budgets });

    expect(report.context.shellFiles).not.toContain('sw.js');
    expect(report.context.serviceWorkerFiles).toEqual([]);
    expect(report.context.measured['app-shell']).toBe(
      gzipOf(dir, 'index.html') +
        gzipOf(dir, 'assets/index-entry.js') +
        gzipOf(dir, 'assets/index-style.css'),
    );
  });
});
