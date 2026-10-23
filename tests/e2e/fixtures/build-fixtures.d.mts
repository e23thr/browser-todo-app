/** Type surface for tests/e2e/fixtures/build-fixtures.mjs (kept beside the script). */

export const FIXTURES_DIR: string;

export const FIXTURES: {
  readonly vA: string;
  readonly vB: string;
  readonly rootA: string;
};

export function buildFixtures(options?: { readonly basePath?: string }): typeof FIXTURES;

export function ensureFixtures(options?: { readonly basePath?: string }): Promise<typeof FIXTURES>;
