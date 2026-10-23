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

  prettierConfig,
);
