/**
 * Fuzzy ranking tests (V1 S8 command palette) + a 10k-task query budget sanity
 * check (PROJECT_ANALYSIS §9.1 INP < 200 ms).
 */

import { describe, expect, it } from 'vitest';

import {
  fuzzyScore,
  rankEntries,
  type PaletteEntry,
} from '../../../src/features/commands/paletteIndex';

function entry(id: string, label: string, kind: 'action' | 'task' = 'action'): PaletteEntry {
  return { id, kind, label, haystack: '' };
}

describe('fuzzyScore', () => {
  it('matches subsequences and rejects non-subsequences', () => {
    expect(fuzzyScore('gt', 'Go to Today')).not.toBe(null);
    expect(fuzzyScore('mk', 'Mark complete')).not.toBe(null);
    expect(fuzzyScore('zz', 'Go to Today')).toBe(null);
  });

  it('prefers word starts and consecutive runs', () => {
    const strong = fuzzyScore('go', 'Go to Today') ?? -1;
    const weak = fuzzyScore('go', 'Bag of potatoes') ?? -1;
    expect(strong).toBeGreaterThan(weak);
  });

  it('is case-insensitive and empty-safe', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
    expect(fuzzyScore('ADD', 'Add a task')).not.toBe(null);
  });
});

describe('rankEntries', () => {
  const entries: readonly PaletteEntry[] = [
    entry('add', 'Add a task'),
    entry('settings', 'Open settings'),
    entry('search', 'Search tasks'),
    entry('t1', 'Buy milk', 'task'),
    entry('t2', 'Call mom', 'task'),
  ];

  it('keeps curated order for an empty query, capped at limit', () => {
    expect(rankEntries('', entries, 3).map((e) => e.id)).toEqual(['add', 'settings', 'search']);
  });

  it('ranks matches and drops non-matches', () => {
    const ranked = rankEntries('milk', entries, 10);
    expect(ranked.map((e) => e.id)).toEqual(['t1']);
  });

  it('finds actions by fuzzy initials', () => {
    const ranked = rankEntries('os', entries, 10);
    expect(ranked[0]?.id).toBe('settings');
  });

  it('stays well inside the INP budget with 10k tasks (one keystroke)', () => {
    const many: PaletteEntry[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      many.push(
        entry(
          `task-${String(i)}`,
          `Task number ${String(i)} with a long descriptive title`,
          'task',
        ),
      );
    }
    many.push(entry('hit', 'ZZ unique needle task', 'task'));
    const started = performance.now();
    const ranked = rankEntries('zz unique needle', many, 20);
    const elapsed = performance.now() - started;
    expect(ranked[0]?.id).toBe('hit');
    // §9.1 budgets INP < 200 ms; a single rank over 10k entries takes single-digit
    // ms locally. The assert keeps a 20x margin so CI noise cannot flake it.
    expect(elapsed).toBeLessThan(200);
  });
});
