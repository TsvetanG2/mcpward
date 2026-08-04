import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Force deterministic color behavior for golden snapshot tests (P2)
    // picocolors enables colors when CI=true, causing environment-dependent snapshots.
    // Set NO_COLOR=1 to disable colors consistently across local and CI.
    env: {
      NO_COLOR: '1',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/cli.ts'],
    },
    testTimeout: 30000,
  },
});
