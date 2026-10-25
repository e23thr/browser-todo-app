/**
 * Evidence-output portability gate (t_61309e52).
 *
 * The three core-UI component suites and the core-UI keyboard Playwright spec used to write their
 * QA evidence into a per-profile Hermes scratch directory of the dev host, so CI's unit job died
 * with ENOENT on the GitHub runner (run 40194624821): that path exists only on the machine that
 * authored it. Evidence now lands in `<repo>/test-results/evidence/` via `tests/evidence.ts`.
 *
 * This test turns the card's zero-tolerance acceptance gate — no absolute user-home path anywhere
 * under tests/ (and the scratch/profile greps that found the offending references) — into an
 * executable assertion, so a machine-local path cannot creep back into the tests/ tree unnoticed.
 *
 * The patterns below are REGEX literals on purpose: their source text must not contain the very
 * strings they ban, or this file would fail its own scan.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/** Machine-local references the tests/ tree must never carry again. */
const FORBIDDEN: readonly (readonly [label: string, pattern: RegExp])[] = [
  ['absolute user-home path', /\/home\//],
  ['Hermes profile scratch reference', /profiles\/h_/],
  ['Hermes scratch-directory reference', /cache\/scratch/],
];

/** Only the tree under test is scanned; derived e2e fixture output is rebuilt per run. */
const SKIPPED_DIRECTORIES = new Set(['.fixtures']);
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.css']);

function collectFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      files.push(...collectFiles(path.join(directory, entry.name)));
      continue;
    }
    if (TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

describe('tests/ portability: no machine-local paths (t_61309e52 zero-tolerance gate)', () => {
  it('scans every text file under tests/ and finds no forbidden machine-local reference', () => {
    const files = collectFiles(path.resolve('tests'));
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const [label, pattern] of FORBIDDEN) {
        const match = content.match(pattern);
        if (match !== null) {
          offenders.push(`${path.relative(process.cwd(), file)} — ${label}: ${match[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
