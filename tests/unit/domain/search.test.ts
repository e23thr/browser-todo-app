/**
 * Search-index semantics (ADR-003 Decision 6) — pinned word-prefix AND over
 * title+notes, rank title > notes, incremental maintenance == full rebuild,
 * keystroke narrowing == fresh query, and the §9.1 performance gate at 10k
 * fixtures with measured numbers recorded in the output.
 */
import { describe, expect, it } from 'vitest';

import { SearchIndex, tokenize, type SearchableTask } from '../../../src/domain/search';

function t(id: string, title: string, notes: string | null = null): SearchableTask {
  return { id, title, notes };
}

const CORPUS: SearchableTask[] = [
  t('1', 'Buy milk and eggs', 'from the corner shop'),
  t('2', 'Reorder the shelf', null),
  t('3', 'Call mom', 'Buy birthday present'),
  t('4', 'MILKSHAKE recipe', null),
  t('5', 'Écrire un rapport', 'café notes'),
];

function indexAll(tasks: SearchableTask[]): SearchIndex {
  const idx = new SearchIndex();
  idx.build(tasks);
  return idx;
}

function ids(hits: { id: string }[]): string[] {
  return hits.map((h) => h.id);
}

describe('search: match semantics (pinned)', () => {
  it('tokenize splits on whitespace and punctuation, lowercases, NFKC-folds', () => {
    expect(tokenize('Buy milk, and: eggs!')).toEqual(['buy', 'milk', 'and', 'eggs']);
    expect(tokenize('ﬁne ｗｏｒｄ')).toEqual(['fine', 'word']); // ligature + full-width
  });

  it('word-prefix AND across query tokens: "buy mil" matches "Buy milk and eggs"', () => {
    const idx = indexAll(CORPUS);
    expect(ids(idx.search('buy mil'))).toContain('1');
    expect(ids(idx.search('buy mil'))).not.toContain('4');
  });

  it('mid-word hits do NOT match ("der" never matches "reorder")', () => {
    const idx = indexAll(CORPUS);
    expect(ids(idx.search('der'))).toEqual([]);
    expect(ids(idx.search('eord'))).toEqual([]);
  });

  it('is case-insensitive and NFKC-normalized', () => {
    const idx = indexAll([...CORPUS, t('6', 'ﬁne print', null)]);
    expect(ids(idx.search('MILKSHAKE'))).toEqual(['4']);
    // Case fold: "Écrire" is found by lowercase "écrire".
    expect(ids(idx.search('écrire'))).toEqual(['5']);
    // NFKC fold: the "ﬁ" ligature is found by "fine".
    expect(ids(idx.search('fine'))).toEqual(['6']);
  });

  it('matches over title AND notes ("birthday" lives in notes)', () => {
    const idx = indexAll(CORPUS);
    expect(ids(idx.search('birthday'))).toEqual(['3']);
  });

  it('empty query returns nothing', () => {
    const idx = indexAll(CORPUS);
    expect(idx.search('   ')).toEqual([]);
  });

  it('ranks title coverage above notes-only (0 > 1 > 2)', () => {
    const tasks = [
      t('title-all', 'buy milk'),
      t('mixed', 'buy', 'something milk'),
      t('notes-only', 'groceries', 'buy milk'),
    ];
    const idx = indexAll(tasks);
    const hits = idx.search('buy mil');
    expect(ids(hits)).toEqual(['title-all', 'mixed', 'notes-only']);
    expect(hits.map((h) => h.rank)).toEqual([0, 1, 2]);
  });
});

describe('search: naive fallback is the semantic reference', () => {
  it('naive and indexed results agree exactly (ids and ranks)', () => {
    const idx = indexAll(CORPUS);
    for (const q of ['buy', 'buy mil', 'milk OR', 'café', 'xyz', 'reorder the']) {
      expect(idx.search(q)).toEqual(SearchIndex.naive(CORPUS, q));
    }
  });
});

describe('search: incremental maintenance', () => {
  it('upsert/remove never diverge from a full rebuild', () => {
    const idx = indexAll(CORPUS);
    const fresh = new SearchIndex();
    const working = [...CORPUS];

    const edited = { ...CORPUS[0]!, title: 'Buy oat milk', notes: 'quick' };
    idx.upsert(edited);
    working[0] = edited;
    fresh.build(working);
    expect(idx.search('oat')).toEqual(fresh.search('oat'));
    expect(idx.search('eggs')).toEqual(fresh.search('eggs'));

    idx.remove('3');
    working.splice(2, 1);
    fresh.build(working);
    for (const q of ['buy', 'birthday', 'milk', 'e']) {
      expect(idx.search(q)).toEqual(fresh.search(q));
    }
    expect(idx.size).toBe(fresh.size);
  });

  it('upserting a brand-new id inserts it (equivalent to rebuild)', () => {
    const idx = indexAll(CORPUS);
    const added = t('9', 'Fresh bread', null);
    idx.upsert(added);
    const fresh = indexAll([...CORPUS, added]);
    expect(idx.search('fresh')).toEqual(fresh.search('fresh'));
    expect(idx.size).toBe(CORPUS.length + 1);
  });

  it('remove of an unknown id is a no-op', () => {
    const idx = indexAll(CORPUS);
    idx.remove('missing');
    expect(idx.size).toBe(CORPUS.length);
  });
});

describe('search: keystroke narrowing', () => {
  it('narrowing on appended chars equals a fresh indexed query', () => {
    const idx = indexAll(CORPUS);
    let prev = { query: '', hits: idx.search('b') };
    for (const q of ['bu', 'buy', 'buy ', 'buy m', 'buy mil']) {
      const narrowed = idx.search(q, prev);
      expect(narrowed).toEqual(idx.search(q));
      prev = { query: q, hits: narrowed };
    }
  });

  it('deleting characters falls back to a fresh query (still correct)', () => {
    const idx = indexAll(CORPUS);
    const atMil = idx.search('buy mil');
    const shrunk = idx.search('buy', { query: 'buy mil', hits: atMil });
    expect(shrunk).toEqual(idx.search('buy'));
  });
});

describe('search: performance at 10,000 fixtures (§9.1 budget)', () => {
  function corpus10k(): SearchableTask[] {
    const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
    const out: SearchableTask[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      const title = `${words[i % 8] ?? ''} ${words[(i >> 3) % 8] ?? ''} task ${String(i)}`;
      const notes =
        i % 5 < 3
          ? `notes ${words[(i >> 6) % 8] ?? ''} ${words[(i >> 9) % 8] ?? ''} detail ${String(i)} lorem ipsum`
          : null;
      out.push(t(`id-${String(i).padStart(6, '0')}`, title, notes));
    }
    return out;
  }

  it('builds, queries and narrows inside the <50ms budget (numbers recorded)', () => {
    const tasks = corpus10k();
    const idx = new SearchIndex();

    const buildStart = performance.now();
    idx.build(tasks);
    const buildMs = performance.now() - buildStart;

    const coldStart = performance.now();
    const cold = idx.search('gam');
    const coldMs = performance.now() - coldStart;

    const cold2Start = performance.now();
    const cold2 = idx.search('alpha beta');
    const cold2Ms = performance.now() - cold2Start;

    const narrowStart = performance.now();
    const narrowed = idx.search('gamma', { query: 'gam', hits: cold });
    const narrowMs = performance.now() - narrowStart;

    const naiveStart = performance.now();
    const naive = SearchIndex.naive(tasks, 'alpha bet');
    const naiveMs = performance.now() - naiveStart;

    console.warn(
      `[bench] search@10k: build ${buildMs.toFixed(1)}ms | cold(1 token) ${coldMs.toFixed(2)}ms | ` +
        `cold(2 tokens) ${cold2Ms.toFixed(2)}ms | narrowed ${narrowMs.toFixed(2)}ms | ` +
        `naive scan ${naiveMs.toFixed(1)}ms | matches ${String(cold.length)}/${String(cold2.length)}/${String(narrowed.length)}/${String(naive.length)}`,
    );

    expect(cold.length).toBeGreaterThan(0);
    expect(narrowed.length).toBeLessThanOrEqual(cold.length);
    // CI gate (ADR-003 testing contract): every indexed query <= 50ms on the CI host.
    expect(buildMs).toBeLessThan(500); // informational headroom; build is off the paint path
    expect(coldMs).toBeLessThan(50);
    expect(cold2Ms).toBeLessThan(50);
    expect(narrowMs).toBeLessThan(50);
    expect(idx.size).toBe(10_000);
  });
});
