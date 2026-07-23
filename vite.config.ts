import path from 'node:path'

import { defineConfig } from 'vp'

const alias = {
  '@bnb-chain/b402/server': path.resolve(import.meta.dirname, 'packages/b402/src/server'),
  '@bnb-chain/b402/client': path.resolve(import.meta.dirname, 'packages/b402/src/client'),
  '@bnb-chain/b402': path.resolve(import.meta.dirname, 'packages/b402/src'),
  '@bnb-chain/mpp-b402/server': path.resolve(import.meta.dirname, 'packages/mpp-b402/src/server'),
  '@bnb-chain/mpp-b402/client': path.resolve(import.meta.dirname, 'packages/mpp-b402/src/client'),
  '@bnb-chain/mpp-b402': path.resolve(import.meta.dirname, 'packages/mpp-b402/src'),
  '@bnb-chain/mpp/server': path.resolve(import.meta.dirname, 'src/server'),
  '@bnb-chain/mpp/client': path.resolve(import.meta.dirname, 'src/client'),
  '@bnb-chain/mpp': path.resolve(import.meta.dirname, 'src'),
  '~test': path.resolve(import.meta.dirname, 'test'),
}

export default defineConfig({
  lint: {
    categories: { correctness: 'error', suspicious: 'warn' },
    plugins: ['typescript', 'oxc'],
    env: { builtin: true },
    rules: {
      'typescript/no-non-null-assertion': 'off',
      'typescript/no-explicit-any': 'off',
      // `_resolved` is the spec-mandated marker for SDK-internal preflight
      // output; verifier code MUST read from it (not re-resolve). Allow the
      // leading underscore so the convention isn't fighting the linter.
      'eslint/no-underscore-dangle': 'off',
    },
  },
  fmt: {
    singleQuote: true,
    semi: false,
    sortImports: {},
    sortPackageJson: false,
  },
  staged: {
    '*': 'vp fmt --write --no-error-on-unmatched-pattern',
    '*.{js,jsx,ts,tsx,mjs,cjs}': 'vp lint --fix',
    '*.{ts,tsx}': "bash -c 'vp check'",
  },
  test: {
    coverage: {
      include: ['src/**', 'packages/*/src/**'],
      exclude: ['test/**', '**/*.test-d.ts'],
      thresholds: { statements: 70, branches: 70, functions: 70 },
    },
    globalSetup: ['./test/setup.global.ts'],
    projects: [
      {
        test: {
          name: 'unit',
          alias,
          include: [
            'src/**/*.test.ts',
            'packages/*/src/**/*.test.ts',
            'test/mppx-contract/**/*.test.ts',
          ],
          exclude: ['**/node_modules/**', 'src/**/*.live.test.ts'],
          typecheck: {
            include: ['src/**/*.test-d.ts', 'packages/*/src/**/*.test-d.ts'],
          },
          globals: true,
          retry: 3,
          setupFiles: ['./test/setup.ts'],
          testTimeout: 10_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'interop',
          alias,
          include: ['test/interop/**/*.test.ts'],
          globals: true,
          setupFiles: ['./test/setup.ts'],
        },
      },
      {
        test: {
          name: 'live',
          alias,
          include: ['test/live/**/*.live.test.ts'],
          globals: true,
          retry: 1,
          testTimeout: 120_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
})
