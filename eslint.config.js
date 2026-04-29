// ESLint flat config — root for the whole monorepo. Single source of
// truth so apps/api, apps/web, packages/* all lint against the same
// rules without per-package configs drifting.
//
// Bootstrap stance (Sprint 0): minimal, opinionated rules. ESLint
// recommended + typescript-eslint recommended + react/react-hooks/jsx-a11y
// for the web app, with eslint-config-prettier last to disable style
// rules Prettier owns. We can tighten with `recommended-type-checked` or
// `strict` once the test/type coverage justifies the noise.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  // 1. Ignored paths — must come first for flat config.
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/.vite/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/playwright-report*/**',
      '**/test-results*/**',
      '**/.features-gen*/**',
      '**/tests/performance/reports/**',
      // Vendored Claude Code skill scripts — not our code, not our lint rules.
      '.claude/**',
      // Generated OpenAPI schema bundle.
      '**/openapi.yaml',
    ],
  },

  // 2. Baseline JS recommended rules everywhere.
  js.configs.recommended,

  // 3. typescript-eslint recommended (no type-checked variant — too
  //    noisy for Sprint 0; revisit after the schema lands and we have
  //    real types to reason about). Then a small set of cheap, zero-
  //    false-positive rules on top.
  ...tseslint.configs.recommended,
  {
    rules: {
      eqeqeq: 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // 4. JSX/TSX everywhere — enable the JSX parser feature for any tsx
  //    file regardless of which workspace, so future tsx outside
  //    web/ui (e.g. in packages/shared) parses correctly. Plugin
  //    registration is scoped to web/ui in the next block.
  {
    files: ['**/*.{tsx,jsx}'],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },

  // 4b. React + hooks + a11y plugins for apps/web, packages/ui, and the
  //     test-utils web wrapper (which also renders JSX).
  {
    files: [
      'apps/web/**/*.{ts,tsx,js,jsx}',
      'packages/ui/**/*.{ts,tsx,js,jsx}',
      'packages/test-utils/src/web/**/*.{ts,tsx}',
    ],
    plugins: {
      react,
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.configs.recommended.rules,
      // React 17+ JSX transform — no need for React in scope.
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off', // we use TS for prop types
    },
  },

  // 5. Node globals for api / scripts / configs / tests.
  {
    files: [
      'apps/api/**/*.{ts,js,mjs,cjs}',
      'packages/shared/**/*.{ts,js}',
      'packages/test-utils/**/*.{ts,js}',
      'tests/**/*.{ts,js,mjs}',
      '**/*.config.{ts,js,mjs,cjs}',
      'scripts/**/*.{js,mjs,ts}',
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // 6. Test files: relax the no-explicit-any rule (test fixtures often
  //    legitimately produce `any`-typed mocks).
  {
    files: ['tests/**/*.{ts,tsx}', '**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },

  // 6b. k6 perf scripts — k6 injects __ENV / __VU / __ITER into the VU
  //     runtime; they're not Node nor browser globals.
  {
    files: ['tests/performance/**/*.{js,mjs}'],
    languageOptions: {
      globals: {
        ...globals.node,
        __ENV: 'readonly',
        __VU: 'readonly',
        __ITER: 'readonly',
      },
    },
  },

  // 7. Prettier — must be LAST. Disables rules that conflict with
  //    Prettier's formatter so the two tools don't fight.
  prettier,
);
