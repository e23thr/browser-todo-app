/**
 * ADR-008 Decision 2 (unit): self-hosted install icons.
 *
 * The icons are generated procedurally (scripts/generate-icons.mjs) and COMMITTED — this suite
 * guards three things: the committed PIXELS are exactly what the generator draws (a manual
 * edit or a non-deterministic generator fails the build), every file is a real PNG at its
 * declared size, and the maskable art keeps its glyph inside the central 80% safe zone so
 * Android adaptive icons never crop the mark.
 *
 * The committed-vs-generated guard deliberately compares decoded pixels, NOT compressed bytes:
 * `deflateSync` output depends on the zlib build linked into the node binary — node's patched
 * fork `1.3.1-e00f703` (what actions/setup-node installs) compresses differently from the plain
 * `zlib 1.3.1` in this box's custom node — so a byte compare greens on the one machine that
 * generated the icons and reds everywhere else even when every pixel is identical.
 */

import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

import { afterAll, describe, expect, it } from 'vitest';

import { ICON_SPECS, drawIcon, encodePng, generateIcons } from '../../scripts/generate-icons.mjs';

// Vitest's jsdom environment does not give this file a `file:` import.meta.url, so the
// committed icons are located from the repo root (vitest runs with cwd = repo root).
const ICONS_DIR = resolve(process.cwd(), 'public', 'icons');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Decode an 8-bit RGBA, non-interlaced PNG back to its raw `size * size * 4` pixel buffer.
 *
 * Only filter type 0 (None) is supported — the only filter `encodePng` emits — so any other
 * filter byte means the committed file was re-encoded by something other than `npm run icons`
 * and belongs in the drift bucket anyway.
 */
function decodePngRgba(bytes: Buffer): Buffer {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('decodePngRgba: not a PNG (bad signature)');
  }

  let offset = 8;
  let size = 0;
  const idat: Buffer[] = [];
  let ended = false;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      size = data.readUInt32BE(0);
      if (data.readUInt32BE(4) !== size) throw new Error('decodePngRgba: non-square IHDR');
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) {
        throw new Error('decodePngRgba: expected an 8-bit RGBA, non-interlaced PNG');
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      ended = true;
    }
    offset += 12 + length;
  }
  if (size === 0 || idat.length === 0 || !ended) {
    throw new Error('decodePngRgba: truncated PNG (missing IHDR, IDAT or IEND)');
  }

  const stride = size * 4;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    if (filter !== 0) {
      throw new Error(
        `decodePngRgba: unsupported PNG filter type ${String(filter)} on row ${String(y)}`,
      );
    }
    raw.copy(pixels, y * stride, rowStart + 1, rowStart + 1 + stride);
  }
  return pixels;
}

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

  it('round-trips through the pixel decoder (encode -> decode == original pixels)', () => {
    // Deliberately non-uniform pixels so a stride/offset slip cannot pass.
    const rgba = Buffer.alloc(8 * 8 * 4);
    for (let i = 0; i < rgba.length; i += 1) rgba[i] = (i * 7) % 256;
    expect(decodePngRgba(encodePng(8, rgba)).equals(rgba)).toBe(true);
  });
});

describe('generated icon set', () => {
  it.each(ICON_SPECS.map((spec) => [spec.file, spec] as const))(
    'committed %s pixels match the generator',
    (file, spec) => {
      // Compare decoded PIXELS, not compressed bytes: deflate output differs between the
      // plain zlib (1.3.1) this box's node links and node's patched fork (1.3.1-e00f703)
      // that actions/setup-node installs, so a byte compare would pin the guard to one
      // machine's compressor. The pixels are byte-identical under both builds.
      const generated = drawIcon(spec);
      const committed = decodePngRgba(readFileSync(join(ICONS_DIR, file)));
      expect(committed.length).toBe(spec.size * spec.size * 4);
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
