#!/usr/bin/env node
/**
 * Bundle budget gate — ADR-001 §8, PROJECT_ANALYSIS.md §9.2.
 *
 * Single enforcement point for every size/byte budget. Thresholds and measurement rules live in
 * scripts/bundle-budgets.json (the single source of truth); this script only measures and
 * enforces, so a threshold change is a one-file diff that review can read against §9.2.
 *
 * Measurement (fixed to prevent gate drift): production build output (dist/), gzip level 9,
 * `*.map` never counted (they are never published).
 *
 * Usage:
 *   node scripts/check-bundle-budget.mjs [--dist <dir>] [--budgets <file>] [--json]
 *
 * Exit codes: 0 = every gate passes (warnings allowed), 1 = at least one gate FAILs,
 * 2 = the build output could not be measured (missing manifest / dist).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import process from 'node:process';

const DEFAULT_DIST = 'dist';
const DEFAULT_BUDGETS = new URL('./bundle-budgets.json', import.meta.url);

const KB = 1024;

/** @param {string} glob */
function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += '\\^$.|+()[]{}'.includes(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${source}$`);
}

/** Recursively list every file under `dir`, as posix-style relative paths. */
function walk(dir, prefix = '') {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(dir, rel));
    else out.push(rel);
  }
  return out;
}

function gzipSize(buffer) {
  return gzipSync(buffer, { level: 9 }).byteLength;
}

function readGzipped(distDir, file) {
  return gzipSize(readFileSync(join(distDir, file)));
}

function toKb(bytes) {
  return `${(bytes / KB).toFixed(1)} KB`;
}

function loadBudgets(budgetsPath) {
  const raw = readFileSync(budgetsPath, 'utf8');
  return JSON.parse(raw);
}

function localeTag(filePath) {
  const base = filePath.split('/').pop() ?? '';
  const withoutExt = base.replace(/\.(?:ts|js|mjs)$/, '');
  const prefixed = /^locale-([A-Za-z]{2}(?:[-_][A-Za-z]{2,4})?)/.exec(withoutExt);
  if (prefixed?.[1] !== undefined) return prefixed[1].toLowerCase();
  const bare = /^([A-Za-z]{2}(?:[-_][A-Za-z]{2,4})?)$/.exec(withoutExt);
  return bare?.[1]?.toLowerCase() ?? null;
}

/**
 * Walk the manifest's static `imports` graph from the HTML entry.
 * Dynamic imports are deliberately not followed — they are lazy chunks, not initial payload.
 *
 * @param {Record<string, any>} manifest
 */
function initialClosure(manifest) {
  const entryKeys = Object.keys(manifest).filter(
    (key) => manifest[key]?.isEntry === true && (key.endsWith('.html') || !key.includes('.')),
  );
  const chosen =
    entryKeys.length > 0 ? entryKeys : Object.keys(manifest).filter((k) => manifest[k]?.isEntry);

  /** @type {Set<string>} */
  const seen = new Set();
  const queue = [...chosen];
  while (queue.length > 0) {
    const key = queue.pop();
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    for (const imported of manifest[key]?.imports ?? []) {
      if (!seen.has(imported)) queue.push(imported);
    }
  }
  return seen;
}

function collectLocales(manifest, files, localeConfig) {
  const keyPattern = new RegExp(localeConfig.manifestKeyPattern);
  const filePattern = new RegExp(localeConfig.fileNamePattern);
  /** @type {{tag: string | null, file: string}[]} */
  const locales = [];
  const seenFiles = new Set();

  for (const [key, node] of Object.entries(manifest)) {
    const file = node?.file;
    if (typeof file !== 'string' || !file.endsWith('.js')) continue;
    if (!keyPattern.test(key)) continue;
    locales.push({ tag: localeTag(key), file });
    seenFiles.add(file);
  }
  for (const file of files) {
    if (seenFiles.has(file) || !file.endsWith('.js') || !filePattern.test(file)) continue;
    locales.push({ tag: localeTag(file), file });
    seenFiles.add(file);
  }
  return locales;
}

/**
 * Measure every gate against the build output.
 *
 * @param {{ distDir: string, budgets: any }} input
 */
export function evaluateBundleBudget({ distDir, budgets }) {
  if (!existsSync(distDir)) {
    throw new Error(`dist directory not found: ${distDir} (run \`npm run build\` first)`);
  }
  const manifestPath = join(distDir, '.vite', 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(
      `${manifestPath} not found — the budget gate needs \`build.manifest: true\` in vite.config.ts`,
    );
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const excludeMatchers = budgets.measurement.excludeGlobs.map(globToRegExp);
  const allFiles = walk(distDir);
  const counted = allFiles.filter((file) => !excludeMatchers.some((re) => re.test(file)));

  const closure = initialClosure(manifest);
  /** @type {Set<string>} */
  const initialFiles = new Set();
  for (const key of closure) {
    const node = manifest[key];
    if (node?.file) initialFiles.add(node.file);
    for (const css of node?.css ?? []) initialFiles.add(css);
  }

  const jsFiles = counted.filter((file) => file.endsWith('.js') || file.endsWith('.mjs'));
  const cssFiles = counted.filter((file) => file.endsWith('.css'));

  const initialJsFiles = jsFiles.filter((file) => initialFiles.has(file));
  const locales = collectLocales(manifest, counted, budgets.gates.locales);
  const localeFiles = new Set(locales.map((entry) => entry.file));
  const bootLocaleFiles = locales.filter((entry) => entry.tag === budgets.gates.locales.bootLocale);

  const serviceWorkerFiles = budgets.serviceWorkerFiles.filter((file) => counted.includes(file));
  // ADR-001 §8 / ADR-005 Decision 1: the service worker counts in the `app-shell` sum — it is
  // never a "lazy chunk", so it must not be excluded alongside the lazy route chunks.
  const serviceWorkerSet = new Set(serviceWorkerFiles);

  const lazyJsFiles = jsFiles.filter(
    (file) => !initialFiles.has(file) && !localeFiles.has(file) && !serviceWorkerSet.has(file),
  );
  const lazyJsSet = new Set(lazyJsFiles);
  const nonBootLocaleFiles = locales.filter(
    (entry) => entry.tag !== budgets.gates.locales.bootLocale,
  );
  const nonBootLocaleSet = new Set(nonBootLocaleFiles.map((entry) => entry.file));

  const shellFiles = counted.filter((file) => !lazyJsSet.has(file) && !nonBootLocaleSet.has(file));

  const sizes = new Map();
  const sizeOf = (file) => {
    const cached = sizes.get(file);
    if (cached !== undefined) return cached;
    const size = readGzipped(distDir, file);
    sizes.set(file, size);
    return size;
  };
  const sumOf = (files) => files.reduce((total, file) => total + sizeOf(file), 0);

  const measured = {
    'initial-js': sumOf(initialJsFiles),
    css: sumOf(cssFiles),
    'app-shell': sumOf(shellFiles),
    locales: sumOf([...localeFiles]),
  };

  /** @type {{file: string, line: string}[]} */
  const externalRefs = [];
  const allowedPrefixes = budgets.gates['no-external-refs'].allowedUrlPrefixes;
  const urlRe = /https?:\/\/[^\s"'`\\)<>]+/gu;
  const scannable = /\.(?:js|mjs|css|html|svg|json|txt)$/;
  for (const file of counted) {
    if (!scannable.test(file)) continue;
    const text = readFileSync(join(distDir, file), 'utf8');
    for (const hit of text.match(urlRe) ?? []) {
      if (allowedPrefixes.some((prefix) => hit.startsWith(prefix))) continue;
      externalRefs.push({ file, line: hit });
    }
  }

  const wasmFiles = counted.filter((file) => file.endsWith('.wasm'));

  /** @type {any[]} */
  const results = [];

  const sizeGate = (name) => {
    const gate = budgets.gates[name];
    const value = measured[name];
    const fail = value > gate.limitBytes;
    const warn = !fail && gate.warnBytes !== undefined && value >= gate.warnBytes;
    results.push({
      name,
      kind: 'size',
      measuredBytes: value,
      limitBytes: gate.limitBytes,
      warnBytes: gate.warnBytes ?? null,
      status: fail ? 'FAIL' : warn ? 'WARN' : 'PASS',
      detail:
        name === 'initial-js'
          ? `${initialJsFiles.length} entry-closure chunk(s)`
          : name === 'css'
            ? `${cssFiles.length} file(s)`
            : name === 'app-shell'
              ? `${shellFiles.length} file(s), ${lazyJsFiles.length + nonBootLocaleFiles.length} lazy chunk(s) excluded`
              : `${localeFiles.size} locale pack(s)`,
    });
  };

  sizeGate('initial-js');
  sizeGate('css');
  sizeGate('app-shell');
  sizeGate('locales');

  const localeInClosure = locales.filter((entry) => initialFiles.has(entry.file));
  results.push({
    name: 'locales-lazy',
    kind: 'count',
    measuredBytes: localeInClosure.length,
    limitBytes: 0,
    warnBytes: null,
    status: localeInClosure.length > 0 ? 'FAIL' : 'PASS',
    detail:
      localeInClosure.length > 0
        ? `locale pack(s) inside the initial JS closure: ${localeInClosure.map((e) => e.file).join(', ')}`
        : 'no locale pack is inside the initial JS closure',
  });

  results.push({
    name: 'no-external-refs',
    kind: 'count',
    measuredBytes: externalRefs.length,
    limitBytes: 0,
    warnBytes: null,
    status: externalRefs.length > 0 ? 'FAIL' : 'PASS',
    detail:
      externalRefs.length > 0
        ? externalRefs.map((ref) => `${ref.file} → ${ref.line}`).join('; ')
        : `scanned ${counted.length} shipped file(s)`,
  });

  results.push({
    name: 'no-wasm',
    kind: 'count',
    measuredBytes: wasmFiles.length,
    limitBytes: 0,
    warnBytes: null,
    status: wasmFiles.length > 0 ? 'FAIL' : 'PASS',
    detail: wasmFiles.length > 0 ? wasmFiles.join(', ') : 'no .wasm asset in dist/ (MVP rule)',
  });

  const ok = results.every((result) => result.status !== 'FAIL');

  return {
    ok,
    distDir,
    manifestEntries: Object.keys(manifest).length,
    results,
    context: {
      initialJsFiles,
      cssFiles,
      shellFiles,
      lazyFiles: [...lazyJsSet],
      locales: locales.map((entry) => `${entry.file} (${entry.tag ?? 'unknown'})`),
      serviceWorkerFiles,
      measured,
    },
  };
}

export function formatReport(report) {
  const pad = (value, width) => String(value).padEnd(width);
  const lines = [];
  lines.push(`Bundle budget report — ${report.distDir} (gzip level 9)`);
  lines.push(`  ${pad('gate', 18)}${pad('measured', 12)}${pad('limit', 12)}status`);
  for (const result of report.results) {
    const measured =
      result.kind === 'size' ? toKb(result.measuredBytes) : `${result.measuredBytes} hit(s)`;
    const limit = result.kind === 'size' ? toKb(result.limitBytes) : '0';
    lines.push(`  ${pad(result.name, 18)}${pad(measured, 12)}${pad(limit, 12)}${result.status}`);
    if (result.status !== 'PASS' || result.detail.length < 90) {
      lines.push(`      ${result.detail}`);
    }
    if (result.kind === 'size' && result.warnBytes !== null && result.status === 'WARN') {
      lines.push(`      warn threshold ${toKb(result.warnBytes)} (target of section 9.2)`);
    }
  }
  lines.push(report.ok ? 'RESULT: PASS' : 'RESULT: FAIL — build is over budget');
  return lines.join('\n');
}

/** @param {{distDir?: string, budgetsPath?: string}} [options] */
export function checkBundleBudget(options = {}) {
  const distDir = resolve(options.distDir ?? DEFAULT_DIST);
  const budgetsPath = options.budgetsPath ?? fileURLToPath(DEFAULT_BUDGETS);
  const budgets = loadBudgets(budgetsPath);
  const report = evaluateBundleBudget({ distDir, budgets });
  return { report, text: formatReport(report), json: JSON.stringify(report, null, 2) };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dist') {
      options.distDir = argv[i + 1];
      i += 1;
    } else if (arg === '--budgets') {
      options.budgetsPath = argv[i + 1];
      i += 1;
    } else if (arg === '--json') {
      options.json = true;
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
    const { report, text, json } = checkBundleBudget(options);
    if (options.json === true) console.log(json);
    else console.log(text);
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    console.error(`bundle-budget: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
