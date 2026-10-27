/**
 * Root ESLint flat config.
 *
 * `package.json` has run `eslint . --max-warnings=0` since the first slice, but
 * no config file existed, so the command died on "couldn't find eslint.config"
 * and the lint gate could neither pass nor fail. This is that missing config.
 *
 * Deliberately narrow: rules that matter for a fail-closed authorization plane
 * are on; stylistic preferences that would bury real findings are off, and each
 * relaxation states why.
 */
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '**/*.tsbuildinfo',
      'apps/web/next-env.d.ts',
      '.scratch/**',
      // Vendored third-party tooling, committed as authored. Linting it here
      // would mean editing someone else's files on every upgrade, and it made
      // `npm run lint` red on main before any of our code was touched.
      '.claude/**',
      '.gitnexus/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{mjs,js,cjs}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['**/*.{ts,tsx,mjs}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // An empty catch is how a fail-closed engine quietly becomes fail-open.
      'no-empty': 'error',
      // `x != null` is the deliberate "neither null nor undefined" test at the
      // intake boundary; everything else must be strict.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    // Fixtures and harnesses assert against shapes they construct themselves.
    files: ['**/test/**/*.ts', '**/tests/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      // Playwright's fixture factory signature is `async ({}, use)` when the
      // fixture consumes none of the built-ins; the empty pattern is required.
      'no-empty-pattern': 'off',
    },
  },
);
