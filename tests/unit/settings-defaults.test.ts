/**
 * Settings defaults — single source of truth (QA defect D1, `docs/qa/e3-data-engine.md` §3;
 * PO decision 2026-10-25, recorded on fix card t_07ad37dd).
 *
 * Three independent literals of the settings default had drifted (`weekStart` 1 vs 0), so
 * "Delete all data" landed on a settings state a fresh install would not have — the opposite
 * of ADR-004 Decision 10 ("an effectively fresh install with the same `deviceId`"). DECIDED
 * shape: `src/domain/model.ts` `DEFAULT_SETTINGS` is the ONLY literal definition (ADR-003
 * Decision 1.2 — the canonical record home); `src/portability/constants.ts` and
 * `src/app/settings.ts` derive from it.
 *
 * The value-equality checks below are behaviour; the source scans are the AC made executable
 * ("a grep for `weekStart: 0` in src/ returns nothing"), so the drift cannot return silently.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS as APP_DEFAULTS, type AppSettings } from '../../src/app/settings';
import { DEFAULT_SETTINGS as DOMAIN_DEFAULTS } from '../../src/domain/model';
import { DEFAULT_SETTINGS_RECORD } from '../../src/portability/constants';

/** Every `.ts`/`.tsx` file under `src/`, as project-root-relative paths. */
function sourceFiles(base = 'src'): string[] {
  return readdirSync(base, { withFileTypes: true }).flatMap((entry) => {
    const path = join(base, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

/** Files whose text carries a literal `weekStart: <digit>,` default entry. */
function weekStartLiterals(files: string[]): string[] {
  return files.filter((file) => /weekStart:\s*[01],/u.test(readFileSync(file, 'utf8')));
}

describe('settings defaults are single-sourced (QA D1)', () => {
  it('the portability reset target IS the domain default (byte-for-byte, no drift possible)', () => {
    expect(DEFAULT_SETTINGS_RECORD).toEqual(DOMAIN_DEFAULTS);
  });

  it('the app store default is the domain default narrowed to its three owned fields', () => {
    const expected: AppSettings = {
      theme: DOMAIN_DEFAULTS.theme,
      weekStart: DOMAIN_DEFAULTS.weekStart,
      defaultListId: DOMAIN_DEFAULTS.defaultListId,
    };
    expect(APP_DEFAULTS).toEqual(expected);
    // The decided value (PO 2026-10-25): the week starts on Monday in a fresh profile.
    expect(APP_DEFAULTS.weekStart).toBe(1);
    expect(DOMAIN_DEFAULTS.weekStart).toBe(1);
  });

  it('src/ holds EXACTLY ONE literal weekStart default — the domain model’s', () => {
    expect(weekStartLiterals(sourceFiles())).toEqual(['src/domain/model.ts']);
  });

  it('never re-introduces the drifted Sunday literal outside the domain model', () => {
    const drifted = sourceFiles().filter(
      (file) =>
        file !== 'src/domain/model.ts' && /weekStart:\s*0,/u.test(readFileSync(file, 'utf8')),
    );
    expect(drifted).toEqual([]);
  });
});
