import globals from 'globals';
import js from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import promisePlugin from 'eslint-plugin-promise';
import sonarjs from 'eslint-plugin-sonarjs';
import { config as tseslintConfig, configs as tseslintConfigs } from 'typescript-eslint';
import unicorn from 'eslint-plugin-unicorn';

function withoutPlugins(config) {
  const nextConfig = { ...config };
  delete nextConfig.plugins;
  return nextConfig;
}

const config = tseslintConfig(
  js.configs.recommended,
  ...tseslintConfigs.recommended,
  ...tseslintConfigs.recommendedTypeChecked,
  ...tseslintConfigs.stylisticTypeChecked,
  { plugins: { import: importPlugin } },
  withoutPlugins(importPlugin.flatConfigs.recommended),
  withoutPlugins(importPlugin.flatConfigs.typescript),
  promisePlugin.configs['flat/recommended'],
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslintConfigs.disableTypeChecked],
    languageOptions: {
      parserOptions: {
        project: false,
        projectService: false,
      },
    },
  },
  {
    files: ['eslint.config.mjs'],
    rules: {
      'import/no-unresolved': 'off',
    },
  },
  {
    files: ['tests/**/*.vitest.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'vitest.config.ts'],
    settings: {
      'import/resolver': {
        node: true,
        typescript: true,
      },
    },
    languageOptions: {
      globals: {
        ...globals.builtin,
        ...globals.node,
        NodeJS: 'readonly',
        BufferEncoding: 'readonly',
      },
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { sonarjs, unicorn },
    rules: {
      'import/no-unused-modules': ['error', {
        ignoreUnusedTypeExports: true,
        unusedExports: true,
        src: ['src/**/*.ts', 'tests/**/*.ts'],
        ignoreExports: ['src/bin/paper-storage.ts', 'src/index.ts', 'vitest.config.ts'],
      }],
      'object-curly-newline': ['error', { ImportDeclaration: 'never' }],
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-useless-catch': 'error',
      'max-lines': ['error', { max: 1600, skipBlankLines: false, skipComments: false }],
      'sonarjs/cognitive-complexity': ['error', 50],
      'sonarjs/no-all-duplicated-branches': 'error',
      'sonarjs/no-collapsible-if': 'error',
      'sonarjs/no-collection-size-mischeck': 'error',
      'sonarjs/no-dead-store': 'error',
      'sonarjs/no-duplicated-branches': 'error',
      'sonarjs/no-element-overwrite': 'error',
      'sonarjs/no-extra-arguments': 'error',
      'sonarjs/no-gratuitous-expressions': 'error',
      'sonarjs/no-identical-conditions': 'error',
      'sonarjs/no-identical-expressions': 'error',
      'sonarjs/no-identical-functions': 'error',
      'sonarjs/no-inverted-boolean-check': 'error',
      'sonarjs/no-nested-switch': 'error',
      'sonarjs/no-nested-template-literals': 'error',
      'sonarjs/no-redundant-boolean': 'error',
      'sonarjs/no-small-switch': 'error',
      'sonarjs/no-unused-collection': 'error',
      'sonarjs/no-use-of-empty-return-value': 'error',
      'sonarjs/prefer-immediate-return': 'error',
      'unicorn/filename-case': 'off',
      'unicorn/no-array-for-each': 'error',
      'unicorn/no-null': 'off',
      'unicorn/prefer-node-protocol': 'error',
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: false, allowNullish: true }],
    },
  },
);

export default config;
