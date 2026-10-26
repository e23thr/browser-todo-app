#!/usr/bin/env node
/**
 * PWA icon generation — ADR-008 Decision 2 (E6, S13).
 *
 * Emits the self-hosted install icons into `public/icons/` as real PNGs, generated
 * procedurally from pixel math (rounded-square accent tile + white checkmark — the same mark as
 * `public/favicon.svg`). ZERO third-party bytes and zero image dependencies: the PNG encoder is
 * ~60 lines of `zlib` + CRC-32, and the drawing is antialiased signed-distance math, so the
 * committed pixels are fully deterministic (`tests/unit/generate-icons.test.ts` proves a fresh run
 * reproduces the committed PIXELS — decode + compare, not deflate bytes, which differ between
 * node's patched zlib 1.3.1-e00f703 (CI/setup-node) and the plain zlib 1.3.1 on the dev box).
 *
 * Files (sizes chosen for the installability matrix, ADR-008 Decision 2):
 *   icon-192.png / icon-512.png            purpose `any`      — Chromium installability floor
 *   maskable-192.png / maskable-512.png    purpose `maskable` — Android adaptive icons
 *   apple-touch-icon-180.png               (root of icons/)   — iOS Safari home-screen icon
 *
 * Maskable art keeps every pixel of the glyph inside the central 80% safe zone; the apple-touch
 * tile is full-bleed (iOS applies its own corner mask and forbids transparency there).
 *
 * Usage:
 *   node scripts/generate-icons.mjs [--out <dir>]   (default: public/icons)
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import process from 'node:process';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = join(REPO_ROOT, 'public', 'icons');

/** Brand accent (tokens.css `--color-accent`) and the checkmark fill. */
const ACCENT = [46, 79, 196];
const CHECK = [255, 255, 255];

/**
 * The generated icon set. `style: 'rounded'` leaves transparent corners, `'full'` paints the
 * tile edge-to-edge (maskable + apple-touch), and `safe` scales the glyph into the maskable
 * safe zone.
 *
 * @type {readonly {file: string, size: number, style: 'rounded' | 'full', safe: boolean}[]}
 */
export const ICON_SPECS = [
  { file: 'icon-192.png', size: 192, style: 'rounded', safe: false },
  { file: 'icon-512.png', size: 512, style: 'rounded', safe: false },
  { file: 'maskable-192.png', size: 192, style: 'full', safe: true },
  { file: 'maskable-512.png', size: 512, style: 'full', safe: true },
  { file: 'apple-touch-icon-180.png', size: 180, style: 'full', safe: false },
];

/* ------------------------------- PNG encoding ------------------------------ */

const CRC_TABLE = (() => {
  /** @type {number[]} */
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * CRC-32 (IEEE) over a byte sequence — PNG chunk checksums.
 *
 * @param {Buffer} buf
 */
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Assemble one PNG chunk: length + type + data + CRC-32(type + data).
 *
 * @param {string} type
 * @param {Buffer} data
 */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * Encode 8-bit RGBA pixels as a PNG.
 *
 * @param {number} size square edge length in pixels
 * @param {Buffer} rgba `size * size * 4` bytes, row-major, non-premultiplied
 * @returns {Buffer} the PNG bytes
 */
export function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive (we emit filter 0 per row)
  ihdr[12] = 0; // interlace: none

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------------- drawing -------------------------------- */

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

/**
 * Signed distance from `px,py` to the rounded box centered on (0.5, 0.5) with the given
 * half-extent and corner radius (unit coordinates).
 */
function roundedBoxSdf(px, py, half, radius) {
  const qx = Math.abs(px - 0.5) - (half - radius);
  const qy = Math.abs(py - 0.5) - (half - radius);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Signed distance from `px,py` to the segment `a -> b` (unit coordinates). */
function segmentSdf(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : clamp01((wx * vx + wy * vy) / len2);
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/**
 * Rasterise one icon into RGBA pixels.
 *
 * @param {{size: number, style: 'rounded' | 'full', safe: boolean}} spec
 * @returns {Buffer} `size * size * 4` bytes
 */
export function drawIcon(spec) {
  const { size, style, safe } = spec;
  const pixels = Buffer.alloc(size * size * 4);

  // Maskable art shrinks the glyph into the central 80% safe zone (0.72 keeps every stroke
  // inside it); everything else uses the full tile minus padding.
  const [cx1, cy1, cx2, cy2] = [0.28, 0.52, 0.44, 0.68].map((v) =>
    safe ? 0.5 + (v - 0.5) * 0.72 : v,
  );
  const [ex, ey] = [0.72, 0.34].map((v) => (safe ? 0.5 + (v - 0.5) * 0.72 : v));
  const stroke = (safe ? 0.085 : 0.1) / 2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // Sample at pixel centers, in unit coordinates.
      const px = (x + 0.5) / size;
      const py = (y + 0.5) / size;

      // Tile: rounded square (transparent outside) or full-bleed square.
      const tile =
        style === 'rounded'
          ? 1 - smooth(-0.6 / size, 0.6 / size, roundedBoxSdf(px, py, 0.5, 0.22))
          : 1;

      // Checkmark: two round-capped segments.
      const d = Math.min(
        segmentSdf(px, py, cx1, cy1, cx2, cy2),
        segmentSdf(px, py, cx2, cy2, ex, ey),
      );
      const mark = 1 - smooth(stroke - 0.6 / size, stroke + 0.6 / size, d);

      const alpha = clamp01(Math.max(tile, mark));
      const mix = clamp01(mark / Math.max(alpha, 1e-6));
      const i = (y * size + x) * 4;
      pixels[i] = Math.round(ACCENT[0] + (CHECK[0] - ACCENT[0]) * mix);
      pixels[i + 1] = Math.round(ACCENT[1] + (CHECK[1] - ACCENT[1]) * mix);
      pixels[i + 2] = Math.round(ACCENT[2] + (CHECK[2] - ACCENT[2]) * mix);
      pixels[i + 3] = Math.round(alpha * 255);
    }
  }

  return pixels;
}

/**
 * Generate every icon into `outDir`.
 *
 * @param {string} outDir
 * @returns {{file: string, bytes: Buffer}[]}
 */
export function generateIcons(outDir) {
  mkdirSync(outDir, { recursive: true });
  /** @type {{file: string, bytes: Buffer}[]} */
  const written = [];
  for (const spec of ICON_SPECS) {
    const bytes = encodePng(spec.size, drawIcon(spec));
    writeFileSync(join(outDir, spec.file), bytes);
    written.push({ file: spec.file, bytes });
  }
  return written;
}

function parseArgs(argv) {
  /** @type {{outDir?: string, check?: boolean}} */
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      options.outDir = argv[i + 1];
      i += 1;
    } else if (arg === '--check') {
      options.check = true;
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
    const outDir = resolve(options.outDir ?? DEFAULT_OUT);
    if (options.check === true) {
      // Verification mode: fail loudly when committed bytes drift from the generator.
      let ok = true;
      for (const spec of ICON_SPECS) {
        const expected = encodePng(spec.size, drawIcon(spec));
        const file = join(outDir, spec.file);
        const actual = existsSync(file) ? readFileSync(file) : null;
        const same = actual !== null && actual.equals(expected);
        if (!same) ok = false;
        console.log(`icons: ${spec.file} ${same ? 'ok' : 'DRIFT — run `npm run icons`'}`);
      }
      if (!ok) process.exitCode = 1;
    } else {
      for (const { file, bytes } of generateIcons(outDir)) {
        console.log(`icons: ${file} (${bytes.length} bytes) -> ${join(outDir, file)}`);
      }
    }
  } catch (error) {
    console.error(`generate-icons: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
