import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * ESLint 9 flat config (ADR-001 §5): typescript-eslint `strictTypeChecked` + jsx-a11y for TS,
 * plain recommended for build/CI scripts, eslint-config-prettier last so formatting stays with
 * Prettier. CI runs `eslint . --max-warnings 0`.
 */

// --- D1 regression guard (docs/qa/e1-scaffold-gates.md §2.7/§6) --------------------------------
// Playwright's default `getByRole(..., { name })` match is a case-insensitive SUBSTRING match, so
// renaming the Today heading to "Todayy" passed the smoke gate 7/7 — QA defect D1. Policy (also
// documented in the tests/e2e/smoke.spec.ts header): every role/text name match carries
// `exact: true`. An explicit `exact: false` is banned outright in tests/.
//
// Deliberate choice, stated in the rule messages: an anchored regex alone (`/^Today$/`) is NOT an
// accepted substitute for `exact: true`. One spelling keeps the policy greppable (`grep exact:
// true tests/`) and a regex cannot be validated as anchored by a selector anyway.
//
// Scope of the role-query half: tests/e2e/** (Playwright's `testDir`) only, because Testing
// Library specs physically cannot comply — `ByRoleOptions` has no `exact` property (TypeScript
// rejects it: "'exact' does not exist in type 'ByRoleOptions'") and @testing-library/dom already
// compares the accessible name with whole-string equality (`matches()` → `normalizedText ===
// matcher`), so there is no substring hole to plug there. The text-query half (`getByText`/…)
// IS substring-by-default in both libraries, so that half runs across all of tests/**.
// Two shapes of every guard, because both are idiomatic and the first shape alone was provably
// bypassable (review round 1):
//   * callee form — `screen.getByRole(...)` / `locator.getByText(...)`, matched via
//     `callee.property.name`;
//   * bare-identifier form — Testing Library's destructured `const { getByText } = render(...)`
//     or `within(dialog)`, matched via `callee.name`. `:is(A, B)` is a union, so a call only has
//     to look like one of them.
// Option keys are likewise matched as an identifier (`name:`) or a string literal (`'name':`),
// for the same bypass reason.
const calleeShape = (pattern) => `:is([callee.property.name=${pattern}],[callee.name=${pattern}])`;
const ROLE_PATTERN = '/^(get|query|find)ByRole$/';
const TEXT_PATTERN =
  '/^(get|query|find)By(Text|Title|Label|LabelText|Placeholder|PlaceholderText|AltText|DisplayValue)$/';
const HAS_NAME = 'ObjectExpression > Property[key.name=name],Property[key.value="name"]';
const HAS_EXACT = 'ObjectExpression > Property[key.name=exact],Property[key.value="exact"]';
const HAS_EXACT_FALSE =
  'ObjectExpression > Property[key.name=exact][value.raw="false"],Property[key.value="exact"]' +
  '[value.raw="false"]';

const ROLE_QUERY_GUARD = {
  selector: `CallExpression${calleeShape(ROLE_PATTERN)}:has(${HAS_NAME}):not(:has(${HAS_EXACT}))`,
  message:
    'D1 guard: getByRole(..., { name }) must also pass exact: true — Playwright matches role ' +
    'names by case-insensitive substring by default, which let a broken label pass the smoke gate ' +
    '(docs/qa/e1-scaffold-gates.md D1). Add exact: true; an anchored regex alone is not accepted.',
};

const TEXT_QUERY_GUARD = {
  selector: `CallExpression${calleeShape(TEXT_PATTERN)}:not(:has(${HAS_EXACT}))`,
  message:
    'D1 guard: getByText/getByTitle/getByLabel/… must pass { exact: true } — a string or regex ' +
    'matcher is a case-insensitive substring match by default in Playwright and Testing Library ' +
    'alike, so a broken label can pass silently (docs/qa/e1-scaffold-gates.md D1).',
};

const EXACT_FALSE_GUARD = {
  selector: `CallExpression${calleeShape(
    '/^(get|query|find)By(Role|Text|Title|Label|LabelText|Placeholder|PlaceholderText|AltText|DisplayValue)$/',
  )}:has(${HAS_EXACT_FALSE})`,
  message:
    'D1 guard: exact: false is banned in tests/ — substring name matching is exactly the hole that ' +
    'let a broken label pass the gate (docs/qa/e1-scaffold-gates.md D1). Use exact: true.',
};

// --- ADR-005 safety rails (E9), shared -------------------------------------------------------
// Extracted from the config block below so that the D1 test blocks can re-spread them: flat
// config replaces `no-restricted-syntax` per matching block, so a block that re-declares it must
// carry every selector that should stay live for those files.
const ADR005_RAILS = [
  {
    selector:
      'CallExpression[callee.object.name="location"][callee.property.name=/^(?:reload|replace|assign)$/]',
    message:
      'Only applyUpdate() in src/app/update.ts may reload or navigate the page (ADR-005 Decision 7 / E9).',
  },
  {
    selector:
      'CallExpression[callee.object.property.name="location"][callee.property.name=/^(?:reload|replace|assign)$/]',
    message:
      'Only applyUpdate() in src/app/update.ts may reload or navigate the page (ADR-005 Decision 7 / E9).',
  },
  {
    selector: 'CallExpression[callee.property.name="skipWaiting"]',
    message:
      'Only the SKIP_WAITING message handler in src/sw/sw.ts may call skipWaiting() (ADR-005 Decision 5 rule 6).',
  },
  {
    selector: 'CallExpression[callee.name="skipWaiting"]',
    message:
      'Only the SKIP_WAITING message handler in src/sw/sw.ts may call skipWaiting() (ADR-005 Decision 5 rule 6).',
  },
];

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'test-results/**',
      'playwright-report/**',
      'blob-report/**',
      '.vite/**',
    ],
  },

  // --- Plain JS/ESM files (scripts/, config files): no type information required -------------
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-console': ['error', { allow: ['error', 'warn'] }],
    },
  },

  // --- CI/build scripts are CLI tools: their report output is the product --------------------
  {
    files: ['scripts/**/*.mjs'],
    rules: {
      'no-console': 'off',
    },
  },

  // --- TypeScript: type-aware strict + a11y -------------------------------------------------
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      jsxA11y.flatConfigs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: [
          './tsconfig.app.json',
          './tsconfig.node.json',
          './tsconfig.test.json',
          './tsconfig.e2e.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.browser },
    },
    rules: {
      // §7.2: no telemetry, local error log only — stray console logging is a defect.
      'no-console': ['error', { allow: ['error', 'warn'] }],
    },
  },

  // --- Domain purity boundary (ADR-001 §9) ---------------------------------------------------
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/app/**',
                '**/features/**',
                '**/components/**',
                '**/storage/**',
                '**/i18n/**',
                'preact',
                'preact/*',
                '@preact/*',
              ],
              message:
                'src/domain/ must stay pure: no app, feature, component, storage or framework imports (ADR-001 §9).',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...[
          'window',
          'document',
          'navigator',
          'localStorage',
          'sessionStorage',
          'indexedDB',
          'fetch',
        ].map((name) => ({
          name,
          message: 'src/domain/ must stay DOM-free (ADR-001 §9).',
        })),
      ],
    },
  },

  // --- Tests: fixture-style code legitimately touches untyped values -------------------------
  {
    files: ['tests/**/*.ts', 'tests/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },

  // --- Playwright specs run in Node with browser globals ------------------------------------
  {
    files: ['tests/e2e/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // --- ADR-005 safety rails: exactly one reload call site, one skipWaiting call site ----------
  // BLOCK ORDER MATTERS (round-2 fix): flat config REPLACES a rule's configuration wholesale for
  // every file a later block matches — it never concatenates arrays. This block has no `files`
  // key, so when it sat after the D1 test blocks below it silently replaced the D1 guards for
  // every test file (`--print-config` proved it: tests/e2e specs showed only these four
  // selectors). The rails therefore come first, and every later block that re-declares
  // `no-restricted-syntax` re-spreads `ADR005_RAILS` so both guard sets stay live.
  {
    rules: {
      'no-restricted-syntax': ['error', ...ADR005_RAILS],
    },
  },

  // --- D1 guard, all tests: text queries are substring by default in BOTH libraries -----------
  {
    files: ['tests/**/*.ts', 'tests/**/*.tsx'],
    rules: {
      'no-restricted-syntax': ['error', ...ADR005_RAILS, TEXT_QUERY_GUARD, EXACT_FALSE_GUARD],
    },
  },

  // --- D1 guard, Playwright specs: role-name matches must be exact ---------------------------
  // Later block wins for tests/e2e/**, so it repeats the text guard above (flat config replaces
  // a rule's config rather than merging it).
  {
    files: ['tests/e2e/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...ADR005_RAILS,
        ROLE_QUERY_GUARD,
        TEXT_QUERY_GUARD,
        EXACT_FALSE_GUARD,
      ],
    },
  },

  {
    // Documented ADR-005 exceptions:
    // - src/app/update.ts: `applyUpdate()` owns the single deliberate `location.reload()`.
    // - src/app/router.ts: `location.replace(hash)` only swaps the hash fragment — same document,
    //   no reload; it is how `replace: true` navigation has always worked (ADR-001 scaffold).
    // - src/sw/sw.ts: the `SKIP_WAITING` message handler is the single `skipWaiting()` call site.
    files: ['src/app/update.ts', 'src/app/router.ts', 'src/sw/sw.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },

  prettierConfig,
);
