import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  checkI18n,
  compareCatalogs,
  findDuplicateKeys,
  findKeyUsages,
  formatReport,
  placeholdersOf,
} from '../../scripts/check-i18n.mjs';

/**
 * The catalog gate must fail loudly (a gate that never fails is a defect, §9.5): every
 * violation class is proven against fixtures, then the REAL catalogs are asserted clean so
 * this suite is itself a CI guard.
 */

const createdDirs: string[] = [];

afterAll(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): {
  enPath: string;
  thPath: string;
  srcDir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'i18n-check-'));
  createdDirs.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'en.json'), files['en.json'] ?? '{}');
  writeFileSync(join(dir, 'th.json'), files['th.json'] ?? '{}');
  writeFileSync(join(dir, 'src', 'app.tsx'), files['app.tsx'] ?? 'export {};');
  return {
    enPath: `file://${join(dir, 'en.json')}`,
    thPath: `file://${join(dir, 'th.json')}`,
    srcDir: `file://${join(dir, 'src')}`,
  };
}

const GOOD_EN = { 'nav.today': 'Today', 'view.count': '{count} tasks' };
const GOOD_TH = { 'nav.today': 'วันนี้', 'view.count': '{count} งาน' };

describe('compareCatalogs', () => {
  it('passes identical catalogs with identical placeholders', () => {
    expect(compareCatalogs(GOOD_EN, GOOD_TH)).toEqual([]);
  });

  it('flags a key missing from th', () => {
    const issues = compareCatalogs(GOOD_EN, { 'nav.today': 'วันนี้' });
    expect(issues).toEqual([{ kind: 'missing-in-th', detail: '"view.count"' }]);
  });

  it('flags a key extra in th', () => {
    const issues = compareCatalogs({ 'nav.today': 'Today' }, { ...GOOD_TH });
    expect(issues.map((issue) => issue.kind)).toContain('extra-in-th');
  });

  it('flags placeholder sets that differ', () => {
    const issues = compareCatalogs(
      { 'view.count': '{count} tasks' },
      { 'view.count': 'งาน {amount}' },
    );
    expect(issues).toEqual([
      {
        kind: 'placeholder-mismatch',
        detail: '"view.count": en {count} vs th {amount}',
      },
    ]);
  });

  it('flags non-string and empty values', () => {
    const issues = compareCatalogs(
      { 'nav.today': 42, 'nav.lists': '   ' },
      { 'nav.today': 'วันนี้', 'nav.lists': 'รายการ' },
    );
    expect(issues.map((issue) => issue.kind).sort()).toEqual(['empty-value', 'non-string-value']);
  });

  it('flags malformed keys', () => {
    const issues = compareCatalogs({ 'Nav.Today': 'x' }, { 'Nav.Today': 'y' });
    expect(issues.map((issue) => issue.kind)).toEqual(['bad-key', 'bad-key']);
  });
});

describe('raw-text checks', () => {
  it('detects duplicate keys JSON.parse would silently collapse', () => {
    const raw = ['{', '  "nav.today": "Today",', '  "nav.today": "Today again"', '}'].join('\n');
    expect(findDuplicateKeys(raw)).toEqual(['nav.today']);
    expect(findDuplicateKeys(JSON.stringify(GOOD_EN, null, 2))).toEqual([]);
  });

  it('extracts placeholder sets', () => {
    expect([...placeholdersOf('{a} and {b} and {a}')].sort()).toEqual(['a', 'b']);
    expect(placeholdersOf('no placeholders').size).toBe(0);
  });
});

describe('findKeyUsages', () => {
  it('collects single- and double-quoted literal keys', () => {
    const { literal } = findKeyUsages('const a = t(\'nav.today\');\nconst b = t("nav.lists");\n');
    expect([...literal].sort()).toEqual(['nav.lists', 'nav.today']);
  });

  it('reports non-literal call sites by line and ignores look-alike identifiers', () => {
    const { literal, dynamic } = findKeyUsages(
      'render(count(x));\nformat(y);\nconst label = t(item.labelKey);\n' +
        "// the contract below is documentation, not a call: t('ignored.in.comment')\n",
    );
    expect(literal.has('ignored.in.comment')).toBe(false);
    expect(dynamic).toEqual([3]);
  });
});

describe('checkI18n — fixtures (every failure path proven)', () => {
  it('passes a consistent fixture', () => {
    const paths = fixture({
      'en.json': JSON.stringify(GOOD_EN),
      'th.json': JSON.stringify(GOOD_TH),
      'app.tsx': "export const label = t('nav.today');",
    });
    const report = checkI18n(paths);
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.stats.literalCallSites).toBeGreaterThanOrEqual(1);
  });

  it('fails on a missing key, an extra key and a used-but-undefined key', () => {
    const paths = fixture({
      'en.json': JSON.stringify({ 'nav.today': 'Today' }),
      'th.json': JSON.stringify({ 'nav.today': 'วันนี้', 'ghost.key': 'ผี' }),
      'app.tsx': "export const label = t('nav.missing');",
    });
    const report = checkI18n(paths);
    expect(report.ok).toBe(false);
    const kinds = report.issues.map((issue) => issue.kind);
    expect(kinds).toContain('extra-in-th');
    expect(kinds).toContain('unknown-key');
    expect(report.issues.map((issue) => issue.detail).join(' ')).toContain('nav.missing');
  });

  it('fails when th drops a placeholder', () => {
    const paths = fixture({
      'en.json': JSON.stringify({ 'view.count': '{count} tasks' }),
      'th.json': JSON.stringify({ 'view.count': 'งานทั้งหมด' }),
    });
    const report = checkI18n(paths);
    expect(report.ok).toBe(false);
    expect(report.issues[0]?.kind).toBe('placeholder-mismatch');
  });

  it('lists dynamic call sites as informational only', () => {
    const paths = fixture({
      'en.json': JSON.stringify({ 'nav.today': 'Today' }),
      'th.json': JSON.stringify({ 'nav.today': 'วันนี้' }),
      'app.tsx': 'const label = t(item.labelKey);',
    });
    const report = checkI18n(paths);
    expect(report.ok).toBe(true);
    expect(report.stats.dynamicCallSites).toEqual(['app.tsx:1']);
    expect(formatReport(report)).toContain('non-literal key');
  });

  it('reports raw violations through formatReport', () => {
    const paths = fixture({
      'en.json': '{ "nav.today": "Today", "nav.today": "Today 2" }',
      'th.json': JSON.stringify({ 'nav.today': 'วันนี้' }),
    });
    const report = checkI18n(paths);
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.kind)).toContain('duplicate-key');
    expect(formatReport(report)).toContain('RESULT: FAIL');
  });
});

describe('checkI18n — the real catalogs', () => {
  it('src/i18n/en.json and th.json are key-complete and every call site resolves', () => {
    const report = checkI18n();
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.stats.enKeys).toBeGreaterThan(150);
    expect(report.stats.thKeys).toBe(report.stats.enKeys);

    // The catalogs on disk really are the two files under test (guards against path drift):
    // read them back through the same cwd-relative paths the CLI uses.
    const en = JSON.parse(readFileSync('src/i18n/en.json', 'utf8'));
    expect(Object.keys(en)).toHaveLength(report.stats.enKeys);
    expect(report.stats.usedKeys).toBeGreaterThan(50);
  });
});
