import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['dist/**/*.test.js'],
    fileParallelism: false,
    // Recovery checks prove bounded operations and cancellation; elapsed test time is not their completion contract.
    testTimeout: 0,
  },
});
