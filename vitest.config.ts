/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.vitest.ts'],
    globals: true,
    testTimeout: 10_000,
    fileParallelism: false,
    passWithNoTests: true,
  },
});
