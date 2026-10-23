import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  buildPrecacheEntries,
  generatePrecache,
  renderPrecacheModule,
  shouldPrecache,
} from '../../scripts/generate-precache.mjs';

/**
 * ADR-005 Decision 9 (unit): precache manifest generation — deterministic ordering, the
 * Decision 2 exclusion rules, content addressing and idempotent output.
 */

const createdDirs: string[] = [];

afterAll(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

function fixtureDist(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'precache-'));
  createdDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content, 'utf8');
  }
  return dir;
}

const FULL_DIST = {
  'index.html': '<!doctype html><html></html>',
  'sw.js': '/* built separately */',
  'favicon.svg': '<svg/>',
  'assets/index-abc.js': 'console.log(1)',
  'assets/index-abc.js.map': '{}',
  'assets/SettingsView-def.js': 'lazy',
  'assets/style-123.css': 'body{}',
  'assets/locale-th-999.js': 'th',
  '.vite/manifest.json': '{}',
  'manifest.webmanifest': '{}',
};

describe('shouldPrecache — ADR-005 Decision 2 exclusion rules', () => {
  it('includes the whole app artifact set (HTML, lazy chunks, CSS, icons)', () => {
    for (const file of [
      'index.html',
      'assets/index-abc.js',
      'assets/SettingsView-def.js',
      'assets/style-123.css',
      'favicon.svg',
      'assets/locale-th-999.js',
      '404.html',
    ]) {
      expect(shouldPrecache(file)).toBe(true);
    }
  });

  it('excludes source maps, the worker script itself, web manifests and .vite build metadata', () => {
    for (const file of [
      'assets/index-abc.js.map',
      'sw.js',
      'manifest.webmanifest',
      '.vite/manifest.json',
    ]) {
      expect(shouldPrecache(file)).toBe(false);
    }
  });
});

describe('buildPrecacheEntries', () => {
  it('emits sorted entries with sha256 digests and excludes non-app artifacts', () => {
    const dir = fixtureDist(FULL_DIST);
    const { entries, shellVersion } = buildPrecacheEntries(dir);

    expect(entries.map((entry) => entry.url)).toEqual([
      'assets/SettingsView-def.js',
      'assets/index-abc.js',
      'assets/locale-th-999.js',
      'assets/style-123.css',
      'favicon.svg',
      'index.html',
    ]);
    const indexEntry = entries.find((entry) => entry.url === 'index.html');
    expect(indexEntry?.sha256).toBe(
      createHash('sha256').update(FULL_DIST['index.html']).digest('hex'),
    );
    expect(shellVersion).toMatch(/^[0-9a-f]{16}$/u);
  });

  it('is deterministic and content-addressed: same content -> same shellVersion, any change -> new one', () => {
    const dirA = fixtureDist(FULL_DIST);
    const dirB = fixtureDist(FULL_DIST);
    const first = buildPrecacheEntries(dirA);
    const second = buildPrecacheEntries(dirB);
    expect(second.shellVersion).toBe(first.shellVersion);
    expect(second.entries).toEqual(first.entries);

    const changed = { ...FULL_DIST, 'assets/index-abc.js': 'console.log(2)' };
    const dirC = fixtureDist(changed);
    const third = buildPrecacheEntries(dirC);
    expect(third.shellVersion).not.toBe(first.shellVersion);
  });
});

describe('renderPrecacheModule / generatePrecache', () => {
  it('renders a typed module carrying the entries and shell version', () => {
    const dir = fixtureDist(FULL_DIST);
    const manifest = buildPrecacheEntries(dir);
    const source = renderPrecacheModule(manifest);
    expect(source).toContain("export const SHELL_VERSION = '" + manifest.shellVersion + "';");
    expect(source).toContain('export const PRECACHE_ENTRIES: readonly PrecacheEntry[] = [');
    expect(source).toContain("  { url: 'index.html', sha256: '");
  });

  it('writes once and reports no change on identical rebuilds (builds never dirty the tree)', () => {
    const dir = fixtureDist(FULL_DIST);
    const outDir = mkdtempSync(join(tmpdir(), 'precache-out-'));
    createdDirs.push(outDir);
    const outFile = join(outDir, 'precache-manifest.ts');

    const first = generatePrecache({ distDir: dir, outFile });
    expect(first.changed).toBe(true);
    expect(first.count).toBe(6);

    const second = generatePrecache({ distDir: dir, outFile });
    expect(second.changed).toBe(false);
    expect(readFileSync(outFile, 'utf8')).toContain('GENERATED FILE');
  });
});
