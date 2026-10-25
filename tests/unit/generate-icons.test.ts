/**
 * ADR-008 Decision 2 (unit): self-hosted install icons.
 *
 * The icons are generated procedurally (scripts/generate-icons.mjs) and COMMITTED — this suite
 * guards three things: the committed bytes are exactly what the generator produces (a manual
 * edit or a non-deterministic generator fails the build), every file is a real PNG at its
 * declared size, and the maskable art keeps its glyph inside the central 80% safe zone so
 * Android adaptive icons never crop the mark.
 */

import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { ICON_SPECS, drawIcon, encodePng, generateIcons } from '../../scripts/generate-icons.mjs';

// Vitest's jsdom environment does not give this file a `file:` import.meta.url, so the
// committed icons are located from the repo root (vitest runs with cwd = repo root).
const ICONS_DIR = resolve(process.cwd(), 'public', 'icons');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const createdDirs: string[] = [];

afterAll(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: false });
});

describe('PNG encoding', () => {
  it('emits a valid IHDR at the declared size', () => {
    const bytes = encodePng(4, Buffer.alloc(4 * 4 * 4));
    expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    // 8-byte signature, 8-byte chunk header, then width/height as big-endian uint32.
    expect(bytes.readUInt32BE(16)).toBe(4);
    expect(bytes.readUInt32BE(20)).toBe(4);
    expect(bytes.toString('ascii', 12, 16)).toBe('IHDR');
    expect(bytes.toString('ascii', bytes.length - 8, bytes.length - 4)).toBe('IEND');
  });

  it('is deterministic', () => {
    const rgba = Buffer.alloc(16 * 16 * 4, 128);
    expect(encodePng(16, rgba).equals(encodePng(16, rgba))).toBe(true);
  });
});

describe('generated icon set', () => {
  it.each(ICON_SPECS.map((spec) => [spec.file, spec] as const))(
    'committed %s matches the generator byte-for-byte',
    (file, spec) => {
      const generated = encodePng(spec.size, drawIcon(spec));
      const committed = readFileSync(join(ICONS_DIR, file));
      expect(committed.equals(generated)).toBe(true);
    },
  );

  it('writes exactly the declared set (any, maskable, apple-touch)', () => {
    expect(ICON_SPECS.map((spec) => spec.file).sort()).toEqual([
      'apple-touch-icon-180.png',
      'icon-192.png',
      'icon-512.png',
      'maskable-192.png',
      'maskable-512.png',
    ]);
  });

  it('is stable across runs (no timestamps or randomness in the bytes)', () => {
    const first = mkdtempSync(join(tmpdir(), 'icons-'));
    const second = mkdtempSync(join(tmpdir(), 'icons-'));
    createdDirs.push(first, second);
    const a = generateIcons(first);
    const b = generateIcons(second);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i += 1) {
      expect(a[i]?.file).toBe(b[i]?.file);
      expect(a[i]?.bytes.equals(b[i]?.bytes ?? Buffer.alloc(0))).toBe(true);
    }
  });
});

describe('maskable safe zone (Android adaptive icons)', () => {
  it.each(ICON_SPECS.filter((spec) => spec.safe))(
    'keeps %s glyph pixels inside the central 80%%',
    (spec) => {
      const pixels = drawIcon(spec);
      const lo = spec.size * 0.1;
      const hi = spec.size * 0.9;
      for (let y = 0; y < spec.size; y += 1) {
        for (let x = 0; x < spec.size; x += 1) {
          const i = (y * spec.size + x) * 4;
          const [r, g, b, a] = [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
          const isGlyph = (a ?? 0) > 128 && (r ?? 0) > 200 && (g ?? 0) > 200 && (b ?? 0) > 200;
          if (!isGlyph) continue;
          expect(x).toBeGreaterThanOrEqual(lo);
          expect(x).toBeLessThan(hi);
          expect(y).toBeGreaterThanOrEqual(lo);
          expect(y).toBeLessThan(hi);
        }
      }
    },
  );
});
