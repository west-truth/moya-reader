import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'screenshots/**',
      'smart-novel-reader-codex-pack/**',
      'src-tauri/gen/**',
      'test_novel/**',
      'ui-reference/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'no-undef': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/rules-of-hooks': 'error',
    },
  },
  {
    files: ['src/domain/**/*.ts', 'src/reader/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react-dom', '**/storage/**', '**/repositories/**', '**/providers/**', '**/sync/**'],
              message: 'Pure text/reader modules must not depend on framework or infrastructure implementations.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/server/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/src/App*', '**/src/platform/**', '**/src/storage/**'],
              message: 'The server may import shared pure contracts, but not web UI/runtime or IndexedDB modules.',
            },
          ],
        },
      ],
    },
  },
);
