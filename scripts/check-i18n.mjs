#!/usr/bin/env node
/**
 * i18n catalog gate — M15 (PROJECT_ANALYSIS §4 M15), wired into CI as `npm run i18n:check`.
 *
 * Enforces the contract every UI card consumes (decomposition card t_1b9ee0e6): `en.json`
 * (English = source of truth) and `th.json` (PO-validated content) are flat catalogs of
 * dotted keys with IDENTICAL key sets and IDENTICAL `{name}` placeholder sets, and every
 * literal `t('…')` call site in `src/` resolves to a key `en.json` defines.
 *
 * FAIL (exit 1) on: a key missing from either file · a non-string or empty value · a
 * malformed key · a duplicate JSON key (JSON.parse silently keeps the last one) · placeholder
 * sets that differ · a key used in src/ that en.json does not define.
 *
 * INFORMATIONAL (never a failure): `t(...)` call sites with a non-literal argument — they
 * cannot be verified statically, so they are listed for human review.
 *
 * Usage:
 *   node scripts/check-i18n.mjs [--en <file>] [--th <file>] [--src <dir>] [--json]
 *
 * Exit codes: 0 = catalogs consistent, 1 = at least one violation, 2 = input unreadable.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import process from 'node:process';

const DEFAULT_EN = 'src/i18n/en.json';
const DEFAULT_TH = 'src/i18n/th.json';
const DEFAULT_SRC = 'src';

/** Accept a `file://` URL, a `URL` instance, or a plain (possibly relative) path. */
function toPath(value) {
  if (value instanceof URL) return fileURLToPath(value);
  if (typeof value === 'string' && value.startsWith('file://')) return fileURLToPath(value);
  return String(value);
}

/** `domain.element[.state]`, camelCase segments allowed, must start lowercase (§5.8). */
export const KEY_PATTERN = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/u;

/** A catalog entry pattern used to count how often a parsed key appears in the raw text. */
const PLACEHOLDER = /\{(\w+)\}/gu;

/**
 * Duplicate keys never survive `JSON.parse` (the last one silently wins), so count each
 * parsed key's `"key":` occurrences in the raw text instead of trusting the parse.
 */
export function findDuplicateKeys(raw) {
  const parsed = JSON.parse(raw);
  const duplicates = [];
  for (const key of Object.keys(parsed)) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const occurrences = raw.match(new RegExp(`"${escaped}"\\s*:`, 'gu'));
    if (occurrences !== null && occurrences.length > 1) duplicates.push(key);
  }
  return duplicates.sort();
}

/** The `{name}` placeholder set of a template (order-independent comparison). */
export function placeholdersOf(text) {
  return new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? ''));
}

/**
 * Collect `t('…')` / `t("…")` keys from one source file plus the call sites whose key is
 * not a string literal (those are unverifiable statically → informational).
 */
export function findKeyUsages(source) {
  const literal = new Set();
  const dynamic = [];
  const lines = source.split('\n');
  lines.forEach((line, index) => {
    // Comment lines document the API, they do not call it (e.g. the contract in i18n.ts).
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return;
    for (const match of line.matchAll(/(?<![\w$])t\(\s*'([^']+)'/gu)) {
      literal.add(match[1]);
    }
    for (const match of line.matchAll(/(?<![\w$])t\(\s*"([^"]+)"/gu)) {
      literal.add(match[1]);
    }
    if (/(?<![\w$])t\(\s*(?!['"])/u.test(line)) dynamic.push(index + 1);
  });
  return { literal, dynamic };
}

/** Recursive list of `*.ts` / `*.tsx` files under `dir`, posix-style relative paths. */
function listSourceFiles(dir, prefix = '') {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(dir, rel));
      continue;
    }
    if (/\.tsx?$/u.test(rel)) out.push(rel);
  }
  return out;
}

/**
 * Compare the two catalogs. Pure — the CLI and the unit tests share this exact logic.
 *
 * @param {Record<string, unknown>} en
 * @param {Record<string, unknown>} th
 */
export function compareCatalogs(en, th) {
  const issues = [];

  for (const [key, value] of Object.entries(en)) {
    if (!KEY_PATTERN.test(key)) issues.push({ kind: 'bad-key', detail: `en: "${key}"` });
    if (typeof value !== 'string') {
      issues.push({ kind: 'non-string-value', detail: `en: "${key}" is not a string` });
      continue;
    }
    if (value.trim() === '') {
      issues.push({ kind: 'empty-value', detail: `en: "${key}"` });
      continue;
    }
    if (!(key in th)) issues.push({ kind: 'missing-in-th', detail: `"${key}"` });
  }

  for (const [key, value] of Object.entries(th)) {
    if (!KEY_PATTERN.test(key)) issues.push({ kind: 'bad-key', detail: `th: "${key}"` });
    if (typeof value !== 'string') {
      issues.push({ kind: 'non-string-value', detail: `th: "${key}" is not a string` });
      continue;
    }
    if (value.trim() === '') {
      issues.push({ kind: 'empty-value', detail: `th: "${key}"` });
      continue;
    }
    if (!(key in en)) issues.push({ kind: 'extra-in-th', detail: `"${key}"` });
  }

  for (const key of Object.keys(en)) {
    if (!(key in th)) continue;
    const enValue = en[key];
    const thValue = th[key];
    if (typeof enValue !== 'string' || typeof thValue !== 'string') continue;
    const enPlaceholders = [...placeholdersOf(enValue)].sort();
    const thPlaceholders = [...placeholdersOf(thValue)].sort();
    if (enPlaceholders.join(',') !== thPlaceholders.join(',')) {
      issues.push({
        kind: 'placeholder-mismatch',
        detail: `"${key}": en {${enPlaceholders.join(',')}} vs th {${thPlaceholders.join(',')}}`,
      });
    }
  }

  return issues;
}

/**
 * Run the full gate: both catalogs + every literal `t()` call site under `src/`
 * (excluding the runtime's own directory, which defines rather than calls the API).
 *
 * @param {{ enPath?: string, thPath?: string, srcDir?: string }} [options]
 */
export function checkI18n(options = {}) {
  const enPath = toPath(options.enPath ?? DEFAULT_EN);
  const thPath = toPath(options.thPath ?? DEFAULT_TH);
  const srcDir = toPath(options.srcDir ?? DEFAULT_SRC);

  const enRaw = readFileSync(enPath, 'utf8');
  const thRaw = readFileSync(thPath, 'utf8');
  const en = JSON.parse(enRaw);
  const th = JSON.parse(thRaw);

  const issues = [];
  for (const key of findDuplicateKeys(enRaw)) {
    issues.push({ kind: 'duplicate-key', detail: `en.json: "${key}"` });
  }
  for (const key of findDuplicateKeys(thRaw)) {
    issues.push({ kind: 'duplicate-key', detail: `th.json: "${key}"` });
  }
  issues.push(...compareCatalogs(en, th));

  const enKeys = new Set(Object.keys(en));
  const usedKeys = new Set();
  const dynamicCallSites = [];
  let literalCallSites = 0;
  for (const file of listSourceFiles(srcDir)) {
    if (file.startsWith('i18n/')) continue; // the runtime implements t(), it does not call it
    const { literal, dynamic } = findKeyUsages(readFileSync(join(srcDir, file), 'utf8'));
    for (const key of literal) usedKeys.add(key);
    literalCallSites += literal.size;
    for (const line of dynamic) dynamicCallSites.push(`${file}:${line}`);
  }
  for (const key of [...usedKeys].sort()) {
    if (!enKeys.has(key)) {
      issues.push({
        kind: 'unknown-key',
        detail: `used in src/ but missing from en.json: "${key}"`,
      });
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    stats: {
      enKeys: enKeys.size,
      thKeys: Object.keys(th).length,
      usedKeys: usedKeys.size,
      literalCallSites,
      dynamicCallSites,
    },
  };
}

export function formatReport(report) {
  const lines = [];
  lines.push('i18n catalog check — src/i18n/en.json vs src/i18n/th.json');
  lines.push(
    `  keys: ${report.stats.enKeys} en / ${report.stats.thKeys} th · ` +
      `${report.stats.usedKeys} distinct keys used by ${report.stats.literalCallSites} literal t() call site(s)`,
  );
  for (const issue of report.issues) {
    lines.push(`  FAIL ${issue.kind}: ${issue.detail}`);
  }
  if (report.stats.dynamicCallSites.length > 0) {
    lines.push(
      `  note: ${report.stats.dynamicCallSites.length} t() call site(s) with a non-literal key ` +
        '(not statically verifiable):',
    );
    for (const site of report.stats.dynamicCallSites) lines.push(`    ${site}`);
  }
  lines.push(
    report.ok
      ? 'RESULT: PASS — en/th key sets, values and placeholders are consistent'
      : `RESULT: FAIL — ${report.issues.length} violation(s)`,
  );
  return lines.join('\n');
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--en') {
      options.enPath = requireValue(argv[i + 1]);
      i += 1;
    } else if (arg === '--th') {
      options.thPath = requireValue(argv[i + 1]);
      i += 1;
    } else if (arg === '--src') {
      options.srcDir = requireValue(argv[i + 1]);
      i += 1;
    } else if (arg === '--json') {
      options.json = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function requireValue(value) {
  if (value === undefined) throw new Error('Missing value after option');
  return value;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) ===
    (process.argv[1].startsWith('/') ? process.argv[1] : `${process.cwd()}/${process.argv[1]}`);

if (invokedDirectly) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = checkI18n(options);
    if (options.json === true) console.log(JSON.stringify(report, null, 2));
    else console.log(formatReport(report));
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    console.error(`i18n:check: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
