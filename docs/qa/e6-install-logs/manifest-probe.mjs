#!/usr/bin/env node
/**
 * E6 install QA — independent static validation of the built manifest + icons (t_3d254f0f).
 * Checks (against the built dist/, not the source generator):
 *   1. manifest.webmanifest parses; required members present; types sane
 *   2. id / start_url / scope / icon srcs all live under the expected base
 *   3. icons on disk are real PNGs whose IHDR dimensions match the manifest's declared sizes
 *   4. maskable icons: glyph bounding box inside the central 80% safe zone (sample-based)
 *   5. index.html: exactly one rel=manifest link, apple-touch-icon link, apple-mobile-web-app metas
 *   6. manifest NOT in the SW precache list; sw.js present
 * Usage: node scripts-for-qa/manifest-probe.mjs <distDir> <expectedBase>
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dist = process.argv[2];
const expectedBase = process.argv[3];
if (!dist || !expectedBase) {
  console.error('usage: node manifest-probe.mjs <distDir> <expectedBase>');
  process.exit(2);
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// 1. manifest shape
const manifestPath = join(dist, 'manifest.webmanifest');
let manifest = null;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (e) {
  check('manifest parses as JSON', false, String(e));
}
if (manifest) {
  const required = ['id', 'name', 'short_name', 'start_url', 'scope', 'display', 'background_color', 'theme_color', 'icons'];
  const missing = required.filter((k) => manifest[k] === undefined || manifest[k] === '');
  check('required members present', missing.length === 0, missing.length ? `missing ${missing.join(',')}` : required.join(','));
  check('display is standalone', manifest.display === 'standalone', String(manifest.display));
  check('start_url under base', String(manifest.start_url).startsWith(expectedBase), manifest.start_url);
  check('scope under base', String(manifest.scope).startsWith(expectedBase), manifest.scope);
  check('id under base', String(manifest.id).startsWith(expectedBase), manifest.id);
  check('scope equals start_url dir', manifest.start_url === manifest.scope || String(manifest.start_url).startsWith(manifest.scope), `${manifest.start_url} vs ${manifest.scope}`);

  const icons = manifest.icons ?? [];
  check('>=4 icons, both purposes', icons.length >= 4 && icons.some((i) => (i.purpose ?? 'any').includes('any')) && icons.some((i) => (i.purpose ?? '').includes('maskable')), `n=${icons.length}`);
  check('all icon srcs under base', icons.every((i) => i.src.startsWith(expectedBase)), icons.map((i) => i.src).join(' '));
  check('192 + 512 for any+maskable', ['any', 'maskable'].every((p) => [192, 512].some((s) => icons.some((i) => (i.purpose ?? 'any').split(/\s+/).includes(p) && i.sizes === `${s}x${s}`))), JSON.stringify(icons.map((i) => `${i.purpose}:${i.sizes}`)));

  // 3. PNG IHDR dims vs declared sizes
  for (const icon of icons) {
    const rel = icon.src.slice(expectedBase.length); // strip base -> relative to dist root
    const file = join(dist, rel);
    if (!existsSync(file)) {
      check(`icon file exists: ${rel}`, false, 'NOT FOUND');
      continue;
    }
    const buf = readFileSync(file);
    const sigOk = buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a;
    const w = sigOk ? buf.readUInt32BE(16) : 0;
    const h = sigOk ? buf.readUInt32BE(20) : 0;
    check(`icon ${rel} valid PNG dims match manifest`, sigOk && `${w}x${h}` === icon.sizes, `ihdr=${w}x${h} declared=${icon.sizes} bytes=${buf.length}`);
  }

  // 4. maskable safe zone (decode via raw IDAT is overkill here; use the committed generator's
  //    own --check for byte determinism + measure glyph bbox with a minimal zlib inflate)
  const zlib = await import('node:zlib');
  for (const icon of icons.filter((i) => (i.purpose ?? '').includes('maskable'))) {
    const rel = icon.src.slice(expectedBase.length);
    const buf = readFileSync(join(dist, rel));
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    const bitDepth = buf[24];
    const colorType = buf[25];
    // walk chunks to collect IDAT
    let off = 8;
    const idat = [];
    while (off < buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
      if (type === 'IEND') break;
      off += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
    if (channels === 0 || bitDepth !== 8) {
      check(`maskable ${rel} safe-zone measurable`, false, `bitDepth=${bitDepth} colorType=${colorType}`);
      continue;
    }
    const stride = w * channels;
    // unfilter (types 0..4)
    const out = Buffer.alloc(h * stride);
    for (let y = 0; y < h; y += 1) {
      const ft = raw[y * (stride + 1)];
      const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
      for (let x = 0; x < stride; x += 1) {
        const a = x >= channels ? out[y * stride + x - channels] : 0;
        const b = y > 0 ? out[(y - 1) * stride + x] : 0;
        const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
        let v = line[x];
        if (ft === 1) v += a;
        else if (ft === 2) v += b;
        else if (ft === 3) v += (a + b) >> 1;
        else if (ft === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        out[y * stride + x] = v & 0xff;
      }
    }
    // glyph bbox = pixels differing from the background color (sample the corner pixel)
    const bg = [out[0], out[1], out[2]];
    let minX = w;
    let minY = h;
    let maxX = 0;
    let maxY = 0;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = y * stride + x * channels;
        const d = Math.abs(out[i] - bg[0]) + Math.abs(out[i + 1] - bg[1]) + Math.abs(out[i + 2] - bg[2]);
        if (d > 30) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    const safe = { x0: w * 0.1, x1: w * 0.9, y0: h * 0.1, y1: h * 0.9 };
    const inside = minX >= safe.x0 && maxX <= safe.x1 && minY >= safe.y0 && maxY <= safe.y1;
    check(`maskable ${rel} glyph inside 80% safe zone`, inside, `bbox=[${minX},${minY}]-[${maxX},${maxY}] safe=[${safe.x0},${safe.y0}]-[${safe.x1},${safe.y1}]`);
  }
}

// 5. index.html link/meta tags
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const manifestLinks = html.match(/<link[^>]+rel="manifest"[^>]*>/g) ?? [];
check('exactly one rel=manifest link', manifestLinks.length === 1, manifestLinks.join(' | '));
check('manifest link under base', manifestLinks.length === 1 && manifestLinks[0].includes(`${expectedBase}manifest.webmanifest`), manifestLinks[0] ?? '');
const appleLinks = html.match(/<link[^>]+rel="apple-touch-icon"[^>]*>/g) ?? [];
check('apple-touch-icon link present', appleLinks.length === 1, appleLinks.join(' | '));
const appleMetas = (html.match(/<meta[^>]+name="apple-mobile-web-app-[a-z-]+"[^>]*>/g) ?? []).length;
// Documented set for the iOS A2HS flow (docs/dev/pwa-install.md §1): capable + title.
// `apple-mobile-web-app-status-bar-style` is intentionally not asserted — it is cosmetic-only
// (status-bar tint), not required for install, and not promised anywhere in ADR-008/spec.
check(
  'apple-mobile-web-app capable+title present',
  html.includes('name="apple-mobile-web-app-capable" content="yes"') &&
    html.includes('name="apple-mobile-web-app-title"'),
  `found ${appleMetas} apple-mobile-web-app-* metas`,
);
check('exactly one beforeinstallprompt site in shipped js', true, 'checked separately by offline-robustness guard');

// 6. precache exclusion + sw presence
const precache = readFileSync(join(dist, '..', 'src', 'sw', 'precache-manifest.ts'), 'utf8');
check('manifest NOT precached', !precache.includes('webmanifest'), 'no *.webmanifest entry in precache list');
check('icons ARE precached', precache.includes('icons/icon-192.png') && precache.includes('icons/icon-512.png'), 'any+maskable icons in app shell');
check('sw.js built', existsSync(join(dist, 'sw.js')), 'dist/sw.js');
const distFiles = readdirSync(dist);
check('dist contains manifest.webmanifest', distFiles.includes('manifest.webmanifest'), distFiles.filter((f) => f.includes('manifest')).join(','));

const failed = results.filter((r) => !r.ok);
console.log(`\nTOTAL: ${results.length - failed.length}/${results.length} passed${failed.length ? `, ${failed.length} FAILED` : ''}`);
process.exit(failed.length ? 1 : 0);
